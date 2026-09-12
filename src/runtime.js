import { createRetainedHost } from './retained.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { validationProjection } from './current-core.js';
import { admitNode } from '@aikdna/kdna-core/node';
import { inspectSnapshot } from '@aikdna/kdna-core/read-boundary';
import { readNode } from '@aikdna/kdna-read/node';
import { createTrustedHostReadProvider, createTrustedReadControlProvider } from '@aikdna/kdna-read/embedding';

export class KDNAWebServerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'KDNAWebServerError';
    this.code = code;
    this.status = status;
  }
}

export function byteLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 25 * 1024 * 1024) {
    throw new TypeError('Host byte limits must be bounded nonnegative safe integers.');
  }
  return limit;
}

function durationLimit(value) {
  const limit = value ?? 5000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30_000) throw new TypeError('Policy timeout must be between 1 and 30000 ms.');
  return limit;
}

async function boundedPolicy(observePolicy, observation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => observePolicy(observation)),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('HOST_POLICY_TIMEOUT')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** The server-owned policy is a prerequisite, never an identity service. */
export function createReferenceHost(options = {}) {
  if (options.runtime !== undefined) throw new TypeError('Runtime injection is unavailable.');
  if (options.observePolicy !== undefined && typeof options.observePolicy !== 'function') {
    throw new TypeError('observePolicy must be a server-owned function.');
  }
  if (options.retainedSession !== undefined && options.retainedSession !== false) return createRetainedHost(options, KDNAWebServerError);
  const maxInputBytes = byteLimit(options.maxInputBytes, 10 * 1024 * 1024);
  const maxResponseBytes = byteLimit(options.maxResponseBytes, 1024 * 1024);
  const admissionResponseBytes = byteLimit(options.admissionResponseBytes, 4096);
  const hostId = options.hostId ?? 'reference-host';
  const clock = options.clock ?? Date.now;
  const policyTimeoutMs = durationLimit(options.policyTimeoutMs);
  const maxReads = byteLimit(options.maxReads, 1024);
  const maxConcurrentReads = byteLimit(options.maxConcurrentReads, 4);
  let disposed = false;
  let reads = 0;
  let activeReads = 0;
  const observePolicy = options.observePolicy ?? (() => ({
    decision: 'deny', scope: [], epoch: 'closed', policyId: 'default-deny',
  }));
  const calls = new AsyncLocalStorage();
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: admissionResponseBytes }));
  const provider = createTrustedHostReadProvider({
    async observe({ request, snapshot }) {
      const view = inspectSnapshot(snapshot);
      if (!view) return null;
      const observationStart = clock();
      const policy = await boundedPolicy(observePolicy, Object.freeze({
        request, snapshot: view, context: calls.getStore()?.context, currentMs: observationStart,
      }), policyTimeoutMs);
      if (!policy || typeof policy !== 'object') return null;
      const currentMs = clock();
      const call = calls.getStore();
      const epochChanged = call.observedEpoch !== undefined && call.observedEpoch !== policy.epoch;
      call.observedEpoch = policy.epoch;
      // Only the accepted Core supplies coordinates and closure. The policy owns scope.
      return {
        host_id: hostId, host_epoch: policy.epoch,
        decision_id: randomUUID(), request_id: request.request_id,
        snapshot_id: view.snapshot_id, A: view.digests.A.observed, C: view.digests.C.observed,
        scope: policy.scope, decision: epochChanged ? 'deny' : policy.decision, policy_id: policy.policyId,
        issued_at: policy.issuedAt ?? currentMs, expires_at: policy.expiresAt ?? currentMs + 30_000,
        current_ms: currentMs,
        ...(policy.revoked === undefined ? {} : { revoked: policy.revoked }),
        ...(policy.liftDenial === undefined ? {} : { lift_denial: policy.liftDenial }),
      };
    },
    async deliver(result) {
      const call = calls.getStore();
      return call.deliver ? await call.deliver(result) === true : true;
    },
  });
  function capture(input) {
    if (!(input instanceof Uint8Array)) throw new KDNAWebServerError('HOST_BYTES_REQUIRED');
    if (input.byteLength > maxInputBytes) throw new KDNAWebServerError('HOST_INPUT_TOO_LARGE', 413);
    return new Uint8Array(input);
  }
  return Object.freeze({
    dispose() { disposed = true; },
    retentionState() { return Object.freeze({ state: 'disabled', active_reads: activeReads, retained_container_bytes: 0, retained_view_charge_bytes: 0, issued_handle_records: 0, issued_handle_charge_bytes: 0, consumed_request_ids: 0 }); },
    limits: Object.freeze({ maxInputBytes, maxResponseBytes, admissionResponseBytes }),
    async validate(input) {
      const admitted = await admitNode(capture(input));
      return validationProjection(admitted);
    },
    async read(input, candidate, settings = {}) {
      if (disposed) throw new KDNAWebServerError('HOST_SESSION_CLOSED', 410);
      if (reads >= maxReads) throw new KDNAWebServerError('HOST_SESSION_EXHAUSTED', 429);
      if (activeReads >= maxConcurrentReads) throw new KDNAWebServerError('HOST_BUSY', 429);
      const budget = candidate && typeof candidate === 'object'
        ? Object.getOwnPropertyDescriptor(candidate, 'budget_bytes') : undefined;
      if (budget && 'value' in budget && Number.isSafeInteger(budget.value) && budget.value > maxResponseBytes) {
        throw new KDNAWebServerError('HOST_RESPONSE_LIMIT_EXCEEDED', 413);
      }
      const bytes = capture(input);
      reads++;
      activeReads++;
      try {
        return await calls.run({ context: settings.context, deliver: settings.deliver },
          async () => readNode(bytes, candidate, control, provider));
      } finally { activeReads--; }
    },
  });
}
