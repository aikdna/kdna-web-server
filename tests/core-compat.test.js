import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKDNAServer } from '../src/index.js';
import { createFileStorage } from '../src/storage.js';

async function readJson(response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function uploadRequest(operation, bytes) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'asset.kdna');
  return new Request(`http://localhost/api/kdna/${operation}`, {
    method: 'POST',
    body: form,
  });
}

function jsonRequest(operation, body) {
  return new Request(`http://localhost/api/kdna/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Core 0.20 validates, inspects, plans, and loads a real public asset', async () => {
  const assetPath = process.env.KDNA_WEB_CORE_ASSET;
  assert.ok(assetPath, 'KDNA_WEB_CORE_ASSET must point to a public .kdna fixture');

  const bytes = fs.readFileSync(assetPath);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-web-core-compat-'));
  const server = createKDNAServer({ storage: createFileStorage({ storageDir }) });

  try {
    const validated = await readJson(await server.handle(uploadRequest('validate', bytes)));
    assert.equal(validated.valid, true);
    assert.ok(validated.fileId);
    assert.ok(validated.domain);

    const inspected = await readJson(await server.handle(uploadRequest('inspect', bytes)));
    assert.ok(inspected.fileId);
    assert.ok(inspected.domain);
    assert.equal(inspected.loadPlan.can_load_now, true);

    const planned = await readJson(await server.handle(jsonRequest('plan-load', {
      fileId: inspected.fileId,
      context: {},
    })));
    assert.equal(planned.canProceed, true);
    assert.deepEqual(planned.missing, []);

    const loaded = await readJson(await server.handle(jsonRequest('load', {
      fileId: inspected.fileId,
      profile: 'compact',
    })));
    assert.equal(loaded.capsule.type, 'kdna.runtime-capsule');
    assert.equal(loaded.domain, 'kdna:aikdna:laozi-wuwei');
    assert.equal(loaded.version, '0.1.1');
    assert.equal(loaded.judgmentVersion, '0.1.0');
    assert.equal(loaded.profile, 'compact');
    assert.ok(loaded.content && typeof loaded.content === 'object');
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
