import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKDNAServer } from '../src/index.js';
import { createMemoryStorage } from '../src/storage.js';
import { createNextHandlers } from '../src/adapters/nextjs/index.js';
import { createKDNAWorkerRouter } from '../src/adapters/cloudflare/index.js';

function fakeRuntime() {
  return {
    validate(input) {
      assert.ok(input);
      return { overall_valid: true, warnings: [] };
    },
    inspect(input) {
      assert.ok(input);
      return {
        asset_id: 'kdna:test:web',
        version: '0.1.0',
        title: 'Web Test',
        summary: 'A test asset',
        profiles_available: ['index', 'compact'],
      };
    },
    planLoad(input, options = {}) {
      assert.ok(input);
      return {
        can_load_now: Boolean(options.hasPassword) || !options.forcePassword,
        required_action: options.forcePassword ? 'enter_password' : 'load',
      };
    },
    loadAuthorized(input, options = {}) {
      assert.ok(input);
      return {
        asset_id: 'kdna:test:web',
        version: '0.1.0',
        profile: options.profile,
        text: 'loaded prompt',
      };
    },
  };
}

function multipartRequest(operation) {
  const form = new FormData();
  form.set('file', new Blob(['fake kdna bytes'], { type: 'application/octet-stream' }), 'asset.kdna');
  return new Request(`http://localhost/api/kdna/${operation}`, { method: 'POST', body: form });
}

function multipartRequestWithBytes(operation, bytes) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'asset.kdna');
  return new Request(`http://localhost/api/kdna/${operation}`, { method: 'POST', body: form });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test('server validates, inspects, plans, and loads an uploaded asset', async () => {
  const server = createKDNAServer({ runtime: fakeRuntime(), storage: createMemoryStorage() });

  const validate = await readJson(await server.handle(multipartRequest('validate')));
  assert.equal(validate.valid, true);
  assert.equal(validate.domain, 'kdna:test:web');
  assert.ok(validate.fileId);

  const inspect = await readJson(await server.handle(multipartRequest('inspect')));
  assert.equal(inspect.domain, 'kdna:test:web');
  assert.deepEqual(inspect.profiles, ['index', 'compact']);

  const plan = await readJson(await server.handle(new Request('http://localhost/api/kdna/plan-load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspect.fileId, context: { hasPassword: true } }),
  })));
  assert.equal(plan.canProceed, true);

  const loaded = await readJson(await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspect.fileId, profile: 'compact' }),
  })));
  assert.equal(loaded.content, 'loaded prompt');
  assert.equal(loaded.profile, 'compact');
});

test('next and worker adapters expose reusable handlers', async () => {
  const options = { runtime: fakeRuntime(), storage: createMemoryStorage() };
  const next = createNextHandlers(options);
  const nextResponse = await next.POST(multipartRequest('inspect'), { params: { route: ['inspect'] } });
  assert.equal((await readJson(nextResponse)).domain, 'kdna:test:web');

  const worker = createKDNAWorkerRouter(options);
  const workerResponse = await worker.handle(new Request('http://localhost/api/kdna/health'));
  assert.equal((await readJson(workerResponse)).ok, true);
});

test('unknown fileId returns a structured 404', async () => {
  const server = createKDNAServer({ runtime: fakeRuntime(), storage: createMemoryStorage() });
  const response = await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: 'missing', profile: 'compact' }),
  }));
  assert.equal(response.status, 404);
  const body = await readJson(response);
  assert.equal(body.error.code, 'KDNA_FILE_NOT_FOUND');
});

test('server rejects uploads larger than maxFileSizeBytes', async () => {
  const server = createKDNAServer({
    runtime: fakeRuntime(),
    storage: createMemoryStorage(),
    maxFileSizeBytes: 4,
  });
  const response = await server.handle(multipartRequestWithBytes('inspect', 'too large'));
  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.equal(body.error.code, 'KDNA_FILE_TOO_LARGE');
});
