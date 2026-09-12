import { createKDNAServer } from '../../index.js';

function mountedOperation(req) {
  const pathname = new URL(req.url || '/', 'http://kdna.invalid').pathname;
  if (pathname === '/') return 'health';
  return /^\/([a-z]+(?:-[a-z]+)*)\/?$/.exec(pathname)?.[1] ?? '__invalid__';
}

async function sendWebResponse(res, response, timeoutMs) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (res.destroyed || res.writableEnded) return false;
  return new Promise(resolve => {
    const done = ok => {
      clearTimeout(timer);
      res.off('finish', onFinish); res.off('close', onClose); res.off('error', onError);
      resolve(ok);
    };
    const onFinish = () => done(true);
    const onClose = () => done(false);
    const onError = () => done(false);
    const timer = setTimeout(() => { done(false); res.destroy(); }, timeoutMs);
    res.once('finish', onFinish); res.once('close', onClose); res.once('error', onError);
    try {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(bytes);
    } catch { done(false); }
  });
}

/** Confirms server-side stream finish only; no claim of remote client processing. */
export function createKDNARouter(options = {}) {
  const server = createKDNAServer(options);
  const timeoutMs = options.deliveryTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('deliveryTimeoutMs must be between 1 and 30000.');
  }
  const retained = options.retainedSession !== undefined && options.retainedSession !== false;
  const middleware = async function kdnaRouter(req, res, next) {
    let sent = false;
    const controller = retained ? new AbortController() : null;
    const onClose = () => { if (retained && !res.writableFinished) controller.abort(); };
    const onFailure = () => { if (retained) controller.abort(); };
    if (retained) { res.once('close', onClose); res.once('error', onFailure); req.once('aborted', onFailure); }
    try {
      const init = { method: req.method, headers: req.headers, ...(retained ? { signal: controller.signal } : {}) };
      if (!['GET', 'HEAD'].includes(req.method)) { init.body = req; init.duplex = 'half'; }
      const request = new Request(new URL(req.url || '/', 'http://kdna.invalid'), init);
      const response = await server.handle(request, {
        operation: mountedOperation(req), context: options.getContext ? (retained ? { then(resolve, reject) { Promise.resolve().then(() => options.getContext(req)).then(resolve, reject); } } : await options.getContext(req)) : undefined,
        async deliverResponse(prepared) {
          sent = true;
          return sendWebResponse(res, prepared, timeoutMs);
        },
      });
      if (!sent) { sent = true; await sendWebResponse(res, response, timeoutMs); }
    } catch {
      if (!res.headersSent && !res.destroyed) {
        await sendWebResponse(res, new Response(null, { status: 500 }), timeoutMs);
      } else if (!res.destroyed) res.destroy();
      // Provider errors and private request data are never forwarded to middleware.
      if (typeof next === 'function') next();
    } finally {
      if (retained) { res.off('close', onClose); res.off('error', onFailure); req.off('aborted', onFailure); }
    }
  };
  Object.defineProperties(middleware, { dispose: { value: () => server.dispose() },
    retentionState: { value: () => server.retentionState() } });
  return middleware;
}
