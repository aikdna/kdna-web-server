import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { selectKDNA, createKDNAWebClient, releaseKDNASelection } from '@aikdna/kdna-web-client';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
function record(name, value) { if (!process.env.KDNA_EVIDENCE_DIR) return;
  mkdirSync(process.env.KDNA_EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.KDNA_EVIDENCE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n'); }

import { createReferenceHost, createKDNAServer, handleKDNARequest } from '@aikdna/kdna-web-server';
import { createKDNARouter } from '@aikdna/kdna-web-server/express';
import { createNextHandlers } from '@aikdna/kdna-web-server/nextjs';
import { config, context, settings, optionalFixture, mandatoryFixture, readRequest, allowAll, upload, tick, delay, deferred } from './hrsp01-fixtures.mjs';
const bytes = optionalFixture();
function host(options = {}) { return createReferenceHost({ retainedSession: config(), observePolicy: allowAll, ...options }); }
const request = (id, extra = {}) => readRequest({ request_id: id, ...extra });
const ready = result => { assert.equal(result.channel, 'read_envelope'); assert.equal(result.envelope.status, 'ready'); return result.envelope; };
const code = result => result.envelope?.diagnostics[0]?.code ?? result.admission_rejection?.code ?? result.transport_failure?.code ?? result.control?.code;
function closed(h, active = 0) { const s = h.retentionState(); assert.equal(s.state, 'closed'); assert.equal(s.active_reads, active);
  assert.equal(s.retained_container_bytes, 0); assert.equal(s.retained_view_charge_bytes, 0);
  if (!active) { assert.equal(s.issued_handle_records, 0); assert.equal(s.issued_handle_charge_bytes, 0); } }

test('configuration is closed, bounded, validates Identifier and does not grant permission', async () => {
  for (const value of [null, true, [], {}, config({ extra: 1 }), config({ binding_id: '' }), config({ binding_id: '\uD800' }),
    config({ authorization_domain_id: 'x\u0080' }), config({ ttlMs: 0 }), config({ ttlMs: 300001 }),
    config({ maxReads: 17 }), config({ maxHandleRecords: 257 }), config({ maxRetainedViewBytes: 16777217 }),
    config({ maxRetainedContainerBytes: 10485761 }), config({ maxHandleRecordBytes: 1048577 }),
    config({ binding_id: 'é'.repeat(129) }), config({ binding_id: '😀'.repeat(65) })]) {
    assert.throws(() => host({ retainedSession: value }), TypeError);
  }
  for (const o of [{ maxInputBytes: 10485761 }, { maxResponseBytes: 1048577 }, { admissionResponseBytes: 4097 },
    { maxConcurrentReads: 2 }, { policyTimeoutMs: 30001 }]) assert.throws(() => host(o), TypeError);
  for (const o of [{ maxRequestBytes: 12582913 }, { maxRequestJsonBytes: 65537 }]) {
    assert.throws(() => createKDNAServer({ retainedSession: config(), ...o }), TypeError);
  }
  for (const binding_id of ['é'.repeat(128), '😀'.repeat(64)]) host({ retainedSession: config({ binding_id }) }).dispose();
  const h = createReferenceHost({ retainedSession: config() });
  assert.equal(code(await h.read(bytes, request('default-deny'), settings)), 'READ_HOST_DENIED'); closed(h);
});

test('default off, Next rejection, helper rejection and missing trusted confirmation remain explicit', async () => {
  const off = createReferenceHost({ retainedSession: false, observePolicy: allowAll });
  ready(await off.read(bytes, request('off'))); assert.equal(off.retentionState().state, 'disabled'); off.dispose();
  assert.throws(() => createNextHandlers({ retainedSession: config() }), { code: 'HOST_RETAINED_DELIVERY_UNSUPPORTED' });
  assert.equal(typeof createNextHandlers({ retainedSession: false }).POST, 'function');
  await assert.rejects(handleKDNARequest(upload('read', bytes), { retainedSession: config() }), { code: 'HOST_RETAINED_INSTANCE_REQUIRED' });
  const h = host(); await assert.rejects(h.read(bytes, request('missing')), { code: 'HOST_DELIVERY_CONFIRMATION_REQUIRED' });
  assert.equal(h.retentionState().state, 'unbound'); h.dispose(); closed(h);
  const s = createKDNAServer({ retainedSession: config(), observePolicy: allowAll });
  assert.equal((await (await s.handle(upload('read', bytes))).json()).error.code, 'HOST_DELIVERY_CONFIRMATION_REQUIRED'); s.dispose();
});

test('only formal success after confirmation activates; same handle supports repeated fresh admitted IDs', async () => {
  let viewCharge = 0;
  const h = host({ observePolicy: o => { viewCharge = Buffer.byteLength(JSON.stringify(o.snapshot)); return allowAll(o); } });
  const gate = deferred(); let prepared;
  const first = h.read(bytes, request('first'), { context, deliverResponse: value => { prepared = value; return gate.promise; } });
  while (!prepared) await tick();
  assert.equal(h.retentionState().state, 'delivering'); assert.equal(h.retentionState().issued_handle_records, 0);
  gate.resolve(true); const one = ready(await first); const handle = one.content.expansion_handles[0];
  assert.ok(handle); assert.equal(h.retentionState().state, 'active');
  assert.equal(h.retentionState().issued_handle_records, 2);
  assert.equal(h.retentionState().issued_handle_charge_bytes,
    one.content.expansion_handles.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x)), 0));
  for (const id of ['expand:1', 'expand:2']) {
    const two = ready(await h.read(new Uint8Array(bytes), request(id, { mode: 'expand', handle }), settings));
    assert.equal(two.snapshot_id, one.snapshot_id);
    assert.ok(JSON.stringify(two.content).includes('RESULT_SENTINEL_1'));
    assert.deepEqual(two.digests, one.digests);
  }
  const summary = h.retentionState(); assert.ok(Object.isFrozen(summary));
  assert.deepEqual(Object.keys(summary).sort(), ['active_reads','consumed_request_ids','issued_handle_charge_bytes','issued_handle_records','retained_container_bytes','retained_view_charge_bytes','state']);
  assert.equal(summary.consumed_request_ids, 3); assert.equal(summary.retained_container_bytes, bytes.length);
  assert.equal(summary.retained_view_charge_bytes, viewCharge); h.dispose(); h.dispose(); closed(h);
});

