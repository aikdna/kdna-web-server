# Getting started with @aikdna/kdna-web-server

This guide walks through the minimum viable setup for a Next.js App
Router project. The same concepts apply to Express and Cloudflare
Workers — see the adapter guides linked at the end.

---

## Prerequisites

- Node.js 18 or later
- An existing Next.js 14+ project, Express app, or Cloudflare Workers
  project
- `@aikdna/kdna-core` installed

---

## Step 1 — Install

```bash
npm install @aikdna/kdna-web-server @aikdna/kdna-core
```

Use `@aikdna/kdna-core@0.17.0` with this server MVP. Other Core versions are
outside the adapter's current tested compatibility declaration.

Studio export is not included in the server MVP yet.

---

## Step 2 — Create the API route (Next.js)

```js
// app/api/kdna/[...route]/route.js
import { createNextHandlers } from '@aikdna/kdna-web-server/nextjs'

const { GET, POST } = createNextHandlers({
  storageDir: process.env.KDNA_STORAGE_DIR ?? '/tmp/kdna',
  activationServerUrl: process.env.KDNA_ACTIVATION_URL,
})

export { GET, POST }
```

---

## Step 3 — Set environment variables

```bash
# .env.local
KDNA_STORAGE_DIR=/tmp/kdna

# Only needed if you use licensed-mode assets:
KDNA_ACTIVATION_URL=https://your-activation-server.example.com

```

---

## Step 4 — Verify the API is running

```bash
npm run dev
curl -X POST http://localhost:3000/api/kdna/validate \
  -F "file=@path/to/your.kdna"
```

Expected response:

```json
{
  "valid": true,
  "domain": "@author/asset-name",
  "version": "1.0.0",
  "warnings": []
}
```

---

## Step 5 — Load a KDNA asset end-to-end

```bash
# 1. Upload and inspect
curl -X POST http://localhost:3000/api/kdna/inspect \
  -F "file=@path/to/your.kdna"

# 2. Check load-plan requirements
curl -X POST http://localhost:3000/api/kdna/plan-load \
  -H "Content-Type: application/json" \
  -d '{"fileId":"<id from inspect>","context":{}}'

# 3. Load (for an unencrypted asset — no password needed)
curl -X POST http://localhost:3000/api/kdna/load \
  -H "Content-Type: application/json" \
  -d '{"fileId":"<id from inspect>","profile":"compact"}'
```

---

## Next steps

- [API reference](../README.md#http-api-reference)
- [Security model](./security-model.md) — understand the server/browser
  trust boundary before adding authentication
- [Next.js adapter guide](./adapters/nextjs.md)
- [Express adapter guide](./adapters/express.md)
- [Cloudflare Workers adapter guide](./adapters/cloudflare-workers.md)
- [Build a complete UI](https://github.com/aikdna/kdna-react)
