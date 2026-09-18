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
  if ! command -v chown >/dev/null 2>&1; then
    log "chown not available — skipping /data ownership setup"
    return 0
  fi

  # The recovery UI runs unprivileged (see docker/s6/recovery-ui/run), so /data
  # has to belong to that account. Default 1000:1000 matches the cloudgate user
  # baked into the image; PUID/PGID override it for operators who bind-mount a
  # host directory and need it owned by a specific id.
  RUNTIME_UID="${PUID:-1000}"
  RUNTIME_GID="${PGID:-${PUID:-1000}}"

  log "Setting /data owner to ${RUNTIME_UID}:${RUNTIME_GID}"
  chown -R "${RUNTIME_UID}:${RUNTIME_GID}" "$DATA_DIR" 2>/dev/null \
    || log "WARN: chown -R ${RUNTIME_UID}:${RUNTIME_GID} failed (continuing, may break later writes)"

  # Hand the resolved ids to the service scripts. They run before any Node
  # code and have no other way to learn what PUID/PGID resolved to.
  printf '%s:%s\n' "${RUNTIME_UID}" "${RUNTIME_GID}" > "${DATA_DIR}/.runtime-uidgid" 2>/dev/null \
    || log "WARN: could not write .runtime-uidgid — recovery UI will fall back to root"
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
# Recover from an update that was killed mid-swap.
#
# apply-update.sh replaces /app with a move-aside pattern: every /app/<sub> is
# renamed to <sub>.old, then the new one is moved in. Its own failures roll
# back, but a container death in between — an OOM kill, a host power cut, a
# `docker kill` — leaves no process to roll anything back. /app/<sub> is then
# simply gone while <sub>.old holds the last good copy.
#
# Nothing used to notice. The backend service would fail to start against a
# missing directory, and since .bootstrap-outcome still said "ok" from the
# previous boot, the recovery UI never took over either: an unusable install
# with no route back. CLAUDE.md §8 sets exactly this bar — a half-finished
# update must not leave the system stuck — so put it back on the way up.
# -----------------------------------------------------------------------------
heal_interrupted_update() {
  for sub in backend frontend recovery-ui; do
    # A half-finished copy from staging, cleaned up so it cannot be mistaken
    # for the real thing. apply-update.sh assembles under `.incoming` and only
    # renames into place once the copy is complete, so anything left here is
    # by definition unfinished.
    if [ -d "/app/${sub}.incoming" ]; then
      log "Interrupted update detected: discarding partial /app/${sub}.incoming"
      rm -rf "/app/${sub}.incoming" 2>/dev/null \
        || err "Could not remove /app/${sub}.incoming"
    fi

    if [ ! -d "/app/${sub}" ] && [ -d "/app/${sub}.old" ]; then
      log "Interrupted update detected: restoring /app/${sub} from ${sub}.old"
      mv "/app/${sub}.old" "/app/${sub}" \
        || err "Could not restore /app/${sub} — recovery UI should take over"
    fi
  done
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  log "Starting CloudGate bootstrap (version $(cat /app/.version 2>/dev/null || echo unknown))"

  heal_interrupted_update

  if ! ensure_data_dir; then
    finalize "fail-data-dir"
    return 1
  fi

  # Early: publishes .runtime-uidgid, which the recovery UI waits for before
  # deciding whether it can drop privileges.
  apply_uid_mapping

  if ! run_node_bootstrap; then
    # Still re-apply ownership: the node step may have created /data/db and
    # /data/secrets as root before failing, and the recovery UI — which is
    # exactly what runs now — needs to be able to work with them.
    apply_uid_mapping
    finalize "fail-node-bootstrap"
    return 1
  fi

  # The node bootstrap creates /data/db, /data/secrets and friends as root,
  # after the first chown has already run. Without this second pass those
  # directories stay root-owned and the unprivileged recovery UI cannot
  # restore a database or archive /data.
  apply_uid_mapping

  finalize "ok"
  return 0
}

main
# Do NOT exit non-zero — s6 will read the outcome file to decide what to do.
# This prevents the container from looping crash-restart-crash on a bad volume.
exit 0
