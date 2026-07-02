# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ComunicaPA — HUB open-source per la trasmissione asincrona di comunicazioni massive della Pubblica Amministrazione (TARI, avvisi, sanzioni) su canali multipli: PEC, Email, App IO, SEND, Postalizzazione.

## Architecture

**pnpm workspaces monorepo.** Tutto gira in Docker — nessun tool installato in locale (Node/pnpm non richiesti sull'host).

```
apps/backend/          NestJS 10 + TypeScript — API REST, worker BullMQ (porta 8080)
apps/frontend-admin/   React 19 + Vite 6 — Portale operatori PA (porta 3000)
apps/frontend-citizen/ React 19 + Vite 6 — Portale cittadini (porta 3001)
packages/shared-types/ @comunicapa/shared-types — interfacce TypeScript condivise
```

**Flusso dati:** CSV upload → stream processing (no in-memory) → BullMQ queue (Redis) → worker asincroni → Strategy Pattern per canale (PEC/Email/AppIO/SEND/Postal).

**Auth:** LDAP/Active Directory per operatori PA; OIDC (SPID/CIE) delegato ai cittadini.

## Dev Environment

Tutti i comandi si eseguono con Docker Compose. Copiare `.env.example` in `.env` prima del primo avvio.

**Compose è splittato in due file:**
- `docker-compose.yml` — **produzione**: immagini da ghcr.io, solo volumi named, nessun bind mount. Usato da solo per il deploy reale (Portainer / podman rootless).
- `docker-compose.override.yml` — **sviluppo**: build da `Dockerfile.dev`, bind mount per hot-reload, porte DB esposte, frontend in ascolto su 3000/3001.

Lo sviluppo locale attiva l'override tramite `COMPOSE_FILE=docker-compose.yml;docker-compose.override.yml` in `.env` (nel `.env.example` la riga è **commentata**: decommentarla per lo sviluppo; in produzione non va impostata). Con questa variabile attiva, `docker compose` carica automaticamente entrambi i file: non serve passare `-f` esplicitamente.

```bash
# Primo avvio
cp .env.example .env
docker compose build
docker compose up -d

# Avvio rapido (immagini già buildate)
docker compose up -d

# Log in tempo reale
docker compose logs -f backend
docker compose logs -f frontend-admin
docker compose logs -f frontend-citizen

# Restart singolo servizio (es. dopo modifica Dockerfile o package.json)
docker compose up -d --build backend

# Spegni tutto
docker compose down

# Spegni e rimuovi volumi (reset DB)
docker compose down -v

# Verifica config produzione (senza override, richiede secret in .env)
docker compose -f docker-compose.yml config --quiet
```

Hot-reload attivo: modifiche ai file in `apps/*/src/` e `packages/shared-types/src/` si riflettono immediatamente nei container senza rebuild (volumi bind montati).

**Rebuild obbligatorio** solo se si modifica `package.json`, `Dockerfile.dev`, o file fuori da `src/`.

## Test

```bash
# Suite backend (SEMPRE --maxWorkers=2: senza, jest satura la RAM su WSL2)
docker compose exec backend node_modules/.bin/jest --maxWorkers=2

# Test singolo/focalizzato
docker compose exec backend node_modules/.bin/jest <pattern> --maxWorkers=2

# Type-check backend
docker compose exec backend node_modules/.bin/tsc --noEmit
```

**Baseline nota:** 7 test falliscono da prima (email.strategy, pec.strategy, notification.processor — template vecchi, `checkAndCompleteCampaign` inesistente). Non sono regressioni: il criterio per una modifica è "failure set identico".

## Configurazione runtime (settings in DB)

`.env` contiene SOLO bootstrap (porte, postgres, secret, LDAP). Tutto il resto (branding, SMTP, PEC, App IO, SEND, OIDC, retention, URL pubblico) vive nella tabella `app_settings` — si configura dalla UI admin (menu Impostazioni). `AppSettingsService.get()` risolve cache→DB→env→default; i secret sono cifrati AES-256-GCM con chiave derivata da `JWT_SECRET` (cambiarlo = reinserire i secret da UI). Chiavi e fallback env: `apps/backend/src/settings/settings.registry.ts`.

## Topologia API — gotcha

Il backend NON ha prefisso globale `/api`: le route sono `/settings`, `/version`, `/branding`... In produzione il nginx di ogni frontend proxya `/api/` verso `backend:8080` **strippando il prefisso** (same-origin, niente CORS, backend mai esposto dal proxy esterno). In dev il browser chiama direttamente `http://localhost:8080`. `API_BASE` arriva a runtime da `/config.js` (dev: `public/config.js`; prod: generato dall'entrypoint nginx da `API_BASE`, default `/api`).

## CI/CD

`.github/workflows/release.yml`: push su main → immagini `:dev`; tag `v*` → `:vX.Y.Z` + `:latest` su `ghcr.io/comune-di-montesilvano/comunicapa-*`. Namespace hardcoded lowercase (il nome org ha maiuscole e romperebbe il cache exporter buildx). Allegati: path fisso `/data/attachments` nel container, volume named `attachments_data`.

## pnpm v11 in Docker — Regola critica

pnpm@latest è v11+ che blocca build script per default (`ERR_PNPM_IGNORED_BUILDS`). Pattern obbligatorio in ogni `Dockerfile.dev`:

```dockerfile
# Install senza lifecycle scripts
RUN pnpm install --ignore-scripts
# Per pacchetti Vite: rebuild esbuild esplicitamente
RUN pnpm install --ignore-scripts && pnpm rebuild esbuild

# CMD: usa il binario diretto — NON usare "pnpm run" o "pnpm --filter X dev"
# pnpm v11 esegue un deps-check preventivo che blocca di nuovo esbuild
WORKDIR /app/apps/backend
CMD ["node_modules/.bin/nest", "start", "--watch"]
```

## TypeScript

`tsconfig.base.json` alla root impone strict mode completo. Ogni app estende questa base. Il backend aggiunge `experimentalDecorators` e `emitDecoratorMetadata` (richiesti dai decorator NestJS).

Il pacchetto `@comunicapa/shared-types` si importa con `workspace:*` — non pubblicato su npm, risolto internamente da pnpm.

## Variabili d'ambiente

Solo le variabili sistemistiche/di bootstrap passano da `.env` (vedi sezione "Configurazione runtime" sopra per tutto il resto). Il `docker-compose.yml` non ha valori hardcoded, solo `${VAR:-default}` — `DATABASE_URL` e `REDIS_URL` le costruisce il compose dagli hostname interni (`postgres`, `redis`). Vedere `.env.example` per la lista completa con documentazione inline.

Obbligatorie in produzione (`:?` nel compose): `JWT_SECRET`, `DOWNLOAD_LINK_SECRET`.
