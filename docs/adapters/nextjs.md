# Next.js adapter

`@aikdna/kdna-web-server/nextjs` provides App Router route handlers
and a Pages Router API helper.

---

## App Router (recommended)

### Catch-all route

```js
// app/api/kdna/[...route]/route.js
import { createNextHandlers } from '@aikdna/kdna-web-server/nextjs'

const { GET, POST } = createNextHandlers({
  storageDir: process.env.KDNA_STORAGE_DIR ?? '/tmp/kdna',
  activationServerUrl: process.env.KDNA_ACTIVATION_URL,
})

export { GET, POST }
```

This registers the MVP endpoints under `/api/kdna/`: `health`,
`validate`, `inspect`, `plan-load`, `load`, `activate`, and the
structured `/export` 501 response.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `KDNA_STORAGE_DIR` | Where uploaded files are stored temporarily |
| `KDNA_ACTIVATION_URL` | URL of an `@aikdna/kdna-activation-server` instance |

---

## Deployment notes

- Vercel edge functions: use the Cloudflare Workers adapter instead —
  the Next.js adapter targets the Node.js runtime.
- Vercel Node.js runtime: set `storageDir` to `/tmp` (ephemeral but
  available within a single invocation).
- Self-hosted: any writable path works. Clean up stale files with a
  cron job or set a short `ttlMs` in the configuration.
