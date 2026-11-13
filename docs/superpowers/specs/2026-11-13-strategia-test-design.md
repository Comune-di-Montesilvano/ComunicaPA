# Strategia test — gap e integrazioni

Data: 2026-11-13 · Stato: bozza da approvare (rivista dopo builder check)

## Perché

La suite backend (167 spec Vitest) copre bene la logica di dominio, ma i
rischi che arrivano davvero in produzione stanno nei punti non coperti:

- **migration** mai eseguite prima del deploy (dev = `synchronize`, CI senza DB);
- **test su Postgres reale** scritti ma sempre saltati in CI
  (`describe.skipIf(!DATABASE_URL)`, il job `run-tests` non ha servizi);
- **autorizzazione delle route** affidata a decorator (`@Public()`, `@Roles`)
  senza un controllo che ne fissi lo stato;
- **frontend** senza alcun test (`frontend-citizen`: `echo 'no tests'`);
- **nessun flusso end-to-end** verificato in automatico: login, wizard,
  invio, portale cittadino si provano a mano.

Obiettivo: chiudere questi buchi con il minimo di infrastruttura nuova,
riusando i pattern già presenti nel repo.

## Obiettivi

1. I test su DB reale girano in merge queue.
2. Ogni migration viene eseguita da zero in merge queue e lo scarto tra
   schema da migration e schema da entity è misurato e congelato: nuovo
   scarto = test rosso.
3. Un nuovo endpoint pubblico o senza ruolo non entra in `main` senza una
   modifica esplicita a un test.
4. La logica pura dei frontend ha unit test.
5. 3 flussi E2E browser girano sulle immagini di produzione prima della
   pubblicazione di una release.
6. Il comportamento BullMQ critico (dedup jobId, retry, orfani) è
   verificato contro Redis reale.
7. I file backend più grossi senza spec ne ottengono una.
8. La copertura è visibile (report), non bloccante.

## Non-obiettivi

- Portare la copertura a una soglia numerica.
- Testare `App.tsx` dell'admin (19.6k righe) a livello di componente: si
  testa la logica estratta e il resto via E2E. Lo split di `App.tsx` è
  un lavoro separato.
- E2E sui canali con fornitori esterni reali (PEC, App IO, SEND,
  GlobalCom, ANPR, INAD): restano mock negli unit test.
- Sostituire gli unit test esistenti.
- **Cambiare comportamento del prodotto.** I test documentano il
  comportamento attuale; scarti di schema, gap di autorizzazione o
  invarianti mancanti trovati qui finiscono in liste `KNOWN_*` commentate
  e diventano lavori separati.

## Anti-obiettivi (fallimento anche se "funziona")

- E2E instabili (flaky) che bloccano la merge queue o il rilascio: un E2E
  che fallisce a caso viene ignorato e poi disattivato.
- PR sensibilmente più lente: sulle PR restano lint + type-check.
- Qualunque dato reale (CF, PEC, indirizzi) nelle fixture.
- Credenziali reali (GlobalCom, PDND, App IO) caricate dagli E2E o dalla
  CI: lo stack E2E parte da DB vuoto, nessun `app_settings` reale.

## Vincoli

- Tutto in Docker; nessun tool sull'host.
- CI: sulle PR solo lint/type-check; build e test completi in merge queue
  (`tests.yml`, `if: github.event_name != 'pull_request'`). Le nuove
  verifiche seguono la stessa regola.
