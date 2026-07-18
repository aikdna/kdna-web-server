import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createKDNAServer } from '../src/index.js';
import { loadDefaultRuntime } from '../src/runtime.js';
import { createMemoryStorage } from '../src/storage.js';
import { createNextHandlers } from '../src/adapters/nextjs/index.js';
import { createKDNARouter } from '../src/adapters/express/index.js';

const require = createRequire(import.meta.url);
const activation = require('@aikdna/kdna-activation-server');
const activationPackage = require('@aikdna/kdna-activation-server/package.json');
const MACHINE_A = 'a'.repeat(64);
const SYNTHETIC_SIGNATURE_BASE64 = Buffer.alloc(64, 7).toString('base64');

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
        load_contract_default_profile: 'compact',
        raw: { provider_error_body: 'synthetic-provider-body' },
      };
    },
    planLoad(input, options = {}) {
      assert.ok(input);
      return {
        can_load_now: Boolean(options.hasPassword) || !options.forcePassword,
        required_action: options.forcePassword ? 'enter_password' : 'load',
        source: { kind: 'file', path: '/private/runtime/asset.kdna' },
        provider_error_body: 'synthetic-provider-body',
      };
    },
    loadAuthorized(input, options = {}) {
      assert.ok(input);
      if (options.as === 'json') {
        return {
          type: 'kdna.runtime-capsule',
          contract_version: '0.1.0',
          asset: {
            asset_id: 'kdna:aikdna:test-server',
            asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000099',
            version: '0.1.0',
            judgment_version: '0.1.0',
          },
          profile: options.profile || 'compact',
          context: { highest_question: 'What should the server load?' },
          trace: { payload_encoding: 'cbor' },
        };
      }
      return {
        asset_id: 'kdna:aikdna:test-server',
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

async function closeHttpServer(server, force = false) {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (force) server.closeAllConnections?.();
  else server.closeIdleConnections?.();
  await closed;
}

async function invokeExpress(options, { method = 'GET', url = '/health', originalUrl } = {}) {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    headers: { host: 'localhost' },
    originalUrl: originalUrl || `/api/kdna${url}`,
    url,
  });
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) { headers[name] = value; },
      end(body) { resolve({ status: this.statusCode, headers, body: Buffer.from(body).toString() }); },
    };
    createKDNARouter(options)(req, res, (error) => resolve({ error }));
  });
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
  assert.equal(inspect.defaultProfile, 'compact');

  const plan = await readJson(await server.handle(new Request('http://localhost/api/kdna/plan-load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspect.fileId, context: { hasPassword: true } }),
  })));
  assert.equal(plan.canProceed, true);

  const publicResponses = JSON.stringify({ inspect, plan });
  assert.doesNotMatch(publicResponses, /private\/runtime|provider_error_body|synthetic-provider-body/);

  const loaded = await readJson(await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspect.fileId, profile: 'compact' }),
  })));
  assert.equal(loaded.content.highest_question, 'What should the server load?');
  assert.equal(loaded.profile, 'compact');
  assert.equal(loaded.capsule.type, 'kdna.runtime-capsule');
  assert.equal(loaded.capsule.asset.asset_id, 'kdna:aikdna:test-server');
  assert.equal(loaded.capsule.asset.version, '0.1.0');
});

test('the Next.js adapter exposes reusable Node.js handlers', async () => {
  const options = { runtime: fakeRuntime(), storage: createMemoryStorage() };
  const next = createNextHandlers(options);
  const nextResponse = await next.POST(multipartRequest('inspect'), {
    params: Promise.resolve({ route: ['inspect'] }),
  });
  assert.equal((await readJson(nextResponse)).domain, 'kdna:test:web');

  const expressHealth = await invokeExpress(options);
  assert.equal(expressHealth.status, 200);
  assert.equal(JSON.parse(expressHealth.body).ok, true);
});

test('inspect maps the exact Core payload_encrypted field', async () => {
  const runtime = fakeRuntime();
  const originalInspect = runtime.inspect;
  runtime.inspect = (input) => ({ ...originalInspect(input), payload_encrypted: true });
  const server = createKDNAServer({ runtime, storage: createMemoryStorage() });
  const response = await server.handle(multipartRequest('inspect'));
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).encrypted, true);
});

