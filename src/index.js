import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { createFileStorage } from './storage.js';
import { resolveRuntime } from './runtime.js';

const require = createRequire(import.meta.url);
const corePackage = require('@aikdna/kdna-core/package.json');
const manifestSchema = require('@aikdna/kdna-core/schema/manifest.schema.json');
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_ACTIVATION_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const MACHINE_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const LICENSE_ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;
const CORE_CONFORMANCE_VERSION = '0.20.0';
const POST_OPERATIONS = new Set(['validate', 'inspect', 'plan-load', 'load', 'activate', 'export']);
export const ENTITLEMENT_ACTIVATE_PATH = '/entitlements/activate';

const assetIdPattern = manifestSchema?.properties?.asset_id?.pattern;
if (corePackage.version !== CORE_CONFORMANCE_VERSION || typeof assetIdPattern !== 'string') {
  throw new Error(`KDNA Web Server requires the exact Core ${CORE_CONFORMANCE_VERSION} contract`);
}
const ASSET_ID_RE = new RegExp(assetIdPattern, 'u');

export class KDNAWebServerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'KDNAWebServerError';
    this.status = options.status || 400;
    this.code = options.code || 'KDNA_WEB_SERVER_ERROR';
    this.cause = options.cause;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function publicString(value) {
  return typeof value === 'string' ? value : null;
}

async function readBoundedBytes(body, maxBytes) {
  const reader = body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new RangeError('body exceeds byte limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function errorResponse(error) {
  if (error instanceof KDNAWebServerError) {
    return jsonResponse({
      error: { code: error.code, message: error.message },
    }, error.status);
  }

  if (error?.code === 'KDNA_DECRYPT_FAILED') {
    return jsonResponse({
      error: {
        code: 'KDNA_DECRYPT_FAILED',
        message: 'Unable to decrypt asset with the provided credentials.',
      },
    }, 401);
  }

  if (error?.code === 'KDNA_LOAD_NOT_AUTHORIZED' || error?.plan?.can_load_now === false) {
    return jsonResponse({
      error: {
        code: error.code || 'KDNA_LOAD_NOT_AUTHORIZED',
        message: 'The asset LoadPlan did not authorize this load.',
      },
    }, 403);
  }

  if (error?.code === 'KDNA_FILE_NOT_FOUND' || error?.code === 'KDNA_FILE_EXPIRED') {
    return jsonResponse({
      error: { code: error.code, message: error.message },
    }, error.code === 'KDNA_FILE_EXPIRED' ? 410 : 404);
  }

  return jsonResponse({
    error: {
      code: 'KDNA_INTERNAL_ERROR',
      message: 'KDNA request failed.',
    },
  }, 500);
}

function normalizeOperation(request, options = {}) {
  if (options.operation != null) {
    const operation = String(options.operation);
    return /^[a-z]+(?:-[a-z]+)*$/.test(operation) ? operation : '__invalid_route__';
  }
  const url = new URL(request.url);
  const configuredBasePath = options.basePath || '/api/kdna';
  const basePath = configuredBasePath === '/'
    ? ''
    : `/${String(configuredBasePath).split('/').filter(Boolean).join('/')}`;
  if (url.pathname === basePath || url.pathname === `${basePath}/`) return 'health';
  if (!url.pathname.startsWith(`${basePath}/`)) return '__invalid_route__';
  const operation = url.pathname.slice(basePath.length + 1);
  return /^[a-z]+(?:-[a-z]+)*$/.test(operation) ? operation : '__invalid_route__';
}

async function parseJson(request, options = {}) {
  const maxBytes = Number.isFinite(options.maxJsonBodyBytes)
    ? options.maxJsonBodyBytes
    : DEFAULT_MAX_JSON_BODY_BYTES;
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new KDNAWebServerError('Request JSON exceeds maxJsonBodyBytes.', {
      status: 413,
      code: 'KDNA_JSON_TOO_LARGE',
    });
  }
  try {
    const bytes = await readBoundedBytes(request.body, maxBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('JSON body is not an object');
    }
    return value;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new KDNAWebServerError('Request JSON exceeds maxJsonBodyBytes.', {
        status: 413,
        code: 'KDNA_JSON_TOO_LARGE',
        cause: error,
      });
    }
    throw new KDNAWebServerError('Request body must be valid JSON.', {
      status: 400,
      code: 'KDNA_INVALID_JSON',
      cause: error,
    });
  }
}

