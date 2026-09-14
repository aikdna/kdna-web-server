# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, use one of these private channels:

- **GitHub Private Vulnerability Reporting**: Go to the [Security Advisories](https://github.com/aikdna/kdna-web-server/security/advisories/new) page
- **Email**: security@aikdna.com

We aim to respond within 72 hours and provide a timeline for resolution within 1 week.
Please do not disclose the vulnerability publicly until we have had a chance to address it.

## Supported Versions

`kdna-web-server` is a pre-release web adapter support surface. Until the first
stable package release, security support tracks the latest mainline pre-release
and the canonical KDNA protocol/runtime surfaces.

| Component | Supported Versions |
|-----------|-------------------|
| KDNA Protocol | Latest tagged release |
| kdna-cli | Latest minor release |
| kdna-web-server | Latest mainline pre-release |

Older pre-release versions may receive critical security patches on a
case-by-case basis.

## Security Model

`kdna-web-server` adapts public Core and Read APIs for server-side web runtimes.
Core and Read own container admission, component interpretation, disclosure,
handle authority and diagnostics. The Host supplies the embedding's independent
policy and delivery boundary; asset content does not authorize an action.

For the KDNA Protocol security architecture, see
[GOVERNANCE.md](https://github.com/aikdna/kdna/blob/main/docs/GOVERNANCE.md)
in the main protocol repository.

## Retained Host candidate

The current Host `0.5.0-rc.component-semantics.1` binds Core
`0.24.0-rc.component-semantics.2` and Read `0.3.0-rc.component-semantics.2`.
Exact artifact digests are recorded in `docs/current-core-read-binding.json`;
this source candidate does not establish a package release or deployment.
Retention is explicit and default off. The embedding owns fixed
identity/domain verification and policy; client session IDs grant no authority.
See [retained sessions](docs/host-retained-session.md) for terminal revocation,
absolute deadlines, caps, uncooperative callback accounting and proof limits.
Only formal Read success and actual Node/Express finish can commit.
