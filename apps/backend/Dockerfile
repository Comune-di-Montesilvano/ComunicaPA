# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/backend/package.json apps/backend/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/backend apps/backend

# shared-types va compilato esplicitamente (--ignore-scripts sopra blocca il suo
# script "build" automatico) — "main"/"types" puntano a ./dist, mai a ./src: in
# produzione "pnpm deploy" sotto copia il pacchetto DENTRO node_modules (non un
# symlink come in dev), e Node blocca il type-stripping nativo per qualunque
# file sotto node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — bug
# reale riscontrato in produzione, crash-loop del backend al primo require().
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.json

WORKDIR /app/apps/backend
RUN node_modules/.bin/nest build

# Albero deploy con sole dipendenze di produzione
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter backend deploy --prod --ignore-scripts --legacy /prod/backend

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine
RUN apk add --no-cache tzdata
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} NODE_ENV=production TZ=Europe/Rome
WORKDIR /app
COPY --from=build --chown=node:node /prod/backend /app
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
