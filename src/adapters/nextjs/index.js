import { createKDNAServer } from '../../index.js';

export function createNextHandlers(options = {}) {
  const server = createKDNAServer(options);

  async function handler(request, context = {}) {
    const route = context.params?.route;
    const operation = Array.isArray(route) ? route.at(-1) : route;
    return server.handle(request, { operation });
  }

  return {
    GET: handler,
    POST: handler,
  };
}
