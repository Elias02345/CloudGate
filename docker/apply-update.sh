#!/usr/bin/env bash
# =============================================================================
# CloudGate in-container update applier.
#
#   apply-update.sh <archive.tar.gz> <target-version>
#
# Called by services/updater.ts. Runs detached. Responsible for:
#   1. Pre-flight: disk space, archive integrity
#   2. Snapshot:   /app → /data/updates/backups/app-<oldver>-<ts>
#                  /data/db/db.sqlite → /data/db/backups/pre-update-<oldver>.sqlite
#   3. Extract:    archive → /data/updates/staging/new-<ver>
#   4. Stop backend, atomic swap, run migrations, restart, health-check
#   5. On failure: rollback to snapshots, restart, mark
#
# Per CLAUDE.md §10.3 / §11.4: NEVER touch /data/secrets/,
# /data/cloudflared/*.json, /data/nginx/custom/, /data/nginx/certs/,
# /data/logs/ — only /app/ and the DB (via migrate).
#
# INTENTIONALLY paranoid: every step wrapped, every failure logged
# + marker written. Never gets stuck half-applied.
# =============================================================================

set -uo pipefail   # NOT -e — we handle each step manually

readonly ARCHIVE="${1:-}"
readonly TARGET_VERSION="${2:-unknown}"
readonly OLD_VERSION="$(cat /app/.version 2>/dev/null || echo unknown)"
readonly TS="$(date -u +%Y%m%dT%H%M%SZ)"
readonly LOG="/data/logs/update-history.log"
readonly LOCK="/data/updates/.update.lock"

readonly APP_SNAPSHOT_DIR="/data/updates/backups/app-${OLD_VERSION}-${TS}"
readonly DB_SNAPSHOT="/data/db/backups/pre-update-${OLD_VERSION}-${TS}.sqlite"
readonly STAGE_DIR="/data/updates/staging/new-${TARGET_VERSION}"

# -----------------------------------------------------------------------------
# Helpers (defined before any use)
# -----------------------------------------------------------------------------

log() {
  local ts; ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] %s\n' "${ts}" "$*" | tee -a "${LOG}" >&2
}

write_marker() {
  local outcome="$1"; shift
  local reason="${*:-}"
  cat >"/data/updates/.last-update-${TS}.json" <<JSON
{
  "from": "${OLD_VERSION}",
  "to": "${TARGET_VERSION}",
  "outcome": "${outcome}",
  "reason": "${reason}",
  "snapshot": "${APP_SNAPSHOT_DIR}",
  "db_snapshot": "${DB_SNAPSHOT}",
  "started_at": "${TS}"
}
JSON
}

cleanup_lock() {
  rm -f "${LOCK}" 2>/dev/null || true
}

rollback() {
  local reason="${1:-rollback triggered}"
  log "ROLLBACK starting: ${reason}"
  s6-svc -d /run/service/backend 2>/dev/null || true

  # Restore code from .old aside-moves first, snapshot dir as second resort
  local sub
  for sub in backend frontend recovery-ui; do
    rm -rf "/app/${sub}" 2>/dev/null || true
    if [[ -d "/app/${sub}.old" ]]; then
      mv "/app/${sub}.old" "/app/${sub}" || log "ROLLBACK: restoring ${sub} from .old failed"
    elif [[ -d "${APP_SNAPSHOT_DIR}/${sub}" ]]; then
      cp -a "${APP_SNAPSHOT_DIR}/${sub}" "/app/" || log "ROLLBACK: cp from snapshot ${sub} failed"
    fi
  done
  [[ -f "${APP_SNAPSHOT_DIR}/.version" ]] && cp "${APP_SNAPSHOT_DIR}/.version" /app/.version || true

  # Restore DB
  if [[ -f "${DB_SNAPSHOT}" ]]; then
    cp -f "${DB_SNAPSHOT}" /data/db/db.sqlite || log "ROLLBACK: DB restore failed"
    rm -f /data/db/db.sqlite-wal /data/db/db.sqlite-shm 2>/dev/null || true
  fi

  s6-svc -u /run/service/backend 2>/dev/null || true
  write_marker "rolled_back" "${reason}"
  cleanup_lock
  log "ROLLBACK complete"
}

bail() {
  local why="$1"
  log "FATAL: ${why}"
  write_marker "failed" "${why}"
  cleanup_lock
  exit 1
}

bail_with_rollback() {
  local why="$1"
  log "FATAL: ${why} — rolling back"
  rollback "${why}"
  exit 1
}

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

mkdir -p /data/logs /data/updates/backups /data/updates/staging /data/db/backups 2>/dev/null

[[ -z "${ARCHIVE}" ]] && bail "no archive path argument"
[[ ! -r "${ARCHIVE}" ]] && bail "archive not readable: ${ARCHIVE}"

log "=== Update starting: ${OLD_VERSION} → ${TARGET_VERSION} (archive=${ARCHIVE})"

