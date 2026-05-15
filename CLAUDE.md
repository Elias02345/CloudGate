# CloudGate — Rules for Contributors & AI Assistants

> This file is auto-loaded by Claude Code in any session opened on this repo. It is also required reading for any human PR author. Detailed examples live in [`docs/UPDATE_RULES.md`](docs/UPDATE_RULES.md).

CloudGate ships a **built-in self-updater** that performs in-place updates on running user installations. Every change you make in `/app/` will eventually land on someone's homelab via that updater. **Breaking the update path = breaking trust.**

The rules below are the contract that keeps user data safe.

---

## 1. The Persistence Contract

CloudGate stores all user state under `/data/`. The self-updater overwrites `/app/` but **NEVER** touches the following paths:

| Path | Why it's sacred |
|---|---|
| `/data/secrets/encryption.key` | All encrypted DB blobs become unreadable without it |
| `/data/secrets/jwt.key` | Active sessions invalidated; not catastrophic but rude |
| `/data/secrets/initial-admin.txt` | Removed after first login; do not regenerate |
| `/data/db/db.sqlite` (+ `-wal`, `-shm`) | The whole app state. Touch only via Knex migrations. |
| `/data/cloudflared/<tunnel-id>.json` | Cloudflare credentials. Losing them = orphaned tunnel on CF side. |
| `/data/cloudflared/bin/` | User may have a newer cloudflared. Updated only via the cloudflared-update flow. |
| `/data/nginx/custom/` | User-authored snippets. Never overwrite. |
| `/data/nginx/certs/` | Let's Encrypt certs. Rate-limited to re-issue. Never delete. |
| `/data/logs/` | Append-only. Never truncate or delete. |

Files that ARE regenerated freely (and should be considered ephemeral by the updater):
- `/data/cloudflared/config.yml` — re-rendered from DB + template by backend.
- `/data/nginx/hosts/*.conf` — re-rendered from DB + template by backend.

If you find yourself wanting to delete or overwrite anything in the "sacred" list — **stop and ask in the PR**.

---

## 2. Bootstrap = Idempotent

`packages/backend/src/bootstrap.ts` runs on every container start. It must:

- ✅ Detect missing secrets and generate them via `crypto.randomBytes(32)` + base64.
- ✅ Detect existing secrets and **never regenerate** them.
- ✅ Detect a missing DB and run migrations + seed initial admin.
- ✅ Detect an existing DB and only run `knex migrate:latest` (no seeding).
- ✅ Wrap every step in its own try/catch with an `Error → Recovery UI` path.
- ❌ Never use `set -e` in bootstrap.sh without an explicit cleanup trap.
- ❌ Never assume `/data/` exists with permissions — check & fail loud to Recovery UI.

If you add a new secret type (e.g. a new key for some encryption feature), follow the existing pattern: `read-or-generate` in `bootstrap.ts`, never inline-generate elsewhere in the codebase.

---

## 3. Migrations

Place new migrations in `packages/backend/src/db/migrations/` with the pattern `<YYYYMMDDHHMMSS>_<description>.ts`.

**Allowed:**
- ✅ New tables.
- ✅ New columns — must be `NULLABLE` or have `.defaultTo(value)`.
- ✅ New indexes.
- ✅ Backfilling new NOT NULL columns: add as nullable → backfill → alter to NOT NULL in the same migration's `up`.
- ✅ Adding new rows to seed tables (e.g. new default settings keys).

**Forbidden without explicit user opt-in:**
- ❌ Editing an existing migration. (Always add a new one.)
- ❌ `DROP TABLE` / `DROP COLUMN` of anything that has held user data.
- ❌ `TRUNCATE` or unconditional `DELETE`.
- ❌ Changing the type of a column with data in it without a documented data-preserving conversion path.
- ❌ Renaming columns. (Add new + backfill + later drop, behind a major version bump.)

Every migration needs a working `down()`. Test it.