async function readUploadedFile(request, options = {}) {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxMultipartBodyBytes = options.maxMultipartBodyBytes
    ?? (Number.isFinite(maxFileSizeBytes)
      ? maxFileSizeBytes + DEFAULT_MULTIPART_OVERHEAD_BYTES
      : Number.POSITIVE_INFINITY);
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxMultipartBodyBytes) {
    throw new KDNAWebServerError('Multipart request exceeds maxMultipartBodyBytes.', {
      status: 413,
      code: 'KDNA_MULTIPART_TOO_LARGE',
    });
  }
  let form;
  try {
    const bytes = await readBoundedBytes(request.body, maxMultipartBodyBytes);
    form = await new Response(bytes, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new KDNAWebServerError('Multipart request exceeds maxMultipartBodyBytes.', {
        status: 413,
        code: 'KDNA_MULTIPART_TOO_LARGE',
        cause: error,
      });
    }
    throw new KDNAWebServerError('Request body must be multipart/form-data with a file field.', {
      status: 400,
      code: 'KDNA_INVALID_MULTIPART',
      cause: error,
    });
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new KDNAWebServerError('Missing multipart field: file.', {
      status: 400,
      code: 'KDNA_FILE_REQUIRED',
    });
  }
  if (Number.isFinite(maxFileSizeBytes) && file.size > maxFileSizeBytes) {
    throw new KDNAWebServerError(`KDNA file exceeds maxFileSizeBytes (${maxFileSizeBytes}).`, {
      status: 413,
      code: 'KDNA_FILE_TOO_LARGE',
    });
  }
  return file;
}

function validationSummary(result, inspectResult = null) {
  const problemCount = Array.isArray(result?.problems)
    ? result.problems.length
    : Array.isArray(result?.warnings) ? result.warnings.length : 0;
  return {
    valid: Boolean(result?.overall_valid ?? result?.ok),
    domain: publicString(inspectResult?.asset_id || inspectResult?.asset?.asset_id || inspectResult?.name),
    version: publicString(inspectResult?.version || inspectResult?.asset?.version),
    warnings: problemCount === 0 ? [] : ['KDNA_VALIDATION_FAILED'],
  };
}

function inspectSummary(inspectResult) {
  const profiles = inspectResult.profiles_available
    || inspectResult.profiles
    || Object.keys(inspectResult.manifest?.load_contract?.profiles || {});

  const defaultProfile = inspectResult.load_contract_default_profile
    || inspectResult.manifest?.load_contract?.default_profile
    || null;

  return {
    domain: publicString(inspectResult.asset_id || inspectResult.name),
    version: publicString(inspectResult.version || inspectResult.asset?.version),
    title: publicString(inspectResult.title || inspectResult.asset?.title),
    description: publicString(
      inspectResult.description || inspectResult.summary || inspectResult.manifest?.description,
    ),
    encrypted: Boolean(
      inspectResult.payload_encrypted
      ?? inspectResult.encrypted
      ?? inspectResult.manifest?.payload?.encrypted,
    ),
    defaultProfile: publicString(defaultProfile),
    ...(Array.isArray(profiles) && profiles.length > 0
      ? { profiles: profiles.filter((profile) => typeof profile === 'string') }
      : {}),
  };
}

function publicLoadPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const asset = plan.asset && typeof plan.asset === 'object' && !Array.isArray(plan.asset)
    ? {
        asset_id: publicString(plan.asset.asset_id),
        asset_uid: publicString(plan.asset.asset_uid),
        title: publicString(plan.asset.title),
        version: publicString(plan.asset.version),
        judgment_version: publicString(plan.asset.judgment_version),
      }
    : null;
  const checks = plan.checks && typeof plan.checks === 'object'
    ? Object.fromEntries(
        Object.entries(plan.checks)
          .filter(([, value]) => typeof value === 'boolean'),
      )
    : {};
  return {
    format_version: publicString(plan.format_version),
    asset,
    access: publicString(plan.access),
    state: publicString(plan.state),
    required_action: publicString(plan.required_action),
    can_load_now: Boolean(plan.can_load_now),
    projection_policy: publicString(plan.projection_policy),
    checks,
  };
}

function normalizePlanContext(context = {}) {
  const options = {};
  if (context.hasPassword != null) options.hasPassword = Boolean(context.hasPassword);
  if (context.password) options.password = context.password;
  if (context.entitlement) options.entitlement = context.entitlement;
  if (context.entitlementToken) options.entitlement = context.entitlementToken;
  return options;
}

function normalizeLoadOptions(body = {}) {
  const options = {
    profile: body.profile || 'compact',
    as: body.as || 'json',
  };
  if (body.password) options.password = body.password;
  if (body.entitlement) options.entitlement = body.entitlement;
  if (body.entitlementToken) options.entitlement = body.entitlementToken;
  return options;
}

function activationField(body, snakeName, camelName) {
  if (body[snakeName] != null && body[camelName] != null && body[snakeName] !== body[camelName]) {
    throw new KDNAWebServerError(`Conflicting ${snakeName} fields.`, {
      status: 400,
      code: 'KDNA_ACTIVATION_INVALID_REQUEST',
    });
  }
  return body[snakeName] ?? body[camelName];
}

function normalizeActivationBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new KDNAWebServerError('Activation body must be a JSON object.', {
      status: 400,
      code: 'KDNA_ACTIVATION_INVALID_REQUEST',
    });
  }
  const domain = body.domain;
  const licenseKey = activationField(body, 'license_key', 'licenseKey');
  const machineFingerprint = activationField(
    body,
    'machine_fingerprint',
    'machineFingerprint',
  );
  if (typeof domain !== 'string' || !ASSET_ID_RE.test(domain)) {
    throw new KDNAWebServerError('domain must be a canonical KDNA asset_id.', {
      status: 400,
      code: 'KDNA_ACTIVATION_INVALID_DOMAIN',
    });
  }
  if (typeof licenseKey !== 'string' || licenseKey.length === 0) {
    throw new KDNAWebServerError('license_key is required.', {
      status: 400,
      code: 'KDNA_ACTIVATION_LICENSE_REQUIRED',
    });
  }
  if (
    machineFingerprint != null &&
    (typeof machineFingerprint !== 'string' || !MACHINE_FINGERPRINT_RE.test(machineFingerprint))
  ) {
    throw new KDNAWebServerError('machine_fingerprint must be a canonical SHA-256 digest.', {
      status: 400,
      code: 'KDNA_ACTIVATION_INVALID_MACHINE',
    });
  }
  if (body.client != null && (typeof body.client !== 'string' || body.client.length === 0)) {
    throw new KDNAWebServerError('client must be a nonempty string when supplied.', {
      status: 400,
      code: 'KDNA_ACTIVATION_INVALID_REQUEST',
    });
  }
  return {
    domain,
    license_key: licenseKey,
    ...(machineFingerprint == null ? {} : { machine_fingerprint: machineFingerprint }),
    ...(body.client == null ? {} : { client: body.client }),
  };
}

const PRIVATE_RESPONSE_FIELDS = new Set([
  'license_key',
  'licenseKey',
  'password',
  'private_key',
  'privateKey',
  'admin_token',
  'adminToken',
]);
const ACTIVATION_SUCCESS_FIELDS = new Set([
  'version',
  'license_id',
  'domain',
  'issued_to',
  'issued_at',
  'expires_at',
  'status',
  'revoked',
  'revoked_at',
  'revocation_reason',
  'require_machine_binding',
  'require_online_check',
  'offline_grace_days',
  'allowed_agents',
  'last_checked_at',
  'offline_valid_until',
  'updated_at',
  'machine_fingerprint',
  'signature_base64',
]);

