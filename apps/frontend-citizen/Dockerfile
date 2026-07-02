# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/frontend-citizen/package.json apps/frontend-citizen/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/frontend-citizen apps/frontend-citizen

WORKDIR /app/apps/frontend-citizen
RUN node_modules/.bin/tsc -b && node_modules/.bin/vite build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=build --chown=nginx:nginx /app/apps/frontend-citizen/dist /usr/share/nginx/html
COPY apps/frontend-citizen/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-citizen/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
