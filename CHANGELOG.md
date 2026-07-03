# Changelog

## 0.1.1 (2026-07-03)

- Load the default runtime from `@aikdna/kdna-core/v1` so published
  generated apps can call `/inspect`, `/plan-load`, and `/load` against
  the current Core v1 API.
- Normalize `repository.url` metadata for npm.
- Use a CI-portable test glob.
- Add `prepublishOnly` release protection.

## 0.1.0 (2026-07-03)

Initial public release of the KDNA web server.

- Server runtime with storage abstraction
- Adapters: Next.js (app + pages router), Express, Cloudflare Workers
- `@aikdna/kdna-web-server` scoped npm package
- Getting started docs, adapter boundaries, and security model
