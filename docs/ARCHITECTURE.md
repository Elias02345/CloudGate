# CloudGate Architecture

> Living document. The detailed planning record is in `~/.claude/plans/hallo-claude-ich-w-rde-eager-matsumoto.md` (developer-internal).

## High-level diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  ───────                                                         │
│  http://<host>/ ───► nginx :80 ──► frontend (static)             │
│                              └──►  /api/* → backend :3000        │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  CloudGate container (single image, s6-overlay supervised)       │
│  ─────────────────────────────────────────────                   │
│                                                                  │
│  bootstrap (oneshot) ──► success ──► backend + nginx (cloudgate) │
│                      └─► failure ──► recovery-ui via nginx       │
│                                                                  │
│  backend                                                         │
│   ├─► spawns cloudflared (child_process) ──► tunnels → CF edge   │
│   ├─► writes /data/cloudflared/config.yml (Liquid template)      │
│   ├─► writes /data/nginx/hosts/*.conf when in local_nginx mode   │
│   └─► self-updater: polls GitHub releases, GPG verify, rollback  │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  /data volume (persistent, NEVER overwritten by updates)         │
│  ──────────────                                                  │
│  secrets/           encryption.key, jwt.key, initial-admin.txt   │
│  db/                db.sqlite + backups                          │
│  cloudflared/       <tunnel-id>.json + config.yml + bin/         │
│  nginx/             hosts/, certs/, custom/                      │
│  logs/              cloudgate.log, cloudflared.log, …            │
│  updates/           staging/, backups/, .update.lock             │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
              ┌─────────────────────────────────────┐
              │  Cloudflare API                     │
              │  ─────────────                      │
              │  POST /accounts/{tag}/cfd_tunnel    │
              │  POST /zones/{zone}/dns_records     │
              └─────────────────────────────────────┘
```

## Boot sequence

1. **Container start** → `s6-overlay /init`.
2. `s6` runs `bootstrap` (oneshot) — defined in `docker/s6/bootstrap/`.
3. `bootstrap.sh` invokes `node /app/backend/dist/bootstrap.js`.
4. `bootstrap.js` runs idempotent steps (see `packages/backend/src/bootstrap.ts` and `CLAUDE.md` §2).
5. Outcome (`ok` / `fail-*`) written to `/data/.bootstrap-outcome`.
6. `s6` starts `nginx` and `backend` services. `nginx`'s `run` script reads the outcome:
   - `ok` → uses `docker/nginx/cloudgate.conf` (UI + `/api`).
   - anything else → uses `docker/nginx/recovery.conf` (everything → recovery-ui).
7. `recovery-ui` runs always on port 8001 — also exposed under `/__recovery/` in healthy mode for emergency access.

## Why two UIs?

The Recovery UI exists so a user never sees a dead container. If the backend can't import a module, can't open the DB, can't talk to Cloudflare — the Recovery UI is up, shows logs, lets the user download a backup, and proposes safe recovery actions. The cost is ~20MB of additional image size for an Express + static HTML stub. Worth it.

## Why no required env vars?

The Zero-Config promise (see plan §9.1 and `CLAUDE.md` §9): a user pulls the image, runs it with a volume mount, and gets a working installation. Every secret needed for security is auto-generated at first run and persisted to `/data/secrets/`. ENV vars are *overrides* only — useful for advanced setups, never required.

## Update flow

See `CLAUDE.md` §5 and `docs/UPDATE_RULES.md` for the formal rules. TL;DR:
1. Poll GitHub releases every 6h.
2. Download tar.gz + sha256 + sig.
3. Verify SHA256 + GPG signature.
4. Snapshot `/app` and the SQLite DB.
5. Atomic swap `/app`, run migrations, health-check.
6. On any failure: rollback from snapshots.
7. `/data` is never touched (except DB migrations).

## Tech choices (summary)

- **Node 22** runtime — native modules: `better-sqlite3`, `argon2`.
- **Express 5** + **TypeScript** + **Objection/Knex** ORM.
- **React 19** + **Vite 6** + **Mantine 7** + **TanStack Query 5** + **react-i18next**.
- **cloudflared** (official Debian package) for tunnel daemon.
- **s6-overlay v3** for process supervision.
- **debian-bookworm-slim** base image for runtime stage.

See [`CLAUDE.md`](../CLAUDE.md) §9 for the binding tech-choice list and `package.json` files for exact versions.
