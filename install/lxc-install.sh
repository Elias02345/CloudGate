#!/usr/bin/env bash
# =============================================================================
# CloudGate — Ubuntu / Debian one-liner installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elias02345/CloudGate/main/install/lxc-install.sh)"
#
# Works on:
#   - Fresh Ubuntu 22.04 / 24.04 LXC container (Proxmox, Incus, LXD)
#   - Plain Ubuntu / Debian VM
#   - Any Docker host (skips Docker install if already present)
#
# DESIGN: robust + self-recovering. NEVER 'set -e' globally — each step is
# fault-tolerant on its own. Re-runnable any time (idempotent).
# =============================================================================

set -uo pipefail
IFS=$'\n\t'

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

readonly CG_CONTAINER="${CG_CONTAINER:-cloudgate}"
readonly CG_VOLUME="${CG_VOLUME:-cloudgate-data}"
readonly CG_HTTP_PORT="${CG_HTTP_PORT:-80}"
readonly CG_HTTPS_PORT="${CG_HTTPS_PORT:-443}"
readonly CG_IMAGE_CANDIDATES=(
  "${CG_IMAGE:-ghcr.io/elias02345/cloudgate:latest}"
  "ghcr.io/elias02345/cloudgate:main"
  "ghcr.io/elias02345/cloudgate:nightly"
  "ghcr.io/elias02345/cloudgate:dev"
)
readonly CG_REPO_URL="https://github.com/Elias02345/CloudGate.git"
readonly CG_REPO_BRANCH="${CG_REPO_BRANCH:-dev}"

readonly LOG_PREFIX="[cloudgate]"

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------

# Detect if stdout is a TTY for nicer colors. Falls back to plain text otherwise.
if [[ -t 1 ]]; then
  readonly C_CYAN=$'\033[36m'
  readonly C_GREEN=$'\033[32m'
  readonly C_YELLOW=$'\033[33m'
  readonly C_RED=$'\033[31m'
  readonly C_BOLD=$'\033[1m'
  readonly C_RESET=$'\033[0m'
else
  readonly C_CYAN=''
  readonly C_GREEN=''
  readonly C_YELLOW=''
  readonly C_RED=''
  readonly C_BOLD=''
  readonly C_RESET=''
fi

log()     { echo "${C_CYAN}${LOG_PREFIX}${C_RESET} $*"; }
warn()    { echo "${C_YELLOW}${LOG_PREFIX} WARN:${C_RESET} $*" >&2; }
err()     { echo "${C_RED}${LOG_PREFIX} ERROR:${C_RESET} $*" >&2; }
success() { echo "${C_GREEN}${LOG_PREFIX} ✓${C_RESET} $*"; }
banner()  { echo "${C_BOLD}${C_CYAN}━━━ $* ━━━${C_RESET}"; }

# -----------------------------------------------------------------------------
# Safety: pre-flight checks
# -----------------------------------------------------------------------------

check_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "This installer must run as root."
    err "Re-run as: sudo bash -c \"\$(curl -fsSL <URL>)\""
    exit 1
  fi
}

detect_distro() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    case "${ID:-}" in
      ubuntu|debian) return 0 ;;
      *)
        if [[ "${ID_LIKE:-}" == *"debian"* || "${ID_LIKE:-}" == *"ubuntu"* ]]; then
          return 0
        fi
        warn "Untested distro: ${ID:-unknown}. Attempting anyway."
        return 0
        ;;
    esac
  fi
  warn "Could not read /etc/os-release. Assuming Debian-family."
  return 0
}

# -----------------------------------------------------------------------------
# Network connectivity helper (used before downloads)
# -----------------------------------------------------------------------------

wait_for_network() {
  local -i tries=0
  local -ri max=12
  log "Checking network connectivity…"
  while (( tries < max )); do
    if curl -fsS --max-time 5 https://api.github.com >/dev/null 2>&1 \
       || curl -fsS --max-time 5 https://cloudflare.com >/dev/null 2>&1; then
      success "Network OK"
      return 0
    fi
    (( tries++ ))
    log "Network not yet ready (attempt ${tries}/${max})… retrying in 5s"
    sleep 5
  done
  err "No internet connectivity after $((max*5))s. Aborting."
  return 1
}

# -----------------------------------------------------------------------------
# APT helpers — patient & idempotent
# -----------------------------------------------------------------------------

apt_update_quiet() {
  log "Updating apt index…"
  local -i tries=0
  while (( tries < 3 )); do
    if DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1; then
      return 0
    fi
    (( tries++ ))
    warn "apt-get update failed (attempt ${tries}/3). Retrying in 3s."
    sleep 3
  done
  warn "apt-get update never succeeded — continuing anyway, may install older pkgs."
  return 0
}

