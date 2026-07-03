# @aikdna/kdna-web-server

**Server-side adapter for the KDNA runtime.**

Mount one function call and your Next.js, Express, or Cloudflare Workers
app gains an MVP KDNA API: validate, inspect, plan-load, load, and
activation proxying. Studio export is not included in this server MVP yet.

> **Security invariant:** decryption, license verification, and
> entitlement checks run exclusively server-side. Passwords and
> license keys are never reflected to the client.

> New to KDNA? → [KDNA Core](https://github.com/aikdna/kdna)
>
> Need browser-side file picking and upload? →
> [@aikdna/kdna-web-client](https://github.com/aikdna/kdna-web-client)
>
> Need React components? →
> [@aikdna/kdna-react](https://github.com/aikdna/kdna-react)

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-web-server)](https://www.npmjs.com/package/@aikdna/kdna-web-server)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

---

## Install

```bash
npm install @aikdna/kdna-web-server @aikdna/kdna-core
```

Studio export is planned for a later server milestone. The MVP returns
a structured `501 KDNA_EXPORT_NOT_IMPLEMENTED` response for `/export`.

---

## Quick start

### Next.js (App Router)

```js
// app/api/kdna/[...route]/route.js
import { createNextHandlers } from '@aikdna/kdna-web-server/nextjs'

const { GET, POST } = createNextHandlers({
  storageDir: process.env.KDNA_STORAGE_DIR ?? './kdna-files',
  activationServerUrl: process.env.KDNA_ACTIVATION_URL,    // optional
})

export { GET, POST }
```

That single route file registers:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/kdna/validate` | Validate a `.kdna` file |
| `POST` | `/api/kdna/inspect` | Return manifest and load-plan metadata |
| `POST` | `/api/kdna/plan-load` | Evaluate the LoadPlan and return requirements |
| `POST` | `/api/kdna/load` | Decrypt and return the formatted payload |
| `POST` | `/api/kdna/activate` | Proxy an entitlement activation request |
| `POST` | `/api/kdna/export` | Not implemented in the MVP; returns `501` |

→ [Full Next.js guide](./docs/adapters/nextjs.md)

### Express

```js
import express from 'express'
import { createKDNARouter } from '@aikdna/kdna-web-server/express'

const app = express()
app.use('/api/kdna', createKDNARouter({
  storageDir: process.env.KDNA_STORAGE_DIR ?? './kdna-files',
}))
app.listen(3000)
```

→ [Full Express guide](./docs/adapters/express.md)

### Cloudflare Workers

```js
import { createKDNAWorkerRouter } from '@aikdna/kdna-web-server/cloudflare'

const router = createKDNAWorkerRouter({
  storage: customStorage,
})

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
}
```

→ [Full Cloudflare Workers guide](./docs/adapters/cloudflare-workers.md)

---

## HTTP API reference

All endpoints accept `multipart/form-data` or `application/json` as
noted. All responses are `application/json`.

### `POST /validate`

Validate a `.kdna` file. Returns the validation result without loading
any content.

**Request** (`multipart/form-data`)

| Field | Type | Description |
|-------|------|-------------|
| `file` | File | The `.kdna` file to validate |

**Response**

```json
{
  "valid": true,
  "domain": "@author/asset-name",
  "version": "1.2.0",
  "warnings": []
}
```

---

### `POST /inspect`

Return the manifest and LoadPlan metadata from a `.kdna` file.
No decryption is performed.

**Request** (`multipart/form-data`)

| Field | Type | Description |
|-------|------|-------------|
| `file` | File | The `.kdna` file to inspect |

**Response**

```json
{
  "domain": "@author/asset-name",
  "version": "1.2.0",
  "title": "Asset display name",
  "description": "...",
  "loadPlan": {
    "mode": "password",
    "requirements": ["password"]
  },
  "profiles": ["compact", "full"],
  "encrypted": true
}
```

---

### `POST /plan-load`

Evaluate the LoadPlan for a `.kdna` file and return what the client
needs to provide before `/load` will succeed.

**Request** (`application/json`)

```json
{
  "fileId": "abc123",
  "context": {
    "hasPassword": false,
    "hasLicenseKey": false,
    "entitlementToken": null
  }
}
```

**Response**

```json
{
  "canProceed": false,
  "missing": ["password"],
  "requirements": {
    "password": { "required": true, "hint": "Contact the asset author." },
    "licenseKey": { "required": false }
  }
}
```

---

### `POST /load`

Decrypt and load a `.kdna` file. Returns the formatted payload.

> **Security:** the `password` and `licenseKey` fields travel from
> the client to this endpoint over HTTPS and are used for the single
> in-flight decryption. They are not logged, stored, or returned.

**Request** (`application/json`)

```json
{
  "fileId": "abc123",
  "profile": "compact",
  "password": "...",
  "licenseKey": "...",
  "entitlementToken": "..."
}
```

All credential fields are optional — provide only what the LoadPlan
requires.

**Response**

```json
{
  "domain": "@author/asset-name",
  "version": "1.2.0",
  "profile": "compact",
  "content": "... formatted judgment payload ..."
}
```

---

### `POST /export`

Studio export is not implemented in the server MVP yet.

**Response** — `501 application/json`

```json
{
  "error": {
    "code": "KDNA_EXPORT_NOT_IMPLEMENTED",
    "message": "KDNA export is not included in the server MVP yet."
  }
}
```

---

### `POST /activate`

Proxy an entitlement activation request to the configured activation
server. Returns the signed entitlement record.

**Request** (`application/json`)

```json
{
  "domain": "@author/asset-name",
  "licenseKey": "KDNA-LIC-customer-1",
  "machineFingerprint": "..."
}
```

**Response** — the signed entitlement record from the activation server.

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storageDir` | `string` | OS temp dir | Directory where uploaded `.kdna` files are stored temporarily by the default Node storage adapter. |
| `storage` | `object` | file storage | Custom storage adapter with `put`, `get`, `remove`, and `cleanup` methods. |
| `ttlMs` | `number` | `3600000` | Upload TTL for the default file storage adapter. |
| `maxFileSizeBytes` | `number` | `10485760` | Maximum accepted file size (10 MB). |
| `activationServerUrl` | `string` | `undefined` | URL of a `@aikdna/kdna-activation-server` instance. Required to use `/activate`. |
| `activationPath` | `string` | `/activate` | Path used when proxying activation requests. |

---

## Security model

See [docs/security-model.md](./docs/security-model.md) for the
authoritative description of what runs server-side vs. what the
browser is allowed to see.

**Short version:**

- The browser never receives encrypted payload bytes or decryption keys.
- `/load` returns formatted content only after the server-side runtime
  authorizes and loads the asset.
- Passwords and license keys are single-use: they travel to `/load` or
  `/activate` over HTTPS and are not returned in responses.
- `/validate` and `/inspect` operate on public metadata only.
- `/plan-load` tells the client what is required but reveals no secrets.

---

## Related packages

| Package | Role |
|---------|------|
| [`@aikdna/kdna-core`](https://github.com/aikdna/kdna) | KDNA format, schemas, and runtime loading contract |
| [`@aikdna/kdna-studio-core`](https://github.com/aikdna/kdna-studio-core) | Studio authoring kernel; server-side export integration is planned after the MVP |
| [`@aikdna/kdna-activation-server`](https://github.com/aikdna/kdna-activation-server) | Self-hosted license activation server |
| [`@aikdna/kdna-remote-server`](https://github.com/aikdna/kdna-remote-server) | Self-hosted remote projection server |
| [`@aikdna/kdna-web-client`](https://github.com/aikdna/kdna-web-client) | Browser-side file picking, upload, and load-plan state |
| [`@aikdna/kdna-react`](https://github.com/aikdna/kdna-react) | React components and hooks |
| [`create-kdna-web-app`](https://github.com/aikdna/create-kdna-web-app) | Project scaffolding CLI |

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
