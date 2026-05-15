# Update Rules — Detailed Reference

This is the long-form companion to [`/CLAUDE.md`](../CLAUDE.md). Read CLAUDE.md first for the quick rules; come here for examples, anti-patterns, and the formal spec.

---

## Table of Contents

1. [The Persistence Contract — formal spec](#1-the-persistence-contract--formal-spec)
2. [Bootstrap Patterns](#2-bootstrap-patterns)
3. [Migration Patterns](#3-migration-patterns)
4. [Settings Evolution](#4-settings-evolution)
5. [Update Manifest Schema](#5-update-manifest-schema)
6. [Anti-Patterns Gallery](#6-anti-patterns-gallery)
7. [Versioning & Release Process](#7-versioning--release-process)

---

## 1. The Persistence Contract — formal spec

The self-updater operates under a **bind-mount assumption**: the user's `/data/` is a Docker volume that survives container replacement. Anything outside `/data/` is considered ephemeral (replaced on every update).

### Sacred paths (immutable to updater)

```
/data/secrets/                  # all auto-generated cryptographic material
/data/db/db.sqlite              # schema mutable via migrations; data NEVER touched
/data/db/db.sqlite-wal          # SQLite WAL — leave alone
/data/db/db.sqlite-shm          # SQLite shared memory — leave alone
/data/db/backups/               # historical snapshots; updater APPENDS here only
/data/cloudflared/*.json        # tunnel credentials (NOT config.yml — see below)
/data/cloudflared/bin/          # user-managed binaries
/data/nginx/custom/             # hand-rolled snippets
/data/nginx/certs/              # ACME-issued certificates
/data/logs/                     # append-only logs
/data/.bootstrap-complete       # bootstrap marker — never delete
/data/.version                  # last-known-good version marker
```

### Regenerable paths (updater may rewrite or leave alone — backend will rebuild)

```
/data/cloudflared/config.yml    # rendered from DB on next host change
/data/nginx/hosts/*.conf        # rendered from DB on next host change
/data/updates/staging/          # temp workspace — clean before, clean after
/data/.update.lock              # acquired/released by updater
```

### Code paths (fully owned by updater)

```
/app/**                         # everything under here is fair game on update
```

---

## 2. Bootstrap Patterns

### The read-or-generate idiom

```typescript
// packages/backend/src/bootstrap.ts (sketch)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

async function ensureSecret(path: string, lengthBytes: number): Promise<string> {
  try {
    if (existsSync(path)) {
      return (await readFile(path, 'utf8')).trim();
    }
  } catch (err) {
    // fall through to generate
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = randomBytes(lengthBytes).toString('base64');
  await writeFile(path, value, { mode: 0o600 });
  return value;
}
```

**Key properties:**
- Never overwrites existing material.
- Creates parent dirs with strict perms.
- Returns the value (cached or new) so callers don't need to know which path was taken.

### What goes wrong without idempotency

Anti-pattern (DON'T):
```typescript
// BAD: regenerates on every boot, breaks all encrypted blobs
const key = randomBytes(32).toString('base64');
await writeFile('/data/secrets/encryption.key', key);
```

This kind of bug is silent — first boot looks fine, second boot suddenly nothing decrypts.

---

## 3. Migration Patterns

### Adding a column safely

```typescript
// migrations/20260520_add_host_meta.ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.json('meta').defaultTo('{}');           // nullable + default = safe
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('meta');
  });
}
```

### Backfilling before NOT NULL

```typescript
export async function up(knex: Knex): Promise<void> {
  // step 1: add nullable
  await knex.schema.alterTable('users', (t) => {
    t.string('display_name').nullable();
  });

  // step 2: backfill from existing data
  await knex.raw(
    `UPDATE users SET display_name = COALESCE(name, email) WHERE display_name IS NULL`
  );

  // step 3: tighten to NOT NULL — SQLite needs alterTable workaround
  await knex.schema.alterTable('users', (t) => {
    t.string('display_name').notNullable().alter();
  });
}
```

### Idempotency guards

```typescript
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('webhooks'))) {
    await knex.schema.createTable('webhooks', (t) => {
      t.increments('id').primary();
      t.string('url').notNullable();
      t.timestamps(true, true);
    });
  }
}
```

Use sparingly — Knex normally tracks migrations, but if a user's `knex_migrations` table is corrupted, these guards save them.

---

## 4. Settings Evolution

Settings live in a key/value table. The recommended pattern:

```typescript
// packages/backend/src/services/settings.ts
const DEFAULTS = {
  update_channel: 'stable',
  update_mode: 'notify',
  auto_update_minor_only: true,
  cloudflared_auto_update: 'pinned',
  // NEW IN v0.3.0:
  health_check_interval_seconds: 10,
};

export async function getSetting<K extends keyof typeof DEFAULTS>(
  key: K
): Promise<typeof DEFAULTS[K]> {
  const row = await db('settings').where({ key }).first();
  return row ? row.value : DEFAULTS[key];
}
```

To add `health_check_interval_seconds`:
- ✅ Add to `DEFAULTS` constant.
- ✅ Old users (no row in DB) get the default automatically.
- ✅ New users get the default too.
- ❌ Do NOT change `DEFAULTS.update_mode` from `notify` to `auto` — that would silently flip behaviour for everyone.

---

## 5. Update Manifest Schema

```jsonc
{
  // semver of this release
  "version": "0.3.0",

  // refuses to upgrade if user is on a version older than this
  // (forces an intermediate stepping stone)
  "min_upgrade_from": "0.2.0",

  // list of migration filenames included in this release
  // (informational — actual migration table is the source of truth)
  "required_migrations": [
    "20260520_add_host_meta.ts",
    "20260521_settings_health_interval.ts"
  ],

  // paths the updater verifies exist + are readable BEFORE deploying
  // (prevents updating a half-broken /data)
  "persisted_paths_check": [
    "/data/secrets/encryption.key",
    "/data/secrets/jwt.key",
    "/data/db/db.sqlite"
  ],

  // if true, UI forces manual user confirmation (auto-update skipped)
  "breaking_changes": false,

  // post-deploy actions, run after migrations + before health check
  "post_install_actions": [
    { "type": "regenerate", "target": "/data/cloudflared/config.yml" },
    { "type": "regenerate", "target": "/data/nginx/hosts/*.conf" },
    { "type": "restart-service", "target": "cloudflared" }
  ]
}
```

The CI release pipeline generates this from `package.json` + migration directory + an optional `release.manifest.json` override in the repo root.

---

## 6. Anti-Patterns Gallery

### ❌ Anti-pattern: silent overwrite of user file
```typescript
// somewhere in updater.ts
await copyFile('templates/config.yml', '/data/cloudflared/config.yml');
```
Why bad: user might have a working tunnel running on the existing config. Overwriting causes downtime + possible loss of in-flight changes.
Fix: rebuild from DB+template at backend start, never copy raw templates into `/data/`.

### ❌ Anti-pattern: destructive DROP in production migration
```typescript
export async function up(knex) {
  await knex.schema.dropTable('legacy_audit_log');
}
```
Why bad: any data the user might still want is gone forever.
Fix: rename to `_legacy_audit_log` and drop it in a major-version-bump release with explicit user-visible CHANGELOG entry.

### ❌ Anti-pattern: required ENV variable
```typescript
const key = process.env.CLOUDGATE_MAGIC_KEY ?? throwHelpfully('Set MAGIC_KEY!');
```
Why bad: zero-config install promise broken. User pulls new image, container won't start.
Fix: every ENV must have a generated default in bootstrap.

### ❌ Anti-pattern: in-place file edit during update
```bash
sed -i 's/old/new/' /app/some-file.conf
```
Why bad: not idempotent, breaks rollback (the old snapshot still has `old`).
Fix: ship the new file as part of the release artifact.

---

## 7. Versioning & Release Process

**SemVer:** `vMAJOR.MINOR.PATCH`

- **PATCH** (`0.2.1` → `0.2.2`): bug fixes, no schema changes, no behaviour changes. Safe for `auto`-mode updates.
- **MINOR** (`0.2.x` → `0.3.0`): new features, additive schema changes, new ENVs (all optional). Safe for `auto`-mode by default if `auto_update_minor_only=true`.
- **MAJOR** (`0.x.y` → `1.0.0`): potentially breaking changes. Always requires manual confirmation. Document breaking changes loudly in release notes.

**Release flow:**
1. Open PR from `dev` → `main`.
2. CI passes. Reviewer approves.
3. Merge.
4. Tag the merge commit: `git tag v0.x.y && git push --tags`.
5. GitHub Action `release.yml` builds tarball, signs with GPG, creates GitHub Release, pushes Docker images to GHCR (`:vX.Y.Z`, `:latest`, `:main`).
6. Within ~6h, all running CloudGate instances with `update_channel: stable` see the update available.

---

## Last word

These rules exist because someone, somewhere, will be running CloudGate on a machine they care about, with photos of their kids in Immich and irreplaceable Nextcloud data behind it. The cost of breaking their setup with a careless update is enormous; the cost of being a bit pedantic in a PR is tiny. When in doubt, ask.
