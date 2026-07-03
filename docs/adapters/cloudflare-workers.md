# Cloudflare Workers adapter

`@aikdna/kdna-web-server/cloudflare` provides a request handler
compatible with the Cloudflare Workers fetch API.

---

## Minimal setup

```js
import { createKDNAWorkerRouter } from '@aikdna/kdna-web-server/cloudflare'

const router = createKDNAWorkerRouter({
  storage: customStorage,
  activationServerUrl: null,
})

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/kdna')) {
      return router.handle(request, env, ctx)
    }
    return new Response('Not found', { status: 404 })
  },
}
```

---

## Storage

Cloudflare Workers do not have a local filesystem. The MVP adapter uses
in-memory storage by default, which is useful for local smoke tests but
is not durable across isolate restarts. Production Workers should pass a
custom storage adapter:

```js
const router = createKDNAWorkerRouter({
  storage: {
    async put(file) { /* write bytes to R2 or another private store */ },
    async get(fileId) { /* return stored metadata for the runtime */ },
    async remove(fileId) {},
    async cleanup() {},
  },
})
```

Do not expose the storage bucket or object keys publicly.

---

## Secrets

Use Wrangler secrets for sensitive values:

```bash
wrangler secret put KDNA_ACTIVATION_URL
```

Reference them in the router:

```js
const router = createKDNAWorkerRouter({
  storage: customStorage,
  activationServerUrl: env.KDNA_ACTIVATION_URL,
})
```

---

## Limitations

- The default KDNA core runtime may require APIs that are not available
  in Workers. Pass a Worker-compatible `runtime` option before treating
  this adapter as production-ready on Cloudflare.
- `@aikdna/kdna-studio-core` (Studio export) uses Node.js APIs and is
  not compatible with the Workers runtime. The `/export` endpoint is
  not available in this adapter.