test('duplicate IDs use Read transport failure without denial latch; earlier invalid request and forged handle keep precedence', async () => {
  const h = host(); const first = ready(await h.read(bytes, request('id:one'), settings)); const handle = first.content.expansion_handles[0];
  const duplicate = await h.read(bytes, request('id:one'), settings);
  assert.equal(duplicate.channel, 'transport_failure'); assert.equal(code(duplicate), 'READ_TRANSPORT_FAILURE');
  assert.equal(duplicate.transport_failure.semantic_cause, null); assert.equal(h.retentionState().state, 'active');
  const malformed = await h.read(bytes, { ...request('id:bad'), extra: true }, settings);
  assert.notEqual(code(malformed), 'READ_TRANSPORT_FAILURE'); assert.equal(h.retentionState().consumed_request_ids, 1);
  const forged = await h.read(bytes, request('id:one', { mode: 'expand', handle: { ...handle, host_epoch: 'forged' } }), settings);
  assert.equal(code(forged), 'READ_HANDLE_UNTRUSTED'); assert.equal(h.retentionState().consumed_request_ids, 1);
  ready(await h.read(bytes, request('id:bad', { mode: 'expand', handle }), settings)); h.dispose();
});

test('different bytes and foreign context cannot replace or close the valid bound session', async () => {
  const h = host(); const first = ready(await h.read(bytes, request('bound'), settings));
  const changed = new Uint8Array(bytes); changed[0] ^= 1;
  changed.some = () => false; Object.defineProperty(changed, 'byteLength', { value: 1 });
  await assert.rejects(h.read(changed, request('changed'), settings), { code: 'HOST_RETAINED_INPUT_MISMATCH' });
  await assert.rejects(h.read(bytes, request('foreign'), { ...settings, context: { session_id: 'binding:test' } }), { code: 'HOST_CONTEXT_UNVERIFIED' });
  assert.equal(h.retentionState().state, 'active'); assert.equal(h.retentionState().consumed_request_ids, 1);
  assert.equal(ready(await h.read(bytes, request('again'), settings)).snapshot_id, first.snapshot_id); h.dispose();
});

test('fresh Host incarnation cannot reuse another provider handle and receives a fresh epoch', async () => {
  const a = host(), b = host(); const aa = ready(await a.read(bytes, request('a'), settings));
  const bb = ready(await b.read(bytes, request('b'), settings)); assert.notEqual(aa.receipt.host_epoch, bb.receipt.host_epoch);
  const result = await b.read(bytes, request('foreign-handle', { mode: 'expand', handle: aa.content.expansion_handles[0] }), settings);
  assert.equal(code(result), 'READ_HANDLE_UNTRUSTED'); a.dispose(); b.dispose();
});

