# Security Policy

## Supported Versions

CloudGate is pre-alpha. Only the latest `main`-tagged release receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest `v0.x.y` on `main` | ✅ |
| `dev` builds (`:nightly`) | ⚠️ best-effort |
| anything older | ❌ |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **elias-kanakidis@gmx.de** with subject prefix `[CloudGate Security]`.

Include:
- Affected version (`docker inspect` or `/api/health` output)
- Steps to reproduce
- Impact assessment
- Any proposed mitigation

You'll get an acknowledgement within 7 days. Critical issues will be patched on `main` and a CVE published if applicable.

## Release Signing

All official releases on `main` are signed with GPG.

- **Public key fingerprint:** _(to be added once first release is signed)_
- **Public key file:** `docker/keys/release.pub` (also baked into the Docker image)
- **Verify a release tarball:**
  ```bash
  gpg --verify cloudgate-v0.x.y.tar.gz.sig cloudgate-v0.x.y.tar.gz
  ```

The self-updater inside CloudGate verifies GPG signatures automatically before installing any update — unsigned or wrongly-signed updates are refused.

## Threat Model (overview)

CloudGate is designed for self-hosted homelab use. We assume:
- The host machine is trusted by its owner.
- Network exposure is the user's choice (UI on LAN, services via Cloudflare Tunnel).
- The Cloudflare API token is the most sensitive secret — stored encrypted at rest.

We protect against:
- ✅ Compromised CloudGate releases (GPG signing)
- ✅ Stolen DB without keys (token encryption AES-256-GCM)
- ✅ Brute-force login (rate limiting + Argon2id + optional 2FA)
- ✅ Container brick-state (Recovery UI + rollback)

We do NOT protect against:
- ❌ Compromised host OS (root access bypasses everything)
- ❌ Compromised Cloudflare account (use API token scopes minimally)
- ❌ Side-channel attacks on shared infrastructure

## Disclosure Timeline

After a fix is released, we publish details in the GitHub Release notes and on the [Discussions](https://github.com/Elias02345/CloudGate/discussions) board.
