# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

---

## [0.2.1] — 2026-05-25

### Fixed — broken tunnels after 0.2.0 upgrade

Migration `004` made several `tunnels` columns nullable via knex's
SQLite `.alter()` table-rebuild path, and some installs came out with
cloudflared tunnel rows that ended up with `NULL` in
`encrypted_tunnel_secret` / `account_tag` / `credentials_path`. The
cloudflared daemon never started, every host returned an error, and
the only available remedy was to wipe `/data` and start over. Not
acceptable.

This release contains both detection and recovery:

- **`CloudflaredProvider.start` is now tolerant** — missing credentials
  surface as `provider_meta.last_error` ("needs re-link") and the boot
  sequence continues. One bad tunnel can no longer brick the whole
  install.
- **Migration `005` flags damaged tunnels** at upgrade time — it scans
  for the breakage signature and marks affected rows `status='error'`
  with an actionable message instead of leaving them in an unexplained
  "stopped" state.
- **New `POST /api/tunnels/:id/recreate`** + sidebar "🆘 Re-create"
  button. Creates a fresh Cloudflare tunnel under the same account,
  swaps the UUID + secret in place, and re-deploys every attached host
  so DNS records point at the new `cfargotunnel.com` target. Hosts and
  their configuration survive.
- **`buildContext` silently skips hosts** with invalid `forward_host` /
  `forward_port` so a single corrupt row can't drop the whole tunnel's
  ingress.

### Fixed — HomeAssistant "400 Bad Request" and similar proxied apps

HomeAssistant rejects proxied requests it doesn't recognise via
`trusted_proxies` + Host-header matching. CloudGate now exposes the
relevant cloudflared `originRequest` knobs per host:

- **HTTP Host header override** (`http_host_header`) — pin the Host
  header sent to origin (`homeassistant.local:8123` or your LAN IP).
- **Origin server name** (SNI) for HTTPS origins with mismatched certs.
- **HTTP/2 origin**, **no Happy Eyeballs**, **disable chunked encoding**.
- **Connect timeout** override.

Surfaced via a new "Advanced (originRequest)" panel in the Edit Host
modal. Schema lives in `proxy_hosts.advanced_options` (migration `006`).

### Added — encrypted Backup &amp; Restore UI

New `/backup` page (admin-only) with two cards:

- **Export** — passphrase → `cloudgate-backup-YYYY-MM-DD….cgbk`. The
  archive contains the SQLite DB, all secrets, Cloudflare tunnel
  credentials, nginx custom snippets and Let's Encrypt certs.
- **Import** — file upload + passphrase + explicit overwrite
  confirmation. Calls the admin `POST /api/restore?force=true` path;
  container restart required afterwards.

The backup format itself was extended to include `nginx/custom` and
`nginx/certs` (previously omitted) so a restored install boots with the
user's full reverse-proxy state intact. `cloudflared/bin` and
`playit/bin` are deliberately skipped — they're downloadable.

### Added — `/api/admin/diagnostics`

Admin-only endpoint that dumps SQLite `PRAGMA integrity_check`,
migration history, row counts, null-column survey on critical tables,
and `/data` path presence. No secrets. Intended as a "paste-into-issue"
JSON when triaging post-upgrade problems.

### Security

- **Fixed an ownership-validation bug** on `POST /api/hosts` introduced
  by 0.2.0: the `.orWhereNotNull('tunnels.provider_meta')` fallback
  matched every tunnel (all rows have `provider_meta='{}'`), so an
  authenticated user could attach a host to a tunnel they didn't own.
  Single-user installs were unaffected in practice — fixed regardless.

---

## [0.2.0] — 2026-05-24

### Added — pluggable tunnel-provider abstraction + Playit.gg for TCP/UDP

CloudGate can now host **Minecraft servers** (Java + Bedrock), SSH, and arbitrary TCP/UDP services that Cloudflare Tunnel can't deliver to vanilla clients on the free plan. Done via a new `TunnelProvider` interface so additional backends (ngrok, FRP, …) can be added without touching `host-deploy`.

**New host types in the UI:**
- **Web app (HTTP/HTTPS)** — existing behaviour, via cloudflared.
- **Minecraft (Java Edition)** — TCP via Playit.gg. CloudGate auto-creates an SRV record (`_minecraft._tcp.<host>`) on your Cloudflare zone so vanilla Java clients connect with just the hostname.
- **Minecraft (Bedrock Edition)** — UDP via Playit.gg. SRV is not supported by the Bedrock client; the UI shows the exact `host:port` players paste into the Servers tab.
- **Raw TCP / Raw UDP** — anything else (SSH, game servers, custom services).

