import { createKDNAServer } from '../../index.js';

export function createNextHandlers(options = {}) {
  const server = createKDNAServer(options);

  async function handler(request, context = {}) {
    const params = await context.params;
    const route = params?.route;
    const operation = Array.isArray(route) && route.length === 1 ? route[0] : route;
    return server.handle(request, { operation });
  }

  return {
    GET: handler,
    POST: handler,
  };
}