apt_install_if_missing() {
  local pkg
  local -a to_install=()
  for pkg in "$@"; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      to_install+=("${pkg}")
    fi
  done
  if (( ${#to_install[@]} == 0 )); then
    log "Already installed: $*"
    return 0
  fi
  log "Installing: ${to_install[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${to_install[@]}" \
    >/dev/null 2>&1 \
    || {
      warn "First install pass failed, retrying with apt-get update first…"
      apt_update_quiet
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${to_install[@]}" \
        >/dev/null 2>&1 \
        || { err "Could not install: ${to_install[*]}"; return 1; }
    }
  return 0
}

# -----------------------------------------------------------------------------
# Docker install — uses official Docker apt repo for current packages
# -----------------------------------------------------------------------------

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    success "Docker is already installed and running"
    return 0
  fi

  banner "Installing Docker"
  apt_install_if_missing ca-certificates curl gnupg lsb-release || return 1

  # Configure Docker official repo (idempotent)
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    log "Importing Docker GPG key…"
    if ! curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
         | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null; then
      # Fallback: try Debian path if Ubuntu URL fails
      curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null \
        || { err "Could not fetch Docker GPG key"; return 1; }
    fi
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local codename
  codename="$(lsb_release -cs 2>/dev/null || echo bookworm)"
  local docker_url="https://download.docker.com/linux/ubuntu"
  # If we're on Debian-family-non-Ubuntu, switch URL
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" == "debian" ]]; then
      docker_url="https://download.docker.com/linux/debian"
    fi
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] ${docker_url} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt_update_quiet
  apt_install_if_missing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    || {
      warn "Official Docker packages failed — falling back to distro 'docker.io'"
      apt_install_if_missing docker.io || { err "Could not install Docker at all."; return 1; }
    }

  # Make sure daemon is running
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || warn "Could not enable docker via systemctl"
  fi

  # Verify
  local -i tries=0
  while (( tries < 10 )); do
    if docker info >/dev/null 2>&1; then
      success "Docker installed and responsive"
      return 0
    fi
    (( tries++ ))
    sleep 2
  done
  err "Docker installed but daemon is not responding."
  err "If this is an LXC container, you likely need 'nesting=1' and 'keyctl=1' in the LXC config."
  return 1
}

# -----------------------------------------------------------------------------
# Image acquisition — try GHCR images, fall back to building from source
# -----------------------------------------------------------------------------

pull_image() {
  banner "Pulling CloudGate image"
  local img
  for img in "${CG_IMAGE_CANDIDATES[@]}"; do
    log "Trying ${img}…"
    if docker pull "${img}" >/dev/null 2>&1; then
      success "Pulled ${img}"
      docker tag "${img}" cloudgate:installed >/dev/null 2>&1 || true
      return 0
    else
      warn "Pull failed for ${img}, trying next…"
    fi
  done

  warn "No prebuilt image available — building from source"
  return 2
}

build_image_from_source() {
  banner "Building CloudGate image from source"
  apt_install_if_missing git ca-certificates || return 1

  local workdir="/tmp/cloudgate-build-$$"
  rm -rf "${workdir}"
  log "Cloning ${CG_REPO_URL} (branch ${CG_REPO_BRANCH})…"
  if ! git clone --depth 1 --branch "${CG_REPO_BRANCH}" "${CG_REPO_URL}" "${workdir}" >/dev/null 2>&1; then
    err "git clone failed. Check your internet connection."
    return 1
  fi

  log "Running docker build (this can take ~5-10 minutes)…"
  if docker build -t cloudgate:installed -f "${workdir}/docker/Dockerfile" "${workdir}"; then
    success "Built local image cloudgate:installed"
    rm -rf "${workdir}"
    return 0
  fi
  err "docker build failed."
  return 1
}

# -----------------------------------------------------------------------------
# Container lifecycle
# -----------------------------------------------------------------------------

container_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${CG_CONTAINER}"
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${CG_CONTAINER}"
}

remove_old_container() {
  if container_exists; then
    log "Removing existing '${CG_CONTAINER}' container (data volume is preserved)"
    docker rm -f "${CG_CONTAINER}" >/dev/null 2>&1 \
      || warn "Could not remove old container — continuing anyway"
  fi
}

ensure_volume() {
  if docker volume inspect "${CG_VOLUME}" >/dev/null 2>&1; then
    log "Data volume '${CG_VOLUME}' already exists — reusing"
    return 0
  fi
  log "Creating data volume '${CG_VOLUME}'"
  docker volume create "${CG_VOLUME}" >/dev/null 2>&1 || {
    err "Could not create Docker volume"
    return 1
  }
  return 0
}

