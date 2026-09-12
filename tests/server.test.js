import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createKDNAServer, createReferenceHost, readResultResponse } from '../src/index.js';
import { createKDNARouter } from '../src/adapters/express/index.js';
import { createNextHandlers } from '../src/adapters/nextjs/index.js';
import { fixture, readRequest, allowAll, upload } from './fixture.js';

const code = result => result.envelope?.diagnostics[0]?.code ?? result.admission_rejection?.code
  ?? result.control?.semantic_cause ?? result.transport_failure?.code;
function rejected(result, expected) {
  assert.equal(code(result), expected, JSON.stringify(result));
  assert.equal(result.envelope?.content ?? null, null);
  assert.doesNotMatch(JSON.stringify(result), /RESULT_SENTINEL|Synthetic author/);
  if (result.envelope) assert.equal(result.envelope.receipt.delivery, 'not_delivered');
}

test('real bytes pass Core admission and two fresh Host observations before bounded delivery', async () => {
  const observations = [], deliveries = [];
  const host = createReferenceHost({ observePolicy: observation => { observations.push(observation); return allowAll(observation); } });
  assert.deepEqual(await host.validate(fixture()), { valid: true, action_authorization: 'not_evaluated' });
  const result = await host.read(fixture(), readRequest(), { deliver: value => { deliveries.push(value); return true; } });
  assert.equal(observations.length, 2);
  assert.equal(deliveries.length, 1);
  assert.equal(result.envelope.status, 'ready');
  assert.equal(result.envelope.states.action_authorization, 'not_evaluated');
  assert.equal(result.envelope.states.confirmation, 'not_evaluated');
  assert.equal(result.envelope.receipt.delivery, 'delivered');
  assert.equal(result.envelope.receipt.snapshot_id, observations[1].snapshot.snapshot_id);
  const actual = Buffer.from(await readResultResponse(result).arrayBuffer());
  assert.equal(actual.length, Number(result.envelope.budget.actual_bytes));
  assert.deepEqual(JSON.parse(actual), result.envelope);
});

test('default Host denies disclosure even after technical validation', async () => {
  const host = createReferenceHost();
  assert.equal((await host.validate(fixture())).valid, true);
  rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
});

test('fresh deny and revocation discard the prepared body; denial remains latched', async () => {
  for (const change of ['deny', 'revoke', 'epoch']) {
    let calls = 0;
    const host = createReferenceHost({ observePolicy: o => {
      const policy = allowAll(o); calls++;
      if (calls === 2) {
        if (change === 'deny') policy.decision = 'deny';
        if (change === 'revoke') policy.revoked = true;
        if (change === 'epoch') policy.epoch = 'epoch:2';
      }
      return policy;
    } });
    rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
    if (change !== 'epoch') rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
  }
});

test('explicit new epoch or independent lift permits a fresh request after revocation', async () => {
  let decision = 'deny', epoch = 'epoch:1', liftDenial = false;
  const host = createReferenceHost({ observePolicy: o => ({ ...allowAll(o), decision, epoch, liftDenial }) });
  rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
  decision = 'allow';
  rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
  liftDenial = true;
  assert.equal((await host.read(fixture(), readRequest())).envelope.status, 'ready');
  decision = 'deny'; liftDenial = false;
  rejected(await host.read(fixture(), readRequest()), 'READ_HOST_DENIED');
  decision = 'allow'; epoch = 'epoch:2';
  assert.equal((await host.read(fixture(), readRequest())).envelope.receipt.host_epoch, epoch);
});

test('Host time is refreshed after asynchronous policy evaluation and expiry fails closed', async () => {
  let now = 1000;
  const host = createReferenceHost({ clock: () => now, observePolicy: async o => {
    now = 2000;
    return { ...allowAll(o), issuedAt: 1000, expiresAt: 1500 };
  } });
  rejected(await host.read(fixture(), readRequest()), 'READ_HOST_CONTEXT_EXPIRED');
  const future = createReferenceHost({ clock: () => 1000,
    observePolicy: o => ({ ...allowAll(o), issuedAt: 2000, expiresAt: 3000 }) });
  rejected(await future.read(fixture(), readRequest()), 'READ_HOST_TIME_INVALID');
});

