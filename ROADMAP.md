# CloudGate Roadmap

> Source of truth for "what CloudGate does today" and "what's planned next." No dates, no promises — see [`CHANGELOG.md`](CHANGELOG.md) for the shipped history release by release.

---

## Released (v0.5.0)

CloudGate is stable as of v0.5.0. What it does today:

- **Setup** — one-liner installer for Ubuntu/LXC, plain `docker run`, or an app-store package (listings pending review; see the README). Zero required configuration: encryption key, JWT secret and the initial admin account are generated on first boot.
- **Cloudflare Tunnel hosting** — add a service, get a public hostname. CloudGate creates the tunnel, the DNS record, and the ingress rule, and reloads `cloudflared` for you. Multiple Cloudflare accounts and multiple tunnels are supported.
- **Playit.gg tunnels for TCP/UDP** — Minecraft (Java via SRV, Bedrock via literal `host:port`), SSH, and other raw TCP/UDP services that Cloudflare's free tier can't carry to a vanilla client.
- **Hybrid mode** — per host, choose "via Cloudflare Tunnel" or "local nginx reverse proxy" with Let's Encrypt via DNS-01 and automatic renewal.
- **Security** — Argon2id passwords, AES-256-GCM secret encryption, 2FA (TOTP), per-route rate limiting, a full audit log, and long-lived scoped API keys for automation (see [`docs/AGENT.md`](docs/AGENT.md)).
- **Self-update** — polls GitHub for new releases, verifies a mandatory SHA256 checksum, applies atomically with a DB/app snapshot, and rolls back automatically on a failed health check. App-store installs leave updates to the platform instead (`CLOUDGATE_DISABLE_UPDATES=true`).
- **Resilience** — a Recovery UI fallback so a broken bootstrap never shows a blank page, plus DB backups taken around every update.
- **UX** — i18n (German + English), light/dark theme, a live dashboard fed by server-sent events, guided onboarding with an app tour, encrypted backup/restore (`.cgbk`), and bulk CSV host import.
- **Admin UI on port 8080** (with 80/443 still available for existing installations and local-nginx mode) — the layout every app-store package uses.

---

## Planned

Real open items, roughly in the order they'd land:

- **Signed releases (GPG).** The updater already enforces a mandatory SHA256 checksum; GPG signature verification is wired in but only runs if a release actually ships a signature, and none does yet.
- **A non-root backend.** Today the container runs as root because the backend directly reloads nginx/cloudflared and manages `/app` during updates. Splitting that into a small privileged helper (nginx reload, `/app` swap, s6 supervision) would let the main process drop privileges.
- **Upgrade gating via an update manifest.** `update-manifest.json` (`min_upgrade_from`, `breaking_changes`, post-install actions) is designed but not built — see `CLAUDE.md` §5. Right now migrations being forward-only and idempotent is what makes "no gating" survivable; a manifest would make that explicit instead of implicit.
- **Proxmox community script.** Their acceptance rules require no Docker, 6+ months of project age, and 600+ GitHub stars — needs a Docker-free install path first.
- **TerraMaster app store.** Needs a non-root image (see above) plus a Docker Hub mirror; TerraMaster's store only pulls from Docker Hub and can't update Docker-based apps itself.
- **Multi-user with RBAC.** CloudGate is single-admin today; role-based access for additional users is unimplemented.
- **Postgres support.** The schema is designed to be Postgres-portable (Knex/Objection), but only SQLite is wired up.
- **Webhooks and a Prometheus `/metrics` endpoint.** Neither exists yet — notifications on host/update events currently mean checking the audit log or the UI.
- **Notification integrations** (Discord, Telegram, Pushover, ntfy) for update and host-failure events.
- **Bring-your-own-DNS.** Cloudflare is the only supported DNS provider today.

---

## How this file is maintained

Updated as priorities change. If an item here ships, it moves to [`CHANGELOG.md`](CHANGELOG.md) and drops out of this list.
