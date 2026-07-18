# Contributing to kdna-web-server

## Issues

Open an issue at the repository. Include:

- Node.js version (`node --version`)
- Framework and version (Next.js or Express on Node.js)
- Minimal reproduction steps
- Expected vs actual behavior
- Any relevant error output or stack trace

If proposing a feature, tag the issue `[RFC]` and describe the problem
before the solution.

## Pull Requests

1. Fork and branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. All commits must be signed off: `git commit -s`
4. Title format: `area: what changed` (e.g. `nextjs: fix handler content-type header`)
5. Verify before opening:
   - `npm test` passes
   - `npm run lint` passes (if available)
   - The affected adapter builds and responds correctly to a test request

## Security Issues

Do **not** report security vulnerabilities through public GitHub issues.
See [SECURITY.md](./SECURITY.md) for the private reporting path.

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by:` line.
Use `git commit -s` to add it automatically.

This certifies that you wrote the code or have the right to submit it
under Apache-2.0. No CLA is required.

## Adapter Contributions

When adding a new framework adapter:

1. Create `src/adapters/<framework>/` with `index.js` and a type
   declaration file.
2. Add `docs/adapters/<framework>.md` with an installation section,
   a minimal working example, and notes on any framework-specific
   constraints.
3. Add at least one integration test in `tests/adapters/<framework>/`.
4. Update the adapter table in `README.md`.

## Security Constraints (Non-Negotiable)

Contributions that violate the following will be rejected:

- Decryption, license verification, and entitlement checks **must** remain
  server-side. Do not move these operations to a browser-accessible code
  path.
- Passwords, license keys, and entitlement tokens **must never** be
  reflected back to the client in any response body or header.
- The server **must** validate that a KDNA file passes `kdna validate`
  before proceeding with any load or export operation.
- LoadPlan requirements **must** be enforced before returning a decrypted
  payload.

These rules are part of the security model, not implementation details.