test('selection coordinates and protocol request fields are validated by public Read', async () => {
  const host = createReferenceHost({ observePolicy: allowAll });
  for (const [field, value, expected] of [
    ['asset_id', 'asset:other', 'READ_ASSET_MISMATCH'],
    ['asset_version', '2.0.0', 'READ_ASSET_VERSION_MISMATCH'],
    ['judgment_id', 'judgment:missing', 'READ_SELECTION_NOT_FOUND'],
  ]) {
    const request = readRequest(); request.selection[field] = value;
    rejected(await host.read(fixture(), request), expected);
  }
  for (const request of [null, [], { ...readRequest(), host: { decision: 'allow' } },
    { ...readRequest(), result: { action_authorization: 'allowed' } },
    { ...readRequest(), trace: { complete: true } }, { ...readRequest(), receipt: { delivery: 'delivered' } }]) {
    rejected(await host.read(fixture(), request), 'READ_INPUT_INVALID');
  }
  const request = readRequest(); request.tuple = { ...request.tuple, core: 'kdna.core/99.0.0' };
  rejected(await host.read(fixture(), request), 'READ_MIXED_VERSION_TUPLE');
});

test('mandatory cross-judgment boundary and actor cannot be removed by scope', async () => {
  const bytes = fixture(2, p => {
    p.actors.push({ id: 'actor:boundary', kind: 'person', name: 'Boundary authority' });
    p.judgments[0].exceptions = { state: 'provided', value: [{ id: 'exception:selected', statement: 'Qualified', boundary_ref: 'boundary:upstream' }] };
    p.judgments[1].boundaries = { state: 'provided', value: [{ id: 'boundary:upstream', effect: 'exclude',
      statement: 'Outside scope is forbidden', declared_by: 'actor:boundary' }] };
  });
  const full = await createReferenceHost({ observePolicy: allowAll }).read(bytes, readRequest());
  assert.equal(full.envelope.status, 'ready');
  for (const value of ['boundary:upstream', 'actor:boundary']) {
    assert.ok(full.envelope.content.closure.some(n => n.value.id === value));
    const host = createReferenceHost({ observePolicy: o => ({ ...allowAll(o),
      scope: o.snapshot.ir.nodes.filter(n => n.value.id !== value).map(n => n.id) }) });
    rejected(await host.read(bytes, readRequest()), 'READ_SCOPE_DENIED');
  }
  assert.doesNotMatch(JSON.stringify(full.envelope.content), /RESULT_SENTINEL_1/);
});

test('catalog and omissions reveal no unauthorized adjacent identities or bodies', async () => {
  let hidden = [];
  const host = createReferenceHost({ observePolicy: o => {
    hidden = o.snapshot.ir.nodes.filter(n => n.owner_judgment_id === 'judgment:1').map(n => n.id);
    return { ...allowAll(o), scope: o.snapshot.ir.nodes.filter(n => !hidden.includes(n.id)).map(n => n.id) };
  } });
  const catalog = await host.read(fixture(2), readRequest({ mode: 'catalog', selection: null }));
  assert.equal(catalog.envelope.status, 'ready');
  assert.deepEqual(catalog.envelope.content.catalog.map(x => x.judgment_id), ['judgment:0']);
  const wire = JSON.stringify(catalog);
  assert.doesNotMatch(wire, /judgment:1|RESULT_SENTINEL/);
  for (const id of hidden) assert.equal(wire.includes(id), false);
});

