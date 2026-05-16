# 🌩️ CloudGate

> **Self-hosted WebUI for Cloudflare Tunnels.** Host services from behind CGNAT without port forwarding — Immich, Nextcloud, Jellyfin, Proxmox, Home Assistant, you name it.

**Status:** 🚧 pre-alpha — under active development, not yet production-ready.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build](https://github.com/Elias02345/CloudGate/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/Elias02345/CloudGate/actions/workflows/ci.yml)

---

## Why CloudGate?

Many home internet connections (especially in Germany — 1&1, Vodafone Cable, mobile) sit behind **CGNAT** or DS-Lite. You have no public IPv4, no port forwarding, and tools like [Nginx Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager) simply don't work.

**Cloudflare Tunnel** solves this — for free — but the setup (`cloudflared login`, `tunnel create`, `route dns`, manage `config.yml`, run the daemon) is a hard wall for non-sysadmins.

**CloudGate** is a WebUI that does it all:
- Add a service: enter `192.168.1.42:8080` and `immich.yourdomain.com` → done.
- CloudGate creates the Cloudflare Tunnel, DNS record, ingress rule, and reloads `cloudflared`.
- Hybrid mode: per host, pick **"via Cloudflare Tunnel"** OR **"local nginx reverse proxy"**.
- Auto-updates itself when new releases ship. Never overwrites your data.

> **Not affiliated with Cloudflare.** CloudGate uses Cloudflare's public Tunnel infrastructure via their documented API.

---

## Quick Start

### Option A — One-liner (Ubuntu / Debian / LXC / Proxmox)

Fresh Ubuntu container, no prior setup:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elias02345/CloudGate/main/install/lxc-install.sh)"
```

The installer:
- Installs Docker if missing
- Pulls the latest CloudGate image (falls back to building from source)
- Creates a persistent data volume
- Starts the container and waits for it to become healthy
- Prints your initial admin password

**Re-runnable** — running it again won't wipe your data.

> **Proxmox LXC users**: enable `nesting=1,keyctl=1` in the container's features config.
> Use an Ubuntu 24.04 template, 2 cores, 1 GB RAM, 4 GB disk minimum.

### Option B — Plain Docker

If you already have Docker:

```bash
docker run -d --name cloudgate \
  -p 80:80 -p 443:443 \
  -v cloudgate-data:/data \
  --restart unless-stopped \
  ghcr.io/elias02345/cloudgate:latest
```

### What happens next

1. Open `http://<your-host-ip>/` in a browser.
2. Login as `admin@cloudgate.local` with the password shown in container logs:
   ```bash
   docker logs cloudgate | grep -A1 "INITIAL ADMIN PASSWORD"
   ```
3. Change the password (forced on first login).
4. Add your Cloudflare API token in the UI (instructions: see [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md)).
5. Create your first tunnel, add a host — services live within ~30 seconds.

That's it. CloudGate manages keys, secrets, and updates automatically.

---

## Features

- 🔐 **Zero-config bootstrap** — auto-generates encryption keys, JWT secret, admin password
- 🌐 **Cloudflare Tunnel manager** — full UI for tunnels, DNS routes, ingress rules
- 🔀 **Hybrid mode** — per host: Cloudflare Tunnel OR local nginx reverse proxy
- ♻️ **Self-updating** — checks GitHub for new releases, GPG-verified, atomic with auto-rollback
- 🛡️ **Anti-brick guarantee** — Recovery UI when anything fails to start
- 🌍 **i18n** — Deutsch + English from day one
- 🔒 **2FA** — TOTP optional
- 📜 **Audit log** — every change tracked

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — rules for contributors (and AI assistants) on writing updates that don't break user data
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design overview
- [`docs/UPDATE_RULES.md`](docs/UPDATE_RULES.md) — detailed update-safety rules
- [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md) — how to create the Cloudflare API token

---

## Branch Strategy

- `main` — release-only. Tagged versions `v0.x.y` trigger GitHub Releases + GHCR image builds.
- `dev` — active development. All feature work goes here first.
- Feature branches → PR into `dev` → CI must pass.
- Periodic merges `dev → main` produce releases.

---

## Contributing

PRs welcome. Read [`CLAUDE.md`](CLAUDE.md) first — especially the persistence and migration rules.
See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the dev workflow.

## License

[MIT](LICENSE)