function containsPrivateResponseField(value) {
  if (Array.isArray(value)) return value.some(containsPrivateResponseField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) => PRIVATE_RESPONSE_FIELDS.has(key) || containsPrivateResponseField(entry),
  );
}

function isCanonicalEd25519Signature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === value;
}

function validateActivationSuccess(payload, requestBody) {
  if (
    Object.keys(payload).some((field) => !ACTIVATION_SUCCESS_FIELDS.has(field)) ||
    !LICENSE_ID_RE.test(payload.license_id || '') ||
    payload.domain !== requestBody.domain ||
    payload.status !== 'active' ||
    payload.revoked !== false ||
    typeof payload.require_machine_binding !== 'boolean' ||
    !isCanonicalEd25519Signature(payload.signature_base64) ||
    containsPrivateResponseField(payload) ||
    (payload.require_machine_binding === true && (
      requestBody.machine_fingerprint == null ||
      payload.machine_fingerprint !== requestBody.machine_fingerprint
    )) ||
    (payload.require_machine_binding === false && payload.machine_fingerprint != null)
  ) {
    throw new Error('activation success response violates the entitlement contract');
  }
}

function activationEndpoint(activationServerUrl, activationPath) {
  if (activationPath != null && activationPath !== ENTITLEMENT_ACTIVATE_PATH) {
    throw new KDNAWebServerError('activationPath must use the canonical entitlement route.', {
      status: 500,
      code: 'KDNA_ACTIVATION_INVALID_CONFIGURATION',
    });
  }
  let parsed;
  try {
    parsed = new URL(activationServerUrl);
  } catch {
    throw new KDNAWebServerError('activationServerUrl must be a canonical origin.', {
      status: 500,
      code: 'KDNA_ACTIVATION_INVALID_CONFIGURATION',
    });
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    throw new KDNAWebServerError(
      'activationServerUrl must be an HTTPS origin or an exact loopback HTTP origin.',
      { status: 500, code: 'KDNA_ACTIVATION_INVALID_CONFIGURATION' },
    );
  }
  return `${parsed.origin}${ENTITLEMENT_ACTIVATE_PATH}`;
}

async function readBoundedActivationJson(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ACTIVATION_RESPONSE_BYTES) {
    throw new Error('activation response exceeds the public limit');
  }
  const bytes = await readBoundedBytes(response.body, MAX_ACTIVATION_RESPONSE_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('activation response is not JSON');
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('activation response must be a JSON object');
  }
  return payload;
}

function normalizeLoaded(result, options) {
  if (result?.type !== 'kdna.runtime-capsule') {
    throw new KDNAWebServerError('KDNA runtime returned an unsupported load response.', {
      status: 500,
      code: 'KDNA_RUNTIME_CONTRACT_VIOLATION',
    });
  }
  return {
    domain: result.asset?.asset_id || null,
    version: result.asset?.version || null,
    judgmentVersion: result.asset?.judgment_version || null,
    profile: result.profile || options.profile || 'compact',
    content: result.context || {},
    capsule: result,
  };
}

