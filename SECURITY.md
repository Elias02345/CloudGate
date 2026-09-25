# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest release (currently `v0.6.0`) on `main` | ✅ |
| `dev` / nightly builds (`:nightly`) | ⚠️ best-effort |
| anything older | ❌ |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting: open a
[**new security advisory**](https://github.com/Elias02345/CloudGate/security/advisories/new)
("Report a vulnerability" on the repo's Security tab).

Include:
- Affected version (`docker inspect` or `/api/health` output)
- Steps to reproduce
- Impact assessment
- Any proposed mitigation

You'll get an acknowledgement within 7 days. Critical issues will be patched on `main` and a CVE published if applicable.

## Release Signing

Signed releases are planned but not yet enabled — no release is currently GPG-signed.

The self-updater's integrity check does not depend on signing: it enforces a
mandatory SHA256 checksum on every downloaded release and aborts the update if
it's missing or doesn't match. GPG signature verification will run only once a
release actually ships a signature; see `CLAUDE.md` §5 for the current state.

## Threat Model (overview)

CloudGate is designed for self-hosted homelab use. We assume:
- The host machine is trusted by its owner.
- Network exposure is the user's choice (UI on LAN, services via Cloudflare Tunnel).
- The Cloudflare API token is the most sensitive secret — stored encrypted at rest.

We protect against:
- ✅ Stolen DB without keys (token encryption AES-256-GCM)
- ✅ Brute-force login (rate limiting + Argon2id + optional 2FA)
- ✅ Container brick-state (Recovery UI + rollback)
- ✅ Tampered release downloads (mandatory SHA256 verification)
- ✅ Unauthenticated admin takeover of a fresh install — first-run setup (`POST /api/setup`) is usable exactly once, only from the local network, and only for a short window after process start (`CLOUDGATE_SETUP_WINDOW_MINUTES`, default 30 minutes); a restart reopens the window

We do NOT yet protect against:
- ❌ A compromised release artifact reaching the updater undetected — release signing is planned but not enabled yet.

We do NOT protect against:
- ❌ Compromised host OS (root access bypasses everything)
- ❌ Compromised Cloudflare account (use API token scopes minimally)
- ❌ Side-channel attacks on shared infrastructure

## Disclosure Timeline

After a fix is released, details are published in the GitHub Release notes and as a GitHub security advisory.