test('zero, one-byte-short and exact budgets apply to complete final wire payloads', async () => {
  const host = createReferenceHost({ observePolicy: allowAll, clock: () => 1000 });
  const full = await host.read(fixture(), readRequest());
  // limit_bytes has its own digit width; find the stable required count for that width.
  let limit = Number(full.envelope.budget.required_bytes);
  let fit;
  for (let i = 0; i < 4; i++) {
    fit = await host.read(fixture(), readRequest({ budget_bytes: limit }));
    const required = Number(fit.envelope?.budget.required_bytes);
    if (fit.envelope?.status === 'ready' && required === limit) break;
    assert.ok(required > 0); limit = required;
  }
  assert.equal(fit.envelope.status, 'ready');
  assert.equal((await readResultResponse(fit).arrayBuffer()).byteLength, limit);
  rejected(await host.read(fixture(), readRequest({ budget_bytes: limit - 1 })), 'READ_BUDGET_INSUFFICIENT');
  for (const budget_bytes of [0, 1]) {
    const result = await host.read(fixture(), readRequest({ budget_bytes }));
    assert.equal(result.channel, 'no_body_control');
    assert.equal((await readResultResponse(result).arrayBuffer()).byteLength, 0);
  }
});

test('delivery false or exception returns only sanitized transport failure with semantic cause', async () => {
  for (const deliver of [() => false, () => { throw new Error('PRIVATE_TRANSPORT_SECRET'); }]) {
    const host = createReferenceHost({ observePolicy: allowAll });
    const result = await host.read(fixture(), readRequest(), { deliver });
    assert.equal(result.channel, 'transport_failure');
    assert.equal(result.envelope, null);
    assert.equal(result.transport_failure.delivery, 'not_confirmed');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|RESULT_SENTINEL|snapshot:/);
    const denied = await createReferenceHost().read(fixture(), readRequest(), { deliver });
    assert.equal(denied.transport_failure.semantic_cause, 'READ_HOST_DENIED');
  }
});

test('Host bounds input, output, concurrent calls and total provider lifetime', async () => {
  const bytes = fixture();
  await assert.rejects(createReferenceHost({ maxInputBytes: bytes.length - 1 }).read(bytes, readRequest()), /HOST_INPUT_TOO_LARGE/);
  await assert.rejects(createReferenceHost({ maxResponseBytes: 2 }).read(bytes, readRequest()), /HOST_RESPONSE_LIMIT_EXCEEDED/);
  const once = createReferenceHost({ maxReads: 1, observePolicy: allowAll });
  await once.read(bytes, readRequest());
  await assert.rejects(once.read(bytes, readRequest()), /HOST_SESSION_EXHAUSTED/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const host = createReferenceHost({ maxConcurrentReads: 1, observePolicy: async o => { await gate; return allowAll(o); } });
  const first = host.read(bytes, readRequest());
  await assert.rejects(host.read(bytes, readRequest()), /HOST_BUSY/);
  release(); assert.equal((await first).envelope.status, 'ready');
  for (const maxInputBytes of [-1, Infinity, NaN, 26 * 1024 * 1024]) assert.throws(() => createReferenceHost({ maxInputBytes }));
});

test('concurrent request context cannot cross policy or delivery channels', async () => {
  const host = createReferenceHost({ observePolicy: async o => {
    await new Promise(resolve => setImmediate(resolve));
    return { ...allowAll(o), epoch: `epoch:${o.context}`, decision: o.context === 'yes' ? 'allow' : 'deny' };
  } });
  const delivered = [];
  const [yes, no] = await Promise.all(['yes', 'no'].map(context => host.read(fixture(), readRequest({ request_id: `request:${context}` }),
    { context, deliver: result => { delivered.push([context, result.envelope.request_id]); return true; } })));
  assert.equal(yes.envelope.status, 'ready'); rejected(no, 'READ_HOST_DENIED');
  assert.deepEqual(delivered.sort(), [['no', 'request:no'], ['yes', 'request:yes']]);
});

test('unsupported old Plan/load/activation/action operations fail closed without fetching', async () => {
  const server = createKDNAServer();
  for (const [operation, expected] of [['plan-load', 'PLAN'], ['plan', 'PLAN'], ['load', 'LOAD'],
    ['activate', 'ACTIVATION'], ['execute', 'ACTION'], ['export', 'EXPORT']]) {
    const response = await server.handle(new Request(`http://localhost/api/kdna/${operation}`, { method: 'POST' }));
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, `KDNA_${expected}_CAPABILITY_UNAVAILABLE`);
  }
  for (const options of [{ runtime: {} }, { storage: {} }, { activationServerUrl: 'https://example.invalid' }]) {
    assert.throws(() => createKDNAServer(options), /unavailable/);
  }
});

