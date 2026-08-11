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

**Senza dichiarazione esplicita dell'utente, lo stack Docker raggiungibile in sessione è locale/dev, mai prod** — nessun accesso reale a produzione per default. Il DB dev condivide comunque le credenziali GlobalCom REALI (vedi sezione POSTAL sotto), quindi un dato reale può comparire anche in un ambiente locale — non è prova che l'ambiente stesso sia prod.

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

**Rebuild obbligatorio** se si modifica `package.json`, `Dockerfile.dev`, o file fuori da `src/`. Questo include file root come `publiccode.yml`: `AppController.getVersion()` lo legge dalla copia buildata nell'immagine, mai dal file host — modificarlo non basta, serve `docker compose build backend` (o `up -d --build`) perché il container lo veda, stesso principio già noto per `package.json`. `publiccode.yml.softwareVersion` inoltre non è mai toccato da CI — va bumpato a mano a ogni tag, altrimenti resta indietro rispetto ai tag git reali. ATTENZIONE per le nuove dipendenze: il rebuild da solo NON basta — il volume named dei node_modules maschera quelli freschi dell'immagine (`Cannot find module` all'avvio):

```bash
# Dopo aver aggiunto una dipendenza a apps/backend/package.json:
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"   # aggiorna pnpm-lock.yaml (niente Node sull'host)
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

**subagent-driven-development su questo repo — mai `isolation:"worktree"` per gli implementer se il lavoro deve andare dritto su `main`.** Un subagent con worktree isolato committa su un branch/checkout separato (`.claude/worktrees/...`) — se poi lo si rimuove, il report scritto dal subagent nella working directory sparisce con esso (bug reale: report ricostruito a mano dal riassunto restituito). Per lavoro diretto su main, dispatchare i subagent SENZA `isolation`, verificare poi con `git log --oneline -1 && git branch --show-current` che il commit sia finito dove atteso.

**`.superpowers/sdd/` è scratch condiviso tra TUTTI i piani eseguiti nel repo, non per-piano.** Nomi file generici (`task-N-brief.md`/`task-N-report.md`) vengono sovrascritti da esecuzioni diverse — un report letto da lì può essere residuo di un piano precedente non correlato (bug reale: report Task 1 riletto per il review conteneva il riepilogo di un task di tutt'altro piano). Verificare sempre che il contenuto corrisponda al task atteso prima di fidarsene per una review.

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

**Baseline:** 1 fallimento noto pre-esistente (`app.controller.spec.ts`, `isLdapMock` — artefatto di `LDAP_HOST=mock` in dev), il resto della suite pulito. Il criterio per una modifica resta "failure set identico" al prima — se emerge un nuovo fallimento oltre a questo, è una regressione, non baseline nota.

**Test rapido di un endpoint autenticato senza frontend**: nessun `curl` nel container backend — usare `node -e` con `fetch()` verso `http://localhost:8080/...` e il token JWT generato con lo snippet sopra. Utile per lanciare/testare una campagna reale da riga di comando durante il debug.

**Simulare un crash reale del backend per test (es. resume da checkpoint) — `docker kill` è bloccato dal classificatore di sicurezza di Claude Code.** Usare `docker compose restart backend`: il container non gestisce `SIGTERM` (nessun `enableShutdownHooks`), quindi il processo termina comunque bruscamente — stesso effetto pratico di un crash vero per testare codice di recovery, senza permessi distruttivi.

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

**Bug reale — migration scritta ma non registrata è invisibile, nessun errore.** Una migration con solo `CREATE INDEX` raw (nessun `@Index` sull'entity) dimenticata nell'array `migrations` di `database.module.ts` non produce log né eccezioni: gli indici restano assenti sia in prod (mai eseguita) sia in dev (`synchronize` sincronizza solo i metadata delle entity, non SQL raw di una migration) — sintomo osservato solo indirettamente come lentezza su una query, non un errore. Dopo aver scritto una migration, verificare SEMPRE che la classe sia sia importata sia presente nell'array `migrations` (`grep NomeMigration database.module.ts`). Se serve testarla subito in dev senza aspettare un redeploy prod, applicare a mano l'SQL della migration sul DB dev (`docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "..."`, idempotente con `IF NOT EXISTS`).

## Topologia API — gotcha

Le route operatore sono segmentate sotto `admin/*` (`admin/campaigns`, `admin/settings`, `admin/auth`, `admin/notifications-search`...), quelle cittadino sotto `citizen/*` (`citizen/auth`, `citizen/notifications`...). Restano bare solo `public/download/*` e le route di root (`/version`, `/branding`). In produzione il nginx di ogni frontend proxya `/api/` verso `backend:8080` **strippando il prefisso** (same-origin, niente CORS, backend mai esposto dal proxy esterno). In dev il browser chiama direttamente `http://localhost:8080`. `API_BASE` arriva a runtime da `/config.js` (dev: `public/config.js`; prod: generato dall'entrypoint nginx da `API_BASE`, default `/api`); il frontend admin usa `ADMIN_API_BASE = \`${API_BASE}/admin\`` per tutte le chiamate autenticate operatore.

## CI/CD

`.github/workflows/release.yml`: push su main → immagini `:dev`; tag `v*` → `:vX.Y.Z` + `:latest` su `ghcr.io/comune-di-montesilvano/comunicapa-*`. Namespace hardcoded lowercase (il nome org ha maiuscole e romperebbe il cache exporter buildx). Allegati: path fisso `/data/attachments` nel container, volume named `attachments_data`.

**Tag pushato = solo build immagine, MAI deploy automatico.** Push+tag
fanno partire CI che builda/pusha su ghcr — il container di produzione
resta sul vecchio codice finché qualcuno non fa pull+redeploy su Portainer.
`gh run list --workflow=release.yml` conferma solo che la build è
riuscita, non che prod la stia servendo.

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

## `@comunicapa/shared-types` — main deve puntare a `./dist`, mai a `./src`

Bug reale in produzione (crash-loop del backend): `packages/shared-types/package.json`
aveva `"main": "./src/index.ts"` (TS grezzo, nessuna build). In **dev**
funzionava per un caso fortuito — `docker-compose.override.yml` bind-monta
`packages/shared-types/src` e il layout pnpm workspace crea un **symlink**
`node_modules/@comunicapa/shared-types` → `../../packages/shared-types`
(fuori da `node_modules` una volta risolto il symlink), quindi Node 22 poteva
fare type-stripping nativo senza problemi. In **produzione**
(`apps/backend/Dockerfile`, `pnpm --filter backend deploy --prod`) il
pacchetto viene invece **copiato realmente dentro** `node_modules` (nessun
symlink — è il punto di `pnpm deploy`, un albero standalone) — e Node
blocca esplicitamente il type-stripping per qualunque file sotto
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), crashando il
backend al primo `require('@comunicapa/shared-types')` (es.
`payment-config.util.ts`). Mai riprodotto in dev, solo dal vivo in
produzione — l'ambiente dev bind-mount maschera completamente questa classe
di bug.

Fix (parte 1): `package.json` → puntare a `./dist`, mai a `./src`.

**Parte 2, bug successivo — CJS/ESM dual build.** Con `main` puntato a un
unico `./dist/index.js` compilato `CommonJS`, la build di produzione dei
frontend (`apps/frontend-admin/Dockerfile`, `tsc -b && vite build`) falliva
a sua volta: `"matchCountry" is not exported by ".../dist/index.js"` —
Rollup/Vite non rileva in modo affidabile i named export di un modulo CJS
risolto fuori da `node_modules` (via symlink workspace), anche quando il
pattern di export CJS è quello standard emesso da `tsc`. Riprodotto solo
buildando l'immagine Docker di produzione reale, mai nei container dev
(stesso motivo del bug precedente: dev maschera tutto).

Fix definitivo: **build duale**, `packages/shared-types/tsconfig.cjs.json`
(`module: CommonJS`, → `dist/cjs`) e `tsconfig.esm.json` (`module: ES2020`,
→ `dist/esm`, nessuna `.d.ts` — le dichiarazioni le emette solo la build
CJS). `package.json` usa `"exports"` condizionale:
```json
"exports": { ".": {
  "types": "./dist/cjs/index.d.ts",
  "import": "./dist/esm/index.js",
  "require": "./dist/cjs/index.js"
} }
```
Node (`require()`, backend) risolve `"require"` → CJS, invariato. Vite/Rollup
(frontend, sempre `import`) risolve `"import"` → ESM nativo, zero euristica
d'interop necessaria. `"main"`/`"types"` flat restano come fallback per tool
che non capiscono `"exports"`.

**Build in Docker — solo binario diretto, mai `pnpm --filter/run`.** Stesso
gotcha pnpm v11 già noto per `CMD` (vedi sezione sopra): `pnpm --filter
@comunicapa/shared-types build` fallisce in build con
`runDepsStatusCheck`/deps-check preventivo bloccante. Pattern corretto in
ogni Dockerfile/`Dockerfile.dev` (backend, frontend-admin, frontend-citizen
— tutti e tre consumano il pacchetto), subito dopo `pnpm install
--ignore-scripts`:
```dockerfile
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json \
 && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json
```
In CI (`.github/workflows/tests.yml`) invece va bene `pnpm --filter
@comunicapa/shared-types run build` — quella pipeline usa pnpm v9
(`pnpm/action-setup@v6 version: 9`), non v11, nessun deps-check bloccante.

**Conseguenza per lo sviluppo**: modificare `packages/shared-types/src/*.ts`
richiede un rebuild dei container che lo consumano (`docker compose build
backend frontend-admin frontend-citizen`) — il bind mount dev aggiorna solo
`src/`, mai `dist/cjs`/`dist/esm`, stesso pattern già noto per modifiche
fuori da `src/` dell'app stessa. **Prima di pushare qualunque modifica a
questo pacchetto o ai Dockerfile che lo buildano, verificare SEMPRE
buildando l'immagine di produzione reale in locale** (`docker build -f
apps/<app>/Dockerfile .`, non solo `Dockerfile.dev`) — il dev bind-mount ha
già mascherato due bug di produzione consecutivi in questa storia.

## TypeScript

`tsconfig.base.json` alla root impone strict mode completo. Ogni app estende questa base. Il backend aggiunge `experimentalDecorators` e `emitDecoratorMetadata` (richiesti dai decorator NestJS).

Il pacchetto `@comunicapa/shared-types` si importa con `workspace:*` — non pubblicato su npm, risolto internamente da pnpm.

## Label/loghi/badge canali — sempre dal registro centralizzato

Label, colore, badge, logo (Data URI SVG) e icona di ogni canale/tipologia (EMAIL, PEC, APP_IO, SEND, POSTAL, PROTOCOLLAZIONE, INAD...) sono definiti **una sola volta per frontend**, mai duplicati in un punto isolato del JSX:

- `frontend-admin`: `apps/frontend-admin/src/data/channels.ts` (`CHANNELS_REGISTRY`, `EMBEDDED_LOGOS`, `getChannelMeta()`, `channelLabel()`, `ENGINE_LABELS`). Usare sempre `getChannelMeta(channel)` o `EMBEDDED_LOGOS.<CANALE>` — mai un'altra label/colore/logo hardcoded per un canale già presente lì (nav sidebar, badge, intestazioni pagina, select, tabelle). Stesso principio per gli stati condivisi (`STATUS_META`, `SEND_STATUS_META`, `POSTAL_STATUS_META` in `App.tsx`).
- `frontend-citizen`: `CHANNEL_META`/`EMBEDDED_LOGOS` in cima a `App.tsx` (copia indipendente, non condivisa con l'admin — due bundle separati, ognuno con la propria unica fonte di verità). Usare sempre `CHANNEL_META[canale]`/`ChannelBadge`, mai un'label/logo hardcoded altrove nel file.

Per aggiungere un canale o cambiarne label/colore/logo, modificare solo il registro di quel frontend: si propaga ovunque senza dover cercare copie sparse (vedi commit `e4dc41e` che ha eliminato 3 copie duplicate della stessa mappa in admin). Se un canale esiste in entrambi i frontend, aggiornare entrambi i registri — non sono sincronizzati automaticamente.

## CSS frontend — gotcha

`frontend-citizen` NON carica Bootstrap: le utility (`d-grid`, `w-100`, `text-center`...) sono no-op. Usare i css custom (`tokens.css`, `fo-components.css`, design system `--ms-*`/`--bi-*`) o stili espliciti. L'admin ha le sue utility custom in `app.css`/`backoffice-shell.css`.

`frontend-citizen` carica in ordine `tokens.css` → `fo-components.css` → `app.css` (vedi `main.tsx`): una classe con lo stesso nome definita in più file vince per ordine di caricamento a parità di specificity, non per "ultima modificata". Prima di aggiungere una classe già vista altrove, cercarla in tutti e tre i file (`grep -rn "nomeclasse" apps/frontend-citizen/src/assets/css/`).

## Formattazione importi — `Intl.NumberFormat`/`toLocaleString('it-IT')` richiede `useGrouping: true` esplicito

`(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`
senza `useGrouping` esplicito risolve internamente a `useGrouping: 'auto'`,
che in pratica NON applica il separatore delle migliaia — produce
`"2941,12"` invece di `"2.941,12"` (verificato dal vivo, sia Node che
browser). Ogni formattazione di importi in euro deve passare
`useGrouping: true` esplicito — vedi `formatEuroCents()` in
`apps/frontend-admin/src/App.tsx`, unico punto da riusare per nuovi importi.

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

Anche stando sotto ~1MB, un endpoint bulk che itera N operazioni sequenziali
per-record dentro una singola richiesta HTTP (es. retry di massa su migliaia
di destinatari falliti) resta a rischio timeout dietro il proxy, indipendente
dal body size — 200-with-flag non basta se la richiesta stessa impiega troppo
a rispondere. Ogni nuovo endpoint bulk deve avere un tetto esplicito sul
numero di elementi per chiamata (validato sia server-side con
`BadRequestException` sia client-side prima di inviare la richiesta, per non
sprecare la chiamata) — vedi `retryRecipientsBulk`/`MAX_BULK_RETRY_SIZE` in
`campaigns.service.ts` (limite 500).

**`assembleChunkedUpload` — attendere sempre l'evento `finish` prima di
ritornare.** Bug reale trovato durante verifica E2E: la funzione chiamava
`out.end()` senza attenderne il completamento — `WriteStream.end()` non
garantisce che l'ultimo chunk sia stato effettivamente flushato su disco,
solo che è stato accodato al buffer interno. Il chiamante poteva quindi
leggere il file assemblato (es. `new AdmZip(path)`) prima del flush,
ottenendo un file troncato (`ADM-ZIP: Invalid filename` su central
directory incompleta) — race intermittente, più probabile su file grandi
(più tempo di flush). Fix: avvolgere `out.end()` in una Promise che
risolve su `finish`/rigetta su `error`, dentro il blocco `finally` prima
del `return`. Questa funzione è condivisa da 4 percorsi upload (campagne
CSV destinatari, campagne allegati, arricchimento tracciati, io-services
verify-bulk) — qualunque modifica a `chunked-upload.util.ts` va verificata
con lo stesso rigore su tutti e quattro, non solo sul percorso che si sta
toccando.

## Lavoro pesante sincrono in un handler HTTP — non solo timeout proxy, affama TUTTO

Oltre al noto rischio timeout proxy esterno (vedi sopra), un endpoint che fa
unzip/scrittura file pesante in modo sincrono dentro la richiesta HTTP
blocca l'event loop Node (single-thread) per l'intera durata — affamando
ANCHE richieste concorrenti scollegate (osservato in prod: 403 su
`/admin/settings` mentre "crea bozza campagna" da arricchimento (unzip
500MB + scrittura 3280 PDF sync) girava). Fix reale applicato:
`EnrichmentService.requestCampaignConversion()` fa solo validazioni rapide
e accoda un job BullMQ (`convert-campaign`, stesso processor
dell'arricchimento) — l'endpoint risponde subito, il frontend fa polling
sul job esistente. Ogni futuro endpoint che fa unzip/IO pesante va valutato
con lo stesso criterio, non solo "rischia il timeout proxy?" ma anche
"blocca l'app intera nel frattempo?".

## Log debug/verbose — gotcha

Il logger NestJS di default (`NestFactory.create`) esclude i livelli
`debug`/`verbose`, a prescindere dall'ambiente. `main.ts` legge `LOG_LEVEL`
da env (default `info`) e lo mappa ai livelli Nest — impostare
`LOG_LEVEL=debug` in `.env` e riavviare il backend per vedere i log di
dettaglio dei motori di invio (payload/risposte PEC/Email/App IO/SEND/Postal).
I job BullMQ salvano inoltre i propri log (`job.log()`), consultabili dalla
UI admin → Motori → "Vedi log" per singolo job, senza bisogno di accesso SSH.

## E2E browser (Chrome DevTools MCP) — gotcha click sidebar

Click su voci di navigazione sidebar (`href="#"`, routing client-side via
`onClick` React, nessun cambio URL reale) spesso fallisce con "did not
become interactive within the configured timeout" anche se l'elemento è
visibile e cliccabile a mano. Workaround: `evaluate_script` che seleziona
il link per testo e chiama `.click()` sul DOM direttamente, es. `() => {
const link = [...document.querySelectorAll('a')].find(a =>
a.textContent.trim() === 'Arricchimento Tracciati'); link?.click(); }` —
bypassa il controllo di interattività del tool `click` che su questi
elementi non lo soddisfa mai.

## Audit log — ogni endpoint che consulta un registro PA esterno deve loggare

`AuditLogsService.log()` non è solo per le azioni su Campaign — qualunque
controller che interroga un registro esterno con dati personali (ANPR,
INAD, App IO...) deve loggare operatore + CF cercato, altrimenti non c'è
modo di ricostruire dopo il fatto "chi ha cercato quale CF". Gap reale
trovato e corretto: `DomicilioController.cerca()` (orchestratore
ANPR+INAD+App IO) non aveva alcun logging fino a `06f943e` — verificare
per ogni nuovo endpoint di ricerca su registro esterno.

## Ownership campagne — cancel()/remove() richiedono requester

`CampaignsService.cancel()`/`remove()` accettano un secondo parametro
`CampaignRequester {username, role}` e chiamano `assertOwnership()`: un
'admin' bypassa sempre, un 'user' solo se `campaign.createdBy ===
requester.username` (altrimenti `ForbiddenException`). Il controller NON
fa il check — lo fa il service, per restare testabile con lo stesso
pattern service-layer già usato per `createdBy` (`campaigns.service.spec.ts`).
Qualunque nuovo metodo mutante su Campaign aggiunto in futuro (oltre a
cancel/remove) va valutato per lo stesso controllo, non solo quello che
lo introduce — stesso principio già in uso per gli stati terminali sopra.

## operator_directory — cache display name, si popola solo al login

`OperatorDirectoryService` mappa username → display name (LDAP reale o
mock), usata da `CampaignsController.findAll()/findOne()` per esporre
`createdByDisplayName` (fallback a `createdBy` grezzo se assente).
Aggiornata SOLO in `AuthService.loginWithLdap()` a ogni login riuscito —
nessun backfill batch, nessuna risoluzione LDAP live per username
arbitrario (richiederebbe un bind service-account che non esiste in
questo codebase). Un operatore che ha creato campagne ma non ha mai
fatto login dopo l'introduzione di questa feature resta con lo username
grezzo finché non fa login una volta.

## Placeholder template notifiche

Delimitatore `%%chiave%%` (doppio `%`, non singolo) — vedi `template.helper.ts`
`processTemplate()`. Un `%` singolo (percentuale in prosa, es. "60% del
tributo") non forma mai un placeholder. Nessuna retrocompatibilità col vecchio
delimitatore singolo: i template esistenti vanno riscritti.

**Oggetto per-destinatario da colonna CSV.** Se `channelConfig.csvMapping.subject`
mappa una colonna, `resolveSubjectTemplate()` (`subject-mapping.util.ts`) usa
il valore di quella cella per il singolo destinatario al posto dell'oggetto
di campagna — utile per invii con tributi diversi nello stesso lancio (es.
SEND), ma significa che editare l'"Oggetto" della campagna nel wizard NON
cambia l'oggetto reale per righe con quella colonna valorizzata. Verificare
sempre `csvMapping.subject` prima di dare per scontato quale oggetto verrà
usato per un destinatario specifico.

**App IO — vincolo di lunghezza anche sull'oggetto**, non solo sul body:
PagoPA rifiuta `content.subject` fuori dal range `[10, 120]` caratteri
(oltre al vincolo già noto su `content.markdown`, `[80, 10000]`) — HTTP 400
"not a valid [string of length >= 10 and < 121]". Validazione bloccante
lato wizard: `wizAppIoSubjectLenInvalid`/`APP_IO_SUBJECT_MIN`/`_MAX`
(`App.tsx`), stesso pattern del check body esistente
(`wizAppIoBodyLenInvalid`).

## Wizard campagne — sync bozza/Recipient anticipato ad ogni "avanti"

Dallo step2 in poi, ogni transizione "avanti" (bottoni, tab-click forward,
"Avvia Test") chiama `syncWizDraftAndRecipients(targetStep)` — salva
nome/config/CSV grezzo bozza e, se cambiati dall'ultimo sync (impronta
`wizRecipientsSyncFingerprint`), risincronizza i `Recipient` in DB (via
`uploadCsv()`, delete+recreate). Questo perché i `Recipient` ora esistono
già in bozza (non solo al lancio reale) — necessario perché
`finalizeAttachments()` risolva correttamente gli allegati referenziati a
step5, prima solo Recipient assenti in bozza causavano lo scarto di ogni
allegato caricato.

**`targetStep` va sempre passato esplicitamente, mai desunto da `wizStep`
state.** `buildWizChannelConfigDraft(targetStep)` scrive `wizStep:
targetStep` nel channelConfig persistito — se un punto di chiamata usasse
`wizStep` (stato del render corrente) invece del target, salverebbe lo
step di PARTENZA della transizione, non quello di arrivo (setState non è
visibile nello stesso render/closure). Bug reale già capitato una volta
per lo stesso motivo su una diversa funzione in questo file (vedi bug1
mappatura CSV, stale closure).

**Ogni nuovo bottone/azione che avanza lo step deve chiamare
`syncWizDraftAndRecipients(targetStep)` prima di `setWizStep`.** Bug reale:
"Avvia Test" (step6→7) inizialmente non lo faceva — se l'operatore
modificava oggetto/testo a step4 e tornava a step6 senza mai ripassare da
un bottone "avanti", il test partiva con `channelConfig` ancora quello
del salvataggio precedente mentre l'anteprima mostrava già il nuovo
contenuto in locale — invii "sfalsati" di un edit rispetto alla preview.

**`handleWizSingleSubmit` — mai leggere `wizValidRows`/`wizAttachments`
subito dopo averli appena calcolati nello stesso tick.** `wizValidRows` è
popolato da un `useEffect` separato che reagisce a `wizCsvRows` — se
`syncWizDraftAndRecipients` viene chiamato subito dopo `parseCsvFile()`
(stessa esecuzione sincrona di `handleWizSingleSubmit`), legge ancora
`wizValidRows` di PRIMA (vuoto al primo invio): il gate
`wizValidRows.length > 0` salta la creazione del `Recipient`, e l'allegato
caricato subito dopo viene scartato da `finalizeAttachments` perché
nessun recipient lo referenzia ancora ("Allegato non trovato",
riproducibile anche in un invio lineare senza mai tornare indietro). Fix
applicato: `syncWizDraftAndRecipients`/`buildWizChannelConfigDraft`
accettano un override esplicito (CSV blob + lista allegati) invece di
affidarsi allo stato asincrono per questa chiamata specifica.

**Gating navigazione tab:** `wizMaxReachedStep` (più alto step raggiunto)
+ snapshot `wizLastSyncedHeaders`/`wizLastSyncedMapping` (presi solo al
sync 3→4, quando la mappatura è confermata) determinano se un tab-step
oltre lo step 3 è cliccabile in avanti — solo se CSV/mappatura non sono
cambiati dall'ultimo sync. Il tab bar esistente (`App.tsx` "Steps
Progress Header") permetteva SOLO click all'indietro prima di questa
modifica — non dare per scontato che un salto in avanti "funzioni già".

## Wizard — bottoni "Avanti"/"Indietro" duplicati in cima e in fondo allo step

Molti step del wizard hanno lo stesso bottone (con la stessa condizione
`disabled`/`onClick`) ripetuto due volte: uno sopra il contenuto dello
step, uno sotto. Le due copie NON sono un unico source-of-truth — sono
letteralmente due blocchi JSX separati che vanno tenuti sincronizzati a
mano. 4 bug reali nella stessa sessione per lo stesso motivo (una copia
aggiornata, l'altra dimenticata): bottone "Riepilogo" (check placeholder
allegati mancante in una sola delle due copie), "Indietro" da step6
(target step corretto in una sola copia), gate tassonomia SEND
obbligatoria (mancante in 2 copie su 3 incluso `wizSingleSubmitDisabled`).
Ogni modifica a una condizione disabled/onClick di questi bottoni va
cercata e applicata a TUTTE le occorrenze (`grep` sul testo della
condizione, non fidarsi di trovarne una sola).

## Job BullMQ e stato campagna/destinatario — pattern jobId = attemptId

`launch()`, `retryRecipient()` e `cancel()` in `campaigns.service.ts` accodano
ogni job BullMQ con `opts.jobId` impostato esplicitamente = `NotificationAttempt.id`
(via `NotificationQueuesService.addBulk`). Questo permette lookup diretto
(`notificationQueues.getJob(channel, attemptId)`) senza scansionare l'intera
coda del canale — indispensabile per annullare/gestire job di UNA campagna
quando la coda è condivisa tra più campagne dello stesso canale. Se aggiungi
un nuovo punto che accoda job (`addBulk`), passa sempre `opts.jobId` con lo
stesso attemptId, altrimenti quel job diventa invisibile a `cancel()`.

**"Motore" ≠ canale**: `NotificationQueuesService`/`EnginesController` usano
`EngineName` (`notification-job.types.ts`), non `NotificationChannel` — un
motore può essere channel-agnostico (es. `PROTOCOLLAZIONE`, usato solo da
SEND oggi ma non specifico a SEND). Convertire un demone `@Cron` poll-based
in un motore BullMQ vero (stessa UI pausa/riprendi/job falliti/log degli
altri) richiede sempre toccare gli stessi 3 punti in `campaigns.service.ts`:
`launch()` (produzione job in bulk al lancio campagna), `retryRecipient()`
(produzione condizionale — valuta se serve davvero un nuovo job o se lo
stato esistente basta), `cancel()` (rimozione best-effort del job pendente,
oltre all'update di stato). Un fallimento del job deve marcare il record
terminale (FAILED) PRIMA di rilanciare l'errore — altrimenti BullMQ registra
il job come fallito ma il destinatario resta bloccato in uno stato intermedio
per sempre (nessun "Rimetti in coda" possibile, la UI non lo mostra tra i
falliti).

Quando aggiungi un nuovo stato "terminale" a `CampaignStatus`/`RecipientStatus`
(es. `CANCELLED`), audit obbligatorio: TUTTI i metodi che mutano quel record
devono guardare contro il nuovo stato, non solo il metodo che lo introduce.
Bug reale: `retryRecipient()` non controllava `campaign.status`, quindi un
destinatario `FAILED` (lasciato intatto da `cancel()` apposta) poteva essere
rimesso in coda su una campagna già `CANCELLED` — inviando davvero un
messaggio su una campagna "annullata".

**Se un canale bypassa BullMQ** (demone `@Cron` invece di job, es. SEND dal
refactor "pipeline a demoni"): il check di completamento campagna
(`CampaignCompletionService.checkAndComplete()`, estratto da
`notification.processor.ts`) NON scatta da solo — va chiamato esplicitamente
dal demone dopo ogni esito terminale (successo/fallimento), esattamente come
fa il processor per gli altri canali. Bug reale: dimenticarlo lascia la
campagna bloccata in `QUEUED` per sempre anche a invio terminato per tutti i
destinatari — nessun errore visibile, solo uno stato mai aggiornato.

**L'inverso è altrettanto reale: un retry che rimette destinatari in coda
deve riportare `campaign.status` FUORI da uno stato terminale.** Bug
confermato dal vivo: `retryRecipient()` (chiamato da retry singolo, bulk
retry, e content-correction) rimetteva `Recipient.status` a `QUEUED` ma non
toccava mai `campaign.status` — una campagna già `COMPLETED`/`FAILED` a cui
si rimettono in coda centinaia di destinatari FAILED resta "Completata" in
UI per sempre, nonostante il lavoro reale ancora in corso. Fix: se
`campaign.status` è `COMPLETED`/`FAILED` al momento del retry, riportarlo a
`QUEUED` (`completedAt: null`) — `checkAndComplete()` la richiuderà da sola
quando anche l'ultimo retry sarà terminale.

## BullMQ — `queue.add()` con jobId esistente è no-op silenzioso, mai un errore

Riaggiungere un job con lo stesso `opts.jobId` di uno già presente in Redis
(**qualunque** stato: completed/failed/active) non lancia eccezioni e non
logga nulla — semplicemente non rieseguirà mai il job. Un demone di
"resume/retry" che riusa l'id originale come dedup naïve resta bloccato per
sempre nonostante un log di successo apparente (bug reale, verificato dal
vivo con crash reale simulato via `docker compose restart` — vedi
`enrichment-resume.service.ts`). Ma rimuovere sempre `opts.jobId` non è la
correzione giusta: se il vecchio job è ancora `active` (worker crashato,
lock scaduto — questo repo non chiama `app.enableShutdownHooks()`, opzioni
BullMQ default), lo stalled-job recovery di BullMQ lo riprende da solo
entro il `stalledInterval` (default 30s) — aggiungerne un secondo in quel
caso produce due processor concorrenti sullo stesso job applicativo
(checkpoint/file scritti due volte, race reale). Prima di un re-add:
`queue.getJob(id)` + `.getState()` — `active/waiting/delayed` → non
toccare, lascialo al recovery automatico; `completed/failed/assente` →
`.remove()` esplicito poi `add()` con lo stesso jobId (ripristina la dedup
come rete di sicurezza).

## Cron/coda con batch fisso — round-robin obbligatorio, mai ORDER BY statico

Un demone che processa un batch limitato (`LIMIT N`) da una coda più grande
deve ordinare per "ultimo controllato", mai per un campo statico come
`created_at` — bug reale: `PostalStatusSyncService` ordinava per
`created_at ASC` fisso; con >200 (`BATCH_SIZE`) candidati totali (390 in
produzione), i record più vecchi che non progrediscono mai (stato non
terminale permanente) monopolizzano per sempre le prime posizioni,
affamando i record più nuovi — mai ripescati dal cron, solo un
"Ricontrolla stato" manuale li aggiornava. Fix: nuova colonna
`postal_last_checked_at` (aggiornata ad OGNI controllo, anche se lo stato
non cambia — non basta il campo "ultimo cambio" esistente,
`postal_status_updated_at`, che non avanza mai per un record fermo),
`ORDER BY COALESCE(postal_last_checked_at, created_at) ASC`. Qualunque
futuro cron con batch+limit va verificato per lo stesso rischio.

**Ogni nuova condizione di re-check su un attempt POSTAL terminale (es.
controllo riaccodamento su `Eliminato`) va aggiunta ANCHE alla WHERE di
`PostalStatusSyncService.handleCron`, non solo alla logica di `syncOne`.**
Bug reale: `checkRequeue()` era corretto ma il filtro del cron escludeva a
priori un `Eliminato` con `cost_cents` già valorizzato (caso comune) — il
controllo automatico non veniva mai raggiunto. Il manuale (`refreshOne`)
bypassa questo filtro (legge per id) e può sembrare funzionare mentre
l'automatico resta silenziosamente rotto — testare sempre entrambi.

**`postal_last_checked_at` va aggiornato ANCHE quando `dettagli_documento`
lancia (SOAP fault/timeout/IDPRO non più valido), non solo su risposta
riuscita.** Bug reale su una campagna con 4000+ POSTAL: un IDPRO che fallisce
sempre non avanzava mai quel timestamp, restando per sempre il candidato più
"vecchio" in cima all'`ORDER BY ASC` — riselezionato a ogni giro cron,
falliva di nuovo, occupava uno slot del batch (200/min) senza mai avanzare,
affamando gli altri destinatari dietro in coda (stato/costo fermi da giorni,
nessun errore visibile lato UI). Fix in `syncOne`: try/catch attorno alla
chiamata, timestamp aggiornato comunque prima di rilanciare l'errore.

**GlobalCom risponde spesso `Costo:0` mentre il documento è ancora in
lavorazione — è un placeholder, MAI un costo reale finale.** `cost_cents = 0`
va trattato come "non ancora calcolato" alla pari di `NULL` in OGNI punto che
legge/aggrega il costo: filtro WHERE del cron, gate di aggiornamento in
`syncOne`, media in `getCampaignCostSavings` (POSTAL), conteggio
"non calcolati" in `getCampaignCost`. 3 bug reali corretti nella stessa
sessione per lo stesso motivo (`cost_cents !== null` bastava a considerarlo
"già costato per sempre", bloccando il vero costo che GlobalCom calcola più
tardi) — qualunque nuovo punto che legge `cost_cents` va controllato contro
questo stesso caso.

## Stato consegna POSTAL/SEND post-accettazione — mai riflesso su recipient.status

Un errore di consegna arrivato DOPO l'accettazione del provider (es.
GlobalCom `Stato=Accettato` ma poi `CodiceErrore!=='0'` su
`postalStatusHistory`, stesso principio già noto per `sendStatus`) non fa
MAI transitare `NotificationAttempt.status`/`Recipient.status` a FAILED —
nessun demone lo fa oggi (`postal-status-sync.service.ts`/
`send-status-sync.service.ts` aggiornano solo `postalStatus`/`sendStatus`,
mai lo status). Conseguenza pratica: `retryRecipient()` (richiede
`RecipientStatus.FAILED`) rifiuta questi destinatari finché qualcosa non
forza la transizione — vedi `updateRecipientAddressAndRetry()` in
`campaigns.service.ts`, che la forza SOLO in risposta a un'azione operatore
esplicita (mai in automatico, per non rischiare di marcare FAILED uno stato
GlobalCom transitorio come "Rimandato").

**`CampaignCompletionService.checkAndComplete()` non guarda `failedCount` né
gli errori di consegna**: marca COMPLETED appena non restano
PENDING/QUEUED, anche se tutti/alcuni i destinatari sono FAILED o hanno un
errore di consegna post-accettazione — "Completata" oggi NON significa
"tutti consegnati senza errori". Cambiare questo comportamento richiede
prima decidere: cosa conta come errore (solo FAILED, o anche
CodiceErrore/sendStatus post-accettazione?), che fare del caso misto
(nuovo stato enum `COMPLETED_WITH_ERRORS`, o restare su COMPLETED con
evidenza solo nei contatori?), e se il check deve aspettare la consegna
finale (giorni, per SEND/POSTAL) o restare al solo momento di
sottomissione — discussione aperta, non ancora implementata.

## Migration enum Postgres — ALTER TYPE ADD VALUE

`typeorm migration:generate` NON sa generare `ALTER TYPE ... ADD VALUE` per un
nuovo valore enum Postgres: produce un diff invasivo (rename tipo esistente →
crea nuovo tipo → `ALTER COLUMN ... USING ... ::testo::nuovo_tipo` → drop/ricrea
eventuali FK coinvolte). Per aggiungere un valore enum, scrivi la migration a
mano con `ALTER TYPE "public"."<tabella>_status_enum" ADD VALUE '<valore>'`
(una query per tipo coinvolto), `down()` no-op documentato (Postgres non ha
`DROP VALUE`). Verifica eseguendo l'intera catena di migration su un DB
temporaneo pulito, non fidandoti dell'output grezzo del generatore.

## Creazione campagne — un solo percorso

La creazione/import destinatari passa **solo** dal wizard multi-step
(`view === 'invio-massivo-wizard'` in `frontend-admin/App.tsx`): è l'unico
punto con le validazioni corrette (formato CF/email, lunghezza minima body
App IO). Non aggiungere form di creazione rapida o importer CSV alternativi
altrove (es. sulla pagina dettaglio campagna) — bypassano quelle validazioni
e hanno già causato invii falliti in produzione (CF troncato, markdown vuoto
per App IO). Per riprendere una bozza: bottone "Riprendi wizard"
(`handleResumeDraft`), non un importer dedicato.

## ANPR C002 — pattern di sicurezza reale (verificato con dati veri, funzionante)

Il servizio C002 "Servizio di comunicazione" (`AnprService`,
`channels/anpr/anpr.service.ts`) usa **bearer voucher standard** (non
DPoP — ipotesi provata dal vivo e scartata: cambiava l'esito del 400 ma
per un motivo diverso, vedi sotto). Sostituisce C020 "Servizio di
accertamento residenza" (stesso schema/pattern di sicurezza, path e
`casoUso` diversi) perché C002 è un superset: oltre a generalità e
residenza restituisce anche esistenza in vita ed eventuale domicilio
digitale, tramite `infoSoggettoEnte` (coppie chiave/valore generiche —
osservato dal vivo: `{chiave:"Verifica esistenza in vita", valore:"S"}`,
nessun'altra chiave documentata nello yaml, se un domicilio digitale è
presente compare come voce aggiuntiva nello stesso array). La
configurazione corretta, verificata byte-per-byte contro un client Java
ufficiale allegato dal supporto ANPR (github.com/italia/anpr/issues/3964
— **non fidarsi di un riassunto, solo di esempi reali con token
catturati**, un riassunto ha già portato su strade sbagliate — es.
certificato X.509 mancante, poi DPoP — in questa stessa integrazione):

1. **`aud` di `Agid-JWT-Signature`/`Agid-JWT-TrackingEvidence` è l'URL
   SENZA `-PDND` e SENZA il segmento operazione finale**
   (`ANPR_C002_AUD` = `.../MinInternoPortaANPR/C002-servizioComunicazione/v1`)
   — diverso dall'URL di invocazione reale (`ANPR_C002_ENDPOINT`, CON
   `-PDND` e CON `/anpr-service-e002` in coda). Un `aud` sbagliato (uno dei
   due dettagli scambiato) è la causa più comune di
   `InteroperabilityInvalidRequest` (HTTP 400) in tutto quel thread.
2. **Il voucher va richiesto con un claim `digest` extra nella client
   assertion** (pattern AUDIT_REST_02): `{alg:"SHA256", value:<hex>}` dove
   `value` è lo SHA-256 **esadecimale** (non base64) del JWT
   `Agid-JWT-TrackingEvidence` — va quindi costruito PRIMA il
   TrackingEvidence, poi hashato, poi richiesto il voucher
   (`PdndAuthService.getVoucherWithDigest`, mai cache: il digest cambia a
   ogni chiamata). Senza questo claim PDND non lo incorpora nel voucher e
   l'erogatore rigetta con lo stesso 400 generico.
3. **`signed_headers` in `Agid-JWT-Signature` è un array**, con chiavi che
   devono combaciare ESATTAMENTE (nome e valore) con gli header HTTP
   realmente inviati — `Content-Type` con la maiuscola, mai
   `content-encoding` se quell'header non viene effettivamente mandato.
4. **Vincoli di lunghezza sui claim di `Agid-JWT-TrackingEvidence`**,
   scoperti solo dall'errore applicativo reale restituito da ANPR (non
   documentati nello yaml): `LoA` max 20 caratteri (es. `SpidL2`, mai un
   URL completo tipo `https://www.spid.gov.it/SpidL2`) — vedi
   `anpr.trackingLoA` in `settings.registry.ts`. `userLocation`/`userID`
   probabilmente hanno vincoli simili, non ancora tutti mappati.
5. **`idOperazioneClient` (corpo della richiesta) max 30 caratteri** — un
   `randomUUID()` (36 con trattini) viene rifiutato con "Lunghezza del
   campo idOperazioneClient maggiore del massimo consentito 30".

**`x5c`/certificato X.509 non necessario**: il kid da solo basta (verifica
lato erogatore risolve la chiave pubblica dal kid già noto a PDND per
quel client) — l'esempio Java ufficiale mette (erroneamente, per quanto
osservabile) la chiave privata dentro `x5c`, un bug del sample mai
segnalato come problema dal supporto ANPR nello stesso thread; nella
nostra implementazione `x5c` è omesso del tutto, funziona.

**Warning non bloccante da tenere presente**: la risposta 200 include
spesso `listaAnomalie` con un warning (`tipoErroreAnomalia:"W"`) che
raccomanda l'uso di `idANPR` invece di `codiceFiscale` in
`criteriRicerca` per conformità al D.M. Interno 3 marzo 2023 — non blocca
la query attuale (funziona comunque per CF), ma se ANPR in futuro rende
`idANPR` obbligatorio, serve una fase di risoluzione CF→idANPR a monte.

## SEND — autenticazione reale verso PN, gotcha critico

PN (`api.notifichedigitali.it`/`api.uat.notifichedigitali.it`) richiede
**ENTRAMBI** gli header su ogni chiamata `/delivery/*`: `x-api-key` (emesso
dal portale self-care PN) **e** `Authorization: Bearer <voucher PDND>`.
Lo spec OpenAPI backend (`components.securitySchemes`) documenta SOLO
`x-api-key` — non descrive il layer di gateway PDND davanti al backend
reale. Verificato solo contro l'esempio curl verbatim della guida ufficiale
(developer.pagopa.it, "Inserimento notifica con il comando curl"), non
fidandosi dello spec YAML da solo. Un solo header → 403/401.

**Upload allegati**: `x-amz-checksum-sha256` sull'URL S3 presigned va come
header HTTP normale, MAI come trailer chunked — un trailer produce
`SignatureDoesNotMatch` (la firma dell'URL presigned assume il checksum tra
gli header firmati). Vedi `send-attachment-upload.service.ts`.

**Payload `documents[].docIdx`**: deve essere stringa (`"0"`), non numero
— lo schema PN è `allOf` di 2 sotto-schemi e un numero fa fallire la
validazione con un errore criptico ("matched only 1 out of 2").

**Campi opzionali ma a volte obbligatori**: `physicalAddress` (destinatario)
è richiesto se PN non risolve un domicilio digitale legale (es. CF non
trovato su ANPR/INAD) — errore "PhysicalAddress cannot be null". `group`
(root payload) è richiesto se l'account PN è associato a più gruppi utenti
(self-care PN) — errore "Specify a group in cx_groups=[...]". Entrambi
configurabili via Impostazioni → SEND, nessun default hardcoded.

**Verifica spec**: mai fidarsi di un riassunto AI dello spec OpenAPI —
scaricare il raw YAML (`curl` su `pagopa/pn-delivery`, `docs/openapi/
api-external-b2b-pa-bundle.yaml` — NON `pn-openapi-devportal`, repo
inesistente/404) e grep diretto su `securitySchemes`/
schema dei singoli campi. Un riassunto ha già portato a un fix sbagliato
una volta in questa stessa giornata di debug.

## SEND — stati notifica PN (sendStatus)

`sendStatus` (colonna `NotificationAttempt`, popolata da
`SendStatusSyncService` da `GET /delivery/v2.9/notifications/sent/{iun}`)
usa l'enum `NotificationStatusV26` dello spec ufficiale PN (repo
`pagopa/pn-delivery`, `docs/openapi/api-external-b2b-pa-bundle.yaml`):
11 valori — `IN_VALIDATION`, `ACCEPTED`, `REFUSED`, `DELIVERING`,
`DELIVERED`, `VIEWED`, `EFFECTIVE_DATE`, `PAID` (deprecato), `UNREACHABLE`,
`CANCELLED`, `RETURNED_TO_SENDER`. Attenzione alla versione:
`RETURNED_TO_SENDER` esiste solo in V26, non nelle versioni più vecchie
dello schema `NotificationStatus` — verificare sempre lo spec raw, non un
riassunto, prima di aggiungere/rimuovere valori da `TERMINAL_STATUSES`
(`send-status-sync.service.ts`) o da `SEND_STATUS_META` (`App.tsx`).

## INAD — Indice Nazionale Domicili Digitali, dati verificati dal vivo

`GET /extract/{cf}` (query singola): **~0.5s**, sincrona. `POST
/listDigitalAddress` (bulk, fino a 1000 CF): **5-10 minuti**, elaborazione a
batch periodici lato INAD non realtime — costo prevalentemente fisso, non
lineare (3 CF: 5m53s; 50 CF: 6m09s-10m04s su due run separate). Non
verificato oltre 50 CF: se emerge crescita marcata su batch da centinaia,
va rivista qualunque soglia extract/bulk basata su questi numeri.
`/extract` ha limite **giornaliero condiviso** (1000-2000 richieste/die,
non nello spec OpenAPI) — non usare in loop su campagne grandi.

## POSTAL — GlobalCom SOAP, gotcha critico

Web service ASMX legacy (`node-soap`), non un'API REST moderna — alcune
convenzioni non sono deducibili dal solo WSDL/manuale, verificate solo
con credenziali reali (**un riassunto del solo WSDL ha già portato a
conclusioni sbagliate una volta in questa integrazione**, verificare
sempre scaricando l'XSD raw o testando dal vivo).

**Campo esito risposta = `<nomeMetodo>Result`, non `Result` generico.**
Convenzione ASMX standard (`LoginResult`, `invio_ext_singoloResult`,
`dettagli_documentoResult`...) — leggere `result.Result` è sempre
`undefined`/falsy, marca FAILED anche un invio realmente ACCETTATO da
GlobalCom (bug reale: un invio con `Stato=Accettato` e IDPRO assegnato
registrato come fallito lato nostro — rischio concreto di doppio invio
su un retry successivo).

**Array (`Destinatari`/`Files`, anche in risposta `ProdottiDisponibili`/
`ContrattiH2H`) sono tipi WSDL `ArrayOfX`**: l'elemento ripetuto dentro
il contenitore si chiama come il TIPO dell'item (`InfoIndirizzoExt`,
`InfoFileExt`, `ServiceType`, `DatiContrattoCOLMOLExt`), non come il
campo. Un array JS nudo produce un contenitore vuoto/non riconosciuto —
il server risponde "Il documento inserito deve contenere almeno un
destinatario" anche con un destinatario effettivamente passato.

**Nomi parametro nel manuale ≠ nomi WSDL reali.** Il manuale usa
"gruppo" solo nel testo descrittivo italiano e nell'esempio C# (dove il
nome del parametro posizionale è irrilevante) — il WSDL live usa
`group` (inglese). Verificare sempre l'XSD scaricato, mai fidarsi del
nome usato in prosa/esempio.

