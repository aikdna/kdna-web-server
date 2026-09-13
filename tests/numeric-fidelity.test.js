import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitNode } from '@aikdna/kdna-core/node';
import { admitReadRequest } from '@aikdna/kdna-read';
import { createTrustedReadControlProvider } from '@aikdna/kdna-read/embedding';
import { createReferenceHost, createKDNAServer } from '../src/index.js';
import { payloadFor, zip, readRequest, allowAll, upload } from './fixture.js';

// Test-only encoder constructs exact CBOR tokens; it never decodes a runtime input.
class IntegerToken { constructor(value) { this.value = value; } }
class FloatToken { constructor(value) { this.value = value; } }
function head(major, value) {
  const n = BigInt(value);
  if (n < 24n) return Buffer.from([(major << 5) | Number(n)]);
  if (n <= 255n) return Buffer.from([(major << 5) | 24, Number(n)]);
  if (n <= 65535n) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(Number(n), 1); return b; }
  if (n <= 4294967295n) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(Number(n), 1); return b; }
  const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(n, 1); return b;
}
function cbor(value) {
  if (value instanceof IntegerToken) return value.value >= 0n ? head(0, value.value) : head(1, -1n - value.value);
  if (value instanceof FloatToken) { const b = Buffer.alloc(9); b[0] = 0xfb; b.writeDoubleBE(value.value, 1); return b; }
  if (typeof value === 'number') return Number.isSafeInteger(value)
    ? cbor(new IntegerToken(BigInt(value))) : cbor(new FloatToken(value));
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  return Buffer.concat([head(5, Object.keys(value).length),
    ...Object.entries(value).flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
}
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function numberFixture(token, mutate = () => {}, manifestChange = () => {}, extra = []) {
  const payload = payloadFor();
  payload.judgments[0].result_contract.shape.scalar_type = 'number';
  payload.judgments[0].result_contract.allowed_result_types = [{ term: 'result.type.number' }];
  payload.judgments[0].result.result_type.term = 'result.type.number';
  payload.judgments[0].result.value = { kind: 'number', value: token };
  mutate(payload);
  const manifest = { format_version: '0.2.0', asset_id: payload.asset.asset_id, asset_uid: 'asset:numeric-test',
    asset_type: 'fixture', title: 'Host numeric fixture', version: '1.0.0', judgment_version: '1.0.0',
    created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z',
    compatibility: { min_loader_version: '0.23.0', profile: 'kdna.payload.judgment', profile_version: '0.2.0' },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    runtime: { mandatory_entries: ['payload.kdnab'] }, access: 'public' };
  manifestChange(manifest);
  const entries = [['mimetype', Buffer.from('application/vnd.kdna.asset')],
    ['kdna.json', Buffer.from(JSON.stringify(manifest))], ['payload.kdnab', cbor(payload)], ...extra];
  return { bytes: zip(entries), entries, manifest };
}
function word(value, width) {
  const b = Buffer.alloc(width);
  if (width === 4) b.writeUInt32BE(value); else b.writeBigUInt64BE(BigInt(value));
  return b;
}
// Independent framing from the fixed public content-tree/runtime-entry-set contracts.
// These are digest preimages for known authored entries, not a second container parser.
function expectedDigests(fixture) {
  const sorted = [...fixture.entries].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const content = [Buffer.from('KDNA-CONTENT-TREE\0' + '0.2.0\0'), word(sorted.length, 4)];
  for (const [name, raw] of sorted) {
    const json = name.endsWith('.json');
    const data = json ? Buffer.from(canonical(JSON.parse(raw))) : raw;
    const bytes = Buffer.from(name);
    content.push(word(bytes.length, 4), bytes, Buffer.from([json ? 0 : 1]), word(data.length, 8), data);
  }
  const runtimeEntries = sorted.filter(([name]) => name !== 'mimetype');
  const runtime = [Buffer.from('KDNA-RUNTIME-ENTRY-SET\0' + '0.2.0\0'), word(runtimeEntries.length, 4)];
  for (const [name, data] of runtimeEntries) {
    const bytes = Buffer.from(name); runtime.push(word(bytes.length, 4), bytes, word(data.length, 8), data);
  }
  return { A: hash(fixture.bytes), C: hash(Buffer.concat(content)), E: hash(Buffer.concat(runtime)) };
}
const observations = [];
function record(value) {
  observations.push(value);
  if (process.env.KDNA_HOST_EVIDENCE) {
    fs.mkdirSync(process.env.KDNA_HOST_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(process.env.KDNA_HOST_EVIDENCE, 'numeric-fidelity.json'), JSON.stringify(observations, null, 2));
  }
}

test('uint64 4294967296 and exact larger integers equal float IR with distinct correct A/C/E', async () => {
  const values = [4294967296n, -4294967296n, 9007199254740991n, -9007199254740991n,
    9007199254740992n, -9007199254740992n, 9007199254740994n, -9007199254740994n,
    9223372036854775808n, -9223372036854775808n, 18446744073709549568n, -18446744073709551616n];
  const host = createReferenceHost({ observePolicy: allowAll });
  for (const value of values) {
    assert.equal(BigInt(Number(value)), value, 'The authored integer itself must be exactly representable');
    const pair = [numberFixture(new IntegerToken(value)), numberFixture(new FloatToken(Number(value)))];
    const results = [];
    for (const fixture of pair) {
      const admitted = await admitNode(fixture.bytes);
      assert.equal(admitted.status, 'accepted', `${value}: ${JSON.stringify(admitted)}`);
      const expected = expectedDigests(fixture);
      for (const key of ['A', 'C', 'E']) assert.equal(admitted.snapshot.digests[key].observed, expected[key]);
      assert.equal(admitted.snapshot.ir_digest, hash(Buffer.from(canonical(admitted.snapshot.ir))));
      const result = await host.read(fixture.bytes, readRequest());
      assert.equal(result.envelope.status, 'ready');
      assert.equal(result.envelope.content.closure.find(n => n.role === 'result').value.value.value, Number(value));
      assert.equal(result.envelope.states.action_authorization, 'not_evaluated');
      results.push(admitted.snapshot);
    }
    assert.deepEqual(results[0].ir, results[1].ir);
    assert.equal(results[0].ir_digest, results[1].ir_digest);
    for (const key of ['A', 'C', 'E']) assert.notEqual(results[0].digests[key].observed, results[1].digests[key].observed);
    record({ value_decimal: value.toString(), expected_number: Number(value), equal_ir: true,
      ir_digest: results[0].ir_digest, representations: pair.map((f, i) => ({ encoding: i ? 'float64' : 'integer',
        bytes: f.bytes.length, container_base64: f.bytes.toString('base64'), digests: results[i].digests })) });
  }
});

test('inexact integer tokens reject before Host and are never silently rounded', async () => {
  for (const value of [9007199254740993n, -9007199254740993n, -9007199254740995n,
    18446744073709551615n, -18446744073709551615n]) {
    let called = 0;
    const fixture = numberFixture(new IntegerToken(value));
    const host = createReferenceHost({ observePolicy: o => { called++; return allowAll(o); } });
    const result = await host.read(fixture.bytes, readRequest());
    assert.equal(result.envelope.diagnostics[0].code, 'READ_CORE_INVALID');
    assert.equal(result.envelope.content, null); assert.equal(called, 0);
    record({ rejected_integer: value.toString(), container_base64: fixture.bytes.toString('base64'), result });
  }
});

test('UInt still admits zero and maximum safe integer but rejects negatives and 2^53', async () => {
  for (const [field, value, accepted] of [['minimum', 0n, true], ['maximum', 9007199254740991n, true],
    ['maximum', 9007199254740992n, false], ['minimum', -1n, false]]) {
    const fixture = numberFixture(new IntegerToken(1n), p => {
      p.judgments[0].result_contract.minimum = 0;
      p.judgments[0].result_contract[field] = new IntegerToken(value);
    });
    const result = await admitNode(fixture.bytes);
    assert.equal(result.status, accepted ? 'accepted' : 'rejected');
    record({ uint_field: field, uint_value: value.toString(), expected_accepted: accepted, result: result.status,
      reason: result.reason ?? null });
  }
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: 4096 }));
  for (const budget_bytes of [0, Number.MAX_SAFE_INTEGER]) assert.equal(admitReadRequest(readRequest({ budget_bytes }), control).channel, 'admitted_request');
  for (const budget_bytes of [-1, 2 ** 53]) assert.equal(admitReadRequest(readRequest({ budget_bytes }), control).channel, 'admission_rejection');
});

