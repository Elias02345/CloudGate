# CloudGate Roadmap

> Living document. Updated as work progresses. Source of truth for "what's done, what's next".
> The detailed planning document is in `~/.claude/plans/` (developer-internal).

**Legend:** ✅ done · 🚧 in progress · ⬜ pending · 🔁 blocked / needs user action

---

## M0 — Setup & Foundation

> Goal: a working scaffold that builds in CI and can be cloned/installed by anyone. Not yet functional, but architecturally complete.

- ✅ Monorepo with pnpm workspaces
- ✅ TypeScript base configs (`tsconfig.base.json`, per-package)
- ✅ Biome (lint + format)
- ✅ Vitest (test runner) per package
- ✅ `.gitattributes` (LF for shell/docker, CRLF for windows scripts)
- ✅ `.gitignore`, `.dockerignore`, `.env.example`
- ✅ `CLAUDE.md` — persistence contract & update rules
- ✅ `docs/UPDATE_RULES.md` — long-form rules
- ✅ `docs/ARCHITECTURE.md`, `docs/CLOUDFLARE_SETUP.md`, `docs/CONTRIBUTING.md`
- ✅ `SECURITY.md`, `README.md`, `LICENSE` (MIT), `CHANGELOG.md`
- ✅ `packages/shared` — Zod-validated DTOs (user, host, tunnel, cloudflare, update, bootstrap)
- ✅ `packages/backend` — Express 5, Pino, Knex/SQLite, idempotent `bootstrap.ts`, health endpoint
- ✅ `packages/recovery-ui` — standalone fallback for anti-brick
- ✅ `packages/frontend` — Vite 6 + React 19 + Mantine 7 + TanStack Query + react-i18next (DE + EN)
- ✅ Initial Knex migration (8 tables: users, settings, cf accounts/zones, tunnels, proxy_hosts, audit_log, update_history)
- ✅ Bootstrap test skeleton, persistence test skeleton
- ✅ Multi-stage Dockerfile (Node 22 + nginx + cloudflared + s6-overlay + gnupg + sqlite3)
- ✅ `bootstrap.sh` (defensive shell wrapper, no `set -e` without recovery)
- ✅ s6 service definitions (bootstrap → backend/nginx, recovery-ui fallback)
- ✅ Nginx configs (cloudgate.conf for healthy mode, recovery.conf for fallback)
- ✅ `.github/workflows/ci.yml`, `release.yml`, `nightly.yml`
- ✅ `.github/PULL_REQUEST_TEMPLATE.md` with persistence checklist
- ✅ Issue templates (bug, feature)
- ✅ First commit + push to `dev`
- ✅ **CI green** — lint-typecheck-test + docker-build + smoke test all pass
- ✅ First successful CI run on `dev`
- 🔁 **GPG keypair** generation (user action — keep optional, signing is graceful no-op without)
- 🔁 **Branch protection** for `main` (user action via GitHub UI)

---

## M1 — Core MVP

> Goal: full end-to-end host-create flow works. Login → add CF token → create tunnel → add host → service reachable via Cloudflare. Single user, HTTP/HTTPS only.

### Phase 1 — Authentication foundation ✅

- ✅ `services/crypto.ts` — AES-256-GCM encrypt/decrypt with `/data/secrets/encryption.key`
- ✅ `services/auth.ts` — JWT issue/verify, Argon2 password hash/verify
- ✅ `middleware/auth.ts` — Express middleware extracting + validating JWT
- ✅ `middleware/rate-limit.ts` — express-rate-limit for `/auth/login`
- ✅ `routes/auth.ts` — `POST /login`, `POST /logout`, `GET /me`, `POST /password`
- ✅ `tests/auth.test.ts` + `tests/crypto.test.ts` — end-to-end with real bootstrap
- ✅ Frontend: `api/auth.ts` — TanStack Query hooks
- ✅ Frontend: `api/client.ts` — fetch wrapper with token storage
- ✅ Frontend: `components/ProtectedRoute.tsx`
- ✅ Frontend: real `LoginPage` (real API, error display, force-password-change flow)
- ✅ Frontend: `PasswordChangePage` with force-change UX + toast
- ✅ Frontend: `App.tsx` routing + header user menu + logout
- ✅ i18n DE+EN strings for header + login + password
- ✅ **Milestone validation**: CI smoke test confirms backend boots, bootstrap runs idempotent,
  health endpoint responds. Full E2E login validation in dev container deferred to M1.4.

### Phase 2 — Cloudflare integration (read-only first) ✅

- ✅ `services/cloudflare-client.ts` — wraps official `cloudflare` npm lib, token validation,
  zone listing, structured `CloudflareApiError` mapping
