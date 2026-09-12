# @aikdna/kdna-web-server

Reference Host `0.5.0-rc.component-semantics.1` consumes Core `0.24.0-rc.component-semantics.2`
and Read `0.3.0-rc.component-semantics.2`. The current public Read tuple is `kdna.read/0.2.0`.
The component definition is `sha256:3087cd19542e72322aec19b3015c916d2cfb074fa42e3fd76b3756bb4f097de3`.
Exact dependency archive bytes are listed in `docs/current-core-read-binding.json`;
matching package versions alone do not identify artifact bytes.

The reference Host delegates container admission, Canonical IR, disclosure,
mandatory support, handle authority and diagnostics to public Core and Read.
It supplies the embedding's independent policy and delivery boundary. It does
not parse payload fields, replicate a Validator or grant permission from an asset.

## Default operation

```js
import { createReferenceHost } from '@aikdna/kdna-web-server';
const host = createReferenceHost({ observePolicy: trustedPolicy });
const result = await host.read(containerBytes, publicReadRequest, {
  context: trustedServerContext,
});
```

Retention is off by default. Each default read makes a new Core admission, so a
handle from an earlier call is stale. Missing policy denies disclosure. A trusted
`settings.deliver(result)` callback may confirm delivery; without it, default
operation confirms the in-process return only. Read preserves denial latching;
only independent policy can request a lift. No execution or action is authorized.

## Explicit retained Host

```js
import { createKDNARouter } from '@aikdna/kdna-web-server/express';
const router = createKDNARouter({
  retainedSession: {
    binding_id: 'application-binding',
    authorization_domain_id: 'application-domain',
    verifyContext: trustedContextVerifier,
  },
  getContext: request => establishedServerContext(request),
  observePolicy: trustedPolicy,
});
// Mount this same long-lived callable instance in the embedding's Node server.
// At shutdown or trusted revocation:
router.dispose();
```

The embedding must independently verify the fixed binding and authorization
domain. Matching strings or caller-held session metadata do not authenticate a
request. No identity service is included. An unrelated or unverified context is
rejected without replacing the legitimate binding. Explicit policy revocation,
epoch change, expiry or disposal closes the instance permanently.

One actual same-Core snapshot and the original Read provider survive successful
calls. The first call uses public `readNode`; later calls compare the complete
input bytes and use public `readBrowser` with that same snapshot. Read alone
checks its private handle issuance registry. A valid handle can be used again
with a fresh admitted request ID. A duplicate admitted ID returns the existing
Read transport failure (502, null body); it does not create an asset denial.

Retention activates only after the actual Node/Express response `finish` event
and successful completion of the same formal Read call. A returned Response,
`end()` invocation or client observation cannot confirm it. The embedding must
not share one retained instance across independent bindings or assets.

See [the complete retained contract](docs/host-retained-session.md) for lifecycle,
configuration, accounting, direct callbacks and proof limits.

## Existing HTTP surface

| Operation | Behavior |
| --- | --- |
| `GET /api/kdna` | Local capability summary |
| `POST /api/kdna/validate` | One multipart `file`; Host admission gate plus public Core rejection states |
| `POST /api/kdna/read` | Multipart `file` and `request` containing unchanged public Read JSON |
| `POST /api/kdna/inspect` | Same public Read contract; catalog is a Read mode |
| `/plan`, `/plan-load`, `/load`, `/activate`, `/export`, `/execute` | Existing named 501 capability-unavailable result |

There are no retained-session routes, headers, form fields or Web Client APIs.
Bodies contain the complete canonical Read envelope or admission rejection;
there is no wrapper or partial truncation. Existing empty-body 413/502 channels
and their bounded `x-kdna-*` control headers remain unchanged.

`createKDNAServer(options).handle(request, settings)` supports Node Web Request
handling. Enabled retention requires trusted `settings.deliverResponse(response)`;
it must resolve true only at the real server finish boundary. Direct
`host.read` uses `settings.deliverResponse(readResult)` for the same obligation.
The optional trusted AbortSignal controls transport lifecycle, never identity.
`dispose()` is idempotent. `retentionState()` returns frozen summary counters only.

The callable Express adapter forwards both management methods. Next keeps its
default stateless behavior and rejects enabled retention with
`HOST_RETAINED_DELIVERY_UNSUPPORTED`. The per-request `handleKDNARequest` helper
rejects enabled retention with `HOST_RETAINED_INSTANCE_REQUIRED`.

## Limits and verification

Default stateless limits remain: input 10 MiB, response 1 MiB, admission control
4 KiB, multipart 12 MiB, request JSON 64 KiB, 1024 reads and four concurrent reads.
Timeout defaults remain five seconds and cannot exceed 30 seconds.
Enabled retention tightens these to the fixed HRSP01 session bounds. Core also
retains its independent input/resource caps. Timers cannot preempt synchronous
Core execution, and these accounting limits are not precise heap or process caps.

For an isolated current source copy, the lock uses the eleven exact archives in
`vendor/`. Use a local npm cache with `npm ci --offline --ignore-scripts
--omit=optional --no-audit --no-fund`, then `npm test`, `npm run lint`, and
`npm pack --ignore-scripts --json`. `npm run check:current-graph` verifies the
current dependency coordinates, archive hashes and component definition.
The historical HRSP01 source projection checker remains available as
`npm run check:legacy-hrsp01 -- path/to/public-semantic-source.json` for its
original pinned source, and does not establish the current graph.

Current focused tests use synthetic containers, public Core/Read, actual
in-process Request/Response handoff and deterministic delivery callbacks.
They do not open an OS HTTP server or exercise a current Web Client release.
Historical loopback and Web Client tests are retained for their original graph.
No browser/native/production deployment is established. Server finish does not
prove remote receipt or application ACK.

Apache-2.0. See [LICENSE](LICENSE).

## Current component graph

`validate().valid` retains its existing meaning: whether public Core admission
accepted the bytes for this Host. Its accepted result remains exactly
`{ valid: true, action_authorization: 'not_evaluated' }`. A rejected result keeps
`valid: false` and `code`, and now also carries Core's unmodified `states`,
`diagnostics`, and `component_failure`. For example, technically valid content
whose component interpretation is blocked still has `valid: false`, while
`states.core` is `valid` and `states.interpretation` is `blocked`. No rejected
snapshot or component body is disclosed and this result grants no action.

Ordinary content, explicit empty components and authored method presence use
the same current Core and Read graph. Retained session policy, budget, handle
issuance, revocation and delivery rules remain in force. Read owns component
interpretation and expansion authority; Host does not reconstruct component
bodies or reinterpret a missing field as an empty collection.

`npm test` runs the current graph checks and focused Host component/service
tests. Historical tests and audit files remain for their original pinned graph;
`test:legacy-graph` and `check:legacy-hrsp01` are not current-graph acceptance.
The legacy web-client is not installed into this Host's current graph. Its
cross-network integration requires the corresponding current client release.
In-process Response handoff and server-side stream finish are not remote ACKs.