test('generic, Next.js, and Express adapters reject noncanonical route aliases', async () => {
  const options = { runtime: fakeRuntime(), storage: createMemoryStorage() };
  const server = createKDNAServer(options);
  for (const pathname of [
    '/api/kdnaevil/activate',
    '/api/kdna/anything/activate',
    '/api/kdna//activate',
  ]) {
    const response = await server.handle(new Request(`http://localhost${pathname}`, { method: 'POST' }));
    assert.equal(response.status, 404, pathname);
    assert.equal((await readJson(response)).error.code, 'KDNA_ROUTE_NOT_FOUND');
  }

  const next = createNextHandlers(options);
  const nextResponse = await next.POST(
    new Request('http://localhost/api/kdna/anything/activate', { method: 'POST' }),
    { params: { route: ['anything', 'activate'] } },
  );
  assert.equal(nextResponse.status, 404);

  const expressResult = await invokeExpress(options, {
    method: 'POST',
    originalUrl: '/api/kdna/anything/activate',
    url: '/anything/activate',
  });
  assert.equal(expressResult.error, undefined);
  assert.equal(expressResult.status, 404);
  assert.equal(JSON.parse(expressResult.body).error.code, 'KDNA_ROUTE_NOT_FOUND');
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

test('load maps decryption failures to a generic 401 without crypto details', async () => {
  const runtime = fakeRuntime();
  runtime.loadAuthorized = () => {
    const error = new Error('AES-256-KW unwrap: integrity check failed for secret material');
    error.code = 'KDNA_DECRYPT_FAILED';
    throw error;
  };
  const server = createKDNAServer({ runtime, storage: createMemoryStorage() });
  const inspected = await readJson(await server.handle(multipartRequest('inspect')));
  const response = await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspected.fileId, password: 'wrong' }),
  }));
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.doesNotMatch(text, /AES|unwrap|integrity check|secret material/i);
  assert.equal(JSON.parse(text).error.code, 'KDNA_DECRYPT_FAILED');
});

test('unexpected runtime errors do not expose internal messages', async () => {
  const runtime = fakeRuntime();
  runtime.loadAuthorized = () => {
    throw new Error('/private/path/provider-error-body');
  };
  const server = createKDNAServer({ runtime, storage: createMemoryStorage() });
  const inspected = await readJson(await server.handle(multipartRequest('inspect')));
  const response = await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspected.fileId }),
  }));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /private\/path|provider-error-body/);
  assert.equal(JSON.parse(text).error.code, 'KDNA_INTERNAL_ERROR');
});

test('load rejects legacy or arbitrary runtime objects without exposing them', async () => {
  const runtime = fakeRuntime();
  runtime.loadAuthorized = () => ({
    content: { internal_path: '/private/runtime/result.json' },
    provider_error_body: 'synthetic-provider-result',
  });
  const server = createKDNAServer({ runtime, storage: createMemoryStorage() });
  const inspected = await readJson(await server.handle(multipartRequest('inspect')));
  const response = await server.handle(new Request('http://localhost/api/kdna/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: inspected.fileId }),
  }));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /private\/runtime|provider-result|provider_error_body/);
  assert.equal(JSON.parse(text).error.code, 'KDNA_RUNTIME_CONTRACT_VIOLATION');
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

test('multipart body limits are enforced before parsing chunked uploads', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(96));
      controller.enqueue(new Uint8Array(96));
      controller.close();
    },
  });
  const request = new Request('http://localhost/api/kdna/inspect', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
    body: stream,
    duplex: 'half',
  });
  const server = createKDNAServer({
    runtime: fakeRuntime(),
    storage: createMemoryStorage(),
    maxMultipartBodyBytes: 128,
  });
  const response = await server.handle(request);
  assert.equal(response.status, 413);
  assert.equal((await readJson(response)).error.code, 'KDNA_MULTIPART_TOO_LARGE');
});

test('validate reports malformed Core input without escalating inspect failure', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-web-invalid-'));
  try {
    const server = createKDNAServer({ storageDir });
    const response = await server.handle(multipartRequestWithBytes('validate', 'not-a-kdna-container'));
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.valid, false);
    assert.deepEqual(body.warnings, ['KDNA_VALIDATION_FAILED']);
    assert.equal(body.domain, null);
    assert.equal(body.version, null);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
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
      if (req.method !== 'POST' || req.url !== '/entitlements/activate') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
        return;
      }
      captured = {
        method: req.method,
        url: req.url,
        body: JSON.parse(body),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        license_id: 'lic_web_fixture',
        domain: 'kdna:author:asset-name',
        status: 'active',
        revoked: false,
        require_machine_binding: true,
        machine_fingerprint: MACHINE_A,
        signature_base64: SYNTHETIC_SIGNATURE_BASE64,
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
      body: JSON.stringify({
        domain: 'kdna:author:asset-name',
        licenseKey: 'synthetic-license-secret-customer-1',
        machineFingerprint: MACHINE_A,
      }),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      license_id: 'lic_web_fixture',
      domain: 'kdna:author:asset-name',
      status: 'active',
      revoked: false,
      require_machine_binding: true,
      machine_fingerprint: MACHINE_A,
      signature_base64: SYNTHETIC_SIGNATURE_BASE64,
    });
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/entitlements/activate');
    assert.deepEqual(captured.body, {
      domain: 'kdna:author:asset-name',
      license_key: 'synthetic-license-secret-customer-1',
      machine_fingerprint: MACHINE_A,
    });
  } finally {
    await closeHttpServer(activationServer);
  }
});

