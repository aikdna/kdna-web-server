import { createFileStorage } from './storage.js';
import { resolveRuntime } from './runtime.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ACTIVATION_PATH = '/v1/entitlements/activate';

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

function errorResponse(error) {
  const status = error.status || 500;
  return jsonResponse({
    error: {
      code: error.code || (status >= 500 ? 'KDNA_INTERNAL_ERROR' : 'KDNA_BAD_REQUEST'),
      message: error.message || 'KDNA request failed.',
    },
  }, status);
}

function normalizeOperation(request, options = {}) {
  if (options.operation) return String(options.operation).replace(/^\/+/, '');
  const url = new URL(request.url);
  const basePath = options.basePath || '/api/kdna';
  let pathname = url.pathname;
  if (pathname.startsWith(basePath)) pathname = pathname.slice(basePath.length);
  const segment = pathname.split('/').filter(Boolean).at(-1);
  return segment || 'health';
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch (error) {
    throw new KDNAWebServerError('Request body must be valid JSON.', {
      status: 400,
      code: 'KDNA_INVALID_JSON',
      cause: error,
    });
  }
}

async function readUploadedFile(request, options = {}) {
  let form;
  try {
    form = await request.formData();
  } catch (error) {
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
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  if (Number.isFinite(maxFileSizeBytes) && file.size > maxFileSizeBytes) {
    throw new KDNAWebServerError(`KDNA file exceeds maxFileSizeBytes (${maxFileSizeBytes}).`, {
      status: 413,
      code: 'KDNA_FILE_TOO_LARGE',
    });
  }
  return file;
}

function validationSummary(result, inspectResult = null) {
  return {
    valid: Boolean(result?.overall_valid ?? result?.ok),
    domain: inspectResult?.asset_id || inspectResult?.asset?.asset_id || inspectResult?.name || null,
    version: inspectResult?.version || inspectResult?.asset?.version || null,
    warnings: result?.warnings || [],
    result,
  };
}

function inspectSummary(inspectResult) {
  const profiles = inspectResult.profiles_available
    || inspectResult.profiles
    || Object.keys(inspectResult.manifest?.load_contract?.profiles || {});

  return {
    domain: inspectResult.asset_id || inspectResult.name || null,
    version: inspectResult.version || inspectResult.asset?.version || null,
    title: inspectResult.title || inspectResult.asset?.title || null,
    description: inspectResult.description || inspectResult.summary || inspectResult.manifest?.description || null,
    encrypted: Boolean(inspectResult.encrypted || inspectResult.manifest?.payload?.encrypted),
    profiles,
    inspect: inspectResult,
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
    as: body.as || 'prompt',
  };
  if (body.password) options.password = body.password;
  if (body.entitlement) options.entitlement = body.entitlement;
  if (body.entitlementToken) options.entitlement = body.entitlementToken;
  return options;
}

function normalizeActivationBody(body = {}) {
  const normalized = { ...body };
  if (normalized.license_key == null && normalized.licenseKey != null) {
    normalized.license_key = normalized.licenseKey;
  }
  if (normalized.machine_fingerprint == null && normalized.machineFingerprint != null) {
    normalized.machine_fingerprint = normalized.machineFingerprint;
  }
  delete normalized.licenseKey;
  delete normalized.machineFingerprint;
  return normalized;
}

function redactLicenseKey(value, licenseKey) {
  if (!licenseKey) return value;
  if (typeof value === 'string') {
    return value.split(licenseKey).join('[redacted-license-key]');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLicenseKey(entry, licenseKey));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactLicenseKey(entry, licenseKey)]),
    );
  }
  return value;
}

function normalizeLoaded(result, options) {
  return {
    domain: result.asset_id || result.domain || null,
    version: result.version || null,
    profile: result.profile || options.profile || 'compact',
    content: result.text || result.content || result,
    result,
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
  const endpoint = new URL(options.activationPath || DEFAULT_ACTIVATION_PATH, options.activationServerUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(activationBody),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  payload = redactLicenseKey(payload, activationBody.license_key);
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

        if (request.method !== 'POST') {
          return jsonResponse({ error: { code: 'KDNA_METHOD_NOT_ALLOWED', message: 'Use POST for KDNA operations.' } }, 405);
        }

        if (operation === 'validate') {
          const file = await readUploadedFile(request, options);
          const stored = await storage.put(file);
          const result = runtime.validate(stored.path);
          const inspected = runtime.inspect ? runtime.inspect(stored.path) : null;
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
            loadPlan: plan,
          });
        }

        if (operation === 'plan-load') {
          const body = await parseJson(request);
          const stored = await storage.get(body.fileId);
          const plan = runtime.planLoad(stored.path, normalizePlanContext(body.context || body));
          return jsonResponse({
            canProceed: Boolean(plan.can_load_now),
            missing: plan.can_load_now ? [] : [plan.required_action].filter(Boolean),
            plan,
          });
        }

        if (operation === 'load') {
          const body = await parseJson(request);
          const stored = await storage.get(body.fileId);
          const loadOptions = normalizeLoadOptions(body);
          const loaded = runtime.loadAuthorized(stored.path, loadOptions);
          return jsonResponse(normalizeLoaded(loaded, loadOptions));
        }

        if (operation === 'activate') {
          const body = await parseJson(request);
          return maybeProxyActivation(body, options);
        }

        if (operation === 'export') {
          throw new KDNAWebServerError('KDNA export is not included in the server MVP yet.', {
            status: 501,
            code: 'KDNA_EXPORT_NOT_IMPLEMENTED',
          });
        }

        throw new KDNAWebServerError(`Unknown KDNA operation: ${operation}`, {
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
