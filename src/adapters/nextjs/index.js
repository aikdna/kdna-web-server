import { createKDNAServer, KDNAWebServerError } from '../../index.js';

export function createNextHandlers(options = {}) {
  if (options.retainedSession !== undefined && options.retainedSession !== false) throw new KDNAWebServerError('HOST_RETAINED_DELIVERY_UNSUPPORTED');
  const server = createKDNAServer(options);

  async function handler(request, context = {}) {
    const params = await context.params;
    const route = params?.route;
    const operation = Array.isArray(route) ? (route.length === 1 ? route[0] : '__invalid__') : route;
    return server.handle(request, { operation,
      context: options.getContext ? await options.getContext(request) : undefined,
    });
  }

  return {
    GET: handler,
    POST: handler,
  };
}