test('policy epoch changes, explicit bound revocation and trusted clock faults close terminally', async () => {
  for (const kind of ['epoch', 'revoked', 'rollback', 'invalid', 'expiry']) {
    let epoch = 'epoch:1', revoked = false, now = 200000;
    const h = host({ clock: () => now, observePolicy: o => ({ ...allowAll(o), epoch, revoked }) });
    ready(await h.read(bytes, request(kind + ':first'), settings));
    if (kind === 'epoch') epoch = 'epoch:2'; if (kind === 'revoked') revoked = true;
    if (kind === 'rollback') now--; if (kind === 'invalid') now = NaN; if (kind === 'expiry') now += 30000;
    const result = await h.read(bytes, request(kind + ':second'), settings).catch(e => e);
    assert.notEqual(result.envelope?.status, 'ready'); closed(h);
    await assert.rejects(h.read(bytes, request('closed'), settings), { code: 'HOST_SESSION_CLOSED' });
  }
});

test('trusted context invalidation and epoch change around delivery prevent commit', async () => {
  for (const kind of ['binding', 'epoch']) {
    let valid = true, epoch = 'epoch:1';
    const h = host({ retainedSession: config({ verifyContext: x => x === context && valid }),
      observePolicy: o => ({ ...allowAll(o), epoch }) });
    const result = await h.read(bytes, request(kind), { context, deliverResponse: () => { if (kind === 'binding') valid = false; else epoch = 'epoch:2'; return true; } });
    assert.equal(result.channel, 'transport_failure'); closed(h);
  }
});

test('monotonic absolute TTL and independent policy expiry are bounded and not renewed', async () => {
  let now = 100000;
  const h = host({ clock: () => now, retainedSession: config({ ttlMs: 100 }) });
  const one = ready(await h.read(bytes, request('ttl:first'), settings));
  assert.ok(one.content.expansion_handles.every(x => x.expires_at <= 100100));
  await delay(45); ready(await h.read(bytes, request('ttl:second'), settings));
  await delay(65); closed(h);
  const p = host({ clock: () => now, observePolicy: o => ({ ...allowAll(o), expiresAt: now + 35 }) });
  const two = ready(await p.read(bytes, request('policy:expiry'), settings));
  assert.ok(two.content.expansion_handles.every(x => x.expires_at <= 100035));
  await delay(45); closed(p);
});

test('failed delivery, callback exception and handle accounting caps never commit issuance', async () => {
  for (const mode of ['false', 'throw', 'records', 'record-bytes', 'view']) {
    let deliveries = 0;
    const overrides = mode === 'records' ? { maxHandleRecords: 1 } : mode === 'record-bytes' ? { maxHandleRecordBytes: 1 }
      : mode === 'view' ? { maxRetainedViewBytes: 1 } : {};
    const h = host({ retainedSession: config(overrides) });
    const result = await h.read(bytes, request(mode), { context, deliverResponse: () => { deliveries++;
      if (mode === 'throw') throw new Error('PRIVATE_CALLBACK_DETAIL'); return mode !== 'false'; } });
    assert.equal(result.channel, 'transport_failure'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CALLBACK_DETAIL/);
    if (['records', 'record-bytes', 'view'].includes(mode)) assert.equal(deliveries, 0); closed(h);
  }
});

test('read attempts include rejects and busy calls, use existing lower Host maximum, never reset', async () => {
  const h = host({ maxReads: 2 });
  await assert.rejects(h.read(bytes, request('bad'), { ...settings, context: {} }), { code: 'HOST_CONTEXT_UNVERIFIED' });
  ready(await h.read(bytes, request('ok'), settings));
  await assert.rejects(h.read(bytes, request('exhausted'), settings), { code: 'HOST_SESSION_EXHAUSTED' }); closed(h);
  const b = host({ retainedSession: config({ maxReads: 2 }) }); const gate = deferred(); let started = false;
  const pending = b.read(bytes, request('pending'), { context, deliverResponse: () => { started = true; return gate.promise; } });
  while (!started) await tick(); await assert.rejects(b.read(bytes, request('busy'), settings), { code: 'HOST_BUSY' });
  gate.resolve(true); ready(await pending);
  await assert.rejects(b.read(bytes, request('exhausted'), settings), { code: 'HOST_SESSION_EXHAUSTED' }); closed(b);
});

