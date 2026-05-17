# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — pre-alpha on `dev`

### Added

#### M0 — Foundation
- pnpm monorepo skeleton with `backend`, `frontend`, `recovery-ui`, `shared` packages
- Zero-config Docker image (multi-stage: Node 22 + nginx + cloudflared + s6-overlay + gpg + sqlite3)
- Idempotent bootstrap: auto-generates encryption key, JWT secret, admin password on first run
- Recovery UI fallback served when the main backend cannot start
- One-liner Ubuntu/LXC installer (`install/lxc-install.sh`) with image-fallback + source-build path
- GitHub Actions: `ci.yml`, `release.yml` (GPG-signed multi-arch), `nightly.yml`
- `CLAUDE.md` + `docs/UPDATE_RULES.md`: persistence contract for contributors
- `TODO_FOR_USER.md`: living doc of manual steps awaiting Elias' hardware test

#### M1 — Core MVP
- Auth: Login + JWT (jose, HS256) + Argon2id passwords + force-password-change on first login
- Rate limiting on `/auth/login` (5/15min) + global 300/min
- Cloudflare integration: API token validation, account CRUD with AES-256-GCM encrypted storage, zone sync
- Tunnel lifecycle: cloudflared spawn with exponential backoff, SIGHUP reload, health-poll, ring-buffer logs
- Proxy hosts: full CRUD with CF DNS CNAME creation + tunnel-config reload
- SSE event bus for live UI updates
- React 19 + Vite + Mantine v7 + TanStack Query + react-i18next (DE + EN)

#### M2 — UI Polish
- Dashboard with 4 live-count stat cards + click-through links
- Settings page: language switcher, theme toggle (light/dark/auto), profile, About
- Top-level `ErrorBoundary` (no blank-page crashes)
- Loading skeletons, empty states, toast notifications

#### M3 — Hybrid Mode
- `local_nginx` host mode: per-host nginx conf with atomic-write + `nginx -t` validation
- ACME / Let's Encrypt integration via `acme-client` (DNS-01 challenge through user's CF account)
- Auto-renewal cron: 24h check, renews certs with <30 days left
- "Issue cert" button in UI for local_nginx hosts

#### M4 — Production
- 2FA TOTP: QR-code setup, login-time verification, password-protected disable
- Encrypted backup: AES-256-GCM + PBKDF2 (200k iterations), tar.gz inside, `.cgbk` extension
- Audit log: paginated UI with color-coded action badges, filter support
- Audit writes wired into login, totp.{enabled,disabled}, backup.exported, update.* events

#### M5 — Auto-Update
- `services/updater.ts`: 6h GitHub-release polling, channel filter (stable/prerelease/nightly/disabled)
- Optional GPG signature verification (graceful warning when unsigned)
- Optional SHA256 integrity check
- `docker/apply-update.sh`: paranoid in-container applier with snapshot+swap+migrate+health-check+rollback
- Update UI with channel + mode (notify/auto/scheduled) selectors

### Security
- AES-256-GCM at rest for Cloudflare tokens, OAuth credentials, TOTP secrets, tunnel secrets
- Argon2id for password hashing
- JWT with HS256 signing (separate `jwt.key` rotated independently from `encryption.key`)
- Helmet for HTTP security headers (CSP enabled in next release)
- Per-route rate limiting

## [0.0.1] — initial scaffold

First commit on `dev`. Not functional — repository structure only.