- ✅ `services/cf-account.ts` — CRUD with encrypted credentials, decrypt-on-demand pattern
- ✅ Zone sync inlined as `doZoneSync()` in routes (transactional reset+insert)
- ✅ `routes/cloudflare.ts` — `POST/GET/DELETE /accounts`, `POST /:id/sync`, `GET /:id/zones`
- ✅ Frontend: `api/cloudflare.ts` — TanStack Query hooks
- ✅ Frontend: `pages/CloudflarePage.tsx` — accounts table + drill-down zones + add modal
- ✅ Frontend: sidebar nav with Dashboard / Cloudflare / Tunnels (disabled, hint to M1.3)
- ✅ i18n DE+EN strings for nav + cloudflare
- ✅ **Milestone validation**: CI green for backend + Docker container after M1.2 push

### Phase 3 — Tunnel lifecycle ✅

- ✅ `services/cloudflared-process.ts` — spawn, `/ready` health-poll, SIGHUP reload,
  exponential backoff (1s→60s), 1000-line log ring buffer
- ✅ `services/tunnel-manager.ts` — orchestrates one process per tunnels row, revives on boot,
  writes credentials.json + config.yml
- ✅ Liquid template inlined in `tunnel-config-writer.ts` (avoids needing to copy .liquid into dist)
- ✅ `services/tunnel-config-writer.ts` — atomic temp+rename write
- ✅ `routes/tunnels.ts` — POST (CF zeroTrust.tunnels.create + start daemon), GET, DELETE,
  POST `/:id/restart`, GET `/:id/logs`
- ✅ Frontend: `pages/TunnelsPage.tsx` — live status badges, create modal, restart, log side-drawer
- ✅ Frontend: 5s auto-refetch for status, 3s for log tail
- ✅ **Milestone validation**: CI smoke test container builds + boots with tunnel infra ready

### Phase 4 — Proxy hosts ✅ (the headline feature)

- ✅ `services/events.ts` — in-process SSE bus, topic filter, 25s heartbeats
- ✅ `routes/events.ts` — `GET /events` SSE with token-via-query auth (EventSource lacks headers)
- ✅ `services/host-deploy.ts` — creates CNAME → `<tunnel-uuid>.cfargotunnel.com`, reloads tunnel
- ✅ `routes/hosts.ts` — full CRUD, hostname-zone validation, async deploy, toggle, HEAD-probe test
- ✅ Frontend: `pages/HostsPage.tsx` — table with mode badges, enable toggle, external-link to host
- ✅ Frontend: `pages/HostFormPage.tsx` — mode picker, cascading tunnel→zone dropdowns
- ✅ Frontend: `api/events.ts` `useEventStream()` — auto-invalidates queries on relevant topics
- ✅ Frontend: mounted in `App.tsx` so all pages get live updates
- ✅ **Milestone validation**: end-to-end host create flow wired and CI green — live exercise
  with real CF account is the M1.5 dev-loop step

### Phase 5 — Tests & Polish

- ⬜ `tests/bootstrap.test.ts` — full impl (fresh /data, partial /data, corrupted DB)
- ⬜ `tests/crypto.test.ts` — encrypt/decrypt roundtrip, key mismatch fails fast
- ⬜ `tests/auth.test.ts` — login, password change, JWT verify
- ⬜ `tests/cloudflare-client.test.ts` — mock CF API responses
- ⬜ `tests/tunnel-manager.test.ts` — mock spawn, reload, backoff
- ⬜ Audit-log middleware — auto-record all writing ops
- ⬜ Error boundary in frontend
- ⬜ Loading skeletons everywhere
- ⬜ Toast notifications on all mutations

---

## M2 — UI Polish

> Goal: feels like a real product, not a wireframe. Empty states, errors, i18n complete.

- ✅ Dashboard with 4 status cards (CF accounts / tunnels / hosts / version) + click-through links + skeletons + hosts-error alert + first-steps guide
- ✅ Empty states for hosts/tunnels/cf-accounts/audit
- ✅ Form validation with inline errors (Mantine form + zod)
- ✅ i18n: complete EN + DE strings for all UI surfaces
- ✅ Language switcher in Settings (live)
- ✅ Color scheme toggle (light / dark / auto)
- ✅ Mantine v7 theming + CloudGate brand color accents
- ✅ Status icons + colors consistent (badges across pages)
- ✅ Sidebar navigation with active-state highlighting
- ✅ User profile menu (header dropdown with logout)
- ✅ ErrorBoundary — top-level crash handler (never blank page)
- ⬜ Keyboard shortcuts (Cmd+K command palette) — deferred to M6
- ⬜ First screenshots for README — needs running instance

---

## M3 — Hybrid Mode (local nginx)

> Goal: per host, user can pick "via Cloudflare Tunnel" OR "local nginx reverse proxy". Killer feature for mixed homelabs.

