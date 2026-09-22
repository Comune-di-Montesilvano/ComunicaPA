# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ComunicaPA — HUB open-source per la trasmissione asincrona di comunicazioni massive della Pubblica Amministrazione (TARI, avvisi, sanzioni) su canali multipli: PEC, Email, App IO, SEND, Postalizzazione.

## Architecture

**pnpm workspaces monorepo.** Tutto gira in Docker — nessun tool installato in locale (Node/pnpm non richiesti sull'host).

```
apps/backend/          NestJS 12 (ESM) + TypeScript — API REST, worker BullMQ (porta 8080)
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

**Il volume può risultare stale anche SENZA aver aggiunto una dipendenza** — un semplice `docker compose up -d --build` su un checkout rimasto fermo a lungo può far ripartire un container con `MODULE_NOT_FOUND`/`Cannot find module` su pacchetti già presenti nell'immagine appena buildata (visto dal vivo: `frontend-admin` su `vite`, `backend` su `bullmq`). Stesso fix di sopra: `docker compose rm -sf <servizio> && docker volume rm comunicapa_<nome>_node_modules && docker compose up -d --build <servizio>`.

**`docker compose up -d --build <un-solo-servizio>` può far ripartire ANCHE
un servizio sibling non toccato dal comando**, con lo stesso
`MODULE_NOT_FOUND` da volume stale se pure il suo volume è vecchio
(container su da giorni) — visto dal vivo: rebuild di solo
`frontend-admin` ha fatto ripartire e crash-loopare `backend`. Controllare
`docker compose ps` dopo ogni `--build` mirato, non solo il servizio
appena ricostruito.

Stesso path-mangling anche su `docker compose exec <servizio> cat /path/assoluto`
(non solo `-v`): prefissare `MSYS_NO_PATHCONV=1` a qualunque comando che passa
un path unix assoluto come argomento a un container da Git Bash Windows.

**Attenzione worktree/checkout paralleli — `docker-compose.yml` ha `name: comunicapa` fisso in cima al file.** Qualsiasi `docker compose` lanciato da QUALSIASI checkout/worktree di questo repo (anche una cartella diversa dalla principale) punta agli **stessi container condivisi** — non crea uno stack isolato, anche passando porte/env diversi. Un `docker compose up` da un worktree può silenziosamente ricreare in-place i container dev del checkout principale, ricollegandoli al codice del worktree (incidente reale già capitato). Se serve lavorare da un worktree/checkout secondario: **mai `docker compose`**, usare `docker run`/`docker exec` diretti sui container/volumi named già esistenti, es.:

```bash
# Test/tsc contro il codice del worktree, senza toccare lo stack principale
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/apps/backend/src:/app/apps/backend/src" \
  -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" \
  -v comunicapa_backend_node_modules:/app/node_modules \
  -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/vitest run

# Migration contro un DB temporaneo, sul container postgres già in esecuzione
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
docker exec -e DATABASE_URL="postgresql://comunicapa:<password>@postgres:5432/migration_test" comunicapa-backend-1 node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

**`git checkout <ref> -- .` — mai per "ispezionare"/confrontare, cancella lavoro non committato.**
Sovrascrive SIA index SIA working tree per ogni path che differisce, in
TUTTO il repo — non solo il file che si intendeva guardare. Su un branch
feature con modifiche non committate (anche già `git add`), questo le
cancella silenziosamente senza conferma, comprese quelle su file mai
toccati dal branch/ref confrontato (incidente reale: ha cancellato 4 fix
non committati invece di limitarsi al file previsto). I commit già fatti
restano al sicuro (comando non tocca la history) — recuperabili con
`git checkout HEAD -- .`, ma il lavoro solo in working tree/index no. Per
confrontare con un altro branch senza rischio: `git diff <ref> -- <path>`
(sola lettura) o `git stash` esplicito prima di qualunque `checkout -- .`.

**subagent-driven-development su questo repo — mai `isolation:"worktree"` per gli implementer se il lavoro deve andare dritto su `main`.** Un subagent con worktree isolato committa su un branch/checkout separato (`.claude/worktrees/...`) — se poi lo si rimuove, il report scritto dal subagent nella working directory sparisce con esso (bug reale: report ricostruito a mano dal riassunto restituito). Per lavoro diretto su main, dispatchare i subagent SENZA `isolation`, verificare poi con `git log --oneline -1 && git branch --show-current` che il commit sia finito dove atteso.

**`.superpowers/sdd/` è scratch condiviso tra TUTTI i piani eseguiti nel repo, non per-piano.** Nomi file generici (`task-N-brief.md`/`task-N-report.md`) vengono sovrascritti da esecuzioni diverse — un report letto da lì può essere residuo di un piano precedente non correlato (bug reale: report Task 1 riletto per il review conteneva il riepilogo di un task di tutt'altro piano). Verificare sempre che il contenuto corrisponda al task atteso prima di fidarsene per una review.

## Test

```bash
# Suite backend (Vitest — maxForks:2 già impostato in vitest.config.ts, niente flag da passare)
docker compose exec backend node_modules/.bin/vitest run

# Test singolo/focalizzato
docker compose exec backend node_modules/.bin/vitest run <pattern>

# Type-check backend (solo src/, esclude gli *.spec.ts)
docker compose exec backend node_modules/.bin/tsc --noEmit

# Type-check backend INCLUSI gli *.spec.ts (SWC/Vitest non type-checkano gli spec — serve questo per coprirli)
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit

# Type-check frontend (NON usare `tsc -b`: fallisce nel container dev per
# errori @types/node preesistenti che non riproducono nel build prod)
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit

# Token operatore admin per testare le API senza login LDAP (solo dev)
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

**Baseline:** 1 fallimento noto pre-esistente (`app.controller.spec.ts`, `isLdapMock` — artefatto di `LDAP_HOST=mock` in dev), il resto della suite pulito. Il criterio per una modifica resta "failure set identico" al prima — se emerge un nuovo fallimento oltre a questo, è una regressione, non baseline nota.

**Test rapido di un endpoint autenticato senza frontend**: nessun `curl` nel container backend — usare `node -e` con `fetch()` verso `http://localhost:8080/...` e il token JWT generato con lo snippet sopra. Utile per lanciare/testare una campagna reale da riga di comando durante il debug.

**E2E chunked-upload via script Node standalone**: per testare end-to-end un endpoint che usa `chunked-upload.util.ts` (init/chunk/complete) serve chunking client-side reale — rispettare `MAX_CHUNK_SIZE_BYTES`, un chunk singolo troppo grande dà 413 silenzioso lato test, non un errore ovvio. Script con `fetch`+`FormData` nativi, JWT dallo snippet sopra, lanciato con `docker compose exec backend node /app/apps/backend/script.mjs` (deve vivere sotto `/app`, non `/tmp`, per la risoluzione moduli `node_modules`) e `MSYS_NO_PATHCONV=1` per gli argomenti path assoluti da Git Bash Windows.

**Simulare un crash reale del backend per test (es. resume da checkpoint) — `docker kill` è bloccato dal classificatore di sicurezza di Claude Code.** Usare `docker compose restart backend`: il container non gestisce `SIGTERM` (nessun `enableShutdownHooks`), quindi il processo termina comunque bruscamente — stesso effetto pratico di un crash vero per testare codice di recovery, senza permessi distruttivi.

**Test pdf-extractor (pytest) — deps NON nell'immagine dev, CI non le esegue.** `Dockerfile.dev` installa solo `requirements.txt` (prod), non `requirements-dev.txt`; `tests.yml` non gira affatto la suite Python. Per lanciarla: `docker cp services/pdf-extractor/requirements-dev.txt comunicapa-pdf-extractor-1:/svc/` + `docker cp services/pdf-extractor/tests comunicapa-pdf-extractor-1:/svc/tests` + `docker compose exec pdf-extractor pip install -r requirements-dev.txt` (una tantum, persiste finché il container non viene ricreato), poi `docker compose exec pdf-extractor python -m pytest tests/ -v`. Baseline: 1 fallimento noto pre-esistente (`test_extract_address_foreign_cap_embedded_in_street`), verificato anche su `main` pulito — non è una regressione.

**Debug estrazione PDF/CSV reale fornito dall'utente**: `unzip -j <zip> "allegati/<file>.pdf" -d <scratch>` per estrarre un singolo file, `docker cp` dentro il container `pdf-extractor` (o `backend` per rubrica.csv/CSV), poi script Python/Node ad-hoc via `docker exec ... python -c "..."` per dumpare testo pagina/campi prima di scrivere un fix — verificare SEMPRE sul dato reale prima di ipotizzare la struttura da un riassunto o da un solo esempio. Pulire sempre i file temporanei dal container/host a fix completato.

**Mai copiare valori reali dumpati (nome/CF/PIVA/PEC/email) in una fixture di test — nemmeno "solo per riprodurre la struttura del bug".**
Quando si debugga un PDF/CSV reale fornito dall'utente, il testo dumpato va SEMPRE anonimizzato prima di incollarlo in una fixture — mai copiato verbatim. Ogni fixture che riproduce un bug trovato su un documento reale va scritta con dati fittizi (stesso pattern già in uso altrove nel file: `ROSSI MARIO`/`RSSMRA80A01H501U`, `ACME SRL`); il filename del documento (`DOC_NNNNNN_NNNNN.pdf`) non è PII e può restare come riferimento in un commento.

**PyMuPDF (`fitz`) `get_text()` senza `sort=True` scrambla l'ordine di lettura su PDF multi-colonna.** Bug reale: un avviso con "1° RATA"/"2° RATA" affiancate sulla stessa pagina restituiva il testo in ordine "2° RATA" PRIMA di "1° RATA" — regex che cercano il primo match (prima rata, prima scadenza) prendevano il dato sbagliato senza errore visibile. Per qualunque testo PDF con possibile layout a colonne (side-by-side), usare `get_text(sort=True)` o verificare l'ordine con un dump diretto prima di scrivere regex posizionali.

## Configurazione runtime (settings in DB)

`.env` contiene SOLO bootstrap (porte, postgres, secret, LDAP, `CITIZEN_ORIGIN`). Da `CITIZEN_ORIGIN` il backend deriva i link email/PEC (`<origine>/api/...`) e la Redirect URI OIDC — chiavi registry `system.*` marcate `bootstrapOnly`: risolte solo env→default, mai DB né UI. Tutto il resto (branding, SMTP, PEC, App IO, SEND, OIDC, retention) vive nella tabella `app_settings` — si configura dalla UI admin (menu Impostazioni). `AppSettingsService.get()` risolve cache→DB→env→default; i secret sono cifrati AES-256-GCM con chiave derivata da `JWT_SECRET` (cambiarlo = reinserire i secret da UI). Chiavi e fallback env: `apps/backend/src/settings/settings.registry.ts`.


## Documentazione dettagliata

Il resto delle note (gotcha, incidenti reali, pattern verificati) è
spezzettato per argomento sotto `docs/claude/` — auto-caricato da Claude
Code via `@import`. Consultare il file pertinente prima di toccare quella
parte di codice.

- @docs/claude/ci-cd-deps.md — CI/CD (workflow, protezione main, release/tag), Dependabot bump a scaglioni
- @docs/claude/build-toolchain.md — pnpm v11 in Docker, `@comunicapa/shared-types` dual build CJS/ESM, backend NestJS v12 ESM, audit costruttori/spec
- @docs/claude/database-queue.md — Migration DB/enum Postgres, Redis AOF, TypeORM select/relations e leftJoinAndSelect bug, query paginate destinatari
- @docs/claude/bullmq-jobs.md — pattern jobId=attemptId, riconciliazione job orfani, dedup BullMQ, cron round-robin, side-effect post-invio
- @docs/claude/campaigns-wizard.md — ownership campagne, operator_directory, placeholder template, wizard sync bozza/Recipient, routing INAD per canale
- @docs/claude/attachments-appio.md — allegati obbligatori SEND/POSTAL, co-consegna App IO, etichetta dinamica
- @docs/claude/enrichment.md — Arricchimento Tracciati (ZIP Maggioli, pdf-extractor, merge multi-ZIP, resume)
- @docs/claude/send-pn.md — SEND: autenticazione PN (PDND + x-api-key), stati notifica (sendStatus)
- @docs/claude/postal-globalcom.md — POSTAL: GlobalCom SOAP (login, invio, stato, Agol, script debug)
- @docs/claude/anpr-inad-registro.md — ANPR C002, INAD, Registro Imprese (stato impresa, encoding XML)
- @docs/claude/pades-signature.md — verifica firma digitale PDF (PAdES) con node-forge
- @docs/claude/external-api-module.md — `external-api/` — exports moduli Nest, `@HttpCode` su POST
- @docs/claude/http-proxy-perf.md — reverse proxy esterno (limite body/HTML error), event loop bloccato, multer diskStorage
- @docs/claude/observability.md — log debug/verbose, audit log, Sentry/GlitchTip
- @docs/claude/frontend-ui.md — registro canali/loghi, CSS gotcha, formattazione importi, form non annidate, polling stato server

## Topologia API — gotcha

Le route operatore sono segmentate sotto `admin/*` (`admin/campaigns`, `admin/settings`, `admin/auth`, `admin/notifications-search`...), quelle cittadino sotto `citizen/*` (`citizen/auth`, `citizen/notifications`...). Restano bare solo `public/download/*` e le route di root (`/version`, `/branding`). In produzione il nginx di ogni frontend proxya `/api/` verso `backend:8080` **strippando il prefisso** (same-origin, niente CORS, backend mai esposto dal proxy esterno). In dev il browser chiama direttamente `http://localhost:8080`. `API_BASE` arriva a runtime da `/config.js` (dev: `public/config.js`; prod: generato dall'entrypoint nginx da `API_BASE`, default `/api`); il frontend admin usa `ADMIN_API_BASE = \`${API_BASE}/admin\`` per tutte le chiamate autenticate operatore.

## TypeScript

`tsconfig.base.json` alla root impone strict mode completo. Ogni app estende questa base. Il backend aggiunge `experimentalDecorators` e `emitDecoratorMetadata` (richiesti dai decorator NestJS).

Il pacchetto `@comunicapa/shared-types` si importa con `workspace:*` — non pubblicato su npm, risolto internamente da pnpm.

## Variabili d'ambiente

Solo le variabili sistemistiche/di bootstrap passano da `.env` (vedi sezione "Configurazione runtime" sopra per tutto il resto). Il `docker-compose.yml` non ha valori hardcoded, solo `${VAR:-default}` — `DATABASE_URL` e `REDIS_URL` le costruisce il compose dagli hostname interni (`postgres`, `redis`). Vedere `.env.example` per la lista completa con documentazione inline.

Obbligatorie in produzione (`:?` nel compose): `JWT_SECRET`, `DOWNLOAD_LINK_SECRET`.

`POSTGRES_PASSWORD` SOLO caratteri alfanumerici: il compose la incastra in `DATABASE_URL` senza escaping — `$ @ # ^` rompono il parsing dell'URL e il backend prova a connettersi a un host sbagliato (es. `0.0.0.48`).

**Nuova env var backend = va aggiunta ANCHE al blocco `environment:` di `docker-compose.yml`, non solo a `configuration.ts`/`.env.example`.** Bug reale trovato in E2E manuale: `LDAP_ADMIN_USERNAMES` letta correttamente in `configuration.ts` e valorizzata in `.env`, ma assente dal blocco `environment:` del servizio `backend` — il container non la riceve affatto (nessun errore, `process.env['LDAP_ADMIN_USERNAMES']` è `undefined` in silenzio, fallback al default). Il compose non fa passthrough automatico di tutte le var di `.env`: ogni var letta da `configuration.ts` deve avere una riga esplicita `NOME_VAR: ${NOME_VAR:-default}` nel servizio `backend` di `docker-compose.yml`, altrimenti resta invisibile al processo Node anche se presente in `.env` e anche dopo un `docker compose restart` (serve comunque `docker compose up -d backend` per far ripartire il container con l'`environment:` aggiornato, il `restart` da solo non rilegge il compose).

**CORS backend hardcoded su `localhost:3000`/`3001` (`main.ts` `enableCors`).** Se `ADMIN_PORT`/`CITIZEN_PORT` in `.env` cambia dal default, il browser blocca ogni fetch **senza alcun log lato backend** — sintomo "non riesco a fare login" con nessun errore leggibile né in console rete lato server. Fix: riportare la porta al default, oppure valorizzare `ADMIN_ORIGIN`/`CITIZEN_ORIGIN` in `.env` (già letti da `main.ts`, non documentati in `.env.example`).

