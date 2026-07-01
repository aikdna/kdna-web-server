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
  remoteServerUrl:     process.env.KDNA_REMOTE_URL,
})

export { GET, POST }
```

This registers all six endpoints under `/api/kdna/`.

### Individual route files

If you need finer-grained control, you can mount each handler
separately:

```js
// app/api/kdna/validate/route.js
import { validateHandler } from '@aikdna/kdna-web-server/nextjs'
export const POST = validateHandler({ storageDir: '/tmp/kdna' })

// app/api/kdna/load/route.js
import { loadHandler } from '@aikdna/kdna-web-server/nextjs'
export const POST = loadHandler({ storageDir: '/tmp/kdna' })
```

---

## Pages Router

```js
// pages/api/kdna/[...route].js
import { createNextPagesHandler } from '@aikdna/kdna-web-server/nextjs'

export default createNextPagesHandler({
  storageDir: process.env.KDNA_STORAGE_DIR ?? '/tmp/kdna',
})

export const config = {
  api: {
    bodyParser: false,   // required — multipart/form-data handled internally
  },
}
```

---

## Server Actions

If you prefer Server Actions over API routes, call the adapter
functions directly:

```js
// app/actions/kdna.js
'use server'

import { validateKDNA, inspectKDNA, loadKDNA } from '@aikdna/kdna-web-server'

export async function validateAsset(formData) {
  const file = formData.get('file')
  return validateKDNA(file, { storageDir: '/tmp/kdna' })
}
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `KDNA_STORAGE_DIR` | Where uploaded files are stored temporarily |
| `KDNA_ACTIVATION_URL` | URL of an `@aikdna/kdna-activation-server` instance |
| `KDNA_REMOTE_URL` | URL of an `@aikdna/kdna-remote-server` instance |

---

## Deployment notes

- Vercel edge functions: use the Cloudflare Workers adapter instead —
  the Next.js adapter targets the Node.js runtime.
- Vercel Node.js runtime: set `storageDir` to `/tmp` (ephemeral but
  available within a single invocation).
- Self-hosted: any writable path works. Clean up stale files with a
  cron job or set a short TTL in the configuration.