test('noncooperative verification, policy, and delivery stay charged after timeout and cannot commit late', async () => {
  for (const kind of ['verify', 'policy', 'delivery']) {
    const gate = deferred(); let entered = false, calls = 0;
    const wait = () => { entered = true; return gate.promise; };
    const h = host({ policyTimeoutMs: 30,
      retainedSession: config({ verifyContext: kind === 'verify' ? wait : value => value === context }),
      observePolicy: kind === 'policy' ? async o => { await wait(); return allowAll(o); } : allowAll });
    const result = h.read(bytes, request(kind), { context, deliverResponse: kind === 'delivery' ? wait : () => { calls++; return true; } });
    while (!entered) await tick();
    if (kind === 'delivery') assert.equal((await result).channel, 'transport_failure');
    else await assert.rejects(result, { code: 'HOST_SESSION_CLOSED' });
    closed(h, 1);
    await assert.rejects(h.read(bytes, request('after-timeout'), settings), { code: 'HOST_SESSION_CLOSED' });
    gate.resolve(true); for (let i = 0; i < 20 && h.retentionState().active_reads; i++) await tick();
    closed(h); assert.equal(calls, 0);
  }
});

test('dispose during unresolved delivery invalidates immediately and preserves pending charge until settlement', async () => {
  const h = host(); const gate = deferred(); let started = false;
  const pending = h.read(bytes, request('dispose'), { context, deliverResponse: () => { started = true; return gate.promise; } });
  while (!started) await tick(); h.dispose(); closed(h, 1);
  assert.equal((await pending).channel, 'transport_failure'); gate.resolve(true);
  for (let i = 0; i < 20 && h.retentionState().active_reads; i++) await tick(); closed(h);
});

test('public Read mandatory support and budget failure retain their semantics', async () => {
  const h = host(); const mandatory = mandatoryFixture(); const value = ready(await h.read(mandatory, request('mandatory'), settings));
  assert.ok(JSON.stringify(value.content.closure).includes('RESULT_SENTINEL_1')); h.dispose();
  const b = host(); const zero = await b.read(bytes, request('zero', { budget_bytes: 0 }), settings);
  assert.equal(zero.channel, 'no_body_control'); closed(b);
});

async function network(t, options = {}) {
  const middleware = createKDNARouter({ retainedSession: config(), observePolicy: allowAll, getContext: () => context, ...options });
  const server = http.createServer((req, res) => middleware(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { middleware.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    record(t.name.replace(/[^a-zA-Z0-9]+/g, '-'), { pid: process.pid, node: process.version, port, listenerClosed: !server.listening, state: middleware.retentionState() }); });
  const port = server.address().port;
  async function send(id, extra = {}) {
    const request = upload('read', bytes, readRequest({ request_id: id, ...extra }));
    return fetch(`http://127.0.0.1:${port}/read`, { method: 'POST', headers: request.headers, body: request.body, duplex: 'half' });
  }
  return { middleware, server, port, send };
}

test('actual Node/Express finish commits two HTTP expand calls, repeated handle and duplicate control correctly', async t => {
  const n = await network(t); const first = await n.send('http:first'); assert.equal(first.status, 200);
  const one = await first.json(); const handle = one.content.expansion_handles[0];
  assert.equal(n.middleware.retentionState().state, 'active');
  for (const id of ['http:expand1','http:expand2']) {
    const response = await n.send(id, { mode: 'expand', handle }); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.snapshot_id, one.snapshot_id);
    assert.ok(JSON.stringify(value.content).includes('RESULT_SENTINEL_1'));
  }
  const duplicate = await n.send('http:expand2', { mode: 'expand', handle });
  assert.equal(duplicate.status, 502); assert.equal(await duplicate.text(), '');
  assert.equal(duplicate.headers.get('x-kdna-code'), 'READ_TRANSPORT_FAILURE');
  assert.equal((await n.send('http:fresh', { mode: 'expand', handle })).status, 200);
});