test('independent grant and Plan observations are prerequisites, never Host permission or action execution', async () => {
  const host = createReferenceHost({ observePolicy: o => ({ ...allowAll(o), epoch: o.context.epoch,
    decision: o.context.currentApplicability === true ? 'allow' : 'deny' }) });
  const prerequisites = { grantObserved: true, planObserved: true, currentApplicability: false, epoch: 'epoch:closed' };
  rejected(await host.read(fixture(), readRequest(), { context: prerequisites }), 'READ_HOST_DENIED');
  const result = await host.read(fixture(), readRequest(), {
    context: { ...prerequisites, currentApplicability: true, epoch: 'epoch:fresh' },
  });
  assert.equal(result.envelope.status, 'ready');
  assert.equal(result.envelope.states.action_authorization, 'not_evaluated');
  for (const field of ['grant', 'plan']) {
    const rejectedRequest = await host.read(fixture(), { ...readRequest(), [field]: { allowed: true } });
    rejected(rejectedRequest, 'READ_INPUT_INVALID');
  }
});

test('HTTP Request adapter uses real Core for validate and protected inspect/read', async () => {
  const server = createKDNAServer({ observePolicy: allowAll });
  const validated = await server.handle(upload('validate', fixture()));
  assert.equal((await validated.json()).valid, true);
  for (const operation of ['inspect', 'read']) {
    const response = await server.handle(upload(operation, fixture()));
    const bytes = Buffer.from(await response.arrayBuffer());
    const envelope = JSON.parse(bytes);
    assert.equal(response.status, 200, bytes.toString());
    assert.equal(envelope.status, 'ready');
    assert.equal(bytes.length, Number(envelope.budget.actual_bytes));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const next = createNextHandlers({ observePolicy: allowAll });
  assert.equal((await next.POST(upload('read', fixture()), { params: Promise.resolve({ route: ['read'] }) })).status, 200);
  assert.equal((await next.POST(upload('read', fixture()), { params: { route: ['extra', 'read'] } })).status, 404);
});

test('HTTP zero-body budget and failed sink never return a cached successful response', async () => {
  const server = createKDNAServer({ observePolicy: allowAll });
  const tiny = await server.handle(upload('read', fixture(), readRequest({ budget_bytes: 0 })));
  assert.equal(tiny.status, 413); assert.equal((await tiny.arrayBuffer()).byteLength, 0);
  for (const deliverResponse of [() => false, () => { throw new Error('PRIVATE_SINK_ERROR'); }]) {
    const response = await server.handle(upload('read', fixture()), { deliverResponse });
    assert.equal(response.status, 502); assert.equal(await response.text(), '');
    const invalid = await server.handle(upload('read', fixture(), null), { deliverResponse });
    assert.equal(invalid.status, 502); assert.equal(await invalid.text(), '');
    assert.equal(invalid.headers.get('x-kdna-channel'), 'transport_failure');
    assert.equal(invalid.headers.get('x-kdna-semantic-cause'), 'READ_INPUT_INVALID');
  }
});

test('HTTP multipart limits, duplicate fields, scope injection and route confusion fail closed', async () => {
  const bounded = createKDNAServer({ maxRequestBytes: 20 });
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(21)); },
    cancel() { cancelled = true; } });
  assert.equal((await bounded.handle(new Request('http://localhost/api/kdna/read', {
    method: 'POST', body, duplex: 'half',
  }))).status, 413);
  assert.equal(cancelled, false); assert.equal(body.locked, false);
  const stoppedPulls = pulls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pulls, stoppedPulls); assert.ok(pulls <= 2);
  const server = createKDNAServer({ observePolicy: allowAll });
  for (const pathname of ['/api/kdnaevil/read', '/api/kdna/extra/read', '/api/kdna//read']) {
    assert.equal((await server.handle(new Request(`http://localhost${pathname}`, { method: 'POST' }))).status, 404);
  }
  for (const field of ['scope', 'context', 'host', 'file', 'request']) {
    const source = upload('read', fixture()); const form = await source.formData(); form.append(field, 'untrusted');
    const response = await server.handle(new Request(source.url, { method: 'POST', body: form }));
    assert.equal(response.status, 400);
  }
});