**Messaggi d'errore Login ambigui**: GlobalCom risponde con lo stesso
identico testo ("La combinazione di utente e gruppo non è valida") sia
per username/gruppo sbagliati sia per password errata — non
distingue le due cause lato loro.

**Mai loggare l'XML di richiesta del Login** (nemmeno a `LOG_LEVEL=debug`):
contiene la password in chiaro nel body SOAP. Loggare solo la risposta.

**Configurazione**: multi-provider in tabella dedicata
`postal_provider_configs` (`PostalProvidersService`), stesso pattern di
`mail_server_configs` per EMAIL/PEC — non chiavi flat in `app_settings`.
Tipologie di invio abilitate (`ProdottiDisponibili`) e codici contratto
(`ContrattiH2H`) sono scoperti automaticamente dal tasto "Test"
(`InformazioniUtenza`, sola lettura), mai configurati a mano — un'utenza
può essere abilitata solo su varianti "Market"/"Contest" (canale
Postel/Irideos), mai su Lettera/Raccomandata standard (canale Poste
diretto), e i Servizio "Market"/"Contest"/Atto Giudiziario richiedono un
`CodiceContratto` valido specifico per utenza.

**Il DB dev ha il provider GlobalCom REALE di produzione** (Montesilvano,
nessun sandbox separato) — un IDPRO/dato reale fornito dall'utente e
assente dal DB dev si può comunque testare dal vivo contro il vero
webservice, decriptando `password_enc` con
`deriveSettingsKey(process.env.JWT_SECRET)` + `decryptValue()`
(`settings-crypto.ts`). Mai loggare la password decriptata.

