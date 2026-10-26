# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
# Versione di pnpm (con hash sha512, verificato da corepack) dal campo packageManager
# di package.json: unica fonte, letta anche da pnpm/action-setup nei workflow.
RUN corepack install
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
RUN echo '{"type":"module"}' > packages/shared-types/dist/esm/package.json

WORKDIR /app/apps/frontend-admin
RUN node_modules/.bin/tsc -b && node_modules/.bin/vite build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
# PKG_REFRESH (data del giorno, passata da release.yml) invalida la cache del layer una
# volta al giorno, cosi' `apk upgrade` prende le patch Alpine anche prima che
# l'immagine base nginx venga ripubblicata. L'immagine gira come utente nginx.
ARG PKG_REFRESH=none
USER root
RUN apk upgrade --no-cache
USER 101
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=build --chown=nginx:nginx /app/apps/frontend-admin/dist /usr/share/nginx/html
COPY apps/frontend-admin/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-admin/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
