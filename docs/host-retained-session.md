# Retained Read sessions

Normative authority is `/engineering/host_retained_session_profile` in the public
semantic source, contract `kdna.host-retained-read-session/0.1.0`. The generated
`src/profile.js` projection is mechanically checked against the frozen source.
This guide explains that contract; it is not a separate semantic authority.

## Trusted configuration

`retainedSession` is false by default, or a closed `RetainedReadSessionOptions`
object with required `binding_id`, `authorization_domain_id` and `verifyContext`.
Identifiers are nonempty Unicode-scalar strings of at most 256 UTF-8 bytes, with
no control characters. `verifyContext(context)` must return true only after
independent verification of the fixed embedding binding and authorization domain.
It may return a Promise. Unknown fields, accessors and invalid limits reject
before retention or timers start. The embedding owns `getContext` and policy;
HTTP input and client `session_id` cannot establish or replace them.

| Optional retained field | Default | Maximum |
| --- | ---: | ---: |
| `ttlMs` | 30000 | 300000 |
| `maxRetainedContainerBytes` | 10485760 | 10485760 |
| `maxRetainedViewBytes` | 16777216 | 16777216 |
| `maxReads` | 16 | 16 |
| `maxHandleRecords` | 256 | 256 |
| `maxHandleRecordBytes` | 1048576 | 1048576 |

All optional values are positive safe integers. The effective read maximum also
cannot exceed the existing Host `maxReads`. Retained mode allows only one
in-flight read and one retained snapshot. Input/response/control caps are at most
10 MiB/1 MiB/4 KiB; multipart/request JSON caps stay 12 MiB/64 KiB. Configurations
may tighten but cannot raise these limits. The per-call callback timeout uses
`policyTimeoutMs`, default 5000 and maximum 30000, and covers trusted context
resolution, verification, policy and delivery. Request and Express delivery
transport timers remain independently bounded.

## Lifecycle and authority

A valid instance begins `unbound`. After trusted verification and bounded
independent input capture, it becomes `preparing` and starts one absolute
monotonic deadline. It observes the actual snapshot through the original trusted
Read provider during the first public `readNode` call. The pending snapshot is
not active during projection or delivery. No inspected view or serialized IR can
substitute for this same-Core object.

Prepared ready results enter `delivering`. Only trusted finish confirmation and
the same formal Read success activate snapshot and bytes. Later reads must match
the retained input byte for byte, then invoke public `readBrowser(snapshot, ...)`
with the original provider and trusted control. There is no new Core admission,
digest recomputation, custom resolver or Host handle authority registry on reuse.

Request IDs are reserved atomically only when formally admitted requests first
enter the original provider's Host observation. Repeated observations within one
call do not reserve again. Earlier formal diagnostics retain precedence. Duplicate
IDs throw a fixed internal failure through Read, yielding its existing 502/null
transport result without latching asset denial. Valid issued handles remain
reusable with fresh admitted IDs, subject to Read's registry and fresh policy.
The original Read denial latch remains; retention never lifts it on its own.

The trusted policy epoch is fixed; every new Host has a fresh incarnation epoch.
Epoch change, `observePolicy` returning `revoked: true`, trusted invalidation of an
already verified call, expiry or disposal is terminal. A foreign/unverified
incoming context only rejects that call. The embedding uses explicit trusted
policy revocation or `dispose()` to terminate a bound session; a false verification
of an unrelated incoming context is not a revocation command.

TTL never renews. Provider expiry is capped by the earliest absolute session and
independent policy deadline. Invalid/rollback trusted clock values terminate the
instance. Byte mismatch cannot replace its asset. Excess concurrency rejects
immediately without a queue. Every read entry, including rejects and busy calls,
consumes the lifetime attempt budget; parsed HTTP entry limits also count earlier
handler rejects. Failures cannot renew that budget or return a closed instance to
`unbound`.

## Delivery and disposal

Enabled direct Host/handle calls require `settings.deliverResponse`. The callback
receives the original prepared Read result for Host calls, or the exact Response
for server handles. It must return true only at the embedding's actual Node server
`finish` boundary. Express provides this boundary directly and forwards
`dispose()`/`retentionState()` on its callable middleware. Context resolution
runs inside the bounded Host call. Constructing the adapter starts no listener.

Binding, epoch, revocation and deadlines are rechecked before and after trusted
ready delivery. Failed Read, false/throwing confirmation, close, error, abort or
timeout cannot commit ready content. Unconfirmed delivery closes the session.
Read registers handles only on successful delivery; Host commits only matching
pending accounting and the same successful formal result. Bounded control results
can be delivered without activating ready content. A control result returned
after an earlier formal error cannot turn that error into success.

`dispose()` invalidates eligibility first, then releases available Host-owned
input/snapshot/result/context references, timers and abort listeners. External
callbacks cannot be forcibly collected. Unsettled work remains in `active_reads`
until actual settlement, even if a timeout or disposal already returned to the
caller. The original provider and its Read-owned registry are released only when
pending work settles. No late callback can reactivate the closed instance.

`retentionState()` is a frozen, closed `RetainedReadSessionState` with only:
`state`, `active_reads`, `retained_container_bytes`, `retained_view_charge_bytes`,
`issued_handle_records`, `issued_handle_charge_bytes`, `consumed_request_ids`.
It exposes no input, snapshot, handles, identity or binding keys. Closed resource
counters distinguish already released bytes/views from unsettled provider work.
Request-ID consumption remains a lifetime numeric count after identifier storage
is released. Counters confer no authority.

View charge is the UTF-8 byte length of plain JSON of the public Core inspection
view, not JCS or a semantic digest. New handle metadata count and serialized byte
charge are reserved before delivery and committed only after formal success.
These are accounting counters; Host never edits or substitutes Read's registry.
The final Read envelope budget is independent of these retention charges.

## Unsupported surfaces and limits of proof

Enabled Next handlers reject with `HOST_RETAINED_DELIVERY_UNSUPPORTED` because a
framework Response is not actual server finish. The stateless helper rejects
with `HOST_RETAINED_INSTANCE_REQUIRED`; missing confirmation gives
`HOST_DELIVERY_CONFIRMATION_REQUIRED`; closed instances give `HOST_SESSION_CLOSED`.
These are Host management errors, not new Read diagnostics. Default-disabled
Next, direct and Express behavior remains available.

No new HTTP route/header/form field, Web Client API, Core/Read primitive, wire
field, tuple or diagnostic is introduced. This profile does not establish remote
application acknowledgement, global replay prevention, restart persistence,
multi-tenant sessions, precise heap usage, third-party Host acceptance, native
Reader behavior, publishing or completion of the Open ecosystem. Physical bytes
already sent cannot be recalled; failure is never proof of zero bytes transmitted.
