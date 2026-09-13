import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { admitNode } from '@aikdna/kdna-core/node';
import { inspectSnapshot } from '@aikdna/kdna-core/read-boundary';
import { admitReadRequest, project } from '@aikdna/kdna-read';
import { createTrustedReadControlProvider } from '@aikdna/kdna-read/embedding';
import { createReferenceHost } from '../src/index.js';
import { fixture, readRequest, allowAll } from './fixture.js';

test('a second real Core cannot supply its private snapshot to the accepted Read instance', async () => {
  const require = createRequire(import.meta.url);
  const original = path.dirname(require.resolve('@aikdna/kdna-core/package.json'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'duplicate-core-'));
  try {
    await cp(original, path.join(root, 'core'), { recursive: true });
    // The duplicate package needs only the same fixed transitive dependency graph.
    for (const name of ['ajv', 'ajv-formats', 'cbor-x', '@noble/hashes', 'fast-deep-equal', 'fast-uri',
      'json-schema-traverse', 'require-from-string']) {
      const installed = path.join(path.dirname(path.dirname(original)), name);
      await cp(installed, path.join(root, 'node_modules', name), { recursive: true });
    }
    const duplicate = require(path.join(root, 'core/src/public-contract/node.js'));
    const admitted = await duplicate.admitNode(fixture());
    assert.equal(admitted.status, 'accepted');
    assert.equal(inspectSnapshot(admitted.snapshot), null);
    const request = admitReadRequest(readRequest(), createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: 4096 })));
    assert.equal(project(request.admitted_request, admitted.snapshot).diagnostics[0].code, 'READ_SNAPSHOT_UNATTESTED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('optional expansion is issued after delivery and re-admission makes the retained handle stale', async () => {
  const bytes = fixture(2, p => {
    p.dependencies = [{ id: 'dependency:optional', producer: { kind: 'judgment_result', judgment_ref: 'judgment:1',
      result_contract_ref: 'contract:1' }, consumer_judgment_ref: 'judgment:0', input_role: 'support',
      data_type: { term: 'result.type.text' }, required: false, purpose: 'Optional support' }];
  });
  const host = createReferenceHost({ observePolicy: allowAll });
  const result = await host.read(bytes, readRequest());
  assert.equal(result.envelope.status, 'ready');
  const handle = result.envelope.content.expansion_handles[0];
  assert.ok(handle);
  const stale = await host.read(bytes, readRequest({ mode: 'expand', handle }));
  assert.equal(stale.envelope.diagnostics[0].code, 'READ_HANDLE_STALE');
  assert.equal(stale.envelope.content, null);
  const forged = await host.read(bytes, readRequest({ mode: 'expand', handle: { ...handle, host_epoch: 'forged' } }));
  assert.equal(forged.envelope.diagnostics[0].code, 'READ_HANDLE_UNTRUSTED');
  let failedHandle;
  const failure = await host.read(bytes, readRequest(), { deliver: prepared => {
    failedHandle = prepared.envelope.content.expansion_handles[0]; return false;
  } });
  assert.equal(failure.channel, 'transport_failure');
  const uncommitted = await host.read(bytes, readRequest({ mode: 'expand', handle: failedHandle }));
  assert.equal(uncommitted.envelope.diagnostics[0].code, 'READ_HANDLE_UNTRUSTED');
});

test('forged Result/Trace runtime fields and bad resource bytes are rejected by Core, without Host parsing', async () => {
  for (const mutate of [p => { p.judgments[0].result.value = { kind: 'number', value: 5 }; },
    p => { p.trace = { completed: true }; }, p => { p.judgments[0].result.action_authorization = 'allowed'; },
    p => { p.resources = [{ id: 'resource:missing', entry: 'attachments/missing', digest: `sha256:${'0'.repeat(64)}`, media_type: 'text/plain' }]; }]) {
    let observed = 0;
    const host = createReferenceHost({ observePolicy: o => { observed++; return allowAll(o); } });
    const result = await host.read(fixture(1, mutate), readRequest());
    assert.equal(result.envelope.status, 'rejected');
    assert.equal(result.envelope.diagnostics[0].code, 'READ_CORE_INVALID');
    assert.equal(observed, 0); assert.equal(result.envelope.content, null);
  }
});

test('input capture owns bytes and no old Core runtime or private Schema is exposed', async () => {
  const bytes = fixture();
  const host = createReferenceHost({ observePolicy: allowAll });
  const pending = host.read(bytes, readRequest()); bytes.fill(0);
  assert.equal((await pending).envelope.status, 'ready');
  assert.equal((await admitNode(bytes)).status, 'rejected');
  const require = createRequire(import.meta.url);
  assert.equal(require('@aikdna/kdna-core/package.json').version, '0.24.0-rc.component-semantics.2');
  for (const subpath of ['schema/manifest.schema.json', 'src/public-contract/brand.js']) {
    assert.throws(() => require(`@aikdna/kdna-core/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('resource identity and digest remain Core-validated; Read never substitutes raw attachment bytes', async () => {
  const attachment = Buffer.from('PRIVATE_ATTACHMENT_BYTES');
  const hash = `sha256:${createHash('sha256').update(attachment).digest('hex')}`;
  const make = digest => fixture(1, p => {
    p.resources = [{ id: 'resource:attachment', entry: 'attachments/reference.txt', digest, media_type: 'text/plain' }];
    p.materials = [{ id: 'material:attachment', kind: 'attachment', resource_ref: 'resource:attachment', source_refs: [] }];
    p.judgments[0].material_refs = ['material:attachment'];
  }, [['attachments/reference.txt', attachment]]);
  const valid = await createReferenceHost({ observePolicy: allowAll }).read(make(hash), readRequest());
  assert.equal(valid.envelope.status, 'ready');
  assert.ok(valid.envelope.content.closure.some(n => n.role === 'resource' && n.value.digest === hash));
  assert.doesNotMatch(JSON.stringify(valid), /PRIVATE_ATTACHMENT_BYTES/);
  const invalid = await createReferenceHost({ observePolicy: allowAll }).read(make(`sha256:${'0'.repeat(64)}`), readRequest());
  assert.equal(invalid.envelope.diagnostics[0].code, 'READ_CORE_INVALID');
  assert.equal(invalid.envelope.content, null);
});
