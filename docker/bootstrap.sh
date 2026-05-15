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

log() {
  echo "${LOG_PREFIX} $*"
}

err() {
  echo "${LOG_PREFIX} ERROR: $*" >&2
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
