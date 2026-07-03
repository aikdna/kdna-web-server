import { createKDNAServer } from '../../index.js';
import { createMemoryStorage } from '../../storage.js';

export function createKDNAWorkerRouter(options = {}) {
  const server = createKDNAServer({
    storage: options.storage || createMemoryStorage(),
    ...options,
  });

  return {
    handle(request, env = {}, ctx = {}) {
      return server.handle(request, { env, ctx });
    },
  };
}
