# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22.22.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    RUNTIME_CONFIG_DIR=/app/config \
    SETUP_TOKEN_FILE=/run/secrets/account-vault-setup-token \
    CONFIG_MASTER_KEY_FILE=/run/secrets/account-vault-config-key \
    SHUTDOWN_GRACE_SECONDS=30
COPY --from=builder --chown=root:root /app/.next/standalone ./.next/standalone
COPY --from=builder --chown=root:root /app/.next/static ./.next/standalone/.next/static
COPY --from=builder --chown=root:root /app/public ./.next/standalone/public
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --from=builder --chown=root:root /app/db ./db
COPY --from=builder --chown=root:root /app/release-manifest.json ./release-manifest.json
RUN groupadd --gid 10001 account-vault \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin account-vault-web \
    && useradd --uid 10002 --gid 10001 --no-create-home --shell /usr/sbin/nologin account-vault-worker \
    && mkdir -p /app/config \
    && chown 10001:10001 /app/config \
    && chmod 0750 /app/config \
    && chmod -R a-w /app/.next /app/dist /app/db /app/release-manifest.json
EXPOSE 3000
ENTRYPOINT ["node", "/app/dist/runtime/supervisor.mjs"]
