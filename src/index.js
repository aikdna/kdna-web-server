import { dependencyVersions, componentContract } from './current-core.js';
import { createReferenceHost, byteLimit, KDNAWebServerError } from './runtime.js';
export { createReferenceHost, KDNAWebServerError } from './runtime.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const UNAVAILABLE = Object.freeze({
  plan: 'KDNA_PLAN_CAPABILITY_UNAVAILABLE', 'plan-load': 'KDNA_PLAN_CAPABILITY_UNAVAILABLE',
  load: 'KDNA_LOAD_CAPABILITY_UNAVAILABLE', activate: 'KDNA_ACTIVATION_CAPABILITY_UNAVAILABLE',
  export: 'KDNA_EXPORT_CAPABILITY_UNAVAILABLE', execute: 'KDNA_ACTION_CAPABILITY_UNAVAILABLE',
});
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}
function deliveryFailureResponse(result) {
  const cause = result?.admission_rejection?.code ?? result?.control?.semantic_cause
    ?? result?.envelope?.diagnostics.find(item => item.severity === 'error')?.code;
  return new Response(null, { status: 502, headers: {
    'cache-control': 'no-store', 'x-kdna-channel': 'transport_failure', 'x-kdna-code': 'READ_TRANSPORT_FAILURE',
    ...(cause ? { 'x-kdna-semantic-cause': cause } : {}),
  } });
}
// Wire encoding only; public contract values are never adapted or inferred.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
/** Send the budgeted payload itself, with no JSON wrapper around the Envelope. */
export function readResultResponse(result) {
  if (result.channel === 'no_body_control' || result.channel === 'transport_failure') {
    const control = result.control ?? result.transport_failure;
    const headers = { 'cache-control': 'no-store', 'x-kdna-channel': result.channel, 'x-kdna-code': control.code };
    if (control.semantic_cause) headers['x-kdna-semantic-cause'] = control.semantic_cause;
    return new Response(null, { status: result.channel === 'transport_failure' ? 502 : 413, headers });
  }
  const payload = result.envelope ?? result.admission_rejection;
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const limit = result.envelope?.budget.limit_bytes ?? result.admission_rejection.control_budget.limit_bytes;
  if (bytes.byteLength > limit) throw new KDNAWebServerError('HOST_WIRE_BUDGET_MISMATCH', 500);
  return new Response(bytes, { status: result.envelope?.status === 'ready' ? 200 : 422,
    headers: { ...JSON_HEADERS, 'x-kdna-channel': result.channel } });
}
async function boundedBody(request, maximum, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new KDNAWebServerError('HOST_INPUT_TOO_LARGE', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new KDNAWebServerError('HOST_REQUEST_TIMEOUT', 408)), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new KDNAWebServerError('HOST_INPUT_TOO_LARGE', 413);
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    // This is a borrowed Request body. Stop pulling and release it on rejection;
    // Node 26 FormData producers can throw asynchronously after reader.cancel().
    // Do not drain the remaining body or take ownership of transport teardown.
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function operationFor(request, options) {
  if (options.operation !== undefined) {
    return typeof options.operation === 'string' && /^[a-z]+(?:-[a-z]+)*$/.test(options.operation)
      ? options.operation : '__invalid__';
  }
  const pathname = new URL(request.url).pathname;
  const base = options.basePath ?? '/api/kdna';
  if (pathname === base || pathname === `${base}/`) return 'health';
  if (!pathname.startsWith(`${base}/`)) return '__invalid__';
  const suffix = pathname.slice(base.length + 1);
  return /^[a-z]+(?:-[a-z]+)*$/.test(suffix) ? suffix : '__invalid__';
}
export function createKDNAServer(options = {}) {
  if (options.runtime !== undefined || options.storage !== undefined || options.activationServerUrl !== undefined) {
    throw new TypeError('Legacy runtime, storage and activation configuration is unavailable.');
  }
  const retained = options.retainedSession !== undefined && options.retainedSession !== false;
  const host = createReferenceHost(options);
  let handling = false, handleAttempts = 0;
  const handleLimit = Math.min(options.maxReads ?? 16, options.retainedSession?.maxReads ?? 16);
  const maxRequestBytes = byteLimit(options.maxRequestBytes, 12 * 1024 * 1024);
  const maxRequestJsonBytes = byteLimit(options.maxRequestJsonBytes, 64 * 1024);
  if (retained && (maxRequestBytes > 12 * 1024 * 1024 || maxRequestJsonBytes > 64 * 1024)) {
    throw new TypeError('Retained Host outer byte caps cannot be raised.');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
    throw new TypeError('requestTimeoutMs must be between 1 and 30000.');
  }
  return Object.freeze({
    dispose: () => host.dispose(),
    retentionState() {
      const summary = host.retentionState();
      return Object.freeze({ ...summary, active_reads: Math.max(summary.active_reads, handling ? 1 : 0) });
    },
    /** Default delivery confirms an in-process Response handoff, not remote acknowledgement. */
    async handle(request, settings = {}) {
      let deliveredResponse = null;
      let attempted = false;
      let admissionResult = null;
      let ownsHandling = false;
      try {
        const operation = operationFor(request, { ...options, operation: settings.operation });
        if (operation === 'health' && request.method === 'GET') {
          return jsonResponse({ ok: true, service: 'kdna-web-server', core: dependencyVersions.core, read: dependencyVersions.read,
            component_definition_digest: componentContract.definition_digest,
            browser: 'NOT_EXPOSED_BY_SERVER_HOST', action_authorization: 'not_evaluated' });
        }
        if (!['validate', 'inspect', 'read', ...Object.keys(UNAVAILABLE)].includes(operation)) {
          throw new KDNAWebServerError('KDNA_ROUTE_NOT_FOUND', 404);
        }
        if (request.method !== 'POST') throw new KDNAWebServerError('KDNA_METHOD_NOT_ALLOWED', 405);
        if (Object.hasOwn(UNAVAILABLE, operation)) throw new KDNAWebServerError(UNAVAILABLE[operation], 501);
        if (retained && operation !== 'validate') {
          if (host.retentionState().state === 'closed') throw new KDNAWebServerError('HOST_SESSION_CLOSED', 410);
          if (handleAttempts >= handleLimit) { host.dispose(); throw new KDNAWebServerError('HOST_SESSION_EXHAUSTED', 429); }
          handleAttempts++;
          if (handling || host.retentionState().active_reads !== 0) throw new KDNAWebServerError('HOST_BUSY', 429);
          if (typeof settings.deliverResponse !== 'function') throw new KDNAWebServerError('HOST_DELIVERY_CONFIRMATION_REQUIRED');
          handling = true; ownsHandling = true;
          if (request.signal.aborted) throw new KDNAWebServerError('HOST_REQUEST_ABORTED', 408);
        }
        const body = await boundedBody(request, maxRequestBytes, requestTimeoutMs);
        let file, candidate;
        try {
          const form = await new Response(body, { headers: {
            'content-type': request.headers.get('content-type') ?? '',
          } }).formData();
          const allowed = operation === 'validate' ? ['file'] : ['file', 'request'];
          if ([...form.keys()].some(key => !allowed.includes(key))
            || allowed.some(key => form.getAll(key).length !== 1)) throw new Error('Invalid fields');
          file = form.get('file');
          if (!file || typeof file.arrayBuffer !== 'function') throw new Error('File required');
          if (file.size > host.limits.maxInputBytes) throw new KDNAWebServerError('HOST_INPUT_TOO_LARGE', 413);
          if (operation !== 'validate') {
            const text = form.get('request');
            if (typeof text !== 'string' || new TextEncoder().encode(text).length > maxRequestJsonBytes) {
              throw new KDNAWebServerError('HOST_REQUEST_JSON_TOO_LARGE', 413);
            }
            candidate = JSON.parse(text);
          }
        } catch (error) {
          if (error instanceof KDNAWebServerError) throw error;
          throw new KDNAWebServerError('HOST_MULTIPART_INVALID');
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (operation === 'validate') return jsonResponse(await host.validate(bytes));
        const result = await host.read(bytes, candidate, { context: settings.context, signal: request.signal,
          async [retained ? 'deliverResponse' : 'deliver'](prepared) {
            attempted = true;
            const response = readResultResponse(prepared);
            if (settings.deliverResponse && await settings.deliverResponse(response) !== true) return false;
            deliveredResponse = response;
            return true;
          },
        });
        if (result.channel === 'transport_failure') return readResultResponse(result);
        // Read returns admission failures before its Host delivery hook.
        if (!attempted) {
          const response = readResultResponse(result);
          admissionResult = result;
          if (settings.deliverResponse) {
            attempted = true;
            if (await settings.deliverResponse(response) !== true) return deliveryFailureResponse(result);
          }
          return response;
        }
        return deliveredResponse ?? readResultResponse(result);
      } catch (error) {
        if (attempted) return deliveryFailureResponse(admissionResult);
        return jsonResponse({ error: { code: error instanceof KDNAWebServerError ? error.code : 'KDNA_INTERNAL_ERROR' } },
          error instanceof KDNAWebServerError ? error.status : 500);
      } finally {
        if (ownsHandling) handling = false;
      }
    },
  });
}
export async function handleKDNARequest(request, options = {}) {
  if (options.retainedSession !== undefined && options.retainedSession !== false) throw new KDNAWebServerError('HOST_RETAINED_INSTANCE_REQUIRED');
  return createKDNAServer(options).handle(request);
}