**Idempotency rule:** A migration that re-runs (due to manual intervention or recovery) must not crash. Use `hasTable` / `hasColumn` guards where appropriate.

---

## 4. Settings & Defaults

Settings live in the `settings` key/value table.

- ✅ Add a new settings key with a default. Backend reads `key ?? default-from-code`.
- ❌ Change the default of an existing key without a migration that explicitly migrates user values.
- ❌ Remove a settings key in active use. Mark it deprecated, ignore it in code, drop it in a much later release.

ENV variables follow the same rule: every new ENV must be optional with a safe default.

---

## 5. The Self-Updater (`updater.ts`)

Every release tarball contains `update-manifest.json`:

```json
{
  "version": "0.2.5",
  "min_upgrade_from": "0.2.0",
  "required_migrations": ["20260520_add_host_meta.ts"],
  "persisted_paths_check": [
    "/data/secrets/encryption.key",
    "/data/secrets/jwt.key",
    "/data/db/db.sqlite"
  ],
  "breaking_changes": false,
  "post_install_actions": [
    { "type": "regenerate", "target": "/data/cloudflared/config.yml" }
  ]
}
```

When you ship a release:
- ✅ Bump `version` in `package.json`.
- ✅ Update `update-manifest.json` (CI does this; don't hand-edit unless you know what you're doing).
- ✅ If a user must pass through an intermediate version (e.g. for a complex migration chain), set `min_upgrade_from` accordingly.
- ✅ Set `breaking_changes: true` to force manual confirmation in the UI.
- ✅ Document everything user-visible in `CHANGELOG.md` under a `## Breaking Changes` H2 if applicable — the updater parses that section for the UI banner.

---

## 6. Required Tests Per PR

The following test files MUST stay green:

- `packages/backend/tests/bootstrap.test.ts` — covers fresh `/data`, partial `/data`, corrupt DB.
- `packages/backend/tests/persistence.test.ts` — parameterised assertion that no sacred path is touched during a simulated update.
- `packages/backend/tests/updater.test.ts` — simulates upgrade from previous version using fixture data.

If your change requires modifying one of these tests, that itself is a discussion point in the PR. Loosening these tests is a red flag.

---

## 7. PR Checklist

Every PR template includes the following — check carefully:

- [ ] `/data/*` persistence verified (no sacred path touched).
- [ ] Migration is idempotent and has a working `down()`.
- [ ] Settings defaults unchanged OR explicitly documented in `CHANGELOG.md`.
- [ ] `update-manifest.json` template updated if migration added.
- [ ] `bootstrap.test.ts` green on fresh + existing `/data`.
- [ ] `persistence.test.ts` green.
- [ ] `CHANGELOG.md` updated for user-visible changes.

---

## 8. When in Doubt

Three guiding questions:

1. **"Would this destroy data on a user's machine that they couldn't get back?"** → If yes, find another way. Always.
2. **"Would this break a homelab user's existing setup after `docker pull` + restart?"** → If yes, gate it behind a manual flag.
3. **"Could a 50% successful update leave the system unusable?"** → If yes, redesign with snapshot + rollback.

The Recovery UI is the last resort, not an excuse for fragility. Ship updates that don't need it.

---

## 9. Project-Specific Tech Choices

(These are **not subject to change in a PR** without prior discussion — the architectural plan is in `docs/ARCHITECTURE.md`.)

- Backend: Node 22 + Express 5 + TypeScript + Objection/Knex + SQLite (Postgres-ready)
- Frontend: React 19 + Vite + TS + Mantine v7 + TanStack Query + react-i18next
- Cloudflare API: official [`cloudflare`](https://www.npmjs.com/package/cloudflare) npm library
- Crypto: AES-256-GCM (tokens), Argon2id (passwords), `jose` (JWT)
- Process supervision: s6-overlay v3
- Logs: Pino + structured JSON
- Package manager: pnpm with workspaces

When using external libraries, prefer mature, well-maintained packages. No bleeding-edge experiments in user-facing code.
