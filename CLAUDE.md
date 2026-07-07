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

**Auth:** LDAP/Active Directory per operatori PA; cittadini via OIDC (SPID/CIE, Authorization Code + PKCE: la SPA chiama `/auth/citizen/oidc/start`, callback SPA su `/oidc/callback`, exchange nel backend con state su Redis). Dev locale senza AD: `LDAP_HOST=mock` in `.env` abilita admin/admin, operator/operator e il simulatore cittadino — mai in produzione.

**Proxy OIDC (pa-sso-proxy):** issuer = root del proxy (senza `/OIDC`), discovery in `/.well-known/openid-configuration`, endpoint sotto `/OIDC/` (`authorization`, `token`, `jwks`, `end_session`). Supporta SOLO `client_secret_basic` (secret nel body → 401 con pagina HTML). Claims id_token: `fiscal_number` = `TINIT-<CF>` (prefisso `TIN`+paese da strippare), `given_name`/`family_name` (spesso senza `name`), claim URI eIDAS `https://attributes.eid.gov.it/fiscal_number`.

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

Hot-reload: i frontend Vite ricaricano da soli; il watch di NestJS spesso NON vede le modifiche sui bind mount Windows — dopo modifiche a `apps/backend/src/` fare `docker compose restart backend` e verificare che `dist/` sia più recente di `src/` (`docker compose exec backend ls -la dist/... src/...`).

**Rebuild obbligatorio** se si modifica `package.json`, `Dockerfile.dev`, o file fuori da `src/`. ATTENZIONE per le nuove dipendenze: il rebuild da solo NON basta — il volume named dei node_modules maschera quelli freschi dell'immagine (`Cannot find module` all'avvio):

```bash
# Dopo aver aggiunto una dipendenza a apps/backend/package.json:
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"   # aggiorna pnpm-lock.yaml (niente Node sull'host)
docker compose build backend
docker compose rm -sf backend && docker volume rm comunicapa_backend_node_modules && docker compose up -d backend
```

Il nome del volume `node_modules` non sempre coincide col nome del servizio (es. `frontend-admin` → volume `comunicapa_admin_node_modules`, non `comunicapa_frontend-admin_node_modules`): verificare con `docker volume ls | grep node_modules` prima di eseguire `docker volume rm`.

**Attenzione worktree/checkout paralleli — `docker-compose.yml` ha `name: comunicapa` fisso in cima al file.** Qualsiasi `docker compose` lanciato da QUALSIASI checkout/worktree di questo repo (anche una cartella diversa dalla principale) punta agli **stessi container condivisi** — non crea uno stack isolato, anche passando porte/env diversi. Un `docker compose up` da un worktree può silenziosamente ricreare in-place i container dev del checkout principale, ricollegandoli al codice del worktree (incidente reale già capitato). Se serve lavorare da un worktree/checkout secondario: **mai `docker compose`**, usare `docker run`/`docker exec` diretti sui container/volumi named già esistenti, es.:

```bash
# Test/tsc contro il codice del worktree, senza toccare lo stack principale
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/apps/backend/src:/app/apps/backend/src" \
  -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" \
  -v comunicapa_backend_node_modules:/app/node_modules \
  -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/jest --maxWorkers=2

# Migration contro un DB temporaneo, sul container postgres già in esecuzione
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
docker exec -e DATABASE_URL="postgresql://comunicapa:<password>@postgres:5432/migration_test" comunicapa-backend-1 node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

## Test

```bash
# Suite backend (SEMPRE --maxWorkers=2: senza, jest satura la RAM su WSL2)
docker compose exec backend node_modules/.bin/jest --maxWorkers=2

# Test singolo/focalizzato
docker compose exec backend node_modules/.bin/jest <pattern> --maxWorkers=2

# Type-check backend
docker compose exec backend node_modules/.bin/tsc --noEmit

# Type-check frontend (NON usare `tsc -b`: fallisce nel container dev per
# errori @types/node preesistenti che non riproducono nel build prod)
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit

# Token operatore admin per testare le API senza login LDAP (solo dev)
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

**Baseline:** suite pulita, nessun fallimento noto. Il criterio per una modifica resta "failure set identico" al prima — se emerge un nuovo fallimento, è una regressione, non baseline nota.

## Configurazione runtime (settings in DB)

`.env` contiene SOLO bootstrap (porte, postgres, secret, LDAP, `CITIZEN_ORIGIN`). Da `CITIZEN_ORIGIN` il backend deriva i link email/PEC (`<origine>/api/...`) e la Redirect URI OIDC — chiavi registry `system.*` marcate `bootstrapOnly`: risolte solo env→default, mai DB né UI. Tutto il resto (branding, SMTP, PEC, App IO, SEND, OIDC, retention) vive nella tabella `app_settings` — si configura dalla UI admin (menu Impostazioni). `AppSettingsService.get()` risolve cache→DB→env→default; i secret sono cifrati AES-256-GCM con chiave derivata da `JWT_SECRET` (cambiarlo = reinserire i secret da UI). Chiavi e fallback env: `apps/backend/src/settings/settings.registry.ts`.

## Migration DB

Dev: `synchronize` allinea lo schema automaticamente. Prod: le migration in `apps/backend/src/database/migrations/` girano da sole all'avvio (`migrationsRun` in `database.module.ts` — vanno anche registrate lì nell'array `migrations`). Dopo aver modificato un'entity, generare la migration con un DB temporaneo:

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/NomeMigration -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