**Under the hood:**
- New `ManagedProcess` base class — shared supervisor (spawn, log ring buffer, exp-backoff restart, health FSM) for cloudflared and playit-agent.
- `TunnelProvider` interface + registry resolves `tunnels.provider` to the right implementation.
- `host-deploy.ts` dispatches via `provider.addHost()` and writes the right DNS record kind per returned `ProviderEdgeEndpoint` (CNAME / SRV / `host_port`).
- Playit account-linking page with TCP/UDP quota bar (Playit free tier: 4 TCP + 4 UDP per account).
- Playit-assigned external endpoint shown on the Hosts list with a copy button — critical for Bedrock since players need the literal `host:port`.

### Database — migration `20260524_004_tunnel_providers.ts`

Purely additive per `CLAUDE.md` §3:
- `tunnels.provider` (default `'cloudflared'`), `tunnels.provider_meta` (JSON), `tunnels.playit_account_id` (nullable FK).
- CF-specific tunnel columns (`cloudflare_account_id`, `encrypted_tunnel_secret`, `credentials_path`, `account_tag`) made nullable so Playit tunnels can co-exist.
- `proxy_hosts.protocol` (default `'http'`), `proxy_hosts.edge_endpoint` (JSON snapshot).
- New `playit_accounts` table (analog to `cloudflare_accounts`).
- Idempotent, with working `down()`. Existing HTTP hosts continue to work with zero user action.

### Bootstrap

- New step `ensure-playit-binary` — idempotent download of `/data/playit/bin/playit-agent` with sha256 verification.
- Skipped when `CLOUDGATE_PLAYIT_ENABLED=false` (locked-down installs).
- `/data/playit/{bin,logs}` added to the sacred-path list — survives updates.

### Honest limitations (documented in-app)

- Bedrock players need the literal `host:port` — UI shows it.
- Playit free tier: 4 TCP + 4 UDP per account. Quota bar surfaces usage; hitting the cap shows a clear upgrade link.
- Playit-assigned ports may change on tunnel rebuild → SRV TTL kept at 60 s; CloudGate re-reads the assigned endpoint on every `provider.reload()`.

---

## [0.1.7] — 2026-05-22

### Fixed — self-updater "migrations failed" rollback