test('activation proxy redacts echoed license keys from upstream errors', async () => {
  const key = 'synthetic-license-secret-error';
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
      body: JSON.stringify({ domain: 'kdna:author:asset-name', license_key: key }),
    }));

    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(key));
    assert.doesNotMatch(text, /license_key .* is invalid|echo/);
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      error: {
        code: 'INVALID_LICENSE_KEY',
        message: 'Activation request was rejected.',
        retryable: false,
      },
    });
  } finally {
    await closeHttpServer(activationServer);
  }
});

test('web activation completes against the exact installed Activation 0.2.0 package', async () => {
  assert.equal(activationPackage.version, '0.2.0');
  assert.equal(activation.ENTITLEMENT_ROUTES.activate, '/entitlements/activate');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-web-activation-'));
  const store = activation.makeStore(dataDir);
  const keys = activation.ensureKeyPair(dataDir);
  const domain = 'kdna:conformance:web-activation';
  const licenseKey = 'synthetic-license-secret-web-integration';
  const license = store.create({ domain, license_key: licenseKey });
  let context;
  try {
    context = await activation.startServer({ dataDir, store, keys, port: 0 });
    const server = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${context.port}`,
    });
    const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        domain,
        licenseKey,
        machineFingerprint: MACHINE_A,
        client: 'kdna-web-server-contract-test',
      }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.doesNotMatch(text, new RegExp(licenseKey));
    const record = JSON.parse(text);
    assert.equal(record.license_id, license.license_id);
    assert.equal(record.domain, domain);
    assert.equal(record.status, 'active');
    assert.equal(record.revoked, false);
    assert.equal(record.machine_fingerprint, MACHINE_A);
    assert.match(record.signature_base64, /^[A-Za-z0-9+/=]+$/);

    const unboundDomain = 'kdna:conformance:web-unbound';
    const unboundKey = 'synthetic-license-secret-web-unbound';
    store.create({
      domain: unboundDomain,
      license_key: unboundKey,
      require_machine_binding: false,
    });
    const unboundResponse = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        domain: unboundDomain,
        licenseKey: unboundKey,
        machineFingerprint: MACHINE_A,
      }),
    }));
    const unboundText = await unboundResponse.text();
    assert.equal(unboundResponse.status, 200, unboundText);
    const unboundRecord = JSON.parse(unboundText);
    assert.equal(unboundRecord.require_machine_binding, false);
    assert.equal(unboundRecord.machine_fingerprint, undefined);
  } finally {
    if (context?.server) await activation.stopServer(context.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('activation request validation fails before contacting an upstream', async () => {
  const server = createKDNAServer({
    runtime: fakeRuntime(),
    storage: createMemoryStorage(),
    activationServerUrl: 'http://127.0.0.1:1',
  });
  for (const body of [
    { domain: '@author/asset-name', license_key: 'synthetic-license-secret' },
    { domain: 'kdna:author:asset-name', license_key: '' },
    {
      domain: 'kdna:author:asset-name',
      license_key: 'first-secret',
      licenseKey: 'second-secret',
    },
    {
      domain: 'kdna:author:asset-name',
      license_key: 'synthetic-license-secret',
      machine_fingerprint: 'device-name',
    },
  ]) {
    const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('activation configuration permits only canonical secure or loopback origins', async () => {
  const body = JSON.stringify({
    domain: 'kdna:author:asset-name',
    license_key: 'synthetic-license-secret',
  });
  for (const activationServerUrl of [
    'http://licenses.example.test',
    'https://user:pass@licenses.example.test',
    'https://licenses.example.test/path',
    'https://licenses.example.test?query=yes',
    'https://licenses.example.test#fragment',
  ]) {
    const server = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl,
    });
    const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    assert.equal(response.status, 500, activationServerUrl);
    assert.equal((await readJson(response)).error.code, 'KDNA_ACTIVATION_INVALID_CONFIGURATION');
  }
});

test('activation redirects and connection failures never escape the generic boundary', async () => {
  let redirectedRequests = 0;
  const destination = http.createServer((_req, res) => {
    redirectedRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ leaked: true }));
  });
  const redirector = http.createServer((_req, res) => {
    const { port } = destination.address();
    res.writeHead(302, { location: `http://127.0.0.1:${port}/capture` });
    res.end();
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const request = () => new Request('http://localhost/api/kdna/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      domain: 'kdna:author:asset-name',
      license_key: 'synthetic-license-secret',
    }),
  });
  try {
    const redirectServer = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${redirector.address().port}`,
    });
    const redirected = await redirectServer.handle(request());
    assert.equal(redirected.status, 502);
    assert.equal(redirectedRequests, 0);

    const closedPort = redirector.address().port;
    await closeHttpServer(redirector);
    const unavailableServer = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${closedPort}`,
    });
    const unavailable = await unavailableServer.handle(request());
    assert.equal(unavailable.status, 502);
    assert.equal((await readJson(unavailable)).error.code, 'KDNA_ACTIVATION_UPSTREAM_UNAVAILABLE');
  } finally {
    if (redirector.listening) await closeHttpServer(redirector, true);
    await closeHttpServer(destination, true);
  }
});

