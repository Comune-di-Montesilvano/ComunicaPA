# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/frontend-admin/package.json apps/frontend-admin/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/frontend-admin apps/frontend-admin

# shared-types va compilato esplicitamente — main/types puntano a ./dist,
# mai a ./src (vedi commento in apps/backend/Dockerfile per il motivo).
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json

WORKDIR /app/apps/frontend-admin
RUN node_modules/.bin/tsc -b && node_modules/.bin/vite build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.31-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=build --chown=nginx:nginx /app/apps/frontend-admin/dist /usr/share/nginx/html
COPY apps/frontend-admin/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-admin/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