- Action GitHub e immagini pinnate per SHA/digest, `harden-runner`
  (baseline `docs/ci-cd-security-baseline.md`, da aggiornare se cambia un
  workflow, un ruleset o un'allowlist di egress).
- Nuove dipendenze (`vitest` nei frontend, `@vitest/coverage-v8`,
  `@playwright/test`): procedura lockfile da CLAUDE.md (pnpm da
  `packageManager`, poi reset volume `node_modules`).
- Test date/orari: devono passare con `TZ=UTC` e `TZ=Europe/Rome`.
- Prod = podman rootless: nessuna modifica a `docker-compose.yml` serve a
  questo lavoro.

## Approcci considerati

**A. Tutto in `tests.yml` (merge queue).** Postgres/Redis e E2E nello
stesso job, con stack dev. L'E2E richiede build di 4 immagini dev a ogni
merge (lento) e non prova le immagini che vanno in prod.

**B. Livelli separati (scelto).** Merge queue: unit + integrazione su
Postgres/Redis reali + migration + inventario route + frontend unit.
Release: E2E Playwright sulle immagini firmate appena buildate, prima del
`publish`. Un E2E rotto blocca la pubblicazione di `latest` come oggi lo
smoke.

**C. E2E nightly separato.** Workflow cron che builda e testa.
Scollegato dal rilascio: un E2E rosso non impedisce a `latest` di uscire.

Scelta: **B**. Limite noto: un E2E rotto emerge al rilascio, non al merge.

## Design

### 1. Postgres e Redis nella merge queue

`services:` `postgres` e `redis` con le **stesse immagini e digest** di
`docker-compose.yml`, in un job dedicato solo merge queue (D1): i service
container partono per l'intero job a prescindere dagli `if:` degli step,
quindi su `run-tests` rallenterebbero le PR.

Env dello step test: `DATABASE_URL=postgres://…@localhost:5432/comunicapa_test`,
`REDIS_URL=redis://localhost:6379`.

**Schema prima della suite.** Il DB del service è vuoto, e i parity spec
esistenti fanno `INSERT` su `campaigns`/`recipients`/
`notification_attempts` senza creare lo schema
(`campaign-access.parity.spec.ts:28-40`, `legal-attention.parity.spec.ts:65-90`).
Un `globalSetup` Vitest, attivo solo con `DATABASE_URL`, esegue tutte le
migration (lista condivisa, punto 2) sul DB di test una volta prima della
suite. Così i test di integrazione girano sullo schema di produzione, non
su quello di `synchronize`.

Regola: i test su DB lavorano in transazione con rollback (pattern già in
uso) oppure su un database dedicato creato e distrutto dal test; mai dati
che sopravvivono al test, perché la suite gira con `maxForks: 2`.

Due fusi solo per i test di integrazione (glob `*.integration.spec.ts`,
`*.parity.spec.ts`): un secondo step con `TZ=Europe/Rome` su quel glob.
La suite completa resta a UTC.

### 2. Test delle migration

**Lista condivisa.** Estrarre entity e migration in
`database/schema.list.ts` (`ENTITIES`, `MIGRATIONS`), importato da
`database.module.ts`, `data-source.ts` e dai test. Oggi `data-source.ts`
manca di 4 entity (`ExternalApiClient`, `PostalAuthorizedUser`,
`AgidTrustListCache`, `SignatureVerificationJob`, `data-source.ts:30`):
`migration:generate` può proporre DROP. La lista condivisa lo chiude.

`database.module.migrations.spec.ts` oggi parsa il sorgente di
`database.module.ts` con una regex: va riscritto per confrontare la
cartella `migrations/` con l'array `MIGRATIONS` importato (stessa
garanzia, niente parsing). Aggiornare CLAUDE.md e
`docs/claude/database-queue.md` ("registrare nell'array di
database.module.ts" → `schema.list.ts`).

Nuovo spec `database/migrations.integration.spec.ts`
(`skipIf(!DATABASE_URL)`):

1. crea un database temporaneo `migr_<random>`;
2. `DataSource` con `ENTITIES` e `MIGRATIONS`;
3. `runMigrations()` da zero → nessun errore;
4. **scarto di schema congelato**: `driver.createSchemaBuilder().log()`
   → le `upQueries` normalizzate (spazi, ordine) devono coincidere con
   una lista `KNOWN_DRIFT` nello spec. Ne fanno già parte con certezza gli
   indici dichiarati solo in migration (`idx_*` di
   `AddRecipientAndAttemptIndexes`, `idx_download_events_recipient_id`,
   `IDX_campaigns_group_id`, `IDX_domicile_verification_jobs_created_by`,
   `IDX_signature_verification_jobs_campaign_id`, l'indice senza nome di
   `enrichment-address-override.entity.ts:12`); il resto si misura al primo
   giro. Una differenza nuova (entity cambiata senza migration o
   viceversa) rende rosso il test; una voce di `KNOWN_DRIFT` sparita
   anche (va tolta dalla lista). Ridurre lo scarto — `@Index` nelle entity,
   `synchronize: false` per indici con `DESC` — è un lavoro separato;
5. **reversibilità dell'ultima migration**: `undoLastMigration()` +
   `runMigrations()` di nuovo, **solo se** l'ultima migration non è
   marcata come irreversibile. Le migration con `down()` no-op (enum:
   `ADD VALUE` non si annulla in Postgres) esportano
   `static readonly irreversible = true` e il test le salta. Regola per le
   nuove: `ALTER TYPE … ADD VALUE IF NOT EXISTS`;
6. drop del database temporaneo in `afterAll`.

### 3. Inventario sicurezza delle route

Nuovo spec `auth/route-security.inventory.spec.ts`, stesso meccanismo di
`campaign-access.routes.spec.ts` (scansione di tutti i `*.controller.ts`
e lettura dei metadata Nest). Per ogni handler calcola:

- percorso + metodo HTTP;
- `public`: `IS_PUBLIC_KEY` su handler o classe;
- `roles`: `ROLES_KEY` effettivo (`getAllAndOverride`: handler vince su
  classe);
- guard extra (`@UseGuards`: `OidcAuthGuard`, `ApiKeyGuard`, …).

Asserzioni:

1. ogni handler `public` senza guard extra è in un'allowlist esplicita:
   oggi `GET /` e `GET /version` (`app.controller.ts`), `/branding*`
   (`branding.controller.ts`), login operatore (`auth.controller.ts`),
   `citizen/auth/*` (config, `oidc/start`, `oidc/callback`, login mock),
   `public/download/*`;
2. i controller `@Public()` con guard propria hanno quella guard su **ogni**
   handler: `CitizenController` → `OidcAuthGuard`; i quattro controller
   `external/*` → `ApiKeyGuard`. Regola per classe, non per prefisso
   (`citizen/auth/*` è pubblico per costruzione);
3. ogni handler `admin/*` non pubblico ha `roles` non vuoto. Oggi l'unica
   eccezione è `GET admin/auth/me` (`auth.controller.ts:19`): parte in
   `KNOWN_GAPS` con commento;
4. snapshot inline della tabella `metodo percorso → public/roles/guard`:
   ogni cambio di autorizzazione appare nel diff della PR.

Più unit test diretti per `RolesGuard`, `JwtAuthGuard`, `OidcAuthGuard`
(oggi senza spec): ruolo mancante → 403, `@Public` bypassa, token
assente → 401, ruoli vuoti → passa (comportamento attuale documentato).

### 4. Unit test frontend

Vitest in `frontend-admin` e `frontend-citizen` (stessa major del
backend), `environment: 'node'`, niente jsdom né Testing Library.

**Posizione degli spec:** cartella `tests/` fuori da `src/`, con
`tsconfig.test.json` proprio. `tsconfig.app.json` include tutto `src`:
spec dentro `src` entrerebbero nel `tsc -b` della build prod. Il type-check
degli spec va aggiunto al lint/type-check CI.

- `frontend-admin`: `journey.ts`, `send-timeline.ts`, `send-documents.ts`,
  `guida.ts` (`guidaSlug`). Esclusi per ora: `chunked-upload.ts` (usa
  `XMLHttpRequest`, servirebbe jsdom o un fake XHR; il percorso è già
  coperto dallo smoke e dall'E2E) e `data/channels.ts` (importa React e
  asset).
- `frontend-citizen`: estrarre da `App.tsx` in moduli `.ts` le funzioni
  pure che già esistono (formattazione importi/date, mapping stati) e
  testarle. Solo estrazione, nessun cambio di comportamento.
- `test` script: `vitest run && node scripts/check-guida.mjs` (admin),
  `vitest run` (citizen). `pnpm test` dalla root li prende già.

### 5. E2E Playwright

Nuovo pacchetto `e2e/` nel workspace (`@comunicapa/e2e`, privato) con
`@playwright/test`.

**Dove gira:** job `e2e` dedicato in `release.yml` (D2, D3). Non dentro
`smoke`: lì `egress-policy: block` ammette solo GitHub/ghcr/Docker Hub
(`release.yml:423-434`) e `timeout-minutes: 15` (`release.yml:419`)
non basta. Container `mcr.microsoft.com/playwright:<versione>-noble`
pinnato per digest, versione allineata a `@playwright/test`.

**Stack:** immagini `:smoke`, `docker-compose.yml`, progetto dedicato.
- `LDAP_HOST=mock` va solo nel file env dello stack (la variabile è già
  nel blocco `environment:` del backend): nessun override per questo;
- override `e2e/docker-compose.e2e.yml` solo per `mailpit`, immagine
  pinnata per digest (nell'override dev oggi è senza tag), con
  `MP_SMTP_AUTH_ACCEPT_ANY=1` e `MP_SMTP_AUTH_ALLOW_INSECURE=1`;
- SMTP configurato via `admin/mail-configs` in un `globalSetup` (DB vuoto,
  nessuna credenziale reale). `inad.checkEnabled` è false di default:
  la campagna Email non si ferma sulla verifica INAD.

**Flussi (prima fase, 3), ognuno con i propri dati:**

1. *Operatore — campagna Email*: login admin → wizard → CSV di 3
   destinatari fittizi → lancio → stato completato (polling API con
   timeout) → Mailpit contiene 3 mail con oggetto e segnaposto espansi.
2. *Cittadino PF e PG*: il setup del test crea via API una campagna con
   un destinatario per CF fittizio e uno per P.IVA fittizia (la P.IVA sta
   nella colonna `codice_fiscale`, `recipientKeyOf`,
   `auth/citizen-claims.ts:46`). Simulatore come persona fisica → vede
   solo la notifica del CF; come impresa → solo quella della P.IVA.
3. *Impostazioni*: salvataggio di una password SMTP → la UI la rimostra
   mascherata → **riavvio backend** → "Test connessione" verso Mailpit con
   AUTH riesce (il secret cifrato con `JWT_SECRET` è ancora decifrabile).
   Il riavvio lo fa il runner, non il container Playwright (niente socket
   Docker montato): il test è diviso in due fasi (`@phase1`, `@phase2`)
   lanciate come due step con `docker compose restart backend` in mezzo.

**Affidabilità:** niente `waitForTimeout`; locator web-first, polling API
con timeout esplicito; dati con suffisso random per run; `retries: 1`
solo in CI; trace + screenshot su fallimento come artifact (retention
breve, nessun dato reale per costruzione). Comando documentato per
lanciarli in locale sullo stack dev.

### 6. BullMQ su Redis reale

Nuovo `queue/notification-queue.integration.spec.ts`
(`skipIf(!REDIS_URL)`), prefisso coda random per test, `obliterate` in
`afterAll`. Le opzioni di default (`attempts: 5`, backoff esponenziale da
40 s, `notification-job.types.ts:30-31`) vanno sovrascritte nel test
(es. `attempts: 2`, backoff fisso 50 ms), altrimenti dura minuti.

Casi:

- due `add` con lo stesso `jobId` (= `attemptId`) → un solo job;
- job che fallisce → retry → stato finale coerente sull'attempt;
- `OrphanReconciliationService`, i tre casi reali
  (`orphan-reconciliation.service.ts:132-213`):
  - attempt `queued` senza job in coda → riaccodato una volta sola;
  - attempt `processing` senza job → FAILED, non riaccodato;
  - attempt con job `failed`/`completed` → FAILED, non riaccodato;
- retry manuale da `retryRecipient()` (campaigns service) con **nuovo**
  `jobId` → non deduplicato.

### 7. Spec mancanti backend

In ordine di rischio:

1. `postal-providers.service.ts` (223 righe): cifratura e mascheramento
   delle credenziali (mai in chiaro nel DTO), `update` con valore
   mascherato non sovrascrive il secret, `test()` con `GlobalComClient`
   mockato, `getActive()` restituisce il **più vecchio** tra gli attivi
   (comportamento attuale: `setActive`/`test()` non disattivano gli altri,
   righe 138-146, 193, 204). Se debba esistere un solo provider attivo è
   una decisione di prodotto separata (`KNOWN_GAPS`).
2. Controller con upload/file: `domicile-verification.controller`,
   `signed-attachments.controller` — integration con supertest sul
   modello di `campaigns-uploads-path-traversal.integration.spec.ts`:
   path traversal, limite dimensione, ownership (operatore A non legge il
   job di B).
3. Contratto HTTP (status code, DTO validati) per `domicilio.controller`
   (solo `POST cerca*`, niente file), `remote-sign.controller`,
   `postal-providers.controller`, `io-services.controller`,
   `templates.controller`, `audit-logs.controller`.

Ogni nuova funzione che trasforma input non fidato aggiunge la sua
proprietà in `untrusted-input.fuzz.spec.ts` (regola esistente).

### 8. Copertura

Nuova dipendenza `@vitest/coverage-v8`. `vitest run --coverage` nel job
merge queue di backend e frontend; `text-summary` nel log, HTML come
artifact (retention 7 giorni). Nessuna soglia.

## Ordine di consegna

PR indipendenti, ognuna verde da sola:

1. Postgres/Redis in CI + `globalSetup` migration + lista condivisa
   `schema.list.ts` (punti 1 e prima parte del 2) — sblocca il resto.
2. Migration test con `KNOWN_DRIFT` (punto 2).
3. Inventario route + spec guard (punto 3).
4. Vitest frontend + primi test (punto 4).
5. Spec backend mancanti (punto 7), anche in più PR.
6. BullMQ integration (punto 6).
7. Copertura (punto 8).
8. E2E Playwright (punto 5) — ultimo perché tocca `release.yml`, che si
   collauda solo con dispatch su `main` dopo il merge.

Ogni PR che cambia un workflow aggiorna
`docs/ci-cd-security-baseline.md`; quelle che cambiano comandi di test
aggiornano la sezione Test di `CLAUDE.md`.

## Decisioni prese

- Test di integrazione eseguiti in due fusi, il resto solo UTC.
- Nessuna soglia di copertura.
- Nessun cambio di comportamento: scarti e gap in liste `KNOWN_*`.
- Migration irreversibili marcate e saltate nel test di reversibilità.
- E2E flusso 3 orchestrato in due fasi dal runner.

## Decisioni dell'utente (2026-11-13)

- **D1 — Job separato.** Postgres/Redis in un nuovo job di `tests.yml`
  (`integration-tests`) che gira solo in merge queue: le PR restano come
  oggi. Il job diventa required check: la modifica al ruleset di `main`
  la fa l'implementazione (via `gh api`), nella stessa PR, dopo conferma
  esplicita prima della chiamata; aggiornare
  `docs/ci-cd-security-baseline.md`. Sulla PR il job risulta saltato
  (stesso schema di `pdf-extractor-tests`, che vale verde). Il job
  `run-tests` continua a eseguire la suite unit; il job nuovo esegue i
  glob di integrazione (`*.integration.spec.ts`, `*.parity.spec.ts`) con
  `DATABASE_URL`/`REDIS_URL`, in UTC e in `Europe/Rome`.
- **D2 — Job `e2e` separato in `release.yml`.** Dopo `build-push`,
  in parallelo a `smoke`; `publish` dipende da entrambi. Allowlist di
  egress propria (in più rispetto a smoke: `mcr.microsoft.com` e CDN,
  `registry.npmjs.org`), timeout proprio. L'allowlist di `smoke` non
  cambia.
- **D3 — L'E2E blocca solo se cambia il codice.** Il job `e2e` gira e
  blocca `publish` quando la release contiene commit nuovi su `main`
  rispetto alla revision di `latest`. Un rebuild solo per patch OS/CVE
  salta l'E2E e passa con il solo smoke. Riusare la logica già presente
  in `release.yml` che distingue la causa del rebuild (commit vs patch
  OS/CVE), non duplicarla.

## Lasciato al builder

- Come tenere allineati i digest Postgres/Redis tra workflow e
  `docker-compose.yml` (step di verifica vs. configurazione Dependabot).
- Struttura dei page object Playwright.
- Forma esatta di allowlist, `KNOWN_GAPS`, `KNOWN_DRIFT`.
- Quali funzioni pure estrarre da `frontend-citizen/App.tsx`.

## Osservazioni emerse (fuori scope, lavori separati)

**Mock auth in produzione.** `LDAP_HOST=mock` abilita admin/admin e il
simulatore cittadino anche con le immagini di produzione: nulla nel codice
lo lega a `NODE_ENV=development` (`auth.service.ts:63`,
`ldap.service.ts:37`, `citizen-auth.controller.ts:24`).

Fix deciso: **blocco irreversibile per istanza**. Al primo avvio con
autenticazione reale (`LDAP_HOST` ≠ `mock`) il backend scrive nel DB un
marcatore (`app_settings`, chiave `system.authRealSeen`). A ogni avvio con
`LDAP_HOST=mock`, se il marcatore esiste il backend rifiuta di partire con
un errore esplicito. Un'istanza che ha visto anche una sola volta l'auth
reale non torna più a mock; un'istanza nata mock (dev, stack E2E effimero)
resta utilizzabile. Limiti accettati: istanza di prod avviata mock fin dal
primo boot non protetta; `down -v` cancella il marcatore; in dev, chi ha
provato l'LDAP reale cancella la riga per tornare a mock. Test: spec sul
bootstrap (marcatore scritto, avvio mock rifiutato con marcatore, avvio
mock consentito senza).

**`JwtStrategy` non controlla `type === 'operator'`**
(`auth/strategies/jwt.strategy.ts:19`). In modalità mock il token
cittadino è firmato con lo stesso `JWT_SECRET` (`auth.service.ts:82`) e
passa il guard globale sulle route senza ruoli (oggi solo
`GET admin/auth/me`). Fix proposto: `validate()` rifiuta payload con
`type` diverso da `operator`.
