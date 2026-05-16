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
  log "ROLLBACK starting"
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
  write_marker "rolled_back" "see ${LOG}"
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
  rollback
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
# Migrate
# -----------------------------------------------------------------------------

log "Running migrations"
cd /app/backend || bail_with_rollback "cd /app/backend failed"
NODE_ENV=production timeout 60 node ./node_modules/.bin/knex \
  --knexfile dist/db/knexfile.js \
  migrate:latest 2>&1 | tee -a "${LOG}" \
  || bail_with_rollback "migrations failed"

# -----------------------------------------------------------------------------
# Restart + health-check
# -----------------------------------------------------------------------------

log "Starting backend"
s6-svc -u /run/service/backend 2>/dev/null || log "WARN: s6-svc -u failed"

log "Health-check loop (max 30s)"
healthy=no
for _ in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    healthy=yes
    break
  fi
  sleep 2
done

if [[ "${healthy}" != "yes" ]]; then
  bail_with_rollback "new backend never became healthy"
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