test('actual client close before delayed policy completion closes retained Host with late-result suppression', async t => {
  const gate = deferred(); let observed = false;
  const n = await network(t, { observePolicy: async o => { observed = true; await gate.promise; return allowAll(o); } });
  const request = upload('read', bytes, readRequest({ request_id: 'disconnect' })); const body = Buffer.from(await request.arrayBuffer());
  const client = http.request({ host: '127.0.0.1', port: n.port, path: '/read', method: 'POST', headers: Object.fromEntries(request.headers) });
  client.on('error', () => {}); client.end(body); while (!observed) await tick(); client.destroy();
  for (let i = 0; i < 30 && n.middleware.retentionState().state !== 'closed'; i++) await tick();
  closed(n.middleware, 1); gate.resolve(true);
  for (let i = 0; i < 30 && n.middleware.retentionState().active_reads; i++) await tick(); closed(n.middleware);
});

class FakeResponse extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.destroyed = false; this.writableEnded = false; this.writableFinished = false; this.headersSent = false; }
  setHeader() {}
  end() { this.headersSent = true; this.writableEnded = true;
    if (this.mode === 'finish') { this.writableFinished = true; this.emit('finish'); }
    else if (this.mode === 'close') this.emit('close'); else if (this.mode === 'error') this.emit('error', new Error('private')); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
test('Express finish/close/error/timeout listener ownership: write/end alone is insufficient', async () => {
  for (const mode of ['finish','close','error','timeout']) {
    const middleware = createKDNARouter({ retainedSession: config(), observePolicy: allowAll, getContext: () => context, deliveryTimeoutMs: 20 });
    const input = upload('read', bytes, request('event:'+mode));
    const req = Readable.from([Buffer.from(await input.arrayBuffer())]); req.method = 'POST'; req.url = '/read'; req.headers = Object.fromEntries(input.headers);
    const res = new FakeResponse(mode); await middleware(req, res);
    if (mode === 'finish') assert.equal(middleware.retentionState().state, 'active');
    else { assert.equal(middleware.retentionState().state, 'closed');
      for (let i = 0; i < 20 && middleware.retentionState().active_reads; i++) await tick(); closed(middleware); }
    for (const event of ['finish','close','error']) assert.equal(res.listenerCount(event), 0);
    assert.equal(req.listenerCount('aborted'), 0); middleware.dispose();
  }
});


test('retained denial latch is owned by original Read and only explicit policy lift changes it', async () => {
  let decision = 'allow', lift = false;
  const h = host({ observePolicy: o => ({ ...allowAll(o), decision, liftDenial: lift }) });
  ready(await h.read(bytes, request('latch:ready'), settings)); decision = 'deny';
  assert.equal(code(await h.read(bytes, request('latch:denied'), settings)), 'READ_HOST_DENIED');
  decision = 'allow';
  assert.equal(code(await h.read(bytes, request('latch:still'), settings)), 'READ_HOST_DENIED');
  lift = true; ready(await h.read(bytes, request('latch:lift'), settings)); h.dispose();
});

test('foreign pre-verification abort and context callback rejection preserve active binding', async () => {
  const gate = deferred(); let useGate = false;
  const h = host({ retainedSession: config({ verifyContext: value => useGate ? gate.promise : value === context }) });
  ready(await h.read(bytes, request('context:first'), settings)); useGate = true;
  const controller = new AbortController();
  const pending = h.read(bytes, request('context:aborted'), { ...settings, context: {}, signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(pending, { code: 'HOST_REQUEST_ABORTED' });
  assert.equal(h.retentionState().state, 'active'); assert.equal(h.retentionState().active_reads, 1);
  gate.resolve(false); for (let i = 0; i < 20 && h.retentionState().active_reads; i++) await tick();
  assert.equal(h.retentionState().active_reads, 0); assert.equal(h.retentionState().state, 'active');
  useGate = false; ready(await h.read(bytes, request('context:after'), settings)); h.dispose();
  const throwing = host({ retainedSession: config({ verifyContext: () => { throw new Error('PRIVATE_VERIFY'); } }) });
  await assert.rejects(throwing.read(bytes, request('context:throw'), settings), { code: 'HOST_CONTEXT_UNVERIFIED' });
  assert.equal(throwing.retentionState().state, 'unbound'); throwing.dispose();
});

test('exact unchanged Web Client consumes real first HTTP read and two fresh expand requests', async t => {
  const n = await network(t); const selected = await selectKDNA(bytes); assert.equal(selected.status, 'selected');
  const endpointUrl = `http://127.0.0.1:${n.port}/read`, endpointId = 'endpoint:hrsp01', sessionId = 'association-only';
  const client = createKDNAWebClient({ endpointUrl, endpointId, sessionId });
  const selection = selected.selection; const results = []; let snapshotId = null, handle = null;
  try {
    for (let i = 0; i < 3; i++) {
      const id = `client:${i}`, now = Date.now();
      const candidate = request(id, i ? { mode: 'expand', handle } : {});
      const transport = { association_id: `association:${i}`, endpoint_id: endpointId, session_id: sessionId,
        endpoint_url: endpointUrl, issued_at_ms: now, expires_at_ms: now + 30000,
        outbound_request_json: JSON.stringify(candidate), correlation: { state: 'validated', request_id: id },
        expected_tuple: selection.tuple, expected_asset: selection.asset,
        expected_digests: { A: selection.digests.A.observed, C: selection.digests.C.observed, E: selection.digests.E.observed },
        expected_snapshot_id: snapshotId, max_response_bytes: 1048576, max_read_ms: 5000, admission_response_limit_bytes: 4096 };
      const result = await client.read(selection, transport); results.push({ transport, result });
      assert.equal(result.status, 'received', JSON.stringify(result));
      assert.equal(result.view.response.channel, 'read_envelope'); assert.equal(result.view.response.body.status, 'ready');
      const body = result.view.response.body;
      if (i === 0) { snapshotId = body.snapshot_id; handle = body.content.expansion_handles[0]; assert.ok(handle); }
      else { assert.equal(body.snapshot_id, snapshotId); assert.ok(JSON.stringify(body.content).includes('RESULT_SENTINEL_1')); }
      assert.equal(result.view.proof_limits.remote_authorization, 'NOT_PROVEN');
      assert.equal(result.view.capabilities.core_snapshot, false);
    }
    record('web-client-two-expand-http', { port: n.port, results, state: n.middleware.retentionState() });
  } finally { client.dispose(); releaseKDNASelection(selection); }
});

test('Express noncooperative context acquisition is inside the charged call and rejects without unhandled errors', async t => {
  const gate = deferred(); let started = false;
  const n = await network(t, { policyTimeoutMs: 25, getContext: () => { started = true; return gate.promise; } });
  const pending = n.send('context:never'); while (!started) await tick();
  const response = await pending; assert.equal(response.status, 410); closed(n.middleware, 1);
  gate.resolve(context); for (let i = 0; i < 20 && n.middleware.retentionState().active_reads; i++) await tick(); closed(n.middleware);
});


test('timeout during rejected-result delivery preserves the earlier formal diagnostic through Read', async () => {
  const h = host({ policyTimeoutMs: 25 }); const gate = deferred();
  const result = await h.read(bytes, { ...request('invalid-delivery'), extra: true }, { context, deliverResponse: () => gate.promise });
  assert.equal(result.channel, 'transport_failure'); assert.equal(result.transport_failure.semantic_cause, 'READ_INPUT_INVALID');
  closed(h, 1); gate.resolve(true); for (let i = 0; i < 20 && h.retentionState().active_reads; i++) await tick(); closed(h);
});

test('all sixteen admitted attempts fit, seventeenth terminates; lower zero concurrency stays bounded', async () => {
  const h = host(); const first = ready(await h.read(bytes, request('capacity:0'), settings));
  const handle = first.content.expansion_handles[0];
  for (let i = 1; i < 16; i++) ready(await h.read(bytes, request('capacity:'+i, { mode: 'expand', handle }), settings));
  assert.equal(h.retentionState().consumed_request_ids, 16);
  await assert.rejects(h.read(bytes, request('capacity:16'), settings), { code: 'HOST_SESSION_EXHAUSTED' }); closed(h);
  const b = host({ maxConcurrentReads: 0 });
  await assert.rejects(b.read(bytes, request('zero-concurrency'), settings), { code: 'HOST_BUSY' }); b.dispose();
});


test('the full 256-record retained cap fits exactly and further prepared issuance closes before delivery', async () => {
  const many = optionalFixture(129); const h = host(); let delivered = 0;
  const sink = { context, deliverResponse: () => { delivered++; return true; } };
  for (let i = 0; i < 2; i++) assert.equal(ready(await h.read(many, request('records:'+i), sink)).content.expansion_handles.length, 128);
  assert.equal(h.retentionState().issued_handle_records, 256);
  const exceeded = await h.read(many, request('records:overflow'), sink);
  assert.equal(exceeded.channel, 'transport_failure'); assert.equal(delivered, 2); closed(h);
});
