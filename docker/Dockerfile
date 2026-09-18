# syntax=docker/dockerfile:1.7
# =============================================================================
# CloudGate — single multi-stage image.
#
# Stage 1 (builder): pnpm + node, builds backend + frontend + recovery-ui.
# Stage 2 (runtime): debian-slim with cloudflared + nginx + s6-overlay + gpg.
#
# Zero-config: docker run -p 80:80 -p 443:443 -v cloudgate-data:/data
# Everything bootstraps itself on first start.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# pnpm + build tools for native modules (better-sqlite3, argon2)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/recovery-ui/package.json ./packages/recovery-ui/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile=false

COPY packages/ ./packages/

RUN pnpm -r run build

# Prune to production-only deps for runtime image (pnpm 9 syntax)
RUN pnpm --filter @cloudgate/backend deploy --prod /deploy/backend && \
    pnpm --filter @cloudgate/recovery-ui deploy --prod /deploy/recovery-ui

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

ARG S6_OVERLAY_VERSION=3.2.0.0
ARG CLOUDFLARED_VERSION=2026.9.1
ARG TARGETARCH

# Install runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    nginx \
    sqlite3 \
    tini \
    xz-utils \
    procps \
 && rm -rf /var/lib/apt/lists/*

# Install Node 22 runtime from the official NodeSource apt repository instead of
# piping deb.nodesource.com's install script into bash as root. The GPG key is
# still fetched over plain TLS (same trust root as before), but from here on
# apt itself verifies the Release file's signature against that pinned keyring
# for every package it installs — not just this one curl — instead of a shell
# script executing unverified as root.
# Key fingerprint (informational, checked manually against nodesource.com docs):
#   6F71 F525 2828 41EE DAF8 51B4 2F59 B5F9 9B1B E0B4
RUN set -eux; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    chmod 644 /etc/apt/keyrings/nodesource.gpg; \
    node_arch="$(dpkg --print-architecture)"; \
    { \
      echo "Types: deb"; \
      echo "URIs: https://deb.nodesource.com/node_22.x"; \
      echo "Suites: nodistro"; \
      echo "Components: main"; \
      echo "Architectures: ${node_arch}"; \
      echo "Signed-By: /etc/apt/keyrings/nodesource.gpg"; \
    } > /etc/apt/sources.list.d/nodesource.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*

# Install cloudflared (official .deb), pinned to an exact release tag (not
# "latest", which is a moving target that makes the image unreproducible) and
# verified against a SHA256 computed ourselves — Cloudflare does not publish a
# checksum file alongside these .deb release assets, so there is nothing to
# fetch-and-compare here; the hash was obtained by downloading each arch's .deb
# and hashing it directly:
#   curl -fsSL -o cloudflared-linux-amd64.deb \
#     https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-linux-amd64.deb
#   sha256sum cloudflared-linux-amd64.deb
# (repeated for cloudflared-linux-arm64.deb). Re-derive and update both hashes
# whenever CLOUDFLARED_VERSION is bumped.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) cf_arch="amd64"; cf_sha256="3be76adc4185d36a0bfb4c2dd8663292f0ed363797f2180333b513b43c81d419" ;; \
      arm64) cf_arch="arm64"; cf_sha256="2a870d5bf6ea74d16c0923b804eabbf4943f1fd7c63a5c20fd41cc66b629c725" ;; \
      *) echo "Unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cf_arch}.deb"; \
    echo "${cf_sha256}  /tmp/cloudflared.deb" | sha256sum -c -; \
    dpkg -i /tmp/cloudflared.deb; \
    rm /tmp/cloudflared.deb

# Install s6-overlay. The release also publishes a .sha256 file next to each
# tarball, but fetching that checksum from the same GitHub release as the
# tarball itself only protects against transport corruption, not against a
# compromised release — both files share one distribution point, so whoever
# could tamper with the tarball could tamper with its checksum file too. The
# hashes below are hard-coded, computed independently with `sha256sum` on the
# downloaded tarballs (and cross-checked against the published .sha256 files,
# which matched):
#   curl -fsSL -o s6-overlay-noarch.tar.xz \
#     https://github.com/just-containers/s6-overlay/releases/download/v3.2.0.0/s6-overlay-noarch.tar.xz
#   sha256sum s6-overlay-noarch.tar.xz
# (repeated for s6-overlay-x86_64.tar.xz and s6-overlay-aarch64.tar.xz). Update
# these hashes whenever S6_OVERLAY_VERSION is bumped.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) s6_arch="x86_64"; s6_arch_sha256="ad982a801bd72757c7b1b53539a146cf715e640b4d8f0a6a671a3d1b560fe1e2" ;; \
      arm64) s6_arch="aarch64"; s6_arch_sha256="868973e98210257bba725ff5b17aa092008c9a8e5174499e38ba611a8fc7e473" ;; \
      *) echo "Unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    s6_noarch_sha256="4b0c0907e6762814c31850e0e6c6762c385571d4656eb8725852b0b1586713b6"; \
    curl -fsSL -o /tmp/s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
    curl -fsSL -o /tmp/s6-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz"; \
    echo "${s6_noarch_sha256}  /tmp/s6-noarch.tar.xz" | sha256sum -c -; \
    echo "${s6_arch_sha256}  /tmp/s6-arch.tar.xz" | sha256sum -c -; \
    tar -C / -Jxpf /tmp/s6-noarch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-arch.tar.xz; \
    rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# Copy build artifacts
WORKDIR /app
COPY --from=builder /deploy/backend /app/backend
COPY --from=builder /deploy/recovery-ui /app/recovery-ui
COPY --from=builder /build/packages/frontend/dist /app/frontend
COPY --from=builder /build/packages/backend/.version /app/.version

# Container-internal files
COPY docker/bootstrap.sh /app/bin/bootstrap.sh
COPY docker/apply-update.sh /app/bin/apply-update.sh
COPY docker/s6/ /etc/s6-overlay/s6-rc.d/
COPY docker/nginx/ /etc/nginx-cloudgate/
COPY docker/keys/ /app/keys/

RUN chmod +x /app/bin/bootstrap.sh /app/bin/apply-update.sh

# nginx user/perms
RUN mkdir -p /var/log/nginx /var/lib/nginx /run/nginx \
 && chown -R www-data:www-data /var/log/nginx /var/lib/nginx /run/nginx

# Unprivileged account for the recovery UI.
#
# The recovery UI has no authentication of its own — it has to work when the
# backend, and therefore auth, is broken — and it can move /data aside or
# restore a database over the live one. That is the service where an
# unexpected bug is least acceptable as root, and the only one that can drop
# privileges cheaply: it touches nothing but /data.
#
# The backend deliberately stays root for now. It runs `nginx -s reload` after
# rendering host configs, and apply-update.sh (which it spawns) swaps /app and
# drives `s6-svc` — three privileged operations that each need a root-side
# broker before it can give up root. That is its own change, with its own test.
#
# 1000:1000 matches the default PUID/PGID convention; bootstrap re-points the
# runtime account at whatever PUID/PGID the operator actually set.
RUN groupadd -g 1000 cloudgate \
 && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin cloudgate

# Data volume
VOLUME ["/data"]

EXPOSE 80 443

ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_KEEP_ENV=1 \
    S6_SERVICES_GRACETIME=10000 \
    CLOUDGATE_DATA_DIR=/data \
    NODE_ENV=production \
    PATH=/app/backend/node_modules/.bin:$PATH

# Docker-native healthcheck. Recovery UI also answers on :80, so a 200 from
# either /api/health or /__recovery/api/status means the container is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1/api/health > /dev/null 2>&1 \
        || curl -fsS http://127.0.0.1/api/status > /dev/null 2>&1 \
        || exit 1

ENTRYPOINT ["/init"]