Root cause: `knexfile.ts` had `directory: './migrations'` — a relative path that the Knex CLI resolves against the **process CWD**, not the knexfile location. `apply-update.sh` ran `cd /app/backend && node ./node_modules/.bin/knex --knexfile dist/db/knexfile.js migrate:latest`, so knex looked for migrations at `/app/backend/migrations/` (doesn't exist) instead of `/app/backend/dist/db/migrations/` (where they actually are). Every install since v0.1.0 hit this; v0.1.5+ surfaced it as the rollback marker reason because we fixed the marker, but the underlying bug was the same.

### Changed — harder, more diagnosable updates

**Dedicated migration runner** (`packages/backend/src/db/run-migrations.ts`):
- Bypasses the Knex CLI entirely — no more `--knexfile` path resolution, no shell-wrapper / symlink fragility.
- Migrations directory resolved against `import.meta.url` (the runner's own location). Cannot point at the wrong dir regardless of CWD.
- Verbose pre-flight: prints db path, migrations dir, pending list, applied list with timings.
- Falls back automatically — `apply-update.sh` uses the runner when present, the knex CLI when it's not.

**apply-update.sh hardening**:
- DB pre-flight: `sqlite3 PRAGMA integrity_check` before migrate; warns (doesn't fail) if not "ok".
- Knex/runner output captured to a temp file, last 50 lines piped into the rollback marker reason — the UI now shows the **actual error**, not just "migrations failed".
- Migration timeout 60s → 180s (native-modules can rebuild on first import).
- Health-check loop 30s → 60s + reports last HTTP status code in the rollback reason (so you can tell `500 Internal Server Error` from `connection refused`).
- `--cwd $(pwd)/dist/db` and absolute `--knexfile` path in the CLI fallback so the CWD bug can't recur even on the legacy path.

**knexfile.ts**:
- `directory:` now uses an absolute path via `dirname(fileURLToPath(import.meta.url))` — robust against any CWD knex chooses to resolve from.
- `loadExtensions: ['.js']` in production / `['.ts']` in dev — prevents `.d.ts` from being misinterpreted as migrations.
- Per-env config block, no shared cross-env state.

### Hardening summary

The update pipeline is now defensive at every step:

| Layer | What protects you |
|---|---|
| Tarball | Sanity-check fails CI if `backend/node_modules/.bin/knex` missing (v0.1.5+) |
| Apply | `node_modules` fallback from `.old/` if tarball is incomplete (v0.1.5+) |
| Migrate | Standalone runner with absolute paths + verbose logging (this release) |
| Rollback marker | Actual error tail (last 50 lines of migrate stderr) instead of "see log" |
| Health-check | 60s window + reports actual HTTP code on failure |

---

## [0.1.6] — 2026-05-22

### Added

- **DNS verification via DoH against `1.1.1.1`.** After every host deploy, CloudGate now actively queries Cloudflare's public DoH endpoint for the host's CNAME — bypassing the container's local resolver cache, so we see what the rest of the internet sees. Five typed outcomes turn into actionable warnings written to `last_error`:
  - **`nxdomain`** — "Cloudflare's resolver returned NXDOMAIN. The CNAME was NOT created — re-deploy."
  - **`no_record`** — "No CNAME after 12s — propagation lag or silent create failure. Click Re-deploy."
  - **`wrong_target`** — "Resolves to X but should point to Y. Delete the conflicting record in CF."
  - **`timeout`** — "Couldn't reach 1.1.1.1 — outbound DoH may be blocked."
  - **`ok`** — record verified, then upstream probe runs next.
- **`GET /api/hosts/:id/verify-dns`** — manual DoH check button in the UI (purple globe icon next to each cloudflare_tunnel host). On success: toast with the resolved target + TTL + a "if your browser still fails, it's local DNS cache, try Ctrl+Shift+R" hint.
- **Config Inspector for tunnels.** Purple file-icon on each tunnel row opens a side drawer showing:
  - **All hosts in DB** for this tunnel, each with `IN CONFIG` / `MISSING` / `DISABLED` badges
  - **Currently rendered `/data/cloudflared/config.yml`** as a live read from disk
  - Critical for diagnosing "DNS resolves but the browser shows 400 / nothing": almost always means the hostname isn't in the ingress YAML, which this drawer makes obvious.
- **`POST /api/tunnels/:id/redeploy-all`** — cyan refresh-dot icon on each tunnel row. Re-renders the config + re-runs `deployHost()` for every host attached to this tunnel. Recovers from cases where a previous deploy crashed before `reloadTunnel()` could finalize. Reports `{ok, failed, errors[]}` in the response.

### Why this matters

User-reported case: one host worked, three others returned Cloudflare 400 / blank pages from the browser despite DNS records visibly present in the Cloudflare dashboard. Root cause hypothesized: ingress list in `config.yml` out of sync with DB (one host got into it, others didn't because of a race between sequential creates). The Config Inspector immediately shows whether this is what's happening, and Re-deploy-all fixes it without losing data.

---

## [0.1.5] — 2026-05-22

### Fixed

**Self-updater was broken** — every install attempt (since v0.1.0) rolled back. Three intertwined bugs:

- **Release tarball was missing `node_modules`.** The release workflow did `cp -r packages/backend/dist` which packed only the compiled JavaScript — but `apply-update.sh` needs `./node_modules/.bin/knex` to run the database migration step. After the swap, the new `/app/backend/` had no node_modules → `knex` not found → migrations failed → rollback.
  - **Fix**: release.yml now runs `pnpm --filter @cloudgate/backend deploy --prod` (and same for recovery-ui) to bundle a self-contained directory with `dist/` + `package.json` + production-only `node_modules/`. The same command the Dockerfile already used for the runtime image — release tarballs now match.
  - **Sanity check**: build fails fast if `backend/node_modules/.bin/knex` is missing from the staging dir.

- **`apply-update.sh` had no fallback for incomplete tarballs.** If a future release tarball ever ships incomplete, it would brick the same way.
  - **Fix**: after the swap, if `/app/backend/node_modules/` is missing but `/app/backend.old/node_modules/` exists, the script carries it forward (same Node ABI across releases). This unblocks even broken tarballs from v0.1.0 → v0.1.4.
  - **Fix**: `KNEX_BIN` is now resolved at runtime — looks at `node_modules/.bin/knex` then `node_modules/knex/bin/knex.js`. Bails clearly with "knex CLI not found … release tarball appears incomplete" if both miss, instead of cryptic "migrations failed".

- **Rollback marker reason was useless.** The `.last-update-*.json` always said `"reason": "see /data/logs/update-history.log"` no matter what actually went wrong. The Update modal then displayed that text in the UI.
  - **Fix**: `rollback()` now accepts the actual bail-reason and writes it to the marker. The Update modal also auto-opens the Terminal-Output panel when a rollback is detected, so the user sees the real story without clicking around.

### Upgrade path

The currently-running container has the broken `apply-update.sh`. The in-app updater **cannot** apply this fix to itself (it would just roll back again with the same bug). One-time manual pull:

```bash
docker stop cloudgate && docker rm cloudgate
docker pull ghcr.io/elias02345/cloudgate:latest
docker run -d --name cloudgate -p 80:80 -p 443:443 \
  -v cloudgate-data:/data --restart unless-stopped \
  ghcr.io/elias02345/cloudgate:latest
```

All future updates will work end-to-end through the WebUI.

---

## [0.1.4] — 2026-05-21

### Added
- **Upstream connectivity probe.** After a host deploys, CloudGate now TCP-sniffs `<scheme>://<host>:<port>` from inside the container — the same network namespace cloudflared lives in. The probe classifies the listener (HTTP vs TLS by the first response byte) and writes a clear warning to `last_error` if there's a mismatch:
  - **`tls_on_http_port`** — "The service at X:Y speaks TLS but the host is configured with scheme 'http'. Edit the host, switch to https + tick 'Don't verify upstream TLS certificate'." Catches the #1 Homelab pitfall — pointing CloudGate at Proxmox/TrueNAS/Unifi with `http://` on a HTTPS-only port.
  - **`http_on_tls_port`** — Reverse case: scheme=https against a plain-HTTP service.
  - **`tcp_refused` / `tcp_timeout`** — Service down or unreachable from container.
  - **`self_signed_tls`** — Suggests ticking no-TLS-verify.
  - **`http_error`** — Service is reachable but returned 5xx.

- **`PUT /api/hosts/:id`** — edit forward_scheme / forward_host / forward_port / path_prefix / tls_options without deleting + recreating the host. Re-runs deployHost() so the tunnel config + upstream probe are refreshed automatically.

- **Edit-host modal in the UI.** Pencil icon in the actions column opens a small form to fix forwarding settings on an existing host. Includes a smart hint when the port matches a known HTTPS-default service (8006/8443/9090/9443) and the scheme is set to http — surfaces the most common fix-it case.

### Fixed
- **SQLite boolean robustness.** `buildContext` in `tunnel-config-writer.ts` used `.where({ enabled: true })` while the routes write `enabled: 1`. SQLite's behaviour here depends on Knex version + better-sqlite3 binding nuances. Switched to the explicit `.where('enabled', 1)` form which is unambiguous across all configurations. Now logs the host count per tunnel reload so config issues are visible in container logs.

### Changed
- `HostRow` in host-deploy.ts now carries `forward_scheme`, `forward_host`, `forward_port`, `tls_options` — needed by the new probe path.

---

## [0.1.3] — 2026-05-21

### Added
- **Retry-deploy button** for hosts in error state. A small orange refresh icon appears next to errored hosts; clicking it re-runs the deploy without deleting + recreating the host. Endpoint: `POST /api/hosts/:id/redeploy`.

### Changed
- **Cloudflare DNS errors are now human-readable.** The raw `403 {"success":false,"errors":[{"code":10000,...}]}` JSON dump that used to show up in the host's `last_error` field is replaced with actionable messages. Specifically:
  - `cf:10000` (Authentication error) → "Cloudflare rejected the DNS record write for `<host>`. Token is missing the 'Zone → DNS → Edit' permission on zone `<zoneId>`, OR the token's 'Zone Resources' scope excludes this zone. Fix it at dash.cloudflare.com/profile/api-tokens, then click Re-deploy."
  - `cf:81057` (record already exists) → "A DNS record for `<host>` already exists in Cloudflare. Delete the conflicting record from your CF dashboard, then click Re-deploy."
  - 401/403 (generic) → "Cloudflare rejected the DNS request: `<message>`. Verify the API token in Settings → Cloudflare."
- `CloudflareApiError` now carries a `cfErrorCode` field with Cloudflare's own numeric code, extracted from the SDK's `.errors[]` array. Future code paths can branch on this for finer-grained handling.

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
