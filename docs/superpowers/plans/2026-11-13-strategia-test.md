# Strategia test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere i gap di test individuati: DB/Redis reali in merge queue, migration provate, inventario autorizzazioni, unit frontend, spec backend mancanti, BullMQ reale, copertura, E2E Playwright in release.

**Architecture:** Merge queue = unit (job `run-tests`, invariato) + nuovo job `integration-tests` con Postgres/Redis come service. Release = nuovo job `e2e` Playwright sulle immagini firmate, in parallelo a `smoke`, che blocca `publish` solo se ci sono commit nuovi. Nessun cambio di comportamento del prodotto: scarti e gap in liste `KNOWN_*`.

**Tech Stack:** Vitest 4 + SWC (backend), Vitest (frontend, nuovo), supertest, TypeORM 1.1, BullMQ, `@vitest/coverage-v8`, `@playwright/test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-strategia-test-design.md` — leggerla prima di ogni task.

## Global Constraints

- Tutto in Docker, nessun tool sull'host. Comandi test: sezione Test di `CLAUDE.md`.
- Sulle PR solo lint + type-check: ogni nuovo job/step di test ha `if: github.event_name != 'pull_request'`.
- Action pinnate per SHA, immagini per digest; `harden-runner` su ogni job nuovo.
- Nuove dipendenze: procedura lockfile di `CLAUDE.md` (pnpm da `packageManager`, mai `@latest`), poi reset volume `node_modules` del servizio.
- Test con date/orari verdi con `TZ=UTC` e `TZ=Europe/Rome`.
- Nessun dato reale nelle fixture: `ROSSI MARIO`/`RSSMRA80A01H501U`, `ACME SRL`/P.IVA `12345678903`.
- Nessuna modifica a `docker-compose.yml`.
- Nessun cambio di comportamento del prodotto; ciò che il test trova "sbagliato" va in `KNOWN_GAPS`/`KNOWN_DRIFT` con commento.
- Baseline suite: unico fallimento noto `app.controller.spec.ts` › `isLdapMock`. Ogni task chiude con "failure set identico" più i test nuovi verdi.
- Ogni PR che tocca un workflow o il ruleset aggiorna `docs/ci-cd-security-baseline.md`; ogni nuovo comando di test va nella sezione Test di `CLAUDE.md`.
- Un branch/PR per gruppo come da "Ordine di consegna" della spec; commit su branch, mai su `main`.

## Review Focus

1. **globalSetup che migra il DB dev.** Il container backend dev ha `DATABASE_URL` del DB `synchronize`: eseguirci le migration lo rompe. Il globalSetup agisce solo con `TEST_DB_MIGRATE=1` (impostata solo nel job CI). Test in Task 2.
2. **Inventario route vacuo.** Se la lettura dei metadata fallisce, la tabella è vuota e ogni asserzione passa. Asserire numero di controller scansionati = numero di file con `@Controller(` e presenza di righe note. Test in Task 4.
3. **Test di integrazione che si pestano i piedi** con `maxForks: 2` sullo stesso DB/Redis: transazione con rollback, DB temporaneo o prefisso coda random per test. Test in Task 3 e Task 10.
4. **E2E che cambia esito tra un run e l'altro** (polling, dati condivisi): ogni flusso crea i propri dati con suffisso random; nessun `waitForTimeout`. Verifica in Task 12 (3 run consecutivi verdi).
5. **Segreti o dati negli artifact E2E**: stack con secret random, solo Mailpit; trace/screenshot solo su fallimento, retention 3 giorni. Verifica in Task 13.

---

### Task 1: Lista condivisa entity/migration