start_container() {
  banner "Starting CloudGate container"
  ensure_volume || return 1
  remove_old_container

  local image="cloudgate:installed"
  # Prefer the GHCR image if it was pulled successfully
  if docker image inspect "${CG_IMAGE_CANDIDATES[0]}" >/dev/null 2>&1; then
    image="${CG_IMAGE_CANDIDATES[0]}"
  fi

  log "Starting from image: ${image}"
  if ! docker run -d \
      --name "${CG_CONTAINER}" \
      -p "${CG_HTTP_PORT}:80" \
      -p "${CG_HTTPS_PORT}:443" \
      -v "${CG_VOLUME}:/data" \
      --restart unless-stopped \
      "${image}" >/dev/null; then
    err "docker run failed"
    return 1
  fi
  success "Container started"
  return 0
}

# -----------------------------------------------------------------------------
# Post-start: wait for health + extract admin password
# -----------------------------------------------------------------------------

wait_for_health() {
  log "Waiting for CloudGate to become healthy (up to 180s)…"
  local -i i=0
  local host="127.0.0.1"
  local probe_port="${CG_HTTP_PORT}"
  while (( i < 90 )); do
    # Try /api/health via nginx fronting the backend
    if curl -fsS --max-time 3 "http://${host}:${probe_port}/api/health" >/dev/null 2>&1; then
      success "Backend is healthy"
      return 0
    fi
    (( i++ ))
    sleep 2
  done
  warn "Backend didn't become healthy in 180s. Recovery UI may be active — open http://${host}:${probe_port}/ to inspect."
  return 1
}

show_admin_password() {
  banner "Initial admin credentials"
  # Try logs first
  local logs
  logs="$(docker logs "${CG_CONTAINER}" 2>&1 | grep -A1 'Initial admin password' || true)"
  if [[ -n "${logs}" ]]; then
    echo "${logs}"
  fi

  # Also read from the secret file inside the container if available
  if docker exec "${CG_CONTAINER}" test -f /data/secrets/initial-admin.txt 2>/dev/null; then
    echo
    echo "${C_BOLD}Initial admin file contents:${C_RESET}"
    docker exec "${CG_CONTAINER}" cat /data/secrets/initial-admin.txt 2>/dev/null \
      | sed 's/^/  /'
  fi
}

# -----------------------------------------------------------------------------
# Self-checks for LXC environments
# -----------------------------------------------------------------------------

check_lxc_nesting() {
  if [[ -d /proc/1/root/.lxc-restart-data ]] || grep -q '^lxc' /proc/1/cgroup 2>/dev/null; then
    log "Detected LXC container environment"
    # In an LXC, /sys/fs/cgroup may not allow systemd-style cgroup operations
    # without nesting=1. Docker startup will fail visibly anyway. We just note it.
    if [[ ! -d /sys/fs/cgroup ]]; then
      warn "/sys/fs/cgroup missing — LXC nesting may not be enabled."
      warn "If Docker fails, enable in your Proxmox/LXD container config:"
      warn "    features: nesting=1,keyctl=1"
    fi
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
  banner "CloudGate installer"
  log "Container name: ${CG_CONTAINER}"
  log "Data volume:    ${CG_VOLUME}"
  log "HTTP port:      ${CG_HTTP_PORT}"
  log "HTTPS port:     ${CG_HTTPS_PORT}"
  echo

  check_root
  detect_distro
  check_lxc_nesting
  wait_for_network || exit 1

  # Make sure basics exist
  apt_install_if_missing curl ca-certificates || { err "Could not install minimal prerequisites"; exit 1; }

  # Docker
  install_docker || {
    err "Docker installation failed. Manual install: https://docs.docker.com/engine/install/"
    exit 1
  }

  # Image — try pull, else build
  if ! pull_image; then
    if ! build_image_from_source; then
      err "Could not pull or build CloudGate image. Aborting."
      exit 1
    fi
  fi

  # Container
  start_container || exit 1

  # Health check
  wait_for_health || true   # not fatal — recovery UI handles it

  # Print credentials & next steps
  echo
  show_admin_password
  echo

  # Detect primary IP for printing the URL
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "${ip}" ]] && ip="<host-ip>"

  banner "All done!"
  echo
  echo "  ${C_BOLD}Open in browser:${C_RESET}  http://${ip}:${CG_HTTP_PORT}/"
  echo
  echo "  ${C_BOLD}Manage container:${C_RESET}"
  echo "    docker logs    ${CG_CONTAINER}    # follow with -f"
  echo "    docker restart ${CG_CONTAINER}"
  echo "    docker stop    ${CG_CONTAINER}"
  echo
  echo "  ${C_BOLD}Re-running this script is safe${C_RESET} — your data in volume '${CG_VOLUME}' is preserved."
  echo
  echo "  Setup guide:  https://github.com/Elias02345/CloudGate/blob/dev/docs/CLOUDFLARE_SETUP.md"
  echo "  Issues:       https://github.com/Elias02345/CloudGate/issues"
  echo
}

# Trap unexpected exits so the user sees what happened
trap 'rc=$?; if (( rc != 0 )); then err "Installer exited unexpectedly (code $rc). Re-run is safe."; fi' EXIT

main "$@"
