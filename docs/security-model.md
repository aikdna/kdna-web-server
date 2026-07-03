# Security model

This document defines what `@aikdna/kdna-web-server` does on the
server, what it sends to the client, and what constraints can never
be relaxed.

---

## Trust boundary

```
Browser                         Server (this package)
──────                          ──────────────────────
File bytes        ──upload──▶   Temporary storage
File metadata     ◀─inspect──   Inspect (no decrypt)
Load-plan state   ◀─plan-load── Evaluate requirements
Password (HTTPS)  ──load──────▶ Authorize → decrypt → format content
License key       ──activate──▶ Proxy to activation server
                  ◀─────────── Signed entitlement record
```

The line between browser and server is not a performance choice or a
configuration option. It is a security requirement.

---

## What the browser is allowed to receive

| Data | Allowed | Reason |
|------|---------|--------|
| Domain, version, title, description | Yes | Public manifest fields |
| LoadPlan requirements (what is needed) | Yes | Drives UI state |
| Formatted payload content (after load) | Yes | The purpose of `/load` |
| Encrypted payload bytes | No | Decryption must be server-side |
| Decryption keys or derived key material | Never | Would defeat encryption |
| Passwords or license keys (echoed back) | Never | Single-use credentials |
| Entitlement tokens (signed by activation server) | Yes | Client needs to present these |

---

## Credential handling

Passwords and license keys sent to `/load` or `/activate` are:

1. Accepted over HTTPS only (enforce TLS in production).
2. Scoped to the current request.
3. Never written to disk, logs, or response bodies.

There is no session storage of credentials. Each `/load` call requires
the credential to be supplied again.

---

## File storage

Uploaded `.kdna` files are stored in `storageDir` for the duration of
the request or a configurable TTL. Files are:

- Identified by a server-generated ID, not the original filename.
- Validated when `/validate` is called. `inspect`, `plan-load`, and
  `load` delegate format checks to the configured KDNA runtime.
- Not accessible by URL — only via the `/inspect`, `/plan-load`, and
  `/load` endpoints with the correct `fileId`.
- Automatically cleaned up after TTL expiry (default: 1 hour).

Do not set `storageDir` to a path served by a static file server.

---

## HTTPS requirement

All credential fields (`password`, `license_key` / `licenseKey`,
`entitlementToken`)
must travel over HTTPS. If you deploy behind a reverse proxy (nginx,
Cloudflare, etc.), ensure TLS is terminated at or before your
application boundary, not after.

Local development over HTTP is acceptable. Production deployments
over plain HTTP are not.

---

## What this package does not enforce

These are left to the application layer:

- **Authentication** — which users may upload files or call `/load`.
  Wrap the router in your own auth middleware.
- **Authorization** — which users may load which assets. Check the
  asset `domain` against your user's entitlements before forwarding
  to `/load`.
- **Rate limiting** — apply at your load balancer or middleware layer.
- **Audit logging** — log which user loaded which asset and when. This
  package does not log credential usage.

---

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