- ⬜ Add `mode='local_nginx'` branch in host form
- ⬜ `templates/nginx-host.conf.liquid`
- ⬜ `services/nginx-config.ts` — write conf, `nginx -t`, `nginx -s reload`
- ⬜ ACME / Let's Encrypt integration (npm `acme-client`)
- ⬜ DNS-01 challenge via Cloudflare API
- ⬜ Cert auto-renewal cron (30-day check)
- ⬜ Cert UI: status, expiry, manual renew button
- ⬜ Frontend: mode-picker in host form, conditional fields
- ⬜ Integration test: local nginx host serving correctly

---

## M4 — Production-ready ✅ (subset done; long-tail items remain)

> Goal: 1.0-worthy. Backups, 2FA, audit UI.

- ✅ 2FA TOTP setup flow (QR code, secret + verify) — Settings page
- ✅ 2FA enforcement on login (server validates totp_code when totp_enabled)
- ✅ Backup endpoint: `GET /api/backup?passphrase=…` → encrypted .cgbk file
  (AES-256-GCM + PBKDF2 200k iterations, tar.gz inside)
- ✅ Audit log UI: paginated `/audit` page, color-coded action badges
- ✅ Audit writes wired into login/totp/backup
- ✅ GHCR `:nightly` + `:dev` images built (workflow_dispatch run)
- ⬜ Restore wizard (first-run accepts a backup file) — deferred to M6
- ⬜ Deep health endpoint (`/api/health/deep`) — deferred
- ⬜ Structured log file rotation (pino-roll) — deferred
- ⬜ Public `v0.1.0` tagged release on `main` — waits for Elias to test on hardware
- ⬜ ARCHITECTURE.md diagrams as SVG — deferred
- ⬜ Getting-started screencast — needs running instance
- ⬜ OAuth flow alongside API token — deferred (API token covers 99% of use)

---

## M5 — Auto-Update ✅

> Goal: containers update themselves seamlessly. The flagship feature.

- ✅ `services/updater.ts` — 6h release polling against GitHub API with channel filter
- ✅ GPG signature verification inline (graceful warning if unsigned)
- ✅ SHA256 integrity check (graceful skip if absent)
- ✅ `docker/apply-update.sh` — paranoid in-container applier:
  Snapshot /app + DB → atomic move-aside swap → migrate → restart → health-check
  → automatic rollback on any failure. NEVER touches /data/secrets, etc.
- ⬜ `services/cloudflared-updater.ts` — separate binary update flow (deferred to vNext)
- ✅ `routes/updates.ts` — status, trigger, install, channel/mode settings
- ✅ Frontend: `pages/UpdatesPage.tsx` with current/latest version, install button,
  channel + mode selectors
- ⬜ Frontend: header banner when update available in `notify` mode
- ⬜ Frontend: full-screen maintenance overlay during update
- ⬜ `tests/updater.test.ts` — simulate upgrade with fixtures
- ⬜ `tests/persistence.test.ts` — fs.watch-based assertions on `/data/`
- ⬜ `release.yml` — fully signed pipeline (works without secret too, signed warning shown)
- ⬜ `update-manifest.json` generator in release workflow
- ⬜ Rollback test: ship a deliberately-bad version, ensure auto-rollback

---

## M6 — Polish & First Release

- ⬜ `install/proxmox-lxc.sh` helper (community tteck-style)
- ⬜ `install.sh` one-liner for bare-Docker hosts
- ⬜ Helm chart (k8s-curious users)
- ⬜ Webhooks (notification on host failure, update success, etc.)
- ⬜ Prometheus metrics export `/metrics`
- ⬜ First `v0.x.0` proper release with signed artifacts
- ⬜ Public announcement (Reddit /r/selfhosted, HN Show)
- ⬜ Documentation site (`docs/` → published to gh-pages)

---

## vNext (Future)

- ⬜ TCP routes (cloudflared `service: tcp://`)
- ⬜ UDP routes (Cloudflare Spectrum / WARP)
- ⬜ Game-server templates (Minecraft, Valheim, etc.)
- ⬜ Multi-user with RBAC
- ⬜ Multiple Cloudflare accounts per user
- ⬜ Multiple tunnels per account (currently single managed daemon)
- ⬜ Windows-native install (no Docker)
- ⬜ macOS-native install
- ⬜ Postgres support (currently SQLite only)
- ⬜ Mobile-friendly responsive UI
- ⬜ Notification integrations (Discord, Telegram, Pushover, ntfy)
- ⬜ Bring-your-own-DNS provider (not just Cloudflare)

---

## How this file is maintained

- Updated incrementally as work happens — usually in the same commit that lands the work.
- Single source of truth for "is M1 done?"  → grep this file.
- Subsections may be reorganized as we learn what users actually need.
- Items can move between milestones if priorities shift; explanation goes in commit message.