test('activation response byte and body-stall limits fail closed', async () => {
  const oversized = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: 'x'.repeat(70 * 1024) }));
  });
  const stalled = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"status":');
  });
  await new Promise((resolve) => oversized.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const request = () => new Request('http://localhost/api/kdna/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      domain: 'kdna:author:asset-name',
      license_key: 'synthetic-license-secret',
    }),
  });
  try {
    for (const [upstream, timeout] of [[oversized, 1_000], [stalled, 50]]) {
      const server = createKDNAServer({
        runtime: fakeRuntime(),
        storage: createMemoryStorage(),
        activationServerUrl: `http://127.0.0.1:${upstream.address().port}`,
        activationTimeoutMs: timeout,
      });
      const response = await server.handle(request());
      assert.equal(response.status, 502);
      assert.equal((await readJson(response)).error.code, 'KDNA_ACTIVATION_BAD_UPSTREAM');
    }
  } finally {
    await closeHttpServer(oversized, true);
    await closeHttpServer(stalled, true);
  }
});

test('malformed or unsigned Activation success responses fail closed', async () => {
  const responses = [
    {},
    {
      license_id: 'lic_wrong_domain',
      domain: 'kdna:wrong:asset',
      status: 'active',
      revoked: false,
      signature_base64: SYNTHETIC_SIGNATURE_BASE64,
    },
    {
      license_id: 'lic_unsigned',
      domain: 'kdna:author:asset-name',
      status: 'active',
      revoked: false,
    },
    {
      license_id: 'lic_short_signature',
      domain: 'kdna:author:asset-name',
      status: 'active',
      revoked: false,
      require_machine_binding: false,
      signature_base64: 'c2hvcnQ=',
    },
    {
      license_id: 'lic_secret_echo',
      domain: 'kdna:author:asset-name',
      status: 'active',
      revoked: false,
      signature_base64: SYNTHETIC_SIGNATURE_BASE64,
      license_key: 'synthetic-license-secret',
    },
    {
      license_id: 'lic_unknown_private_field',
      domain: 'kdna:author:asset-name',
      status: 'active',
      revoked: false,
      require_machine_binding: false,
      signature_base64: SYNTHETIC_SIGNATURE_BASE64,
      access_token: 'different-synthetic-upstream-secret',
      internal_path: '/private/provider/record.json',
    },
  ];
  let index = 0;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responses[index++]));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const server = createKDNAServer({
      runtime: fakeRuntime(),
      storage: createMemoryStorage(),
      activationServerUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
      const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          domain: 'kdna:author:asset-name',
          license_key: 'synthetic-license-secret',
        }),
      }));
      assert.equal(response.status, 502);
      assert.equal(
        (await readJson(response)).error.code,
        'KDNA_ACTIVATION_BAD_UPSTREAM',
        `response ${responseIndex}`,
      );
    }
  } finally {
    await closeHttpServer(upstream);
  }
});

test('JSON request limits count bytes before parsing', async () => {
  const server = createKDNAServer({
    runtime: fakeRuntime(),
    storage: createMemoryStorage(),
    activationServerUrl: 'http://127.0.0.1:1',
    maxJsonBodyBytes: 128,
  });
  const response = await server.handle(new Request('http://localhost/api/kdna/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      domain: 'kdna:author:asset-name',
      license_key: '界'.repeat(100),
    }),
  }));
  assert.equal(response.status, 413);
  assert.equal((await readJson(response)).error.code, 'KDNA_JSON_TOO_LARGE');
});

test('package peers pin the current KDNA runtime API', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.peerDependencies['@aikdna/kdna-core'], '0.20.0');
});

test('default runtime resolves the current KDNA API surface', async () => {
  const runtime = await loadDefaultRuntime();
  for (const name of ['validate', 'inspect', 'planLoad', 'loadAuthorized']) {
    assert.equal(typeof runtime[name], 'function', `expected runtime.${name}`);
  }
});
