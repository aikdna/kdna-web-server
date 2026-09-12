import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createReferenceHost } from '@aikdna/kdna-web-server';
import { config, context, settings, optionalFixture, readRequest, allowAll, tick, delay, deferred } from './hrsp01-fixtures.mjs';

const bytes = optionalFixture();
const request = id => readRequest({ request_id: id });
const phases = ['context', 'verify:1', 'verify:2', 'policy:1', 'verify:3', 'policy:2', 'verify:4', 'policy:3', 'sink', 'verify:5', 'policy:4'];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function closed(h, active) {
  const s = h.retentionState();
  assert.equal(s.state, 'closed'); assert.equal(s.active_reads, active);
  assert.equal(s.retained_container_bytes, 0); assert.equal(s.retained_view_charge_bytes, 0);
  if (!active) { assert.equal(s.issued_handle_records, 0); assert.equal(s.issued_handle_charge_bytes, 0); }
  return s;
}
async function bounded(promise, ms = 150) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('terminal caller did not settle within bound')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function exercise(phase, seeded, terminal = 'exhaustion', rejectLate = false) {
  const gate = deferred(), entered = deferred();
  let enabled = false, verifies = 0, policies = 0, sinks = 0;
  const history = [];
  function external(name, value) {
    if (!enabled) return value;
    history.push(name);
    if (name !== phase) return value;
    entered.resolve();
    return gate.promise.then(() => { if (rejectLate) throw new Error('PRIVATE_LATE_CALLBACK'); return value; });
  }
  const h = createReferenceHost({ policyTimeoutMs: terminal === 'timeout' ? 60 : 1000,
    retainedSession: config({ ttlMs: terminal === 'expiry' ? 90 : 30000,
      verifyContext: x => external(`verify:${++verifies}`, x === context) }),
    observePolicy: o => external(`policy:${++policies}`, allowAll(o)) });
  if (seeded) assert.equal((await h.read(bytes, request('seed'), settings)).envelope.status, 'ready');
  enabled = true; verifies = 0; policies = 0;
  const controller = new AbortController();
  const contextValue = phase === 'context' ? external('context', context) : context;
  const pending = observe(h.read(bytes, request('pending'), { context: contextValue, signal: controller.signal,
    deliverResponse: () => { sinks++; return external('sink', true); } }));
  try {
    await bounded(entered.promise, 500);
    const before = h.retentionState(); const countAtClose = history.length;
    const started = performance.now();
    if (terminal === 'exhaustion') {
      const used = seeded ? 2 : 1;
      for (let i = used; i < 16; i++) await assert.rejects(h.read(bytes, request(`busy:${i}`), settings), { code: 'HOST_BUSY' });
      await assert.rejects(h.read(bytes, request('exhaust'), settings), { code: 'HOST_SESSION_EXHAUSTED' });
    } else if (terminal === 'dispose') h.dispose();
    else if (terminal === 'abort') controller.abort();
    const settled = await bounded(pending);
    const elapsed = performance.now() - started;
    assert.notEqual(settled.value?.envelope?.status, 'ready');
    if (phase === 'context' || ['verify:1','verify:2','verify:3','policy:1','policy:2'].includes(phase)) {
      assert.equal(settled.error?.code, 'HOST_SESSION_CLOSED');
    } else assert.equal(settled.value?.channel, 'transport_failure');
    closed(h, 1); h.dispose(); h.dispose(); closed(h, 1);
    await assert.rejects(h.read(bytes, request('closed'), settings), { code: 'HOST_SESSION_CLOSED' });
    await delay(10); closed(h, 1);
    gate.resolve();
    for (let i = 0; i < 50 && h.retentionState().active_reads; i++) await tick();
    const after = closed(h, 0);
    assert.equal(history.length, countAtClose, 'no callback starts after terminal notification');
    assert.equal(after.consumed_request_ids, before.consumed_request_ids);
    assert.equal(sinks, ['sink','verify:5','policy:4'].includes(phase) ? 1 : 0);
    console.log(JSON.stringify({ terminal, phase, seeded, rejectLate, elapsed_ms: elapsed, before, after, callback_history: history, pid: process.pid }));
  } finally { gate.resolve(); h.dispose(); await pending; }
}
for (const seeded of [false, true]) for (const phase of phases) {
  test(`terminal exhaustion settles ${seeded ? 'retained' : 'first'} call during ${phase} and holds actual work`,
    () => exercise(phase, seeded));
}
for (const [terminal, phase, seeded, rejectLate] of [
  ['timeout','context',false,false], ['timeout','context',true,false],
  ['expiry','context',true,false], ['dispose','context',false,false],
  ['dispose','policy:1',true,true], ['abort','policy:1',true,false],
  ['exhaustion','sink',false,true], ['exhaustion','policy:4',true,true],
]) test(`terminal ${terminal} control ${phase} seeded=${seeded} rejection=${rejectLate}`,
  () => exercise(phase, seeded, terminal, rejectLate));