**Files:**
- Create: `apps/backend/src/database/schema.list.ts`
- Modify: `apps/backend/src/database/database.module.ts` (import + `entities`/`migrations`), `apps/backend/src/database/data-source.ts`
- Modify (riscrittura): `apps/backend/src/database/database.module.migrations.spec.ts`
- Modify: `CLAUDE.md`, `docs/claude/database-queue.md` (dove dicono di registrare nell'array di `database.module.ts`)

**Interfaces:**
- Produces: `export const ENTITIES: Function[]`, `export const MIGRATIONS: Function[]` da `database/schema.list.ts`.

- [ ] **Step 1: Riscrivere lo spec di registrazione** — `it('ogni migration in migrations/ è in MIGRATIONS')`: legge i nomi `export class (\w+)` dai file di `migrations/` e asserisce `expect(missing).toEqual([])` dove `missing` = nomi non presenti in `MIGRATIONS.map(m => m.name)`. Secondo test `it('ogni entity in entities/ è in ENTITIES')`, stessa logica su `entities/*.entity.ts`.
- [ ] **Step 2: Eseguire** `docker compose exec backend node_modules/.bin/vitest run database.module.migrations` → FAIL (modulo `schema.list.js` assente).
- [ ] **Step 3: Creare `schema.list.ts`** spostando gli import e l'array migration da `database.module.ts`; `ENTITIES` = elenco entity attuale di `database.module.ts` (che include le 4 mancanti in `data-source.ts`). `database.module.ts` e `data-source.ts` usano `ENTITIES`/`MIGRATIONS`.
- [ ] **Step 4: Eseguire** lo spec → PASS; `tsc --noEmit` e `tsc -p tsconfig.spec.json --noEmit` puliti; suite completa: failure set identico.
- [ ] **Step 5: Aggiornare** `CLAUDE.md`/`docs/claude/database-queue.md`: "registrare in `database/schema.list.ts`".
- [ ] **Step 6: Commit** `refactor(db): lista condivisa entity e migration in schema.list.ts`.

### Task 2: Job `integration-tests` + globalSetup

**Files:**
- Create: `apps/backend/vitest.global-setup.ts`
- Modify: `apps/backend/vitest.config.ts` (`globalSetup`)
- Modify: `.github/workflows/tests.yml` (nuovo job), `docs/ci-cd-security-baseline.md`, `CLAUDE.md` (Test)
- Test: `apps/backend/src/database/global-setup.spec.ts`

**Interfaces:**
- Consumes: `ENTITIES`, `MIGRATIONS` (Task 1).
- Produces: `export async function migrateTestDatabase(url: string): Promise<number>` (numero migration eseguite) in `vitest.global-setup.ts`; default export `setup()` che la chiama solo se `process.env.TEST_DB_MIGRATE === '1' && process.env.DATABASE_URL`.

- [ ] **Step 1: Test** `global-setup.spec.ts`: `it('senza TEST_DB_MIGRATE non tocca il DB')` — con `TEST_DB_MIGRATE` assente, `setup()` non chiama `migrateTestDatabase` (spy) anche con `DATABASE_URL` valorizzata. `describe.skipIf(!DATABASE_URL)`: `it('migra un DB vuoto')` — crea `gs_<random>`, `migrateTestDatabase(url)` ritorna `MIGRATIONS.length`, seconda chiamata ritorna `0`, drop del DB.
- [ ] **Step 2: Eseguire** → FAIL (file assente).
- [ ] **Step 3: Implementare** `vitest.global-setup.ts` (DataSource TypeORM con `ENTITIES`/`MIGRATIONS`, `runMigrations()`, `destroy()`); aggiungere `globalSetup: ['../vitest.global-setup.ts']` in `vitest.config.ts`.
- [ ] **Step 4: Eseguire** lo spec nel container dev → PASS; suite completa: failure set identico (il DB dev non viene toccato: verificare con `SELECT count(*) FROM migrations` invariato prima/dopo).
- [ ] **Step 5: Job CI** in `tests.yml`, nome job `integration-tests`, `if: github.event_name != 'pull_request'`, `timeout-minutes: 20`, harden-runner `egress-policy: audit` (come `run-tests`), `services:` `postgres` e `redis` con immagine+digest identici a `docker-compose.yml` e healthcheck (`pg_isready`, `redis-cli ping`). Setup Node/pnpm/install/build shared-types copiati da `run-tests`. Due step:
  - `TZ=UTC` e poi `TZ=Europe/Rome`: `pnpm --filter backend exec vitest run integration parity` con env `DATABASE_URL=postgres://comunicapa:comunicapa@localhost:5432/comunicapa_test`, `REDIS_URL=redis://localhost:6379`, `TEST_DB_MIGRATE=1`.
  - Step di guardia: confronta i digest di `postgres`/`redis` tra `tests.yml` e `docker-compose.yml` (grep + diff), fallisce se divergono.
- [ ] **Step 6: Verifica locale del job**: stesso comando in un container `node` con un Postgres/Redis effimeri (`docker run`, rete dedicata) — i due parity spec risultano eseguiti (non `skipped`) e verdi in entrambi i fusi.
- [ ] **Step 7: Ruleset** — **chiedere conferma esplicita all'utente prima di eseguire.** Poi aggiungere `integration-tests` ai required check del ruleset `25888219` ("main branch"):
  ```bash
  gh api repos/Comune-di-Montesilvano/ComunicaPA/rulesets/25888219 > rs.json
  jq '{name,target,enforcement,conditions,bypass_actors,rules: (.rules|map(if .type=="required_status_checks" then .parameters.required_status_checks += [{"context":"integration-tests"}] else . end))}' rs.json > rs-new.json
  gh api -X PUT repos/Comune-di-Montesilvano/ComunicaPA/rulesets/25888219 --input rs-new.json
  ```
  Eseguirlo **dopo** il merge della PR che introduce il job (prima il check non esisterebbe e bloccherebbe la coda). Verifica: `gh api …/rulesets/25888219 --jq '…context'` contiene `integration-tests`.
- [ ] **Step 8: Docs** — baseline CI/CD (nuovo job, service, required check), `CLAUDE.md` Test (comando integrazione + `TEST_DB_MIGRATE`; la frase "la CI non ha DB" va corretta).
- [ ] **Step 9: Commit** `ci(tests): job integration-tests con Postgres e Redis`.

### Task 3: Test delle migration

**Files:**
- Create: `apps/backend/src/database/migrations.integration.spec.ts`
- Modify: le 3 migration enum con `down()` no-op (`AddCancelledStatus`, `AddCheckingInadStatus`, `AddPendingReviewStatus`) + ogni altra con `down` vuoto/no-op: aggiungere `static readonly irreversible = true`.
- Modify: `docs/claude/database-queue.md` (regole: `irreversible`, `ADD VALUE IF NOT EXISTS`, `KNOWN_DRIFT`)

**Interfaces:**
- Consumes: `ENTITIES`, `MIGRATIONS` (Task 1).

- [ ] **Step 1: Misurare lo scarto reale**: su DB temporaneo migrato, stampare `(await ds.driver.createSchemaBuilder().log()).upQueries.map(q => q.query)`; salvare l'output nella descrizione della PR.
- [ ] **Step 2: Scrivere lo spec** (`describe.skipIf(!process.env.DATABASE_URL)`, DB `migr_<random>` creato in `beforeAll`, droppato in `afterAll`):
  - `it('tutte le migration girano da zero')` → `runMigrations()` ritorna `MIGRATIONS.length` elementi;
  - `it('lo scarto schema/entity coincide con KNOWN_DRIFT')` → `expect(normalize(upQueries)).toEqual(normalize(KNOWN_DRIFT))`, `normalize` = trim, spazi multipli → uno, sort. `KNOWN_DRIFT` = output dello Step 1, ogni voce con commento sul perché;
  - `it('l\'ultima migration è reversibile')` → se `MIGRATIONS.at(-1).irreversible` → `it.skip` con motivo; altrimenti `undoLastMigration()` poi `runMigrations()` ritorna 1 elemento e lo scarto resta `KNOWN_DRIFT`.
- [ ] **Step 3: Eseguire** nel container dev (DB temporaneo sul Postgres dev) con `TZ=UTC` e `TZ=Europe/Rome` → PASS.
- [ ] **Step 4: Verificare che morda**: aggiungere temporaneamente una colonna a un'entity → test scarto FAIL con la query `ALTER TABLE … ADD …` nel diff; ripristinare.
- [ ] **Step 5: Marcare** le migration irreversibili e documentare le regole.
- [ ] **Step 6: Commit** `test(db): migration da zero, scarto schema congelato, reversibilità`.

### Task 4: Inventario sicurezza route + spec guard

**Files:**
- Create: `apps/backend/src/auth/route-security.inventory.spec.ts`
- Create: `apps/backend/src/auth/guards/roles.guard.spec.ts`, `jwt-auth.guard.spec.ts`, `oidc-auth.guard.spec.ts`
- Riuso: logica di scansione di `campaigns/campaign-access.routes.spec.ts` — estrarla in `apps/backend/src/common/testing/controller-routes.ts` se servono le stesse funzioni (no duplicazione) e far usare a entrambi gli spec.

**Interfaces:**
- Produces: `export function listRoutes(): Promise<RouteInfo[]>` con `type RouteInfo = { method: string; path: string; controller: string; handler: string; isPublic: boolean; roles: string[]; guards: string[] }` in `common/testing/controller-routes.ts`.

- [ ] **Step 1: Test inventario**:
  - `it('scansiona tutti i controller')` → numero di classi controller = numero di file `*.controller.ts` con `@Controller(` (escl. spec); tabella non vuota; contiene `GET /admin/campaigns`.
  - `it('le route pubbliche senza guard sono solo quelle ammesse')` → `PUBLIC_ALLOWLIST`: `GET /`, `GET /version`, route di `branding.controller.ts`, login operatore di `auth.controller.ts`, `GET /citizen/auth/config`, `GET /citizen/auth/oidc/start`, `POST /citizen/auth/oidc/callback`, `POST /citizen/auth/login`, `public/download/*`.
  - `it('controller pubblici con guard propria la applicano a ogni handler')` → `CitizenController` tutti con `OidcAuthGuard`; i 4 controller `external/*` tutti con `ApiKeyGuard`.
  - `it('ogni route admin non pubblica ha ruoli')` → eccezioni = `KNOWN_GAPS = ['GET /admin/auth/me']` (commento: token cittadino mock passa, vedi spec "Osservazioni").
  - `it('tabella autorizzazioni')` → `toMatchInlineSnapshot()` di `method path public roles guards`, una riga per route, ordinata.
- [ ] **Step 2: Test guard**: `RolesGuard` — ruoli vuoti → `true`; utente assente con ruoli → `ForbiddenException`; ruolo non ammesso → `ForbiddenException` con messaggio `Ruolo richiesto: admin`; ruolo ammesso → `true`. `JwtAuthGuard` — `@Public` → `true` senza chiamare `super.canActivate` (spy). `OidcAuthGuard.handleRequest` — `err` → rilancia `err`; `user` assente → `UnauthorizedException`; ok → ritorna `user`.
- [ ] **Step 3: Eseguire** → l'inventario fallisce finché lo snapshot non è generato; generarlo con `-u` una volta e **rileggerlo riga per riga** contro i controller prima di accettarlo.
- [ ] **Step 4: Verificare che morda**: togliere temporaneamente `@Roles` da un handler admin → FAIL; aggiungere `@Public()` a un handler admin → FAIL; ripristinare.
- [ ] **Step 5: Commit** `test(auth): inventario autorizzazioni route e spec guard`.

### Task 5: Vitest frontend-admin

**Files:**
- Modify: `apps/frontend-admin/package.json` (devDependency `vitest` stessa versione del backend; script `test`: `vitest run && node scripts/check-guida.mjs`)
- Create: `apps/frontend-admin/vitest.config.ts` (`environment: 'node'`, `include: ['tests/**/*.spec.ts']`), `apps/frontend-admin/tsconfig.test.json` (estende `tsconfig.app.json`, `include: ["tests", "src"]`, `types: ["vitest/globals"]` se si usano globali)
- Create: `apps/frontend-admin/tests/journey.spec.ts`, `send-timeline.spec.ts`, `send-documents.spec.ts`, `guida.spec.ts`
- Modify: lint/type-check CI (`pnpm lint` o step in `tests.yml`) per includere `tsc -p tsconfig.test.json --noEmit`; `CLAUDE.md` Test.

- [ ] **Step 1: Aggiungere la dipendenza** con la procedura lockfile, rebuild, reset volume `comunicapa_admin_node_modules`; `docker compose ps` dopo il `--build`.
- [ ] **Step 2: Test** — per ogni modulo, casi tratti dalle funzioni esportate: `guidaSlug('Problemi frequenti')` → `'problemi-frequenti'` (+ accenti, punteggiatura); `describeSendTimelineEvent` su ogni categoria evento nota e su una sconosciuta; `journey.ts` su notifica Email consegnata, SEND perfezionata, POSTAL in giacenza (oggetti fittizi minimi con i campi letti dal modulo); `send-documents.ts` su etichette documenti.
- [ ] **Step 3: Eseguire** `docker compose exec frontend-admin node_modules/.bin/vitest run` → PASS con `TZ=UTC` e `TZ=Europe/Rome`.
- [ ] **Step 4: Verificare** che la build prod non includa i test: `tsc -p tsconfig.app.json --noEmit` pulito, `pnpm --filter frontend-admin build` ok.
- [ ] **Step 5: Commit** `test(admin): vitest e unit test logica notifiche`.

### Task 6: Vitest frontend-citizen

**Files:**
- Modify: `apps/frontend-citizen/package.json` (`vitest`, script `test`: `vitest run`)
- Create: `apps/frontend-citizen/vitest.config.ts`, `tsconfig.test.json` (come Task 5)
- Create: `apps/frontend-citizen/src/lib/format.ts` (o nomi equivalenti per responsabilità) con le funzioni pure estratte da `App.tsx`
- Create: `apps/frontend-citizen/tests/*.spec.ts`

- [ ] **Step 1: Inventariare** in `App.tsx` le funzioni pure (nessun hook/JSX: formattazione importi/date, mapping stati/etichette).
- [ ] **Step 2: Test** sulle funzioni come sono oggi (scrivere i test importandole dalla nuova posizione) → FAIL per modulo assente.
- [ ] **Step 3: Spostarle** senza modificarne il corpo; `App.tsx` le importa.
- [ ] **Step 4: Eseguire** test (due fusi), `tsc -p tsconfig.app.json --noEmit`, build → ok; smoke manuale portale cittadino col simulatore (lista + dettaglio identici).
- [ ] **Step 5: Commit** `test(citizen): vitest ed estrazione funzioni pure`.

### Task 7: Spec `postal-providers.service`

**Files:**
- Test: `apps/backend/src/postal-providers/postal-providers.service.spec.ts`

- [ ] **Step 1: Test** (repository e `GlobalComClient` mockati, `ConfigService` con `JWT_SECRET` fittizio):
  - `create` → il repo salva credenziali cifrate (≠ testo in chiaro, decifrabili con `decryptValue`); DTO restituito con `MASKED_VALUE`;
  - `listMasked` → nessun campo segreto in chiaro;
  - `update` con `MASKED_VALUE` nel campo segreto → secret invariato; con valore nuovo → ricifrato;
  - `setActive(id, true)` → attiva senza disattivare gli altri (comportamento attuale, commento `KNOWN_GAPS`);
  - `getActive` con due attivi → il più vecchio;
  - `test(id)` successo/fallimento GlobalCom → `{ success, message }`; id inesistente → `NotFoundException`.
- [ ] **Step 2: Eseguire** → PASS (il codice esiste: se un test fallisce, il test descrive male il comportamento: correggere il test, non il codice, e annotare).
- [ ] **Step 3: Verificare che morda**: rimuovere la cifratura in `create` in copia → FAIL.
- [ ] **Step 4: Commit** `test(postal-providers): cifratura, mascheramento, provider attivo`.

### Task 8: Integration controller con file

**Files:**
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification.integration.spec.ts`, `apps/backend/src/remote-sign/signed-attachments.integration.spec.ts`
- Modello: `campaigns/campaigns-uploads-path-traversal.integration.spec.ts`

- [ ] **Step 1: Test** (Nest app reale con controller + guard + pipe, service mockati dove toccano DB/esterni):
  - path traversal: id/filename con `../`, `%2e%2e%2f`, path assoluto → 400/404, nessun accesso fuori dalla cartella prevista;
  - upload oltre `MAX_CHUNK_SIZE_BYTES` → 413;
  - ownership: job creato da operatore A, richiesta di operatore B (ruolo `operator`) → 403/404; admin → consentito (se è il comportamento attuale);
  - nuove funzioni di sanificazione trovate → proprietà in `common/untrusted-input.fuzz.spec.ts`.
- [ ] **Step 2: Eseguire** → PASS; se un caso rivela un buco reale: **fermarsi e segnalarlo all'utente** (sicurezza, non va in `KNOWN_GAPS` in silenzio).
- [ ] **Step 3: Commit** `test(uploads): integration path traversal, limiti e ownership`.

### Task 9: Contratto HTTP controller senza spec

**Files:**
- Test: un `*.controller.spec.ts` accanto a ciascuno di `channels/domicilio/domicilio.controller.ts`, `remote-sign/remote-sign.controller.ts`, `postal-providers/postal-providers.controller.ts`, `io-services/io-services.controller.ts`, `templates/templates.controller.ts`, `audit-logs/audit-logs.controller.ts`

- [ ] **Step 1: Test** per ogni handler, con supertest su app Nest e service mockato: status code atteso (attenzione `@Post` → 201 salvo `@HttpCode`), body inoltrato al service, DTO invalido → 400 con `ValidationPipe` configurata come in `main.ts`.
- [ ] **Step 2: Eseguire** → PASS; suite completa failure set identico.
- [ ] **Step 3: Commit** `test(controllers): contratto HTTP dei controller senza spec`.

### Task 10: BullMQ su Redis reale

**Files:**
- Test: `apps/backend/src/queue/notification-queue.integration.spec.ts`

- [ ] **Step 1: Test** (`describe.skipIf(!process.env.REDIS_URL)`; code BullMQ create direttamente con `prefix: 'test-<random>'`; `obliterate({ force: true })` + `close()` in `afterAll`):
  - `it('stesso jobId → un solo job')` → due `addBulk` con `jobId` = stesso `attemptId` → `getJobCounts()` totale 1;
  - `it('protocollazione: retry fino a fallimento')` → coda `PROTOCOLLAZIONE_QUEUE` con `{ ...PROTOCOLLAZIONE_JOB_OPTIONS, attempts: 2, backoff: { type: 'fixed', delay: 50 } }`, worker che lancia sempre → job `failed` con `attemptsMade === 2`;
  - `OrphanReconciliationService.reconcileEngine` con `NotificationQueuesService` reale sulle code di test e repository mockati che restituiscono candidati più vecchi di 30 min: `queued` senza job → `repaired: 1` e job presente in coda; secondo giro → `repaired: 0`; `processing` senza job → `markedFailed: 1`, nessun job; job `completed` → `markedFailed: 1`;
  - `retryRecipient` → il nuovo job ha `jobId` diverso dal precedente e viene aggiunto (non deduplicato) — se richiede troppi mock, testare il punto in cui genera il nuovo `attemptId`/`jobId` e documentarlo.
- [ ] **Step 2: Eseguire** con Redis dev (`REDIS_URL` del container) → PASS, nessuna chiave `test-*` residua (`redis-cli --scan --pattern 'test-*'` vuoto).
- [ ] **Step 3: Commit** `test(queue): integrazione BullMQ su Redis reale`.

### Task 11: Copertura

**Files:**
- Modify: `apps/backend/package.json`, `apps/frontend-admin/package.json`, `apps/frontend-citizen/package.json` (devDependency `@vitest/coverage-v8`, stessa versione di `vitest`)
- Modify: `vitest.config.ts` dei tre (`coverage: { provider: 'v8', reporter: ['text-summary', 'html'] }`)
- Modify: `.github/workflows/tests.yml` (step `run-tests`: `--coverage`; upload artifact `coverage-*`, `retention-days: 7`, solo merge queue)

- [ ] **Step 1: Dipendenze** con procedura lockfile, rebuild, reset volumi.
- [ ] **Step 2: Eseguire** `vitest run --coverage` in ogni container → summary stampato, nessun fallimento nuovo, tempo della suite backend aumentato < 30% (misurare prima/dopo).
- [ ] **Step 3: Commit** `ci(tests): report di copertura`.

### Task 12: Pacchetto E2E Playwright

**Files:**
- Create: `e2e/package.json` (`@comunicapa/e2e`, `private: true`, devDependency `@playwright/test`), `e2e/playwright.config.ts`, `e2e/docker-compose.e2e.yml`, `e2e/global-setup.ts`, `e2e/tests/operator-email-campaign.spec.ts`, `e2e/tests/citizen-pf-pg.spec.ts`, `e2e/tests/settings-secret.spec.ts`, `e2e/fixtures/`, `e2e/README.md`
- Modify: `pnpm-workspace.yaml` (aggiungere `e2e`), `CLAUDE.md` (come lanciare gli E2E)

**Interfaces:**
- Produces: `playwright.config.ts` legge `ADMIN_URL`, `CITIZEN_URL`, `API_URL`, `MAILPIT_URL` da env; tag `@phase1`/`@phase2` sul flusso 3. Comando: `npx playwright test --grep-invert @phase2` poi `--grep @phase2`.

- [ ] **Step 1: Stack** — `docker-compose.e2e.yml` aggiunge solo `mailpit` (immagine pinnata per digest, `MP_SMTP_AUTH_ACCEPT_ANY=1`, `MP_SMTP_AUTH_ALLOW_INSECURE=1`, porta API 8025). Env stack: secret random, `LDAP_HOST=mock`.
- [ ] **Step 2: globalSetup** — login `admin`/`admin` via API, `POST /admin/mail-configs` verso `mailpit:1025` come default, svuota Mailpit (`DELETE /api/v1/messages`).
- [ ] **Step 3: Flusso 1** `operator-email-campaign.spec.ts`: login UI → wizard canale Email → CSV 3 righe fittizie con suffisso run → lancio → polling stato campagna via API fino a completata (timeout 120 s) → Mailpit `GET /api/v1/search?query=<suffisso>` = 3 messaggi, oggetto senza segnaposto `{{`.
- [ ] **Step 4: Flusso 2** `citizen-pf-pg.spec.ts`: setup via API di una campagna con destinatario CF `RSSMRA80A01H501U` e destinatario P.IVA `12345678903` (colonna `codice_fiscale`); simulatore cittadino come PF → solo notifica del CF; come impresa (checkbox "per conto di un'impresa") → solo quella della P.IVA.
- [ ] **Step 5: Flusso 3** `settings-secret.spec.ts`: `@phase1` salva una mail-config con password → UI mostra valore mascherato; `@phase2` (dopo `docker compose restart backend` lanciato dal runner) → "Test connessione" riuscito.
- [ ] **Step 6: Eseguire in locale** sullo stack di prod di prova (`docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml -p e2e --env-file <env> up -d`, mai il progetto `comunicapa`), Playwright nel container `mcr.microsoft.com/playwright:<versione>-noble`: **3 run consecutivi verdi**; poi `down -v`.
- [ ] **Step 7: Commit** `test(e2e): pacchetto Playwright con 3 flussi`.

### Task 13: Job `e2e` in `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml` (output `code_changed` in `setup`; job `e2e`; `publish.needs`)
- Modify: `docs/ci-cd-security-baseline.md`, `docs/claude/ci-cd-deps.md`

**Interfaces:**
- Consumes: pacchetto `e2e/` (Task 12); `scripts/smoke-stack.sh` pattern di avvio stack.
- Produces: output `setup.outputs.code_changed` = `'true'` se tag, se `rebuild_latest` manuale, o se almeno un'app ha causa *a* (commit su main) nel controllo cause; `'false'` altrimenti.

- [ ] **Step 1: `code_changed`** — in `setup`, step mode: `true` per tag e dispatch manuale; nel ramo schedule derivarlo da `rebuild-check.sh` (aggiungere all'output dello script `code_changed=true|false` = esiste una causa *a*). Test dello script: `node --test`/bats esistenti in `scripts/security/test/` se coprono `rebuild-check.sh`, altrimenti verifica con `dry_run=true`.
- [ ] **Step 2: Job `e2e`** — `needs: [setup, build-push]`, `if: needs.setup.outputs.skip != 'true' && needs.setup.outputs.code_changed == 'true'`, `timeout-minutes: 30`, harden-runner `egress-policy: block` con allowlist = quella di `smoke` + `mcr.microsoft.com:443`, CDN di mcr (ricavarli dal primo run in `audit`), `registry.npmjs.org:443`. Steps: avvio stack come `smoke` con override e2e e progetto `-p e2e`; `@phase1`; `docker compose … restart backend`; attesa `/api/version`; `@phase2`; upload artifact `playwright-report` solo `if: failure()`, `retention-days: 3`; `down -v` in `always()`.
- [ ] **Step 3: `publish`** — `needs: [setup, smoke, e2e]` con condizione che accetta `e2e` `skipped` (es. `if: always() && needs.smoke.result == 'success' && (needs.e2e.result == 'success' || needs.e2e.result == 'skipped') && needs.setup.outputs.skip != 'true'`).
- [ ] **Step 4: Verifica** — `actionlint` sul workflow; dopo il merge: `gh workflow run release.yml --ref main -f dry_run=true` (solo cause, mostra `code_changed`), poi `-f rebuild_latest=true` → job `e2e` eseguito e verde, `publish` eseguito. Documentare che `release.yml` si collauda solo su `main`.
- [ ] **Step 5: Docs** — baseline (nuovo job, allowlist, dipendenza di `publish`), `ci-cd-deps.md`.
- [ ] **Step 6: Commit** `ci(release): job e2e Playwright prima di publish`.

---

## Fuori da questo piano

Fix decisi nella spec, da pianificare a parte: blocco irreversibile del mock auth per istanza (`system.authRealSeen`) e controllo `type === 'operator'` in `JwtStrategy.validate`.