async function maybeProxyActivation(body, options = {}) {
  if (!options.activationServerUrl) {
    throw new KDNAWebServerError('activationServerUrl is not configured.', {
      status: 501,
      code: 'KDNA_ACTIVATION_NOT_CONFIGURED',
    });
  }
  const activationBody = normalizeActivationBody(body);
  const endpoint = activationEndpoint(options.activationServerUrl, options.activationPath);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
  );
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activationBody),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new KDNAWebServerError('Activation server request failed.', {
      status: 502,
      code: 'KDNA_ACTIVATION_UPSTREAM_UNAVAILABLE',
      cause: error,
    });
  }
  let payload;
  try {
    payload = await readBoundedActivationJson(response);
  } catch (error) {
    throw new KDNAWebServerError('Activation server returned an invalid response.', {
      status: 502,
      code: 'KDNA_ACTIVATION_BAD_UPSTREAM',
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const upstreamCode = payload?.error?.code;
    const code = typeof upstreamCode === 'string' && /^[A-Z][A-Z0-9_]*$/.test(upstreamCode)
      ? upstreamCode
      : 'KDNA_ACTIVATION_REJECTED';
    return jsonResponse({
      ok: false,
      error: {
        code,
        message: 'Activation request was rejected.',
        retryable: Boolean(payload?.error?.retryable),
      },
    }, response.status >= 400 && response.status <= 599 ? response.status : 502);
  }
  try {
    validateActivationSuccess(payload, activationBody);
  } catch (error) {
    throw new KDNAWebServerError('Activation server returned an invalid response.', {
      status: 502,
      code: 'KDNA_ACTIVATION_BAD_UPSTREAM',
      cause: error,
    });
  }
  return jsonResponse(payload, response.status);
}

export function createKDNAServer(options = {}) {
  const storage = options.storage || createFileStorage(options);

  return {
    storage,
    async handle(request, requestOptions = {}) {
      try {
        const operation = normalizeOperation(request, { ...options, ...requestOptions });
        const runtime = await resolveRuntime(options);

        if (request.method === 'GET' && operation === 'health') {
          return jsonResponse({ ok: true, service: 'kdna-web-server' });
        }

        if (!POST_OPERATIONS.has(operation)) {
          throw new KDNAWebServerError('Unknown KDNA operation.', {
            status: 404,
            code: 'KDNA_ROUTE_NOT_FOUND',
          });
        }

        if (request.method !== 'POST') {
          return jsonResponse({ error: { code: 'KDNA_METHOD_NOT_ALLOWED', message: 'Use POST for KDNA operations.' } }, 405);
        }

        if (operation === 'validate') {
          const file = await readUploadedFile(request, options);
          const stored = await storage.put(file);
          let result;
          try {
            result = runtime.validate(stored.path);
          } catch {
            result = { overall_valid: false, problems: ['KDNA_FORMAT_INVALID'] };
          }
          const valid = Boolean(result?.overall_valid ?? result?.ok);
          const inspected = valid && runtime.inspect ? runtime.inspect(stored.path) : null;
          return jsonResponse({ fileId: stored.id, ...validationSummary(result, inspected) });
        }

        if (operation === 'inspect') {
          const file = await readUploadedFile(request, options);
          const stored = await storage.put(file);
          const inspected = runtime.inspect(stored.path);
          const plan = runtime.planLoad ? runtime.planLoad(stored.path) : null;
          return jsonResponse({
            fileId: stored.id,
            file: {
              id: stored.id,
              originalName: stored.originalName,
              size: stored.size,
              expiresAt: stored.expiresAt,
            },
            ...inspectSummary(inspected),
            loadPlan: publicLoadPlan(plan),
          });
        }

        if (operation === 'plan-load') {
          const body = await parseJson(request, options);
          const stored = await storage.get(body.fileId);
          const plan = runtime.planLoad(stored.path, normalizePlanContext(body.context || body));
          return jsonResponse({
            canProceed: Boolean(plan.can_load_now),
            missing: plan.can_load_now ? [] : [plan.required_action].filter(Boolean),
            plan: publicLoadPlan(plan),
          });
        }

        if (operation === 'load') {
          const body = await parseJson(request, options);
          const stored = await storage.get(body.fileId);
          const loadOptions = normalizeLoadOptions(body);
          const loaded = runtime.loadAuthorized(stored.path, loadOptions);
          return jsonResponse(normalizeLoaded(loaded, loadOptions));
        }

        if (operation === 'activate') {
          const body = await parseJson(request, options);
          return await maybeProxyActivation(body, options);
        }

        if (operation === 'export') {
          throw new KDNAWebServerError('KDNA export is not included in the server MVP yet.', {
            status: 501,
            code: 'KDNA_EXPORT_NOT_IMPLEMENTED',
          });
        }

        throw new KDNAWebServerError('Unknown KDNA operation.', {
          status: 404,
          code: 'KDNA_ROUTE_NOT_FOUND',
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export async function handleKDNARequest(request, options = {}) {
  return createKDNAServer(options).handle(request);
}
