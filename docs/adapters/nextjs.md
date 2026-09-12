# Next handlers

`createNextHandlers` from `@aikdna/kdna-web-server/nextjs` returns Node GET/POST
handlers for the unchanged public Read multipart surface. Supply independently
trusted `getContext(request)` and `observePolicy`; default policy denies reading.

Next supports the default `retainedSession: false` path only. Enabled retention
throws Host-local `HOST_RETAINED_DELIVERY_UNSUPPORTED` before a retained instance
is created. Returning a generic Response cannot confirm the actual Node server
finish event. Use a long-lived Node/Express embedding with its real finish boundary
for the [retained profile](../host-retained-session.md).

No Edge runtime, storage, activation proxy, action execution or Reader integration
is established by these handlers.
