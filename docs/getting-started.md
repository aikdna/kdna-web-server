# Getting started

This page is the current entry for the reference Host. It replaces the earlier
`0.4.0-rc.host-session.*` quickstart, whose Core 0.23.0 / Read 0.2.0 coordinates
belong to that superseded candidate and must not be mixed with this graph.

## Coordinates

| Item | Value |
|---|---|
| Reference Host | `0.5.0-rc.component-semantics.1` (unpublished candidate; the published adapter is `0.3.1`) |
| Core | `0.24.0-rc.component-semantics.2` |
| Read | `0.3.0-rc.component-semantics.2`, contract `kdna.read/0.2.0` |
| Component definition | `sha256:3087cd19542e72322aec19b3015c916d2cfb074fa42e3fd76b3756bb4f097de3` |
| Exact archive bytes | [`current-core-read-binding.json`](./current-core-read-binding.json) |

Matching version labels alone do not identify the tested graph. Install only the
archive bytes recorded in that binding file; this candidate is not a registry
release.

## Minimal Host read

```js
import { createReferenceHost } from '@aikdna/kdna-web-server';

const host = createReferenceHost({ observePolicy: trustedServerPolicy });
const result = await host.read(containerBytes, publicReadRequest, {
  context: trustedServerContext,
});
```

`observePolicy` and the server context are supplied by the embedding, never
derived from uploaded fields. Retention is off by default, so every default read
calls public Core again and a handle from an earlier call is stale. Missing
policy denies disclosure, and `settings.deliver(result)` is the only way to
confirm delivery beyond the in-process return.

The HTTP surface is the unchanged multipart `file` field plus the public Read
`request` field. [README](../README.md) describes isolated installation.

Default `createReferenceHost`, `createKDNAServer`, Express and Next operation is
stateless and default deny. Supply independent server policy; do not derive it
from uploaded fields. Technical `validate` never grants read/action authority.

For repeated expansion, create one long-lived Node/Express instance with explicit
trusted `retainedSession` configuration. Use the same input bytes and binding;
first obtain a delivered public Read handle, then submit an unchanged public
expand request with a fresh request ID. Read remains the only handle authority.
See [retained sessions](host-retained-session.md), [Express](adapters/express.md)
and [Next](adapters/nextjs.md). No fileId, persistent upload or activation service
is provided by this reference Host.

## Not provided

No identity service, no persistent upload or file-id store, no activation
proxy, no action authorization and no transparent compatibility with the retired
`fileId`/`load` API. A rejected asset stays rejected: technically valid content
whose component interpretation is blocked still has `valid: false`. Server
stream finish is not a remote application acknowledgement.
