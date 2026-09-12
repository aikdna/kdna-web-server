# Express / Node

`createKDNARouter` from `@aikdna/kdna-web-server/express` returns callable Node
middleware and starts no network listener. The embedding mounts that instance
and supplies independently trusted `getContext(req)` and `observePolicy`.

Retention defaults off. When explicitly enabled, keep one instance for one fixed
binding and one input asset. Trusted context resolution and policy callbacks are
bounded; only real response `finish` plus formal Read success commits retention.
Close/error/abort/timeout cannot commit. `end()` alone is insufficient.
`deliveryTimeoutMs` defaults to 5000 and is bounded at 30000.

The callable forwards `dispose()` and `retentionState()`. Dispose it at shutdown
or trusted bound revocation. See the [retained contract](../host-retained-session.md)
and [HTTP surface](../../README.md). Server finish does not prove client ACK.
