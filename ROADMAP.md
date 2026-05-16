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

### Phase 2 — Cloudflare integration (read-only first)

- ⬜ `services/cloudflare-client.ts` — wraps official `cloudflare` npm lib, token validation
- ⬜ `services/cf-account.ts` — CRUD logic with encrypted token storage
- ⬜ `services/zone-sync.ts` — fetches & caches zones from CF
- ⬜ `routes/cloudflare.ts` — `POST/GET/DELETE /accounts`, `POST /accounts/:id/sync-zones`, `GET /accounts/:id/zones`
- ⬜ Frontend: `pages/CloudflarePage.tsx` — list accounts, add account form
- ⬜ Frontend: `pages/CloudflareDetail.tsx` — show account info + zones
- ⬜ **Milestone validation**: paste CF token, see your zones

### Phase 3 — Tunnel lifecycle

- ⬜ `services/cloudflared-process.ts` — spawn, health-check, SIGHUP reload, backoff
- ⬜ `services/tunnel-manager.ts` — orchestrates daemon per tunnel record
- ⬜ `templates/cloudflared-config.yml.liquid`
- ⬜ `services/tunnel-config-writer.ts` — render template, atomic write, validate, reload
- ⬜ `routes/tunnels.ts` — `POST/GET/DELETE /tunnels`, `POST /:id/restart`, `GET /:id/logs` (SSE)
- ⬜ Frontend: `pages/TunnelsPage.tsx` — list, create form, live status
- ⬜ Frontend: `components/TunnelLogsDrawer.tsx` — SSE log tail
- ⬜ **Milestone validation**: create tunnel from UI, see it in CF dashboard, daemon running

### Phase 4 — Proxy hosts (the headline feature)

- ⬜ `services/events.ts` — SSE singleton + topic filtering
- ⬜ `routes/events.ts` — `GET /events` (SSE endpoint)
- ⬜ `services/host-deploy.ts` — orchestrates CF DNS create + config reload
- ⬜ `routes/hosts.ts` — full CRUD, `POST /:id/toggle`, `GET /:id/test`
- ⬜ Frontend: `pages/HostsPage.tsx` — list with status indicators
- ⬜ Frontend: `pages/HostFormPage.tsx` — create/edit form (hostname validation, zone picker, forward target)
- ⬜ Frontend: `api/events.ts` — SSE client hook with auto-reconnect
- ⬜ Frontend: global `<EventStream>` provider — invalidates queries on relevant events
- ⬜ **Milestone validation**: full E2E — add host `test.mydomain.com` → 192.168.x.y:8080, reachable via HTTPS within 30s

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

- ⬜ Dashboard with status cards (backend, daemon, hosts, last events)
- ⬜ Empty states for hosts/tunnels/cf-accounts
- ⬜ Form validation with inline errors
- ⬜ i18n: complete DE + EN strings for all UI
- ⬜ Language switcher in settings
- ⬜ Color scheme toggle (system / dark / light)
- ⬜ Mantine theming with CloudGate brand colors
- ⬜ Status icons + colors consistent across pages
- ⬜ Keyboard shortcuts (Cmd+K command palette, optional)
- ⬜ First screenshots for README
- ⬜ Sidebar navigation polish (active state, collapse, icons)
- ⬜ User profile menu (header dropdown)

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

## M4 — Production-ready

> Goal: 1.0-worthy. Backups, 2FA, audit UI, first official GHCR release.

- ⬜ 2FA TOTP setup flow (QR code, verify)
- ⬜ 2FA enforcement on login
- ⬜ Backup endpoint: `GET /settings/backup` → encrypted ZIP
- ⬜ Restore wizard (first-run can accept backup file)
- ⬜ Audit log UI (filterable list, JSON detail view)
- ⬜ Deep health endpoint (`/api/health/deep`): DB, daemon, CF, disk space
- ⬜ Structured log file rotation (pino-roll)
- ⬜ Public GHCR image first build (`v0.1.0`)
- ⬜ ARCHITECTURE.md polish (diagrams as PNG/SVG)
- ⬜ Getting-started screencast
- ⬜ OAuth flow (best-effort) for CF auth alongside API token

---

## M5 — Auto-Update

> Goal: containers update themselves seamlessly. The flagship feature.

- ⬜ `services/updater.ts` — release polling
- ⬜ `services/gpg-verify.ts` — signature verification (graceful no-op when unsigned)
- ⬜ `services/snapshot.ts` — `/app` and DB snapshots
- ⬜ `services/update-runner.ts` — orchestrates download → verify → backup → swap → migrate → health → rollback
- ⬜ `services/cloudflared-updater.ts` — separate binary update flow
- ⬜ `routes/updates.ts` — status, trigger, history, channel/mode settings
- ⬜ Frontend: `pages/UpdatesPage.tsx` (settings/updates)
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