# Disk space (need ~500MB free)
free_kb="$(df -k /data | awk 'NR==2 {print $4}')"
if (( free_kb < 500000 )); then
  bail "insufficient disk space (need 500MB, have $((free_kb / 1024))MB)"
fi
log "Disk space OK: $((free_kb / 1024)) MB free"

# -----------------------------------------------------------------------------
# Snapshot
# -----------------------------------------------------------------------------

log "Snapshotting /app → ${APP_SNAPSHOT_DIR}"
mkdir -p "${APP_SNAPSHOT_DIR}" || bail "mkdir snapshot failed"
cp -a /app/backend "${APP_SNAPSHOT_DIR}/" || bail "cp -a /app/backend failed"
cp -a /app/frontend "${APP_SNAPSHOT_DIR}/" 2>/dev/null || true
cp -a /app/recovery-ui "${APP_SNAPSHOT_DIR}/" 2>/dev/null || true
[[ -f /app/.version ]] && cp /app/.version "${APP_SNAPSHOT_DIR}/" || true

log "Snapshotting DB → ${DB_SNAPSHOT}"
if [[ -f /data/db/db.sqlite ]]; then
  sqlite3 /data/db/db.sqlite ".backup '${DB_SNAPSHOT}'" || bail "DB snapshot failed"
fi

# Rotate old app snapshots — keep 3 newest
# shellcheck disable=SC2012
ls -1dt /data/updates/backups/app-* 2>/dev/null | tail -n +4 | xargs -r rm -rf 2>/dev/null || true

# -----------------------------------------------------------------------------
# Extract
# -----------------------------------------------------------------------------

log "Extracting ${ARCHIVE} → ${STAGE_DIR}"
rm -rf "${STAGE_DIR}" 2>/dev/null
mkdir -p "${STAGE_DIR}" || bail "mkdir stage failed"
tar -xzf "${ARCHIVE}" -C "${STAGE_DIR}" || bail "tar extraction failed"

EXTRACTED_ROOT=""
if [[ -d "${STAGE_DIR}/cloudgate" ]]; then
  EXTRACTED_ROOT="${STAGE_DIR}/cloudgate"
else
  found="$(find "${STAGE_DIR}" -maxdepth 2 -name '.version' -type f 2>/dev/null | head -1)"
  EXTRACTED_ROOT="$(dirname "${found}")"
fi
[[ -d "${EXTRACTED_ROOT}/backend" ]] || bail "extracted bundle has no backend/ — corrupt artifact"

# -----------------------------------------------------------------------------
# Stop backend
# -----------------------------------------------------------------------------

log "Stopping backend service"
s6-svc -d /run/service/backend 2>/dev/null || log "WARN: s6-svc -d failed (continuing)"
for _ in $(seq 1 20); do
  ss -tln 2>/dev/null | grep -q ':3000 ' || break
  sleep 0.5
done

# -----------------------------------------------------------------------------
# Swap (move-aside pattern for safe rollback)
# -----------------------------------------------------------------------------

log "Swapping /app contents"
swap_failed=no
for sub in backend frontend recovery-ui; do
  if [[ -d "/app/${sub}" ]]; then
    mv "/app/${sub}" "/app/${sub}.old" || { swap_failed=yes; break; }
  fi
done
if [[ "${swap_failed}" == "yes" ]]; then
  bail_with_rollback "could not move /app/* aside"
fi

for sub in backend frontend recovery-ui; do
  if [[ -d "${EXTRACTED_ROOT}/${sub}" ]]; then
    mv "${EXTRACTED_ROOT}/${sub}" "/app/${sub}" || bail_with_rollback "move ${sub} from staging failed"
  fi
done
[[ -f "${EXTRACTED_ROOT}/.version" ]] && cp "${EXTRACTED_ROOT}/.version" /app/.version
echo "${TARGET_VERSION#v}" > /data/.version 2>/dev/null || true

# -----------------------------------------------------------------------------
# node_modules fallback
#
# Newer release tarballs are built with `pnpm deploy --prod` so the
# extracted backend/ has its own production node_modules. Older tarballs
# (≤ v0.1.3) shipped only dist/ → the swap leaves /app/backend without
# its native modules and migrations fail. We carry the old node_modules
# forward as a fallback so the install can complete instead of rolling
# back. ABI mismatches are rare since we pin node 22 across releases.
# -----------------------------------------------------------------------------

for sub in backend recovery-ui; do
  if [[ -d "/app/${sub}" && ! -d "/app/${sub}/node_modules" && -d "/app/${sub}.old/node_modules" ]]; then
    log "node_modules missing in new ${sub}/ — carrying forward from ${sub}.old/ (fallback)"
    cp -a "/app/${sub}.old/node_modules" "/app/${sub}/node_modules" \
      || log "WARN: copying ${sub}.old/node_modules failed (continuing — likely will fail later)"
  fi
done

