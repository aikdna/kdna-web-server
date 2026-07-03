import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createKDNAServer } from '../src/index.js';
import { loadDefaultRuntime } from '../src/runtime.js';
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

test('activation proxy defaults to the canonical entitlement endpoint', async () => {
  let captured = null;
  const activationServer = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        body: JSON.parse(body),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entitlementToken: 'signed-token' }));
    });
  });

  await new Promise((resolve) => activationServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = activationServer.address();
    const server = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${port}`,
    });

    const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        domain: '@author/asset-name',
        licenseKey: 'KDNA-LIC-customer-1',
        machineFingerprint: 'device-sha',
      }),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { entitlementToken: 'signed-token' });
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/v1/entitlements/activate');
    assert.deepEqual(captured.body, {
      domain: '@author/asset-name',
      license_key: 'KDNA-LIC-customer-1',
      machine_fingerprint: 'device-sha',
    });
  } finally {
    await new Promise((resolve, reject) => {
      activationServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('activation proxy redacts echoed license keys from upstream errors', async () => {
  const key = 'KDNA-LIC-SECRET';
  const activationServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'INVALID_LICENSE_KEY',
          message: `license_key ${key} is invalid`,
          echo: { license_key: key },
        },
      }));
    });
  });

  await new Promise((resolve) => activationServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = activationServer.address();
    const server = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${port}`,
    });

    const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: '@author/asset-name', license_key: key }),
    }));

    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(key));
    assert.match(text, /\[redacted-license-key\]/);
  } finally {
    await new Promise((resolve, reject) => {
      activationServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('package peers pin the Core v1 runtime API range', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.peerDependencies['@aikdna/kdna-core'], '^0.15.10');
});

test('default runtime resolves the Core v1 API surface', async () => {
  const runtime = await loadDefaultRuntime();
  for (const name of ['validate', 'inspect', 'planLoad', 'loadAuthorized']) {
    assert.equal(typeof runtime[name], 'function', `expected runtime.${name}`);
  }
});
