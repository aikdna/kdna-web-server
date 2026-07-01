# Cloudflare Workers adapter

`@aikdna/kdna-web-server/cloudflare` provides a request handler
compatible with the Cloudflare Workers fetch API.

---

## Minimal setup

```js
import { createKDNAWorkerRouter } from '@aikdna/kdna-web-server/cloudflare'

const router = createKDNAWorkerRouter({
  storageBucket: null,   // see storage section below
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

Cloudflare Workers do not have a local filesystem. Configure an R2
bucket for temporary file storage:

```js
const router = createKDNAWorkerRouter({
  storageBucket: env.KDNA_BUCKET,   // R2 binding
})
```

Bind the bucket in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "KDNA_BUCKET"
bucket_name = "my-kdna-files"
```

Files stored in R2 are keyed by a server-generated ID and are not
publicly accessible unless you create a public bucket policy. Do not
create a public policy on this bucket.

---

## Secrets

Use Wrangler secrets for sensitive values:

```bash
wrangler secret put KDNA_ACTIVATION_URL
```

Reference them in the router:

```js
const router = createKDNAWorkerRouter({
  storageBucket: env.KDNA_BUCKET,
  activationServerUrl: env.KDNA_ACTIVATION_URL,
})
```

---

## Limitations

- The Cloudflare Workers runtime does not support all Node.js APIs.
  `@aikdna/kdna-web-server/cloudflare` uses the Web Crypto API for
  all cryptographic operations.
- `@aikdna/kdna-studio-core` (Studio export) uses Node.js APIs and is
  not compatible with the Workers runtime. The `/export` endpoint is
  not available in this adapter.
