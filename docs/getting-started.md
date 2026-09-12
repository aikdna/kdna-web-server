# Getting started

Use the exact authorized Core 0.23.0 and Read 0.2.0 artifacts with the local
Web Server 0.4.0-rc.host-session.1 candidate. The candidate is not a registry
release. [README](../README.md) describes isolated installation and the unchanged
multipart `file` plus public Read `request` surface.

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