test('new RC still rejects malformed containers and unsupported cryptographic capabilities', async () => {
  const normal = numberFixture(new IntegerToken(4294967296n));
  const crc = Buffer.from(normal.bytes); crc[45] ^= 1;
  const cases = [
    ['truncated', normal.bytes.subarray(0, normal.bytes.length - 1), 'READ_CORE_INVALID'],
    ['crc', crc, 'READ_CORE_INVALID'],
    ['signature', numberFixture(new IntegerToken(1n), undefined, undefined,
      [['signature.kdsig', Buffer.from('synthetic-signature')]]).bytes, 'READ_CORE_CAPABILITY_UNAVAILABLE'],
    ['checksums', numberFixture(new IntegerToken(1n), undefined, undefined,
      [['checksums.json', Buffer.from('{}')]]).bytes, 'READ_CORE_CAPABILITY_UNAVAILABLE'],
    ['encrypted', numberFixture(new IntegerToken(1n), undefined, m => {
      m.payload.encrypted = true;
      m.encryption = { profile: 'encryption:unavailable', profile_version: '1.0.0', encrypted_entries: ['payload.kdnab'] };
    }).bytes, 'READ_CORE_CAPABILITY_UNAVAILABLE'],
  ];
  for (const [name, bytes, expected] of cases) {
    let observed = 0;
    const host = createReferenceHost({ observePolicy: o => { observed++; return allowAll(o); } });
    const result = await host.read(bytes, readRequest());
    assert.equal(result.envelope.diagnostics[0].code, expected, name);
    assert.equal(result.envelope.content, null); assert.equal(observed, 0);
    record({ container_case: name, result });
  }
  const server = createKDNAServer({ observePolicy: allowAll });
  const response = await server.handle(upload('read', normal.bytes));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content.closure.find(n => n.role === 'result').value.value.value, 4294967296);
  const health = await server.handle(new Request('http://localhost/api/kdna'));
  assert.equal((await health.json()).browser, 'NOT_EXPOSED_BY_SERVER_HOST');
});
