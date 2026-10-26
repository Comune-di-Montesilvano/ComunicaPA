# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
RUN npm install -g corepack@0.36.0 && corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/frontend-citizen/package.json apps/frontend-citizen/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/frontend-citizen apps/frontend-citizen

# shared-types va compilato esplicitamente — main/types puntano a ./dist,
# mai a ./src (vedi commento in apps/backend/Dockerfile per il motivo).
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json
RUN echo '{"type":"module"}' > packages/shared-types/dist/esm/package.json

WORKDIR /app/apps/frontend-citizen
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
COPY --from=build --chown=nginx:nginx /app/apps/frontend-citizen/dist /usr/share/nginx/html
COPY apps/frontend-citizen/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-citizen/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
