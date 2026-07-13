# Changelog

## 0.2.2 (2026-07-13)

- Correct the published installation documentation to require KDNA Core
  0.16.0, matching the package peer dependency and tested runtime.

## 0.2.1 (2026-07-13)

- Map password/decryption failures to a generic 401 response and authorization
  denial to a generic 403 response.
- Prevent provider error bodies, crypto details, local paths, and stack
  information from crossing the public HTTP boundary.
- Document and test the actual Runtime Capsule response shape.
- Align the adapter peer and test runtime with KDNA Core 0.16.0.

## 0.2.0 (2026-07-13)

- Load the current KDNA Core package root instead of the removed versioned subpath.
- Pin Core 0.15.12 and default load responses to Runtime Capsules.
- Keep validation, authorization, decryption, and profile selection inside Core.
- Normalize Capsule responses across Next.js, Express, and Cloudflare Workers.

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
