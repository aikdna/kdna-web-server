import { validationProjection } from './current-core.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { admitNode } from '@aikdna/kdna-core/node';
import { inspectSnapshot } from '@aikdna/kdna-core/read-boundary';
import { readNode } from '@aikdna/kdna-read/node';
import { readBrowser } from '@aikdna/kdna-read/browser';
import { createTrustedHostReadProvider, createTrustedReadControlProvider } from '@aikdna/kdna-read/embedding';
import { retainedProfile } from './profile.js';

const L = retainedProfile.limits;
const encoder = new TextEncoder();
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const internalFailure = () => new Error('HOST_RETAINED_CONTROL_FAILURE');
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && encoder.encode(value).byteLength <= 256
  && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
function capped(value, fallback, maximum, positive = false) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0) || n > maximum) {
    throw new TypeError('Retained Host configuration exceeds its closed resource bounds.');
  }
  return n;
}
function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid retainedSession.');
  const spec = retainedProfile.options;
  const keys = [...Object.keys(spec.required), ...Object.keys(spec.optional)];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)
    || !('value' in descriptors[key]))) throw new TypeError('Unknown retainedSession field or accessor.');
  if (Object.keys(spec.required).some(key => !Object.hasOwn(descriptors, key))) throw new TypeError('Missing retainedSession field.');
  if (!identifier(value.binding_id) || !identifier(value.authorization_domain_id)
    || typeof value.verifyContext !== 'function') throw new TypeError('Trusted retained binding is required.');
  const config = { binding_id: value.binding_id, authorization_domain_id: value.authorization_domain_id,
    verifyContext: value.verifyContext };
  for (const [key, bounds] of Object.entries(spec.optional)) {
    config[key] = capped(value[key], bounds.default, bounds.maximum, true);
  }
  return Object.freeze(config);
}