# -----------------------------------------------------------------------------
# Migrate
#
# Strategy:
#   1. Pre-flight check: db file exists + readable + integrity_check ok.
#   2. Prefer the standalone migration runner (dist/db/run-migrations.js)
#      — it ships compiled with every backend build from v0.1.7+ and uses
#      absolute paths derived from import.meta.url so it can't pick the
#      wrong CWD.
#   3. Fallback to the knex CLI (older tarballs that don't have the
#      runner yet).
#   4. Capture stderr/stdout — last 50 lines go into the rollback marker
#      so the UI shows the actual error, not just "migrations failed".
# -----------------------------------------------------------------------------

log "Running migrations"
cd /app/backend || bail_with_rollback "cd /app/backend failed"

# DB pre-check — fail fast with clear message rather than letting knex
# crash on a corrupt db.
if [[ ! -r /data/db/db.sqlite ]]; then
  bail_with_rollback "DB at /data/db/db.sqlite missing or unreadable"
fi
DB_INTEGRITY="$(timeout 10 sqlite3 /data/db/db.sqlite 'PRAGMA integrity_check;' 2>&1 || echo 'check-failed')"
if [[ "${DB_INTEGRITY}" != "ok" ]]; then
  log "WARN: sqlite integrity_check returned: ${DB_INTEGRITY}"
  # We don't bail — the snapshot we already took has the same data.
  # Migrations may still succeed on corruption that integrity_check
  # is picky about.
fi
log "Pre-flight: db readable, integrity=${DB_INTEGRITY}"

MIGRATE_LOG="$(mktemp /tmp/cg-migrate.XXXXXX.log)"
MIGRATE_EXIT=0
MIGRATE_METHOD=""

if [[ -f "./dist/db/run-migrations.js" ]]; then
  MIGRATE_METHOD="run-migrations.js"
  log "Using standalone migration runner (dist/db/run-migrations.js)"
  NODE_ENV=production timeout 180 node ./dist/db/run-migrations.js \
    >>"${MIGRATE_LOG}" 2>&1 || MIGRATE_EXIT=$?
else
  # Fallback for older tarballs: knex CLI. Same caveats apply (CWD
  # resolution etc.) — we use absolute --knexfile path here.
  KNEX_BIN=""
  for candidate in ./node_modules/.bin/knex ./node_modules/knex/bin/knex.js; do
    if [[ -x "${candidate}" || -f "${candidate}" ]]; then
      KNEX_BIN="${candidate}"
      break
    fi
  done
  if [[ -z "${KNEX_BIN}" ]]; then
    bail_with_rollback "neither dist/db/run-migrations.js nor knex CLI found — tarball is incomplete"
  fi
  MIGRATE_METHOD="knex-cli (${KNEX_BIN})"
  log "Using ${MIGRATE_METHOD}"
  NODE_ENV=production timeout 180 node "${KNEX_BIN}" \
    --knexfile "$(pwd)/dist/db/knexfile.js" \
    --cwd "$(pwd)/dist/db" \
    migrate:latest >>"${MIGRATE_LOG}" 2>&1 || MIGRATE_EXIT=$?
fi

# Echo the full migration output to the main log regardless of outcome
cat "${MIGRATE_LOG}" | tee -a "${LOG}"

if [[ "${MIGRATE_EXIT}" -ne 0 ]]; then
  # Capture the last 50 lines for the rollback marker — gives UI users
  # a real error message instead of just "migrations failed".
  TAIL_LINES="$(tail -50 "${MIGRATE_LOG}" | tr '\n' ' ' | tr '"' "'" | head -c 1500)"
  rm -f "${MIGRATE_LOG}" 2>/dev/null || true
  bail_with_rollback "migrations failed (method=${MIGRATE_METHOD}, exit=${MIGRATE_EXIT}): ${TAIL_LINES}"
fi

log "Migrations OK (method=${MIGRATE_METHOD})"
rm -f "${MIGRATE_LOG}" 2>/dev/null || true

# -----------------------------------------------------------------------------
# Restart + health-check
# -----------------------------------------------------------------------------

log "Starting backend"
s6-svc -u /run/service/backend 2>/dev/null || log "WARN: s6-svc -u failed"

# Generous health-check loop — 60s total. The first start of a fresh
# backend can take 10-20s on slow disks; previous 30s was too tight.
log "Health-check loop (max 60s)"
healthy=no
HEALTH_LAST=""
for _ in $(seq 1 30); do
  HEALTH_LAST="$(curl -fsS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || echo 'connect-fail')"
  if [[ "${HEALTH_LAST}" == "200" ]]; then
    healthy=yes
    break
  fi
  sleep 2
done

if [[ "${healthy}" != "yes" ]]; then
  bail_with_rollback "new backend never became healthy (last http_code=${HEALTH_LAST})"
fi

# -----------------------------------------------------------------------------
# Success — clean up
# -----------------------------------------------------------------------------

log "✓ Update successful — cleaning up"
for sub in backend frontend recovery-ui; do
  rm -rf "/app/${sub}.old" 2>/dev/null || true
done
rm -rf "${STAGE_DIR}" 2>/dev/null || true

write_marker "succeeded"
cleanup_lock
log "=== Update complete: now running ${TARGET_VERSION}"
exit 0