test('Express adapter delivers over a temporary loopback HTTP server and closes it', async () => {
  const router = createKDNARouter({ observePolicy: allowAll });
  const listener = createServer((req, res) => { void router(req, res); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const source = upload('read', fixture());
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/read`, {
      method: 'POST', body: await source.arrayBuffer(), headers: source.headers,
    });
    const bytes = Buffer.from(await response.arrayBuffer()); const envelope = JSON.parse(bytes);
    assert.equal(response.status, 200); assert.equal(envelope.receipt.delivery, 'delivered');
    assert.equal(bytes.length, Number(envelope.budget.actual_bytes));
  } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
});

test('a real HTTP client disconnect before delivery yields no success body or confirmed receipt', async () => {
  let ready, finished;
  const observed = new Promise(resolve => { ready = resolve; });
  const outcome = new Promise(resolve => { finished = resolve; });
  const server = createKDNAServer({ observePolicy: async o => {
    o.context.observations++;
    if (o.context.observations === 2) { ready(); await o.context.closed; }
    return allowAll(o);
  } });
  const listener = createServer(async (req, res) => {
    const closed = new Promise(resolve => res.once('close', resolve));
    const web = new Request('http://localhost/api/kdna/read', { method: 'POST', headers: req.headers,
      body: req, duplex: 'half' });
    const response = await server.handle(web, { context: { observations: 0, closed },
      deliverResponse: async prepared => {
        if (res.destroyed) return false;
        res.end(Buffer.from(await prepared.arrayBuffer())); return true;
      } });
    finished({ response, destroyed: res.destroyed });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  let client;
  try {
    const source = upload('read', fixture());
    const input = Buffer.from(await source.arrayBuffer());
    client = httpRequest({ hostname: '127.0.0.1', port: listener.address().port, path: '/read', method: 'POST',
      headers: { 'content-type': source.headers.get('content-type'), 'content-length': input.length } });
    client.on('error', () => {}); // Expected client abort, not a successful response.
    client.end(input);
    await observed; client.destroy();
    const result = await outcome;
    assert.equal(result.destroyed, true); assert.equal(result.response.status, 502);
    assert.equal(result.response.headers.get('x-kdna-code'), 'READ_TRANSPORT_FAILURE');
    assert.equal(await result.response.text(), '');
  } finally {
    client?.destroy(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
  }
});

test('policy and request stream timeouts release capacity without leaking provider errors', async () => {
  const host = createReferenceHost({ policyTimeoutMs: 5, maxConcurrentReads: 1,
    observePolicy: () => new Promise(() => {}) });
  const result = await host.read(fixture(), readRequest());
  assert.equal(result.channel, 'transport_failure');
  assert.equal(result.envelope, null);
  assert.equal((await host.read(fixture(), readRequest())).channel, 'transport_failure');
  let cancelled = false;
  const server = createKDNAServer({ requestTimeoutMs: 5 });
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  const response = await server.handle(new Request('http://localhost/api/kdna/read', { method: 'POST', body: stalled, duplex: 'half' }));
  assert.equal(response.status, 408); assert.equal(cancelled, false); assert.equal(stalled.locked, false);
  const throwing = new ReadableStream({ pull() { throw new Error('PRIVATE_STREAM_SECRET'); } });
  const error = await server.handle(new Request('http://localhost/api/kdna/read', { method: 'POST', body: throwing, duplex: 'half' }));
  assert.equal(error.status, 500); assert.doesNotMatch(await error.text(), /PRIVATE_/);
  assert.equal(throwing.locked, false);
});

test('native FormData limit rejection completes the child process without asynchronous cancellation failure', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createKDNAServer } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(${JSON.stringify(fixture().toString('base64'))}, 'base64')]), 'e.kdna');
    form.append('request', '{}');
    const request = new Request('http://e.invalid/api/kdna/read', { method: 'POST', body: form });
    const response = await createKDNAServer({ maxRequestBytes: 100 }).handle(request);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: { code: 'HOST_INPUT_TOO_LARGE' } });
    assert.equal(request.body.locked, false);
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log('SURVIVED_413');
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, ''); assert.match(result.stdout, /SURVIVED_413/);
});

test('the same native FormData is accepted below and at the byte limit and rejected above it', async () => {
  const bytes = fixture();
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'asset.kdna'); form.append('request', JSON.stringify(readRequest()));
  const makeRequest = () => new Request('http://localhost/api/kdna/read', { method: 'POST', body: form });
  const length = (await makeRequest().arrayBuffer()).byteLength;
  for (const spare of [1, 0, -1]) {
    let observed = 0;
    const server = createKDNAServer({ maxRequestBytes: length + spare,
      observePolicy: observation => { observed++; return allowAll(observation); } });
    const request = makeRequest(); const response = await server.handle(request);
    assert.equal(response.status, spare < 0 ? 413 : 200);
    if (spare < 0) {
      assert.deepEqual(await response.json(), { error: { code: 'HOST_INPUT_TOO_LARGE' } });
      assert.equal(observed, 0);
    } else {
      assert.equal((await response.json()).receipt.delivery, 'delivered'); assert.equal(observed, 2);
    }
    assert.equal(request.body.locked, false);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
});

test('declared overflow does not acquire or pull the body and timeout releases a pending read', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const declared = new Request('http://localhost/api/kdna/read', { method: 'POST', body, duplex: 'half',
    headers: { 'content-length': '101' } });
  const response = await createKDNAServer({ maxRequestBytes: 100 }).handle(declared);
  assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'HOST_INPUT_TOO_LARGE');
  assert.equal(pulls, 0); assert.equal(cancelled, false); assert.equal(body.locked, false);

  let controller, pendingPulls = 0;
  const pending = new ReadableStream({ start(c) { controller = c; }, pull() { pendingPulls++; } }, { highWaterMark: 0 });
  const request = new Request('http://localhost/api/kdna/read', { method: 'POST', body: pending, duplex: 'half' });
  const timeout = await createKDNAServer({ requestTimeoutMs: 5 }).handle(request);
  assert.equal(timeout.status, 408); assert.equal((await timeout.json()).error.code, 'HOST_REQUEST_TIMEOUT');
  assert.equal(pending.locked, false); assert.equal(pendingPulls, 1);
  controller.enqueue(new Uint8Array([1])); controller.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pendingPulls, 1);
  const owner = pending.getReader();
  assert.deepEqual((await owner.read()).value, new Uint8Array([1]));
  assert.equal((await owner.read()).done, true); owner.releaseLock();
});

test('Next FormData and Express network overflow retain 413 and release their handlers', async () => {
  const source = upload('read', fixture());
  const nextRequest = upload('read', fixture());
  const nextResponse = await createNextHandlers({ maxRequestBytes: 100 }).POST(nextRequest, { params: { route: ['read'] } });
  assert.equal(nextResponse.status, 413);
  assert.equal((await nextResponse.json()).error.code, 'HOST_INPUT_TOO_LARGE');
  assert.equal(nextRequest.body.locked, false);
  const router = createKDNARouter({ maxRequestBytes: 100 });
  let finished;
  const completed = new Promise(resolve => { finished = resolve; });
  const listener = createServer(async (req, res) => { await router(req, res); finished(); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/read`, {
      method: 'POST', body: source.body, duplex: 'half', headers: source.headers,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'HOST_INPUT_TOO_LARGE');
    await completed;
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
});
