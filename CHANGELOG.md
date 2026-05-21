# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

---

## [0.1.2] — 2026-05-21

### Added

- **Interactive update modal.** Clicking "Install update" now opens a full progress dialog instead of firing a toast and leaving the user blind:
  - **Real progress bar** with accurate stage-by-stage percentages (download = 50% weight, verify = 8%, apply = 30%). Download phase tracks live bytes-downloaded / total, including a human-readable byte counter (e.g. `1.4 MB / 12.7 MB`).
  - **9-stage list** with running spinner / done checkmark / pending circle per step (acquire lock → download tarball → download SHA → download GPG sig → verify SHA → verify GPG → spawn applier → apply → done).
  - **Collapsible terminal view** with live log lines from the backend during the download/verify phase, then the historical `/data/logs/update-history.log` tail after the apply finishes.
  - **Auto-reconnect on container restart**: when the SSE drops mid-update, the modal switches to a 2-second `/api/health` poll, interpolates progress 65→95 % via wall clock, and detects success by comparing the returned version to the starting version.
  - **Auto-reload to new frontend** with a 5-second countdown once the new backend is reachable.
  - **Rollback / failure detection** via the `.last-update-*.json` marker: shows the reason from `apply-update.sh` so the user understands what triggered the rollback.
- **`GET /api/updates/log?lines=N`** — tails `/data/logs/update-history.log` so the SPA can replay the apply phase after reconnect.
- **`GET /api/updates/last`** — returns the most recent `.last-update-*.json` marker for outcome detection.
- **New SSE topic `update.progress`** with fine-grained step + percent + download bytes.

### Changed
- `services/updater.ts` now tracks `step`, `step_label`, `overall_progress`, `download_bytes`, `download_total`, `started_at`, `target_version` on the status payload. All optional — older frontends ignore them.

---

## [0.1.1] — 2026-05-18

### Fixed

- **Tunnel creation crashed with `cf.zeroTrust.tunnels.create is not a function (TUNNEL_CREATE_FAILED)`.** The `cloudflare` npm SDK moved the `cfd_tunnel` endpoints under `.cloudflared` one level deeper. Tunnel create + delete now use the correct SDK path. ([8f5b987](https://github.com/Elias02345/CloudGate/commit/8f5b987))

---

## [0.1.0] — 2026-05-18

First user-facing release. Everything from M0 through M8 — `:latest` images now exist on GHCR and the one-liner installer picks them up.

### Added

#### M6 — Guided Onboarding + App-Tour
- Animated 6-step onboarding wizard with inline-SVG animations (welcome cloud, key glide, tunnel flow, server checkmark, spinner, confetti bounce) and Mantine `<Transition>` between steps
- NEW step 5 "Live verification": runs `/api/health/deep` and displays each subsystem with rotating spinner → green check or red ✗ with per-failure "fix this" hint
- 12-stop `react-joyride` spotlight tour across Dashboard / Hosts / Tunnels / Cloudflare / Settings / Audit / Updates / Donate with cross-page navigation
- DB-persisted user flags (`user.{id}.onboarding_completed_at` / `tour_completed_at` / `tour_dismissed`) so dismissal survives browser changes
- Settings → "Help & guided tour" card to replay the wizard or the tour at any time

#### M7 — Shell API for humans + AI agents
- Long-lived `cgk_<prefix>_<secret>` API keys with `admin` / `read` scope and optional expiry
- Unified auth middleware: `requireAuth` accepts JWT (SPA) OR API key (curl / scripts) transparently
- Per-key rate limit tier: 60 req/min admin · 120 req/min read, keyed on key id
- Conditional CORS: `Authorization: Bearer cgk_*` requests get `Access-Control-Allow-Origin: *`; browser cookie path stays same-origin
- New routes `GET/POST/DELETE/POST :id/rotate` under `/api/api-keys` (browser-only — keys can't manage keys)
- `GET /api/openapi.json` — OpenAPI 3.1 spec with 60s cache, served unauthenticated
- New frontend pages: `/api-keys` (Mantine table + create modal + shown-once plaintext display) and `/api-docs` (lightweight rendering of the live spec)
- `docs/AGENT.md` (~470 lines): quickstart, glossary, 7 numbered recipes with copy-paste curl (CF account + tunnel + host, bulk import, diagnose tunnel, ACME, encrypted backup, audit filter, health-recovery loop), full endpoint catalog, SSE topic list, error code table, safe-defaults checklist for autonomous agents

#### M8 — Optional in-app AI assistant
- Multi-provider: Anthropic (Claude), OpenAI, or any OpenAI-compatible base URL (OpenRouter, LMStudio, Ollama, vLLM)
- 3 user-configurable autonomy modes:
  - `off` (default) — feature disabled, FAB hidden, `/api/ai/chat` returns 503
  - `suggest_only` — AI reads freely, writes need a click-confirm
  - `autonomous` — AI may write directly; every action logged with `ai_initiated=true` in the audit log
- 9 read tools (list/get hosts, tunnels, audit, cf accounts, zones, health) + 4 write tools (create_host, toggle_host, delete_host, restart_tunnel). Tools call internal services directly — no HTTP round-trip
- Floating chat drawer (FAB bottom-right) with `react-markdown` + `remark-gfm` for tables, inline confirmation cards for suggest_only writes
- API key AES-256-GCM-encrypted via existing crypto service; never returned to the browser after save
- New routes under `/api/ai/`: settings, chat, conversations, confirm-action, settings/test
- New DB tables: `ai_conversations`, `ai_messages`, `ai_pending_actions` (5-min TTL for action tokens)

### Changed
- `GET /api/auth/me` now returns `{ user, flags }` (was: `{ user }`). Frontend handles both shapes transparently
- `globalLimiter` now skips API-key callers — they go through the per-key tier instead

### Migrations
- `20260518_002_api_keys` — new table
- `20260518_003_ai_conversations` — three new tables for AI feature (all opt-in, do nothing unless `llm.autonomy != 'off'`)

### Dependencies
- frontend: `react-joyride@^2.9`, `react-markdown@^9`, `remark-gfm@^4`
- backend: `@anthropic-ai/sdk@^0.32`, `openai@^4.77`

---

## [0.0.1] — pre-alpha

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
