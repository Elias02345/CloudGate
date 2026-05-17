#!/usr/bin/env bash
# =============================================================================
# CloudGate Bootstrap (shell-side wrapper)
#
# Runs ONCE at container start, BEFORE the backend service.
#
# DESIGN RULES (see CLAUDE.md §2):
# - Idempotent: re-runnable any time.
# - NEVER 'set -e' without an explicit failure handler. We want every step
#   to either succeed, recover, or hand off to the Recovery UI — never crash
#   the container.
# - The heavy lifting (key generation, DB migrations, admin seed) is done by
#   the Node-side bootstrap (packages/backend/dist/bootstrap.js). This shell
#   wrapper handles the lowest level: ensuring /data exists, has correct
#   permissions, and the Node bootstrap binary is reachable.
# =============================================================================

DATA_DIR="${CLOUDGATE_DATA_DIR:-/data}"
APP_DIR="/app"
LOG_PREFIX="[bootstrap]"
PUID="${PUID:-}"
PGID="${PGID:-}"

log() {
  echo "${LOG_PREFIX} $*"
}

err() {
  echo "${LOG_PREFIX} ERROR: $*" >&2
}

# -----------------------------------------------------------------------------
# PUID/PGID — LinuxServer.io-style user-id mapping for /data ownership.
# When the user mounts a volume from the host, /data may need to be owned by
# a specific UID/GID so the host can read/write it cleanly. Optional.
# -----------------------------------------------------------------------------
apply_uid_mapping() {
  if [ -z "$PUID" ] && [ -z "$PGID" ]; then
    return 0
  fi
  if ! command -v chown >/dev/null 2>&1; then
    log "chown not available — skipping PUID/PGID"
    return 0
  fi
  if [ -n "$PUID" ]; then
    log "Setting /data owner to UID=$PUID"
    chown -R "$PUID:${PGID:-$PUID}" "$DATA_DIR" 2>/dev/null \
      || log "WARN: chown -R $PUID:$PGID failed (continuing, may break later writes)"
  fi
}

# -----------------------------------------------------------------------------
# Step 1: ensure /data exists and is writable
# -----------------------------------------------------------------------------
ensure_data_dir() {
  if [ ! -d "$DATA_DIR" ]; then
    if ! mkdir -p "$DATA_DIR"; then
      err "Cannot create $DATA_DIR"
      return 1
    fi
  fi
  if ! touch "$DATA_DIR/.write-probe" 2>/dev/null; then
    err "$DATA_DIR is not writable"
    return 1
  fi
  rm -f "$DATA_DIR/.write-probe"
  log "Data dir OK: $DATA_DIR"
  return 0
}

# -----------------------------------------------------------------------------
# Step 2: invoke node-side bootstrap (where real logic lives)
# -----------------------------------------------------------------------------
run_node_bootstrap() {
  local bootstrap_js="${APP_DIR}/backend/dist/bootstrap.js"
  if [ ! -f "$bootstrap_js" ]; then
    err "Bootstrap binary missing: $bootstrap_js"
    return 1
  fi
  log "Running node bootstrap…"
  if ! node "$bootstrap_js"; then
    err "Node bootstrap failed (exit code $?)"
    return 1
  fi
  log "Node bootstrap completed"
  return 0
}

# -----------------------------------------------------------------------------
# Step 3: write a marker for s6 to decide which downstream service to start
# -----------------------------------------------------------------------------
finalize() {
  local outcome="$1"
  echo "$outcome" > "$DATA_DIR/.bootstrap-outcome"
  if [ "$outcome" = "ok" ]; then
    log "Bootstrap completed successfully — backend will start"
  else
    err "Bootstrap failed — recovery-ui will start instead"
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  log "Starting CloudGate bootstrap (version $(cat /app/.version 2>/dev/null || echo unknown))"

  if ! ensure_data_dir; then
    finalize "fail-data-dir"
    return 1
  fi

  apply_uid_mapping

  if ! run_node_bootstrap; then
    finalize "fail-node-bootstrap"
    return 1
  fi

  finalize "ok"
  return 0
}

main
# Do NOT exit non-zero — s6 will read the outcome file to decide what to do.
# This prevents the container from looping crash-restart-crash on a bad volume.
exit 0
