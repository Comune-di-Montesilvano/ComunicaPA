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

## Label/loghi/badge canali — sempre dal registro centralizzato

Label, colore, badge, logo (Data URI SVG) e icona di ogni canale/tipologia (EMAIL, PEC, APP_IO, SEND, POSTAL, PROTOCOLLAZIONE, INAD...) sono definiti **una sola volta per frontend**, mai duplicati in un punto isolato del JSX:

- `frontend-admin`: `apps/frontend-admin/src/data/channels.ts` (`CHANNELS_REGISTRY`, `EMBEDDED_LOGOS`, `getChannelMeta()`, `channelLabel()`, `ENGINE_LABELS`). Usare sempre `getChannelMeta(channel)` o `EMBEDDED_LOGOS.<CANALE>` — mai un'altra label/colore/logo hardcoded per un canale già presente lì (nav sidebar, badge, intestazioni pagina, select, tabelle). Stesso principio per gli stati condivisi (`STATUS_META`, `SEND_STATUS_META`, `POSTAL_STATUS_META` in `App.tsx`).
- `frontend-citizen`: `CHANNEL_META`/`EMBEDDED_LOGOS` in cima a `App.tsx` (copia indipendente, non condivisa con l'admin — due bundle separati, ognuno con la propria unica fonte di verità). Usare sempre `CHANNEL_META[canale]`/`ChannelBadge`, mai un'label/logo hardcoded altrove nel file.

Per aggiungere un canale o cambiarne label/colore/logo, modificare solo il registro di quel frontend: si propaga ovunque senza dover cercare copie sparse (vedi commit `e4dc41e` che ha eliminato 3 copie duplicate della stessa mappa in admin). Se un canale esiste in entrambi i frontend, aggiornare entrambi i registri — non sono sincronizzati automaticamente.

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

**Gating navigazione tab:** `wizMaxReachedStep` (più alto step raggiunto)
+ snapshot `wizLastSyncedHeaders`/`wizLastSyncedMapping` (presi solo al
sync 3→4, quando la mappatura è confermata) determinano se un tab-step
oltre lo step 3 è cliccabile in avanti — solo se CSV/mappatura non sono
cambiati dall'ultimo sync. Il tab bar esistente (`App.tsx` "Steps
Progress Header") permetteva SOLO click all'indietro prima di questa
modifica — non dare per scontato che un salto in avanti "funzioni già".

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
