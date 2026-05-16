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

# Install Node 22 runtime
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install cloudflared (official .deb)
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) cf_arch="amd64" ;; \
      arm64) cf_arch="arm64" ;; \
      *) echo "Unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}.deb"; \
    dpkg -i /tmp/cloudflared.deb; \
    rm /tmp/cloudflared.deb

# Install s6-overlay
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) s6_arch="x86_64" ;; \
      arm64) s6_arch="aarch64" ;; \
      *) echo "Unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
    curl -fsSL -o /tmp/s6-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz"; \
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
COPY docker/s6/ /etc/s6-overlay/s6-rc.d/
COPY docker/nginx/ /etc/nginx-cloudgate/
COPY docker/keys/ /app/keys/

RUN chmod +x /app/bin/bootstrap.sh

# nginx user/perms
RUN mkdir -p /var/log/nginx /var/lib/nginx /run/nginx \
 && chown -R www-data:www-data /var/log/nginx /var/lib/nginx /run/nginx

# Data volume
VOLUME ["/data"]

EXPOSE 80 443

ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_KEEP_ENV=1 \
    S6_SERVICES_GRACETIME=10000 \
    CLOUDGATE_DATA_DIR=/data \
    NODE_ENV=production \
    PATH=/app/backend/node_modules/.bin:$PATH

ENTRYPOINT ["/init"]
