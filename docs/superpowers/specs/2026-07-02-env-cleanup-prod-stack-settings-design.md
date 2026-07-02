# Design: pulizia env, stack prod, CI/CD tagging, settings da UI, storage allegati unificato

**Data:** 2026-07-02
**Stato:** approvato

## Obiettivi

1. Eliminare variabili d'ambiente duplicate/morte; in `.env` restano solo valori sistemistici/bootstrap.
2. Split compose: `docker-compose.yml` = produzione (podman rootless + Portainer, solo volumi named), `docker-compose.override.yml` = sviluppo (bind mount, hot-reload).
3. Dockerfile di produzione multi-stage per le 3 app + CI/CD GitHub Actions con tagging automatico e caching massimo.
4. Badge versione nel menù admin (`dev` per build manuale, `vX.Y.Z` per immagine taggata).
5. Tutte le configurazioni applicative (branding, retention, SMTP, PEC, App IO, SEND) persistite in DB e configurabili da UI admin.
6. Storage allegati unificato su un solo path configurabile (`ATTACHMENTS_PATH`) montato su volume dedicato.

## 1. Variabili d'ambiente

### Restano in `.env` (bootstrap/sistemistica)

| Gruppo | Variabili |
|---|---|
| Porte | `BACKEND_PORT`, `ADMIN_PORT`, `CITIZEN_PORT` |
| PostgreSQL | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| Runtime | `NODE_ENV`, `LOG_LEVEL` |
| Secret | `JWT_SECRET`, `JWT_EXPIRES_IN`, `DOWNLOAD_LINK_SECRET` |
| URL deployment | `PUBLIC_BACKEND_URL`, `ADMIN_ORIGIN`, `CITIZEN_ORIGIN` |
| Auth operatori | `LDAP_HOST`, `LDAP_TLS_SKIP_VERIFY`, `LDAP_STARTTLS`, `LDAP_BASE_DN`, `LDAP_USER_DN_TEMPLATE`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_REQUIRED_GROUP`, `LDAP_ADMIN_GROUP` |
| Auth cittadini | `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI` |
| Storage | `ATTACHMENTS_PATH` (default `/data/attachments`) |
| Deploy | `IMAGE_TAG` (tag immagini prod, default `latest`), `COMPOSE_FILE` (solo dev) |

LDAP/OIDC restano su env per il problema chicken-egg: senza autenticazione funzionante non si accede alla UI per configurare.

### Eliminate (morte o duplicate)

- `DATABASE_URL`, `REDIS_URL` — il compose le costruisce internamente da componenti; i valori in `.env` erano ignorati.
- `POSTGRES_HOST`, `POSTGRES_PORT`, `REDIS_HOST`, `REDIS_PORT` — mai lette da compose né da codice.
- Blocco SMTP duplicato in `.env.example` (righe commentate "Fase 4").
- `PDF_STORAGE_PATH` — sostituita da `ATTACHMENTS_PATH`.

### Migrano in DB (configurabili da UI admin)

`BRAND_NAME`, `BRAND_LOGO`, favicon (nuovo), `RETENTION_MAX_DAYS`, `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`, `PEC_HOST/PORT/SECURE/USER/PASSWORD/FROM`, `APP_IO_API_KEY/BASE_URL`, `SEND_API_KEY/BASE_URL`.

Fallback dolce: se una chiave non è in DB, il servizio legge la variabile d'ambiente corrispondente, poi il default. Le installazioni esistenti continuano a funzionare senza migrazione manuale.

## 2. Modulo settings persistente

### Entity `app_settings`

```
key        varchar PK      es. "smtp.host", "brand.name", "retention.maxDays"
value      jsonb           valore (stringa, numero, booleano)
encrypted  boolean         true se value contiene ciphertext
updatedAt  timestamptz
updatedBy  varchar         username operatore
```

### `AppSettingsService`

- `get<T>(key)`: cache in-memory → DB → fallback `process.env` (mappa chiave→env) → default. Cache invalidata su ogni write.
- `set(key, value, user)`: upsert + invalidazione cache.
- Chiavi secret (`smtp.password`, `pec.password`, `appIo.apiKey`, `send.apiKey`): cifrate AES-256-GCM prima del salvataggio. Chiave di cifratura derivata da `JWT_SECRET` via HKDF (info: `comunicapa-settings-encryption`). Nessuna nuova variabile d'ambiente.

### Endpoint

- `GET /settings` (admin): tutte le impostazioni; i secret tornano mascherati (`••••••••` se valorizzati, vuoto se assenti).
- `PUT /settings` (admin): upsert batch; se un secret arriva come `••••••••` non viene toccato.
- `POST /settings/branding/logo`, `POST /settings/branding/favicon` (admin): upload file → `${ATTACHMENTS_PATH}/branding/`; validazione tipo (png/jpg/svg per logo, ico/png/svg per favicon) e dimensione.
- `GET /api/branding` (pubblico, no auth): `{ name, logoUrl, faviconUrl }` — usato da entrambi i frontend per header e favicon dinamica.

### Refactor consumatori

- `EmailStrategy`, `PecStrategy`, `AppIoStrategy`, `SendStrategy`: `ConfigService` → `AppSettingsService` per i valori migrati (lettura già a ogni `send()`, nessun problema di init).
- `SettingsController` (test-email/test-pec): fallback password da `AppSettingsService`.
- `RetentionCleanupService` e utility retention: `retention.maxDays` da `AppSettingsService`.
- Template helper / layout email: `brand.name` da settings.

### UI admin

Pagina impostazioni con sezioni: Branding (nome, upload logo, upload favicon), Retention (giorni), Email, PEC, App IO, SEND. I bottoni "test connessione" esistenti restano collegati. Salvataggio via `PUT /settings`.

## 3. Split compose

### `docker-compose.yml` (base = produzione)

- Servizi: `postgres`, `redis`, `backend`, `frontend-admin`, `frontend-citizen`.
- App da immagini `ghcr.io/mirkochipdotcom/comunicapa-{backend,frontend-admin,frontend-citizen}:${IMAGE_TAG:-latest}` — nessun `build:`.
- Solo volumi named: `postgres_data`, `redis_data`, `attachments_data:/data/attachments`. Nessun bind mount.
- `postgres`/`redis` senza porte pubblicate sull'host (solo rete interna).
- `DATABASE_URL`/`REDIS_URL` costruite internamente dalle componenti.
- Env backend: solo variabili bootstrap (sez. 1) — via `${VAR:-default}`.
- Compatibile podman rootless: nessuna porta privilegiata, nessun bind, immagini non-root.
- Deploy Portainer: si incolla il file come stack, si valorizzano le env, fine.

### `docker-compose.override.yml` (sviluppo)

- Override delle 3 app: `build:` con `Dockerfile.dev`, bind mount `src/`, volumi `node_modules`, `NODE_ENV=development`.
- Porte `postgres`/`redis` esposte sull'host per debug.
- `.env` di dev contiene `COMPOSE_FILE=docker-compose.yml;docker-compose.override.yml` (separatore `;` su Windows, `:` su Linux — documentato in `.env.example`).

## 4. Dockerfile di produzione

Tre nuovi `Dockerfile` (accanto ai `.dev`), tutti con `ARG APP_VERSION=dev`.

### Backend (`apps/backend/Dockerfile`)

- Stage build: `node:22-alpine` + pnpm; `pnpm install --ignore-scripts` con cache mount BuildKit sul pnpm store; build `shared-types` + backend.
- Stage runtime: `node:22-alpine`, solo `dist` + dipendenze di produzione (`pnpm deploy --prod` o equivalente), utente non-root, `ENV APP_VERSION`.

### Frontend admin/citizen (`apps/frontend-*/Dockerfile`)

- Stage build: Vite build (con cache mount pnpm store).
- Stage runtime: `nginxinc/nginx-unprivileged:alpine` (ascolta 8080, gira non-root — richiesto da podman rootless). Config nginx: statici + fallback SPA su `index.html`. Le chiamate `/api/*` sono instradate al backend dal reverse proxy dell'infrastruttura (fuori scope), non da questo nginx.

## 5. CI/CD e badge versione

### Workflow `.github/workflows/release.yml`

- Trigger: push tag `v*` e push su `main`.
- Job matrix (3 immagini in parallelo): backend, frontend-admin, frontend-citizen.
- Step: `actions/checkout@v5` → `docker/setup-buildx-action@v3` → `docker/login-action@v3` (ghcr, `GITHUB_TOKEN`) → `docker/metadata-action@v5` → `docker/build-push-action@v6`.
- Tagging: tag git `v0.5.0` → tag immagine `v0.5.0` + `latest`; push su `main` → tag `dev`.
- `APP_VERSION` build-arg = tag git (o `dev` su main).
- Caching: BuildKit cache mount per pnpm store (nel Dockerfile) + registry cache `type=registry,ref=ghcr.io/...-<app>:buildcache,mode=max`.
- Permessi workflow: `packages: write`, `contents: read`.

### Badge versione

- Backend: `GET /api/version` (pubblico) → `{ "version": process.env.APP_VERSION ?? "dev" }`.
- Frontend admin: badge nel menù, fetch a `/api/version` al mount, mostra `dev` o `vX.Y.Z`.

## 6. Storage allegati unificato

- Unica variabile `ATTACHMENTS_PATH` (default `/data/attachments`), volume named `attachments_data` in prod e dev. Personalizzazione: in Portainer si mappa il volume su path/driver desiderato.
- Layout: PDF generati/timbrati alla radice; upload operatore in `${ATTACHMENTS_PATH}/uploads/<campaignId>/`; branding in `${ATTACHMENTS_PATH}/branding/`.
- Fix bug: `attachment.service.ts:44`, `campaigns.controller.ts:79`, `retention-cleanup.service.ts:52` oggi usano `join(__dirname, '../../uploads/attachments/...')` — path dentro il container, perso a ogni rebuild e non configurabile. Passano tutti a `${ATTACHMENTS_PATH}/uploads/<campaignId>`.
- `pdf.service.ts`: `PDF_STORAGE_PATH` → `ATTACHMENTS_PATH`.
- Le path sono centralizzate in `configuration.ts` (una sola lettura di `process.env`), i servizi le ricevono via `ConfigService`.

## Gestione errori

- Settings: chiave sconosciuta in `PUT /settings` → 400 con elenco chiavi valide. Decrypt fallito (JWT_SECRET cambiato) → log warn + fallback env/default, il valore va reinserito da UI.
- Upload branding: tipo/size non validi → 400. Directory creata con `mkdir recursive` al bisogno.
- `/api/version` e `/api/branding`: sempre 200 con fallback (`dev`, brand default) — mai bloccanti per la UI.

## Test

- Unit: `AppSettingsService` (fallback DB→env→default, cache, cifratura round-trip, mascheramento secret), refactor strategy (mock settings service — aggiornare spec esistenti), `resolveCustomAttachmentFilename`/retention con nuove path (spec esistenti da aggiornare), endpoint version/branding.
- Manuale: `docker compose config` con e senza override; build immagini prod locale; verifica badge `dev`.

## Fuori scope

- Migrazione LDAP/OIDC in UI (chicken-egg auth).
- Reverse proxy/TLS di produzione (responsabilità infrastruttura).
- Migrazione automatica dei valori env esistenti in DB (il fallback env la rende superflua).
