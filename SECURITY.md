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

`kdna-web-server` adapts KDNA APIs for server-side web runtimes. It must not
define protocol validity, access modes, LoadPlan states, or crypto policy;
those contracts come from `aikdna/kdna` and conforming core/CLI behavior.

For the KDNA Protocol security architecture, see
[GOVERNANCE.md](https://github.com/aikdna/kdna/blob/main/docs/GOVERNANCE.md)
in the main protocol repository.