## Topologia API — gotcha

Le route operatore sono segmentate sotto `admin/*` (`admin/campaigns`, `admin/settings`, `admin/auth`, `admin/notifications-search`...), quelle cittadino sotto `citizen/*` (`citizen/auth`, `citizen/notifications`...). Restano bare solo `public/download/*` e le route di root (`/version`, `/branding`). In produzione il nginx di ogni frontend proxya `/api/` verso `backend:8080` **strippando il prefisso** (same-origin, niente CORS, backend mai esposto dal proxy esterno). In dev il browser chiama direttamente `http://localhost:8080`. `API_BASE` arriva a runtime da `/config.js` (dev: `public/config.js`; prod: generato dall'entrypoint nginx da `API_BASE`, default `/api`); il frontend admin usa `ADMIN_API_BASE = \`${API_BASE}/admin\`` per tutte le chiamate autenticate operatore.

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

## CSS frontend — gotcha

`frontend-citizen` NON carica Bootstrap: le utility (`d-grid`, `w-100`, `text-center`...) sono no-op. Usare i css custom (`tokens.css`, `fo-components.css`, design system `--ms-*`/`--bi-*`) o stili espliciti. L'admin ha le sue utility custom in `app.css`/`backoffice-shell.css`.

`frontend-citizen` carica in ordine `tokens.css` → `fo-components.css` → `app.css` (vedi `main.tsx`): una classe con lo stesso nome definita in più file vince per ordine di caricamento a parità di specificity, non per "ultima modificata". Prima di aggiungere una classe già vista altrove, cercarla in tutti e tre i file (`grep -rn "nomeclasse" apps/frontend-citizen/src/assets/css/`).

## Variabili d'ambiente

Solo le variabili sistemistiche/di bootstrap passano da `.env` (vedi sezione "Configurazione runtime" sopra per tutto il resto). Il `docker-compose.yml` non ha valori hardcoded, solo `${VAR:-default}` — `DATABASE_URL` e `REDIS_URL` le costruisce il compose dagli hostname interni (`postgres`, `redis`). Vedere `.env.example` per la lista completa con documentazione inline.

Obbligatorie in produzione (`:?` nel compose): `JWT_SECRET`, `DOWNLOAD_LINK_SECRET`.

`POSTGRES_PASSWORD` SOLO caratteri alfanumerici: il compose la incastra in `DATABASE_URL` senza escaping — `$ @ # ^` rompono il parsing dell'URL e il backend prova a connettersi a un host sbagliato (es. `0.0.0.48`).

## Reverse proxy esterno in produzione — gotcha critico

Davanti al backend in produzione c'è un reverse proxy esterno (fuori da questo
repo, gestito a livello infrastruttura) con **limite body ~1MB** e che
**sostituisce il body delle risposte non-2xx con una pagina HTML propria**,
rendendo illeggibile qualsiasi messaggio di errore lato frontend. Pattern
obbligatorio per endpoint che possono fallire in modo "previsto" (validazione,
allegati mancanti): rispondere sempre **HTTP 200** con un flag tipo
`{ blocked: true, message: '...' }`, mai lanciare eccezioni HTTP non-2xx per
errori che l'utente deve poter leggere (vedi `campaigns.service.ts`
`launch()`/`uploadCsv()`). Per upload di file grandi (CSV migliaia di righe,
ZIP allegati) usare l'upload a chunk (`chunked-upload.util.ts` +
`:id/recipients/upload/{init,chunk,complete}` e equivalente per attachments):
chunk client-side da 512KB (sotto il limite del proxy), riassemblati lato
server prima di riusare la logica di import esistente.

## Log debug/verbose — gotcha

Il logger NestJS di default (`NestFactory.create`) esclude i livelli
`debug`/`verbose`, a prescindere dall'ambiente. `main.ts` legge `LOG_LEVEL`
da env (default `info`) e lo mappa ai livelli Nest — impostare
`LOG_LEVEL=debug` in `.env` e riavviare il backend per vedere i log di
dettaglio dei motori di invio (payload/risposte PEC/Email/App IO/SEND/Postal).
I job BullMQ salvano inoltre i propri log (`job.log()`), consultabili dalla
UI admin → Motori → "Vedi log" per singolo job, senza bisogno di accesso SSH.

## Placeholder template notifiche

Delimitatore `%%chiave%%` (doppio `%`, non singolo) — vedi `template.helper.ts`
`processTemplate()`. Un `%` singolo (percentuale in prosa, es. "60% del
tributo") non forma mai un placeholder. Nessuna retrocompatibilità col vecchio
delimitatore singolo: i template esistenti vanno riscritti.

## Creazione campagne — un solo percorso

La creazione/import destinatari passa **solo** dal wizard multi-step
(`view === 'invio-massivo-wizard'` in `frontend-admin/App.tsx`): è l'unico
punto con le validazioni corrette (formato CF/email, lunghezza minima body
App IO). Non aggiungere form di creazione rapida o importer CSV alternativi
altrove (es. sulla pagina dettaglio campagna) — bypassano quelle validazioni
e hanno già causato invii falliti in produzione (CF troncato, markdown vuoto
per App IO). Per riprendere una bozza: bottone "Riprendi wizard"
(`handleResumeDraft`), non un importer dedicato.
