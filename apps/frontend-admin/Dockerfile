# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/frontend-admin/package.json apps/frontend-admin/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/frontend-admin apps/frontend-admin

WORKDIR /app/apps/frontend-admin
RUN node_modules/.bin/tsc -b && node_modules/.bin/vite build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=build --chown=nginx:nginx /app/apps/frontend-admin/dist /usr/share/nginx/html
COPY apps/frontend-admin/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-admin/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
