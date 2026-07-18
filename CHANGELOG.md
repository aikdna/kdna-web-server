# Changelog

## 0.3.0 (2026-07-18)

- Bind the adapter to the exact published `@aikdna/kdna-core@0.20.0` runtime
  and current `kdna.runtime-capsule` contract.
- Verify validate, inspect, plan-load, and load against the accepted public
  Laozi asset 0.1.1 in CI.
- Change the default activation proxy target to the responsibility route
  `/entitlements/activate` without retaining a compatibility alias.
- Integrate the exact Activation 0.2 package and cover bound and unbound
  entitlement activation.
- Enforce canonical asset IDs, routes, activation origins, request and response
  byte limits, total response timeouts, no redirects, and strict successful
  entitlement response fields.
- Remove local paths, provider details, credential fields, and raw runtime
  results from public JSON responses; invalid containers now return
  `valid: false`, and non-Capsule load results fail closed.
- Correct Core inspect mapping for encryption state and default profile.
- Limit the verified runtime surface to Node.js-hosted Next.js and Express;
  remove the unverified Worker adapter and export.
- Add public-surface, protocol-name, exact-release-event, immutable-action, and
  exact-asset release gates.
- Require future GitHub Release tags to equal the package's natural SemVer
  coordinate without a generation-style prefix.
- Add upstream route enforcement to the activation proxy integration test.

## 0.2.3 (2026-07-14)

- Pin the tested KDNA Core compatibility declaration to 0.17.0.
- Install the exact Core 0.17.0 registry package in CI and keep the development
  lockfile on the same version.
- Run the real server adapter against a public KDNA asset through validation,
  inspection, load planning, and Runtime Capsule loading.

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

- Load the default runtime from the now-removed versioned Core subpath so
  published generated apps could call `/inspect`, `/plan-load`, and `/load`
  against the then-current Core API.
- Normalize `repository.url` metadata for npm.
- Use a CI-portable test glob.
- Add `prepublishOnly` release protection.

## 0.1.0 (2026-07-03)

Initial public release of the KDNA web server.

- Server runtime with storage abstraction
- Adapters: Next.js (app + pages router), Express, Cloudflare Workers
- `@aikdna/kdna-web-server` scoped npm package
- Getting started docs, adapter boundaries, and security model