**`RicevutaDiRitorno=true` richiede anche `Colore`/`FronteRetro` e un
`Ricevuta` esplicito.** `Colore`/`FronteRetro` (stampa a colori/fronte-retro)
sono booleani obbligatori nel WSDL (`InfoGUIDExt`, verificato sull'XSD
live) — vanno sempre inviati, non solo quando true. Con AR attiva serve
anche il campo `Ricevuta` (`InfoIndirizzoExt`, indirizzo a cui torna la
cartolina firmata): omesso, GlobalCom risponde "Destinatario ricevuta: I
campi Denominazione1 e Denominazione2 sono entrambi vuoti".
`UsaDestinatarioARPredefinito=true` (stesso pattern di
`UsaMittentePredefinito`) è un fallback che presuppone un indirizzo AR
predefinito configurato lato GlobalCom sull'utenza — non è il caso
generale (errore reale: "E' stato richiesto il destinatario AR
predefinito per questo utente, ma non è presente in archivio"). Soluzione
adottata: `Ricevuta` = mittente configurato (`postal.strategy.ts`,
`ricevuta: ricevutaDiRitorno ? provider.mittente : undefined`) — la
cartolina AR torna al mittente, comportamento standard per raccomandate PA.

**Campo `Nazionale` (InfoGUIDExt) obbligatorio, nessun default.** Mai
valorizzato prima di un fix reale: GlobalCom applicava il default
nazionale e rigettava ogni invio con `Stato` estero valorizzato ("è
stato indicato un invio nazionale, ma lo stato del destinatario non
risulta l'Italia"), anche con contratto `Estero:true`. Fix:
`Nazionale: !destinatario.stato` in ogni `invio_ext_singolo`
(`globalcom-client.service.ts`). **CAP non forwardato per indirizzo
estero**, stesso principio già in vigore per Provincia: GlobalCom
valida `InfoIndirizzoExt.CAP` come "se presente, 5 cifre" (formato
italiano) — un CAP estero (es. belga "1180") viene rigettato
("Il CAP, se presente, deve essere un numero di cinque cifre").

**Errore GlobalCom `-1: "numeri raccomandata non salvati o non
disponibili"` (visibile solo su `postal_status_history`/portale GlobalCom,
mai in `invio_ext_singolo` — arriva DOPO l'accettazione, `Stato` passa da
`Accettato` a `Errore` al poll successivo) è confermato lato GlobalCom
essere un problema dei server Poste Italiane (mancata assegnazione del
numero identificativo raccomandata a monte), non un bug del nostro payload
SOAP — verificato XML request/response reale, tutti i campi (`Ricevuta`,
`Colore`, `FronteRetro`, `CodiceFiscale`) corretti. Nessuna azione
lato nostro possibile: intermittente, segnalare a supporto GlobalCom con
l'IDPRO se persiste.**

**`CodiceErrore`/`descrizione` NON sono legati allo `Stato` — mai gatare su
`stato==='Errore'`.** GlobalCom manda un `CodiceErrore` reale (es. `-2`,
"Richiesta HTTP vietata con lo schema di autenticazione client 'Basic'")
anche su stati transitori come `Rimandato` (durante un retry lato loro) —
gatare la persistenza su `stato==='Errore'` nasconde quell'informazione
finché non arriva un vero stato terminale (bug reale corretto). Ma manda
anche un `CodiceErrore` "benigno" (`"0"`) su stati positivi come
`Confermato` — persisterlo comunque mostra in UI un invio riuscito come se
fosse un errore (altro bug reale corretto: "GlobalCom (0)" su una
raccomandata in realtà confermata). Il criterio giusto è il **valore** di
`CodiceErrore` (`!== '0'`), non lo `stato` associato — vedi
`postal-status-sync.service.ts`/`App.tsx` (colonna Errore, dettaglio
notifica).

**Atto Giudiziario richiede sempre `Ricevuta`/AR, indipendente dal
checkbox "Ricevuta di ritorno" (per Agol resta nascosto/forzato sempre
attivo).** `ricevutaDiRitorno` era gated solo su
`servizio.startsWith('Raccomandata')` — per Agol restava sempre `false`,
GlobalCom accettava l'invio ma falliva dopo, in lavorazione (`Stato:
Accettato → Errore`, `CodiceErrore -2` "Nessun destinatario ricevuta
trovato per questa spedizione"): l'AR è obbligatoria per legge sull'Atto
Giudiziario, non opzionale come per una raccomandata. Riprodotto e
confermato dal vivo su due campagne reali. Stesso Servizio richiede anche
sempre protocollazione preventiva (`channelConfig.protocolla`), stesso
obbligo già in vigore per SEND — vedi
`assertSendProtocolConfigured`/`isChannelAlwaysLegalValue`.

**Atto Giudiziario (`AgolMarket`/`AgolBusiness`, non `AttoGiudiziario*` —
nome facilmente sbagliato, verificare sempre l'enum `ServiceType` reale
sul WSDL, non un riassunto) richiede `OpzioniAgol` (`DatiAgol`) sempre
popolato, mai omesso**: `TipoNotificante`, `SecondoTentativoRecapito`,
`AvvisoRicevimentoDigitale` sono dereferenziati incondizionatamente dal
codice GlobalCom per questo Servizio — omessi, `NullReferenceException`
generico ("Riferimento a un oggetto non impostato su un'istanza di
oggetto"), zero informazione diagnostica. `AvvisoRicevimentoDigitale`
in particolare ha comportamento ancora poco chiaro, verificato solo in
parte: con CF reale e flag `false` → errore esplicito "Ritiro digitale
richiesto... Avviso di Ricevimento digitale è obbligatorio"; con flag
`true` e destinatario senza email in anagrafica → torna comunque
NullReferenceException generico (ipotesi non confermata: manca un
contatto digitale — `Email` su `InfoIndirizzoExt`, aggiunta ma non ancora
testata con un valore reale — a cui recapitare l'avviso). Osservato anche
che un CF con checksum non valido ("inventato", non solo un CF reale mai
esistito) sembra produrre lo stesso NullReferenceException indipendentemente
dal flag `AvvisoRicevimentoDigitale` — ipotesi: GlobalCom valida/processa il
CF solo per Servizio Agol, un checksum invalido manda in crash quel path
invece di restituire un errore applicativo.

**Confermato con test reale (invio accettato, Stato=Accettato):** la causa
di entrambi gli errori era il `CodiceFiscale` sul destinatario — GlobalCom
lo usa (solo per Servizio Agol) per verificare un domicilio digitale e
richiedere/proporre il ritiro digitale, che questo Comune non vuole mai
usare via GlobalCom per Atto Giudiziario (nessun caso d'uso reale).
`postal.strategy.ts` ora omette `codiceFiscale` sul destinatario quando
`servizio.startsWith('Agol')`, mantenendolo per gli altri Servizio
(Raccomandata/Lettera, dove non risulta causare problemi). `Email` su
`InfoIndirizzoExt` resta comunque valorizzata quando disponibile (innocua,
non richiesta senza CF).

**WebFetch sul WSDL GlobalCom non è affidabile su nomi enum/campi al primo
giro** — una query ha restituito `AttoGiudiziarioBusiness`/`AttoGiudiziarioMarket`
(mai esistiti), il valore reale è `AgolBusiness`/`AgolMarket` (enum
`ServiceType`). Prima di scrivere codice che dipende da un nome di
campo/enum, rifare una seconda WebFetch mirata proprio su quell'enum/tipo
per confermare, non fidarsi del primo riassunto (stesso principio già in
nota per il manuale POSTAL/SEND sopra).

**Nessuna operazione di annullamento/cancellazione invio nel WSDL
GlobalCom** — inventario completo delle 61 operazioni verificato
(`invio_ext_singolo`, `AutorizzaLottoInvio`, `account_*`, ecc.): l'unica
azione "annulla invio in preparazione" vista sul portale GlobalCom è solo
UI loro, non esposta via API — non automatizzabile da questo codebase.

**Un nuovo metodo SOAP ASMX: `<nomeMetodo>Result` è SEMPRE il booleano di
esito, MAI il wrapper dati.** Bug reale (`listaRiaccodamentiDocumento`):
leggeva `result.lista_riaccodamenti_documentoResult.string` assumendo che
il wrapper `ArrayOfString` vivesse lì — invece quel campo è `true`/`false`
(stessa convenzione di `dettagli_documentoResult`/`invio_ext_singoloResult`),
i dati sono sempre in `Risposta`. `.string` su un booleano è `undefined`
senza errore — ricadeva silenziosamente sul solo IDPRO originale anche con
un riaccodamento reale presente, zero log/eccezioni. Verificato dal vivo
contro GlobalCom prod (Montesilvano) con IDPRO reale. Per ogni nuovo
metodo SOAP: dati sempre da `Risposta`, mai dal campo `<metodo>Result`.

**Script di debug per interrogare GlobalCom a mano su un IDPRO reale**:
`apps/backend/src/debug/globalcom-dettagli-documento.js` — replica a mano
login+cookie di sessione+`dettagli_documento` senza passare da nest
build/dist (decripta la password del provider POSTAL attivo dal DB dev,
stesso pattern già noto per testare IDPRO reali assenti dal DB dev). Uso:
`docker compose exec backend node src/debug/globalcom-dettagli-documento.js <IDPRO>`.
Due gotcha già presi a mazzate una volta, incorporati nello script: (1)
`LoginAsync` vuole `user`/`password`/`group` minuscoli inglesi — nomi
diversi producono un `NullReferenceException` generico, non un errore di
auth leggibile; (2) la sessione dopo Login è un **cookie HTTP**
(`set-cookie` nella risposta), non un token nel payload — senza
riapplicarlo con `client.addHttpHeader('Cookie', ...)` ogni chiamata
successiva torna `CodiceErrore "0401" "NOK: Login"` anche con credenziali
corrette. `apps/backend/src/debug/` è escluso da `.dockerignore`
(`apps/backend/src/debug`) — mai finire nell'immagine, anche se `tsc`
(nessun `allowJs`) non lo compilerebbe comunque. Qualunque futuro script
di debug backend va in questa cartella, stesso trattamento.

**`StatoConsegna` vuoto è a volte un dato mancante lato GlobalCom stesso,
non un bug nostro.** Verificato dal vivo con lo script di debug sopra su 3
IDPRO reali (`RaccomandataMarket4`, sia esteri che italiani, spediti 5+
giorni prima): `dettagli_documento` risponde `Stato: Confermato` con
`StatoConsegna: ""` per tutti e tre, costo già dettagliato (documento
realmente stampato/spedito) — non un problema di parsing/salvataggio né di
round-robin del cron, il dato non c'è proprio lato GlobalCom. Ipotesi
iniziale "succede solo per indirizzi estero" confutata dal terzo IDPRO
(italiano, stesso esito). Prima di sospettare un bug nostro su questo
sintomo, verificare con lo script contro IDPRO reali — se `StatoConsegna`
torna vuoto anche da loro, è un problema esterno (stesso tipo già noto per
l'errore `-1`), segnalare a supporto GlobalCom con gli IDPRO, nessuna
azione lato codice possibile.

## Frontend admin — mai `<form>` annidate

La pagina Impostazioni avvolge tutte le tab in un'unica `<form
onSubmit={handleSaveSettings}>`. Un pannello di editing dentro una tab
(es. CRUD provider) non può usare un proprio `<form onSubmit={...}>`:
HTML non valido, il browser instrada il submit sulla form esterna
(bug reale: "Salva" su un pannello interno riportava alla home invece
di salvare). Usare `<div>` + bottone con `onClick` esplicito per
qualunque pannello di editing dentro una tab di Impostazioni.

## Allegati e co-consegna App IO — gotcha

**Wizard: due punti separati costruiscono `channelConfig`, vanno tenuti allineati.**
`buildWizChannelConfigDraft()` (bozza) è già channel-agnostic per `secondaryChannels`;
`handleWizLaunch()` (lancio reale) costruisce `channelConfig` per-branch,
un ramo per canale. Bug reale: aggiungendo co-consegna App IO a POSTAL, la
bozza la salvava correttamente ma `handleWizLaunch()` non la scriveva affatto
per quel canale (il blocco `secondaryChannels` viveva solo dentro il ramo
`EMAIL`/`PEC`) — la campagna partiva senza App IO nonostante la UI la
mostrasse configurata. Ogni nuovo campo channel-agnostic in `buildWiz...Draft`
va replicato anche in `handleWizLaunch`, non solo nell'uno o nell'altro.

**Stesso bug, altre due istanze reali: `attachments` e `wizSingleMode`
mancanti in `handleWizLaunch`.** `campaigns.service.ts` fa **replace
completo** di `channelConfig` sul PATCH (`if (dto.channelConfig !==
undefined) campaign.channelConfig = dto.channelConfig`, nessun merge) —
quindi un ramo di `handleWizLaunch` che dimentica un campo lo CANCELLA
dalla campagna già sincronizzata in bozza, non lo lascia semplicemente
invariato. Bug reale #1: i branch POSTAL e SEND non includevano
`attachments: wizAttachments` (a differenza di EMAIL/PEC/APP_IO che ce
l'hanno) — l'allegato già sincronizzato in bozza spariva al lancio,
bloccando con "allegato obbligatorio" nonostante l'anteprima (che legge lo
stato client `wizAttachments`, non ancora sovrascritto) lo mostrasse
correttamente. Bug reale #2: nessun branch impostava
`wizSingleMode` — `campaigns.service.ts` legge
`isWizSingleMode = channelConfig['wizSingleMode'] === true` per decidere
se saltare il check INAD bulk (pensato solo per campagne CSV, mai per un
destinatario singolo); assente, un invio singolo veniva trattato come
bulk e INAD ha dirottato una raccomandata POSTAL su PEC a sua insaputa.
Fix: `channelConfig.attachments = wizAttachments` in ogni branch che lo
richiede, `channelConfig.wizSingleMode = wizSingleMode` sempre,
incondizionatamente, per qualunque canale.

**Terzo punto di sync, oltre ai due sopra: il lifecycle del wizard stesso.**
Un nuovo stato `wiz*` legato a `channelConfig` (es. `wizPecReserveMailConfigId`)
va anche azzerato in `resetWizard()` e ripristinato in `prefillWizardFrom()`
— altrimenti il valore di una campagna trapela silenziosamente sulla
successiva (mai azzerato) o si perde riprendendo una bozza/duplicando
(mai ripristinato dal `channelConfig` salvato).

**POSTAL: `channelConfig.body`/`subject` NON sono il contenuto reale inviato.**
La lettera cartacea viene generata dagli allegati (PDF), non da un body HTML
come per EMAIL/PEC — `PostalStrategy.send()` non legge mai `channelConfig.body`.
Di conseguenza la co-consegna App IO su POSTAL non può fare fallback al body
del canale primario (sarebbe vuoto/non pertinente): la differenziazione
oggetto/testo App IO è forzata sempre per POSTAL (checkbox "Differenzia"
nascosta, campi sempre obbligatori nel wizard).

**Etichetta allegato dinamica per destinatario.** `AttachmentConfigEntry` ha
un campo opzionale `labelColumn`: se impostato, l'etichetta effettiva va letta
riga per riga da `recipient.extraData[labelColumn]` tramite
`resolveAttachmentLabel(entry, recipient)` (`attachment.service.ts`), MAI
leggendo `.label` direttamente — sono ~8 punti diversi (email/pec/app-io
strategy, notification.processor, protocollazione.processor, citizen.service,
campaigns.service preview/dettaglio) che costruiscono `attachmentLabels`: un
nuovo punto che dimentica di passare il `recipient` specifico produce
un'etichetta sempre fissa, ignorando silenziosamente la colonna scelta.

**Fallback legacy senza mappatura allegati esplicita.** Se una campagna non
ha né `channelConfig.attachments` né `allegatoKey` (campagne vecchie, o mai
configurate a step3), `resolveCustomAttachmentFilename()`
(`attachment.service.ts`) scansiona `extraData` e usa il primo valore che
termina in `.pdf`, con etichetta fissa "Documento principale.pdf"
(`processTemplate`, `template.helper.ts`). Qualunque UI che mostri "quali
allegati sono attesi" leggendo solo `channelConfig.attachments` (es.
`wizAttachments` nel wizard) deve replicare lo stesso fallback, altrimenti
mostra "nessun allegato" per campagne che in realtà ne inviano uno — bug
reale corretto nell'anteprima PDF di step6.

**Allegato obbligatorio per SEND e POSTAL — bloccato in UI e backend.**
Per questi due canali l'allegato È il contenuto notificato (atto legale /
lettera), non un corredo opzionale al body come per EMAIL/PEC/APP_IO. Il
wizard blocca "Procedi" allo Step3 senza almeno un allegato mappato;
`CampaignsService.launch()` ripete lo stesso controllo lato server (pattern
200 + `{blocked:true}`, vedi gotcha proxy sopra — mai eccezione non-2xx qui).

**`AttachmentService.generatePdfBuffer` non genera più un PDF segnaposto.**
Se nessun file custom risolve per l'indice richiesto (config assente o file
mancante su disco), lancia `NotFoundException` — niente più fallback silenzioso
con logo/dati generici che mascherava configurazioni rotte. Impatta anche
`public-download.controller.ts` (propaga come 404 al citizen) e i job
(`postal.strategy.ts`, `send-dispatch.service.ts`, `protocollazione.processor.ts`)
dove ora un allegato mancante fa fallire esplicitamente l'attempt invece di
spedire un documento fittizio.

## Nuova dependency in un costruttore — audit spec esistenti

Aggiungere un parametro al costruttore di un Controller/Service rompe
silenziosamente ogni spec file che lo istanzia manualmente con `new X(a,
b)` altrove nel repo — TypeScript lo segnala solo se quello spec file
viene compilato, e `jest <pattern-mirato>` non tocca spec non correlati.
Bug reale: fase INAD aggiunge `InadService` al costruttore di
`SettingsController`, `settings.controller.spec.ts` (3 istanziazioni
dirette) resta rotto per settimane — scoperto solo eseguendo la suite
COMPLETA (`jest --maxWorkers=2`, non un pattern) durante un task
successivo non correlato. Dopo ogni modifica a una firma di costruttore,
lanciare la suite intera prima di dichiarare la baseline pulita.

## TypeORM — leftJoinAndSelect + orderBy + take, bug interno

TypeORM 0.3.30 lancia `Cannot read properties of undefined (reading
'databaseName')` in `createOrderByCombinedWithSelectExpression` quando
`take()`+`orderBy()` sono combinati con `leftJoinAndSelect()` su relazioni
dichiarate per stringa (`@ManyToOne('Campaign', ...)`, pattern usato in
tutte le entity di questo repo per evitare import circolari). Il bug è
silenzioso nei log di produzione (una riga di errore ogni tick cron, senza
stack trace) — un demone `@Cron` che lo colpisce non processa MAI nulla,
senza errori visibili all'avvio. Workaround: due query separate — la prima
(senza join) seleziona solo gli id con `where`/`orderBy`/`take`, la seconda
carica le relazioni via `Repository.find({ where: { id: In(ids) },
relations })`, senza `orderBy`/`take`. Vedi `protocollazione-sync.service.ts`
e `send-dispatch.service.ts`.

## Query paginata destinatari — subquery EXISTS va ancorata a recipient_id, non DISTINCT ON

`CampaignsService.getRecipientsPage()` faceva scansione full-table con
`DISTINCT ON` per calcolare l'ultimo tentativo per destinatario — su
campagne grandi (migliaia di righe) niente indice utile. Fix: subquery
`EXISTS` ancorata direttamente a `recipient_id` (scan indice, non
full-table), più indici dedicati (migration
`AddRecipientAndAttemptIndexes`): `recipients(campaign_id, status)` e
`notification_attempts(recipient_id, attempt_number, send_status,
postal_status, postal_delivery_status)`. Qualunque nuova query paginata
su `Recipient`/`NotificationAttempt` con filtro/ordinamento va verificata
con `EXPLAIN` per lo stesso pattern prima di aggiungerla, non assumere che
un indice esistente coincida per colonna d'ordine.

## Side-effect su NotificationAttempt dopo l'invio — solo in notification.processor.ts

Le `*Strategy.send()` (`postal.strategy.ts`, `send-dispatch.service.ts`...)
ritornano solo un `ChannelSendResult`, nessun accesso ad `attemptRepo` —
qualunque scrittura sull'attempt subito dopo un invio riuscito (es.
`postalTrackingId`, stato iniziale) va fatta in `notification.processor.ts`,
l'unico layer che chiama `attemptRepo.update()` dopo aver ricevuto il
risultato della strategy. Un design doc ha assunto una volta che questo
andasse nella strategy stessa — sbagliato, verificato solo leggendo il
codice reale, non lo spec di progettazione.

## Stato business null vs attempt fallito pre-provider — gotcha

Per i canali con stato business esterno (`sendStatus`/`postalStatus`, SEND
via PN, POSTAL via GlobalCom), un attempt fallito PRIMA di raggiungere il
provider (`AttemptStatus.FAILED`, mai un IUN/IDPRO assegnato) lascia quel
campo a `null` per sempre — indistinguibile da "non ancora processato" in
barre di stato e CSV export, a meno di controllare esplicitamente
`attempt.status === AttemptStatus.FAILED` e sovrascrivere con un valore
sentinella (es. `'FAILED'`) prima di passare il valore a label/breakdown.
Bug reale corretto su `getSendStatusBreakdown`/`getSendReportRows`/
`getPostalStatusBreakdown`/`getPostalReportRows` (`campaigns.service.ts`) —
replicare lo stesso controllo per ogni nuovo canale che aggiunge un
breakdown/report basato sullo stato esterno.

## INAD — override canale per-recipient, gotcha critico

`NotificationAttempt.channelType` è la fonte di verità sul canale REALE di
un destinatario, non `campaign.channelType` — un override INAD (domicilio
digitale trovato) lo dirotta a PEC anche se la campagna è EMAIL/POSTAL/
APP_IO, scrivendolo sull'attempt al momento della creazione. Qualunque
punto che re-instrada/riprova/riporta "per canale" deve leggere
`attempt.channelType` (o l'ultimo attempt del destinatario), MAI
`campaign.channelType` — 3 bug reali corretti nella stessa giornata per
questo esatto errore: `protocollazione.processor.ts` (re-accodava sul
canale di campagna dopo la protocollazione, vanificando il dirottamento),
`retryRecipient()` (stesso errore su un retry manuale), `getSendStageCounts()`
(filtrava `attempt.channel_type = campaign.channelType`, escludendo i
dirottati dal widget "Stato Protocollazione" — sembravano mai protocollati
anche quando lo erano).

**Quarta istanza trovata in sessione successiva**: `getRecipientStats()`
(lista "Destinatari Caricati") filtrava allo stesso modo su
`channelType: campaign.channelType` — un dirottato mostrava sempre "—" su
protocollo/iun/stato consegna anche quando il dato esisteva davvero in DB.
Query su attempt per "ultimo tentativo per destinatario" non deve MAI
filtrare su channelType, punto.

**Priorità tra override**: se un destinatario è dirottato da INAD, l'App IO
esclusiva (che salterebbe il canale primario) viene declassata a parallela
SOLO per quel destinatario — INAD è fonte di verità assoluta sul domicilio
digitale, non bypassabile da un'esclusiva App IO (`notification.processor.ts`).

`Recipient.inadCheck.found` (INAD ha trovato un domicilio) ≠ `.diverted`
(l'indirizzo trovato è REALMENTE diverso da quello già configurato — per
una campagna PEC con indirizzo INAD coincidente, `found:true` ma
`diverted:false`, non è un vero dirottamento). Le decisioni di
instradamento/reporting vanno sempre su `diverted`, mai su `found` da solo.

## Matrice comportamenti campagne per canale — fonte di verità

Riferimento completo, verificato contro il codice (non contro il manuale):
[`docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`](docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md).
Consultare PRIMA di modificare comportamento canale/INAD/App IO
secondaria/protocollo/allegato — evita di reintrodurre un caso già
verificato o di romperne uno esistente.

Riassunto (dettaglio riga-per-riga nel file linkato):

| Canale | App IO secondaria | INAD | Protocollo | Allegato |
|---|---|---|---|---|
| EMAIL | none/parallela/esclusiva¹ | sì → `channelType`=PEC + `recipient.pec`=indirizzo INAD | opzionale | opzionale |
| PEC | none/parallela/esclusiva¹ | sì, se PEC INAD diversa → solo `recipient.pec` sovrascritto (stesso canale) | opzionale | opzionale |
| POSTAL | none/parallela/esclusiva¹ | sì → `channelType`=PEC + `recipient.pec`=indirizzo INAD (skip stampa) | opzionale | **obbligatorio** |
| APP_IO | n/a | sì → `channelType`=PEC (skip invio App IO) | opzionale | opzionale |
| SEND | n/a (`isMailChannel` esclude SEND) | n/a (PN risolve da sé) | **obbligatorio** | **obbligatorio** |

¹ esclusiva → declassata a parallela per singolo destinatario se `diverted:true` (INAD vince sempre).

Se aggiungi un nuovo canale, un nuovo asse (es. verifica toponomastica
POSTAL, oggi non implementata) o cambi una di queste regole: aggiorna
PRIMA il file linkato, poi il codice — è la fonte di verità che evita di
dover rileggere 5 file diversi per capire "cosa succede se combino X con Y".

## Arricchimento tracciati

Feature `apps/backend/src/enrichment/` (+ vista admin "Arricchimento
Tracciati"): carica uno ZIP formato Maggioli (`rubrica.csv`/`pag_indice.csv`
+ `allegati/`), estrae indirizzo postale e dati PagoPA dai PDF via il
microservizio Python `services/pdf-extractor/` (FastAPI + PyMuPDF/pyzbar,
containerizzato, **raggiungibile solo sulla rete interna Docker**
`http://pdf-extractor:8000` — nessuna porta pubblicata verso l'host, non
esposto dal reverse proxy), produce un CSV arricchito scaricabile.

**Coda dedicata, non il meccanismo `EngineName`/`ENGINE_QUEUES`.** A
differenza dei motori di invio (PEC/Email/SEND/...), l'arricchimento usa una
propria coda BullMQ (`ENRICHMENT_QUEUE`, `enrichment-job.types.ts`) con
proprio processor (`enrichment.processor.ts`) — non è un canale di notifica
né un "motore" nel senso di `EnginesController`, quindi non compare nella UI
Motori e non partecipa a pausa/riprendi condivisi. Riusa comunque lo stesso
pattern verificato altrove: stato terminale (`DONE`/`FAILED`) scritto
PRIMA di uscire dal job, mai un job che finisce silenziosamente in stato
intermedio.

**`deleteJob` NON blocca su stato `PROCESSING`** (deviazione deliberata dal
pattern altrove in questo repo, dove un blocco su stato intermedio è la
norma). Un job rimasto bloccato in `PROCESSING` (es. backend riavviato a
metà job) non ha altrimenti alcuna via d'uscita da UI: retention lo
esclude sempre, e non può essere riconvertito in bozza campagna. Endpoint
già `@Roles('admin')`-only — l'eliminazione forzata è la valvola di sfogo,
non un bug.

**Upload sempre chunked**, mai un multipart diretto — stesso vincolo del
proxy esterno ~1MB descritto sopra: `POST
/admin/enrichment/upload/{init,chunk,complete}`, chunk client-side,
riassemblati lato server prima di processare lo ZIP.

**Retention**: `enrichment.retentionDays` (default 30, chiave in
`settings.registry.ts`) — job e file (ZIP sorgente, CSV/ZIP risultato)
più vecchi vengono ripuliti da `EnrichmentRetentionService`, stesso
pattern di retention già usato per le campagne.

**"Crea bozza campagna" non è un importer parallelo.** Il pulsante sul job
completato scrive il CSV arricchito su disco come `draft_recipients.csv` e
imposta `wizCsvFilename` sulla campagna bozza creata — il wizard (`view
=== 'invio-massivo-wizard'`) lo rileva e precarica quel file allo Step 2
esattamente come una ripresa bozza normale (`handleResumeDraft`),
riusando le stesse validazioni CF/email/mappatura colonne del percorso
wizard standard. Nessun bypass di quelle validazioni, coerente con la
regola "creazione campagne — un solo percorso" sopra.

**Rate multiple PagoPA — classificazione via etichetta, mai ordine pagina.**
`pdf_extractor.py` scansiona TUTTE le pagine con QR pagamento (non solo la
prima) e classifica ciascuna leggendo il testo: `RATA UNICA` → totale,
`N° RATA` → rata N (il numero nell'etichetta determina l'ORDINAMENTO delle
rate, non la posizione pagina — alcuni documenti non hanno la pagina "rata
unica", altri hanno solo quella). **Attenzione**: le rate ordinate vengono
poi compattate per POSIZIONE nelle colonne CSV `rataN_*`, non per numero-
etichetta-esatto — un piano con un buco nella numerazione (solo "2° RATA"
e "3° RATA", manca "1°") produce `rata1_*`=2°rata/`rata2_*`=3°rata, non
`rata2_*`/`rata3_*` con `rata1_*` vuota. Deviazione nota e accettata (caso
raro, piani rateali quasi sempre contigui da 1). Il CSV di output ha
quindi un header dinamico per job: colonne
`rataN_numero_avviso/importo/scadenza` quante ne servono (max trovato tra
i record del job), calcolate da `buildEnrichedCsvHeaders()`
(`enriched-csv.util.ts`) — non più una costante fissa. Controlli di
coerenza (somma rate vs totale, scadenze consecutive, unica≈prima rata)
producono warning, mai bloccanti.

**`pdf_extractor.py` — indirizzo (regex testo) e pagamento (QR code) sono
estrazioni indipendenti sullo stesso PDF, un fallimento non blocca l'altra.**
L'indirizzo usa un pattern testuale (`"Residente in:"`) via testo pagina;
il pagamento decodifica il QR embeddato (`_extract_payment_from_page_qr`,
payload `PAGOPA|002|<numero_avviso>|<cf_ente>|<centesimi>`). Una riga con
warning "Indirizzo non estratto" può avere comunque numero_avviso/importo
già corretti — verificare quale delle due estrazioni è fallita prima di
assumere che l'intera riga vada corretta a mano.

**`numero_avviso`/`numero_avviso_alternativo`: il PDF (QR) vince sempre sul
CSV del tracciato** (`enrichment.processor.ts`, `row.numero_avviso =
result.payment.totale.numero_avviso || rec.csvNumeroAvviso`) — il CSV Maggioli
può avere un valore disallineato dal vero IUV stampato (verificato dal vivo:
QR scansionato manualmente ≠ colonna CSV), il CSV resta solo fallback per
righe senza dati pagamento estratti dal PDF. L'indirizzo fa l'opposto (CSV
vince, PDF solo se `csvAddress` assente) — non generalizzare una priorità
all'altra, sono decisioni indipendenti per campo.

**Formato riga `rubrica.csv` (tracciato Maggioli) per costruire ZIP di test:**
`id;pec@pec.it;;NOME;COGNOME;CODICE_FISCALE;;NOMINATIVO;numeroProvvedimento;
dataEmissione;Oggetto;;;nomeFile.pdf` (14 campi `;`-separati, vedi
`parseRubricaPec` in `maggioli-parser.ts`) — un file `allegati/nomeFile.pdf`
mancante per una riga produce deliberatamente il warning "PDF non trovato nel
ZIP", utile per riprodurre scenari di correzione manuale senza dati reali.

**Log live job (SSE) — bridge in-memory, valido a singola istanza.**
`GET admin/enrichment/jobs/:id/stream` inoltra in tempo reale gli eventi
che `EnrichmentProcessor` emette via `EnrichmentEventsService`
(`EventEmitter` per jobId) man mano che elabora ogni riga — funziona solo
perché worker BullMQ e HTTP server girano nello stesso processo Node
(un solo servizio `backend`, nessun worker separato). Se il backend scala
a più repliche in futuro, va sostituito con Redis pub/sub — non fatto ora
(YAGNI). Il frontend NON usa `EventSource` nativo (non supporta header
`Authorization`): legge lo stream via `fetch()` +
`response.body.getReader()`, parsing manuale delle righe `data: ...\n\n`.
Nessuna persistenza lato backend — è un log live, non uno storico (i
warning finali restano su `EnrichmentJob.warnings` come sempre).

**adm-zip — "Unknown descriptor format" non è (necessariamente) un file
corrotto.** Un'entry ZIP scritta con **data descriptor** (general purpose
bit 3, sizes nell'header locale assenti, valori dopo i dati compressi) può
far fallire `entry.getData()` di `adm-zip@0.5.18` con `"Unknown descriptor
format"` — limite noto della libreria nel riconoscere il descriptor
(verificato dal vivo: il PDF estratto standalone dallo stesso entry era un
`%PDF-1.4` perfettamente valido, `%%EOF` finale incluso). Non trattarlo
come sintomo di corruzione del file/PDF prima di aver verificato lo stream
isolato. **Ogni punto che itera entry di uno ZIP arricchimento deve avere
un try/catch PER-ENTRY** — bug reale: `EnrichmentProcessor.
processConvertCampaign` iterava tutti i PDF senza try/catch, un solo entry
illeggibile bloccava l'intera conversione di migliaia di destinatari,
mentre `processEnrich` già gestiva lo stesso caso con un warning per-riga.
Stesso fix applicato anche a `EnrichmentService.buildResultZip` (stesso
pattern, stesso rischio).

**PDF scompattati su disco una volta sola (mai più AdmZip su source.zip a
valle).** `EnrichmentProcessor.processEnrich` scompatta ogni PDF valido su
`allegati/` (cartella piatta, `getEnrichmentAttachmentsDir()`) nello stesso
passaggio in cui già legge l'entry per l'estrazione (`entry.getData()`
chiamato una sola volta, riusato sia per l'estrattore Python sia per la
scrittura su disco, con `basename()` sul filename da CSV prima di scrivere
— dato caricato dall'operatore, non fidato per costruire un path) — poi
cancella `source.zip` a fine job **riuscito** (mai su FAILED: un
resume/retry deve poterlo rileggere). `buildResultZip`/
`processConvertCampaign` leggono solo da `allegati/`, mai più `new
AdmZip(source.zip)` a valle — elimina il re-parsing ripetuto di uno ZIP
fino a 500MB in 3 punti diversi e la classe di bug sopra in due di quei tre
punti. **Gap noto**: nessun meccanismo di resume/recovery per
`campaignConversionStatus` bloccato in `processing` (es. backend
riavviato/redeploy a metà copia) — a differenza dello stato principale del
job (`EnrichmentResumeService`), un `campaignConversionStatus` stallato
oggi richiede intervento manuale in DB, nessuna valvola di sfogo da UI.

**Badge/stato "corretto" solo client-side ottimistico — verificare che il
fallback da server dichiarato nel commento esista davvero, non fidarsi.**
Bug reale: `enrichCorrectedPdfs` (badge "Corretto" su riga con override
indirizzo salvato) settato solo al salvataggio riuscito in sessione — un
commento nel codice dichiarava "al refresh torna a leggersi da row.override
via GET" ma nessun endpoint bulk lo faceva, solo GET per singola riga
on-demand al click "Correggi indirizzo". Dato restava sempre corretto in DB
(`enrichment_address_overrides`), solo il badge spariva a ogni
remount/refresh del pannello "Avvisi". Fix: `GET
admin/enrichment/jobs/:id/overrides`, letto all'apertura del pannello per
riconciliare stato locale con DB. Pattern generale: uno stato React
Set/flag "visivo" con commento che promette un fallback server-side va
grep-verificato sul setter effettivo, mai dato per buono dal commento.

## Liste e pannelli con stato lato server — nessun refresh automatico globale

Non esiste un meccanismo generale (websocket/SSE) che push-aggiorna la UI
quando lo stato di una campagna cambia lato server (worker BullMQ) — l'unica
eccezione è il log live job di Arricchimento Tracciati (SSE dedicato, vedi
sopra). Qualunque lista/pannello che mostra stato potenzialmente in corso
deve avere il proprio `useEffect` con `setInterval` — bug reale corretto:
dashboard "Attività Recenti", elenco "Campagne Massive" e vista Statistiche
fetchavano una volta sola (al login o all'ingresso vista) e restavano fermi
su "In coda" anche a campagna completata, finché l'operatore non ricaricava
la pagina manualmente. Il dettaglio campagna aveva già un polling da 3s ma
solo per l'oggetto `campaign` principale, non per i pannelli di breakdown/
statistiche/destinatari (fetchati una sola volta al click) — un nuovo
pannello nel dettaglio campagna va aggiunto anche al polling esistente, non
solo al caricamento iniziale.

Stessa istanza trovata anche fuori dal dettaglio campagna: il modale
"Dettaglio Notifica" (`openNotificationDetail`, apribile dalla ricerca
notifiche globale) fetchava una volta sola all'apertura — lo stato di un
singolo tentativo (es. "In corso" → "Consegnato") restava fermo finché non
si ricaricava tutto il sito. Fix: `useEffect` con `setInterval` (3s) che
rilegge silenziosamente (nessun reset a `null`/loading, per non far
sfarfallare/richiudere il modale già aperto) finché resta aperto.

**Il gate sullo `status` campagna può fermare il polling troppo presto per
canali con tracking di consegna asincrono (SEND/POSTAL).** Il polling del
dettaglio campagna si fermava non appena `campaign.status` passava a
`completed` — ma per SEND/POSTAL il completamento è deciso a livello di
submission (tutti gli attempt hanno un esito terminale), mentre
`sendStatus`/`postalStatus` (consegna a valle) continuano ad aggiornarsi
per giorni via demoni separati. Bug reale: l'elenco messaggi restava fermo
all'ultimo stato di consegna visto al completamento — fix: continuare il
polling anche a `status==='completed'` quando `channelType` è `SEND` o
`POSTAL`.

**Tabella destinatari (dettaglio campagna) — un solo trigger per fetch, mai
sia `useEffect` reattivo sia chiamata esplicita sullo stesso cambio
stato.** `fetchRecipientsPage()` ha parametri con default = stato React
corrente (`page = recipientsPageNum`, ecc.), per poter essere chiamata
senza argomenti sia dal timer di polling 3s sia da un handler. Serie di 3
bug reali consecutivi sistemando questo: (1) il timer di polling passava i
vecchi valori posizionali invece dei default, duplicando la fetch a ogni
tick; (2) rimuovendo quella duplicazione, cambio pagina/filtro/ordinamento
è stato spostato su un solo `useEffect` con tutte le dipendenze — corretto
in teoria ma la paginazione ha smesso di rispondere in modo affidabile al
click; (3) fix finale: `onClick`/`onChange` di paginazione, filtri e
intestazioni ordinabili chiamano `fetchRecipientsPage(...)` esplicitamente
con i nuovi valori, **oltre** allo `useEffect` che resta come rete di
sicurezza sulle stesse dipendenze — doppia fetch occasionale accettata come
compromesso, preferibile a un click che non aggiorna nulla. Debounce 300ms
mantenuto SOLO sul campo di ricerca testuale libera, mai su
pagina/filtri/ordinamento (0ms, l'operatore si aspetta risposta immediata
al click).

## External API (`external-api/`) — due gotcha reali, non presi dalla suite unit

**Modulo consumato solo internamente prima → serve `exports` esplicito
quando arriva un nuovo consumer esterno al modulo.** `DomicilioModule`
dichiarava `providers: [DomicilioService]` ma nessun `exports` (mai servito
finora: `DomicilioController` lo usava dentro lo stesso modulo).
`ExternalApiModule`, importando `DomicilioModule` per riusare
`DomicilioService` nel nuovo `ExternalDomicilioController`, andava in
crash-loop al boot reale (`docker compose up`) — DI di Nest non risolve un
provider non esportato attraverso un `imports`. Nessuno unit test lo
intercetta: i service spec istanziano `new DomicilioService(...)`
direttamente, bypassando interamente il grafo dei moduli Nest. Fix: aggiungere
`exports: [DomicilioService]` a `DomicilioModule`. Ogni volta che un modulo
esistente guadagna un nuovo consumer esterno (anche se già usato da tempo
internamente), verificare che i provider richiesti siano in `exports` — non
darlo per scontato solo perché funzionava prima.

**`@Post()` di NestJS risponde 201 di default, non 200 — serve
`@HttpCode(HttpStatus.OK)` esplicito su ogni handler POST di `external/v1/*`.**
Il contratto "always 200" per gli endpoint `external/v1/*` (stesso principio
della sezione "Reverse proxy esterno in produzione" sopra) è normalizzato
solo per il path di errore da `ExternalApiExceptionFilter` — un handler che
risponde con successo mantiene lo status HTTP di default di Nest, 201 per
`@Post()`. `ExternalNotificationsController.create()` ed
`ExternalAttachmentsController` (init/chunk/complete) sono partiti senza
`@HttpCode(HttpStatus.OK)` per 11 task, mai scoperto perché ogni unit test
chiamava i metodi controller direttamente e asseriva solo sul corpo della
risposta, mai sullo status HTTP che Nest avrebbe realmente prodotto — emerso
solo con un E2E che boota l'app e fa richieste HTTP vere (task 12). Ogni
nuovo handler `@Post()` sotto `external/v1/*` va annotato esplicitamente,
non assumere che il filtro di eccezioni copra anche il caso di successo.