/** One instance owns lifetime and accounting. Read alone owns handle authority. */
export function createRetainedHost(options, HostError) {
  const config = configuration(options.retainedSession);
  const maxInputBytes = capped(options.maxInputBytes, L.input_bytes_maximum, L.input_bytes_maximum);
  const maxResponseBytes = capped(options.maxResponseBytes, L.response_bytes_per_call_maximum, L.response_bytes_per_call_maximum);
  const admissionResponseBytes = capped(options.admissionResponseBytes, L.control_response_bytes_per_call_maximum, L.control_response_bytes_per_call_maximum);
  const maxReads = Math.min(config.maxReads, capped(options.maxReads, L.read_attempts_maximum, 25 * 1024 * 1024));
  const concurrency = capped(options.maxConcurrentReads, 1, 1);
  const timeoutMs = capped(options.policyTimeoutMs, L.timeout_ms_per_call.default, L.timeout_ms_per_call.maximum, true);
  const clock = options.clock ?? Date.now;
  const hostId = options.hostId ?? 'reference-host';
  if (typeof clock !== 'function' || !identifier(hostId)) throw new TypeError('Invalid trusted Host clock or identifier.');
  const observePolicy = options.observePolicy ?? (() => ({ decision: 'deny', scope: [], epoch: 'closed', policyId: 'default-deny' }));
  const hostEpoch = randomUUID();
  const calls = new AsyncLocalStorage();
  const ids = new Set();
  let state = 'unbound', activeReads = 0, attempts = 0, consumedIds = 0;
  let bytes = null, snapshot = null, pendingSnapshot = null, viewBytes = 0;
  let handleRecords = 0, handleBytes = 0, policyEpoch, policyExpiry = Infinity;
  let monoDeadline = Infinity, wallDeadline = Infinity, lastClock;
  let expiryTimer = null, callTimer = null, stopCurrent = null;
  let provider, activeCall = null;
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: admissionResponseBytes }));
  function releaseProvider() {
    if (state === 'closed' && activeReads === 0) {
      provider = null; ids.clear(); handleRecords = 0; handleBytes = 0;
    }
  }
  function close() {
    if (state !== 'closed') {
      state = 'closed'; // Invalidate before releasing any owned resource.
      bytes = null; snapshot = null; pendingSnapshot = null; viewBytes = 0;
      clearTimeout(expiryTimer); expiryTimer = null;
      clearTimeout(callTimer); callTimer = null;
      if (activeCall) {
        activeCall.signal?.removeEventListener('abort', activeCall.onAbort);
        activeCall.context = null; activeCall.actualSnapshot = null; activeCall.lastRequest = null;
        activeCall.delivered = null; activeCall.deliverResponse = null;
      }
    }
    // Every terminal path publishes cancellation, including repeated closes.
    // An already unwinding formal Read keeps its existing diagnostic. At the
    // next event-loop turn, any still-pending caller is independently stopped;
    // its uncooperative work continues to own the slot/provider until settlement.
    const call = activeCall;
    if (call) {
      call.cancelDelivery();
      if (!call.deliveryPhase && call.closeNotification === null) {
        const stop = stopCurrent;
        call.closeNotification = setImmediate(() => {
          call.closeNotification = null;
          if (activeCall === call) stop?.();
        });
      }
    }
    releaseProvider();
  }
  function current() {
    let now;
    try { now = clock(); } catch { close(); throw internalFailure(); }
    if (!Number.isSafeInteger(now) || now < 0 || (lastClock !== undefined && now < lastClock)) {
      close(); throw internalFailure();
    }
    lastClock = now;
    if (state === 'closed' || performance.now() >= monoDeadline || now >= wallDeadline || now >= policyExpiry) {
      close(); throw internalFailure();
    }
    return now;
  }
  function deliveryExternal(call, invoke) {
    const pending = Promise.resolve().then(() => {
      if (state === 'closed') throw internalFailure();
      return invoke();
    });
    call.external.add(pending);
    pending.then(() => call.external.delete(pending), () => call.external.delete(pending));
    return Promise.race([pending, call.deliveryCancelled.then(() => { throw internalFailure(); })]);
  }
  async function binding(call) {
    current();
    const verified = call.deliveryPhase
      ? await deliveryExternal(call, () => config.verifyContext(call.context))
      : await config.verifyContext(call.context);
    if (verified !== true) { close(); throw internalFailure(); }
    current();
  }
  function armExpiry() {
    clearTimeout(expiryTimer);
    const remaining = Math.min(monoDeadline - performance.now(), wallDeadline - lastClock, policyExpiry - lastClock);
    if (remaining <= 0) { close(); return; }
    expiryTimer = setTimeout(() => close(), Math.min(remaining, L.ttl_ms.maximum));
    expiryTimer.unref?.();
  }
  async function policyFor(call, request, actualSnapshot) {
    await binding(call);
    const view = inspectSnapshot(actualSnapshot);
    if (!view) throw internalFailure();
    if (snapshot && actualSnapshot !== snapshot || pendingSnapshot && actualSnapshot !== pendingSnapshot) {
      close(); throw internalFailure();
    }
    if (!snapshot && !pendingSnapshot) {
      const charge = encoder.encode(JSON.stringify(view)).byteLength;
      if (charge > config.maxRetainedViewBytes) { close(); throw internalFailure(); }
      pendingSnapshot = actualSnapshot; viewBytes = charge;
    }
    if (!call.reserved) {
      // request is admitted by Read; no caller field can reserve an ID early.
      if (ids.has(request.request_id)) throw internalFailure();
      if (consumedIds >= L.validated_request_ids_maximum) { close(); throw internalFailure(); }
      ids.add(request.request_id); consumedIds++; call.reserved = true;
    }
    const policy = await observePolicy(Object.freeze({ request, snapshot: view, context: call.context, currentMs: current() }));
    const now = current();
    if (!policy || typeof policy !== 'object') return null;
    if (!identifier(policy.epoch)) return null;
    if (policyEpoch !== undefined && policyEpoch !== policy.epoch) { close(); throw internalFailure(); }
    policyEpoch = policy.epoch;
    const expiry = policy.expiresAt ?? now + config.ttlMs;
    if (!Number.isSafeInteger(expiry) || expiry < 0) return null;
    policyExpiry = Math.min(policyExpiry, expiry);
    if (policy.revoked === true) close();
    else { current(); armExpiry(); }
    if (state !== 'closed') { call.lastRequest = request; call.actualSnapshot = actualSnapshot; }
    return { host_id: hostId, host_epoch: hostEpoch, decision_id: randomUUID(), request_id: request.request_id,
      snapshot_id: view.snapshot_id, A: view.digests.A.observed, C: view.digests.C.observed,
      scope: policy.scope, decision: policy.decision, policy_id: policy.policyId,
      issued_at: policy.issuedAt ?? now,
      expires_at: Math.min(policyExpiry, wallDeadline, now + Math.max(0, Math.floor(monoDeadline - performance.now()))),
      current_ms: now,
      ...(policy.revoked === undefined ? {} : { revoked: policy.revoked }),
      ...(policy.liftDenial === undefined ? {} : { lift_denial: policy.liftDenial }) };
  }
  async function deliveryRecheck(call) {
    await binding(call);
    // This checks only trusted binding, epoch, revocation and deadlines. Formal
    // authorization/scope and denial handling remain the two existing Read gates.
    const view = inspectSnapshot(call.actualSnapshot);
    const observation = Object.freeze({ request: call.lastRequest, snapshot: view, context: call.context, currentMs: current() });
    const policy = await deliveryExternal(call, () => observePolicy(observation));
    current();
    if (!policy || policy.epoch !== policyEpoch || policy.revoked === true || policy.decision !== 'allow') { close(); throw internalFailure(); }
    if (policy.expiresAt !== undefined) {
      if (!Number.isSafeInteger(policy.expiresAt) || policy.expiresAt < 0) { close(); throw internalFailure(); }
      policyExpiry = Math.min(policyExpiry, policy.expiresAt);
    }
    current(); armExpiry();
  }
  async function deliver(prepared) {
    const call = calls.getStore();
    const ready = prepared.channel === 'read_envelope' && prepared.envelope.status === 'ready';
    if (state === 'closed') return false;
    call.deliveryAttempted = true; call.deliveryPhase = true;
    try {
      if (ready) {
        await deliveryRecheck(call);
        const handles = prepared.envelope.content.expansion_handles;
        const charge = handles.reduce((n, h) => n + encoder.encode(JSON.stringify(h)).byteLength, 0);
        if (handleRecords + handles.length > config.maxHandleRecords || handleBytes + charge > config.maxHandleRecordBytes) {
          close(); return false;
        }
        call.pendingRecords = handles.length; call.pendingHandleBytes = charge;
        state = 'delivering';
      }
      const sink = call.deliverResponse;
      if (await deliveryExternal(call, () => sink(prepared)) !== true) { close(); return false; }
      if (ready) await deliveryRecheck(call);
      call.delivered = prepared;
      return true;
    } catch { close(); return false; }
  }
  provider = createTrustedHostReadProvider({
    observe: observation => policyFor(calls.getStore(), observation.request, observation.snapshot), deliver,
  });
  function boundedInput(input) {
    if (!(input instanceof Uint8Array) || !ArrayBuffer.isView(input)) throw new HostError('HOST_BYTES_REQUIRED');
    const length = typedByteLength.call(input);
    if (length > maxInputBytes || length > config.maxRetainedContainerBytes) {
      throw new HostError('HOST_INPUT_TOO_LARGE', 413);
    }
    return input;
  }
  async function execute(input, candidate, settings, call) {
    // A foreign/unverified first context never closes the legitimate binding.
    if (call.aborted) throw new HostError('HOST_REQUEST_ABORTED', 408);
    current();
    try { call.context = await call.context; } catch { throw new HostError('HOST_CONTEXT_UNVERIFIED', 403); }
    current();
    let verified = false;
    try { verified = await config.verifyContext(call.context) === true; } catch { /* Unverified context is not a revocation. */ }
    if (!verified) throw new HostError('HOST_CONTEXT_UNVERIFIED', 403);
    if (call.aborted) throw new HostError('HOST_REQUEST_ABORTED', 408);
    current(); call.verified = true;
    const captured = new Uint8Array(boundedInput(input));
    if (state === 'unbound') {
      bytes = captured;
      const now = current();
      if (!Number.isSafeInteger(now + config.ttlMs)) { close(); throw internalFailure(); }
      monoDeadline = performance.now() + config.ttlMs; wallDeadline = now + config.ttlMs;
      state = 'preparing'; armExpiry();
    } else {
      if (captured.byteLength !== bytes.byteLength) throw new HostError('HOST_RETAINED_INPUT_MISMATCH', 409);
      for (let i = 0; i < captured.length; i++) {
        if (captured[i] !== bytes[i]) throw new HostError('HOST_RETAINED_INPUT_MISMATCH', 409);
      }
    }
    const budget = candidate && typeof candidate === 'object' ? Object.getOwnPropertyDescriptor(candidate, 'budget_bytes') : undefined;
    if (budget && 'value' in budget && Number.isSafeInteger(budget.value) && budget.value > maxResponseBytes) {
      throw new HostError('HOST_RESPONSE_LIMIT_EXCEEDED', 413);
    }
    const originalProvider = provider;
    const result = snapshot ? await readBrowser(snapshot, candidate, control, originalProvider)
      : await readNode(bytes, candidate, control, originalProvider);
    // Read skips its delivery hook for transport failure. Confirm bounded control
    // delivery separately without claiming ready content or handle issuance.
    if (!call.deliveryAttempted) await deliver(result);
    const success = state !== 'closed' && result.channel === 'read_envelope' && result.envelope.status === 'ready'
      && call.delivered === result;
    if (success) {
      current(); snapshot = pendingSnapshot ?? snapshot; pendingSnapshot = null;
      handleRecords += call.pendingRecords; handleBytes += call.pendingHandleBytes;
      state = 'active';
    } else if (!snapshot) close();
    else if (state !== 'closed') state = 'active';
    return result;
  }
  return Object.freeze({
    limits: Object.freeze({ maxInputBytes, maxResponseBytes, admissionResponseBytes }),
    dispose: () => close(),
    retentionState() {
      return Object.freeze({ state, active_reads: activeReads, retained_container_bytes: bytes?.byteLength ?? 0,
        retained_view_charge_bytes: viewBytes, issued_handle_records: handleRecords,
        issued_handle_charge_bytes: handleBytes, consumed_request_ids: consumedIds });
    },
    async validate(input) {
      if (state === 'closed') throw new HostError('HOST_SESSION_CLOSED', 410);
      const admitted = await admitNode(new Uint8Array(boundedInput(input)));
      return validationProjection(admitted);
    },
    async read(input, candidate, settings = {}) {
      if (state === 'closed') throw new HostError('HOST_SESSION_CLOSED', 410);
      if (attempts >= maxReads) { close(); throw new HostError('HOST_SESSION_EXHAUSTED', 429); }
      attempts++;
      if (activeReads >= concurrency) throw new HostError('HOST_BUSY', 429);
      if (typeof settings.deliverResponse !== 'function') throw new HostError('HOST_DELIVERY_CONFIRMATION_REQUIRED');
      if (settings.signal !== undefined && !(settings.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
      activeReads++;
      const call = { context: settings.context, deliverResponse: settings.deliverResponse,
        reserved: false, deliveryAttempted: false, delivered: null, pendingRecords: 0, pendingHandleBytes: 0,
        verified: false, aborted: false, signal: settings.signal, onAbort: null,
        deliveryPhase: false, closeNotification: null, external: new Set(), deliveryCancelled: null, cancelDelivery: null };
      call.deliveryCancelled = new Promise(resolve => { call.cancelDelivery = resolve; });
      activeCall = call;
      let stop;
      const stopped = new Promise((resolve, reject) => { stop = error => reject(error ?? new HostError('HOST_SESSION_CLOSED', 410)); });
      stopCurrent = stop;
      call.onAbort = () => { call.aborted = true;
        if (call.verified) close(); else stop(new HostError('HOST_REQUEST_ABORTED', 408)); };
      call.signal?.addEventListener('abort', call.onAbort, { once: true });
      if (call.signal?.aborted) call.onAbort();
      callTimer = setTimeout(() => close(), timeoutMs);
      const task = calls.run(call, () => execute(input, candidate, settings, call)).catch(error => {
        if (!snapshot && state !== 'unbound') close();
        throw error;
      });
      // Read can return its existing transport failure promptly while a timed-out
      // delivery callback still runs. Keep the slot/provider charged until BOTH
      // the formal pipeline and every such external callback have settled.
      const finish = () => {
        clearImmediate(call.closeNotification); call.closeNotification = null;
        activeReads--; clearTimeout(callTimer); callTimer = null; stopCurrent = null;
        call.signal?.removeEventListener('abort', call.onAbort); call.signal = null; call.onAbort = null;
        if (activeCall === call) activeCall = null;
        call.context = null; call.deliverResponse = null; call.actualSnapshot = null; call.lastRequest = null;
        call.delivered = null;
        releaseProvider();
      };
      const settle = () => {
        if (call.external.size === 0) finish();
        else Promise.allSettled([...call.external]).then(finish);
      };
      task.then(settle, settle);
      return Promise.race([task, stopped]);
    },
  });
}
