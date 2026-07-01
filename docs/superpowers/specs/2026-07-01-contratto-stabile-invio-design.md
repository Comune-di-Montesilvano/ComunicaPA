# Design: contratto stabile canali di invio (pre-batch TARI)

**Data**: 2026-07-01
**Contesto**: batch TARI in partenza (6133 destinatari, rubrica/allegati in `Desktop\0tmail`). Prima dell'invio, fissare come contratto stabile 5 aree che non devono cambiare comportamento nelle prossime versioni: link download, retention, template, statistiche download, invio App IO.

**Vincolo**: l'invio del batch TARI attende il completamento di questo contratto (deciso dall'utente).

## Stato attuale (audit)

| Area | Stato pre-design |
|---|---|
| Link download | Implementato, URL pubblico con `notificationId` in chiaro, protetto solo da login OIDC cittadino, nessun TTL |
| Retention | Assente. Nessun cron/cleanup. File restano su `PDF_STORAGE_PATH` indefinitamente |
| Template | Motore custom funzionante (`template.helper.ts`), nessun lock: editare la campagna dopo l'invio ne altera il contenuto storico |
| Statistiche download | Parziale, salvate in `recipient.extraData` (JSONB), nessuna tabella tipizzata, nessuna API |
| App IO | Implementato ma sequenziale: parte solo se il canale primario (Email/PEC) ha successo |

## 1. Link download — token firmato

- Formato URL: `{citizenPortalUrl}/download/{recipientId}?exp={unixTs}&sig={hmacHex}`
- `sig = HMAC-SHA256(DOWNLOAD_LINK_SECRET, recipientId + ":" + exp)`
- `DOWNLOAD_LINK_SECRET`: nuova variabile in `.env` / `configuration.ts`
- `exp` calcolato al momento dell'invio: `sentAt + campaign.retentionDays` (in secondi unix)
- Nuovo endpoint pubblico `GET /public/download/:recipientId` (no OIDC):
  - valida `exp` (se `now > exp` → `410 Gone`)
  - valida `sig` (mismatch → `403 Forbidden`)
  - se `attachmentDeletedAt` già valorizzato (retention scattata) → `410 Gone`
  - altrimenti stream del PDF + registra evento download (vedi punto 4)
- Endpoint OIDC-autenticato esistente (`/citizen/notifications/:id/attachment`) resta per l'area riservata cittadino, non viene rimosso

## 2. Retention policy

- `configuration.ts`: `retentionMaxDays` da env `RETENTION_MAX_DAYS`, default `90`
- Nuova colonna `campaign.retentionDays` (int, nullable → fallback a `retentionMaxDays`)
- Validazione wizard (step avanzato, opzionale): `retentionDays <= retentionMaxDays`, altrimenti 400
- Job cron giornaliero (`@Cron('0 3 * * *')` in un nuovo `RetentionCleanupService`):
  - seleziona recipient con `sentAt + retentionDays < now` e `attachmentDeletedAt IS NULL`
  - elimina il file PDF da `PDF_STORAGE_PATH`
  - imposta `recipient.attachmentDeletedAt = now()`
- TTL del link (punto 1) coincide sempre con `retentionDays` — un solo parametro da governare, nessuna scadenza disallineata

## 3. Template lock (immutabilità post-lancio)

- Stati campagna esistenti: `DRAFT → QUEUED → RUNNING → COMPLETED/FAILED`, più `CANCELLED`
- Regola: se `campaign.status !== 'DRAFT'`, il `PATCH` su `channelConfig` (subject/body/appIo config) risponde `409 Conflict`
- `CANCELLED` è terminale e irreversibile: nessuna transizione di uscita. Per modificare un template già lanciato, l'operatore annulla la campagna corrente e ne crea una nuova (dati CSV/mapping riutilizzabili dal wizard, ma nuova entità campagna)
- Nessuna tabella di versioning separata: il "congelamento" è lo stato stesso della campagna

## 4. Statistiche download

- Migrazione DB: da `recipient.extraData.download_count/downloaded_at` (JSONB) a colonne tipizzate su `Recipient`:
  - `downloadCount: int` (default 0)
  - `firstDownloadedAt: timestamp nullable`
  - `lastDownloadedAt: timestamp nullable`
  - `attachmentDeletedAt: timestamp nullable` (da punto 2)
- Ogni download riuscito (via endpoint punto 1) incrementa `downloadCount`, aggiorna `lastDownloadedAt` (e `firstDownloadedAt` se null)
- Nuovi endpoint (auth operatore PA):
  - `GET /campaigns/:id/stats` → aggregato: totale inviati, totale con almeno 1 download, percentuale, ultima data download della campagna
  - `GET /campaigns/:id/stats/recipients` → lista paginata per destinatario: nominativo, canale, `downloadCount`, `firstDownloadedAt`, `lastDownloadedAt`, `attachmentDeletedAt` — usato per contestazioni singole ("non ho mai ricevuto la TARI")

## 5. App IO — invio indipendente

- In `notification.processor.ts`: rimuovere il gate che condiziona l'enqueue del job App IO al successo del canale primario (Email/PEC)
- Se `campaign.channelConfig.appIo` è configurato, il job App IO viene sempre accodato, indipendentemente dall'esito Email/PEC
- Ordine di esecuzione tra canali resta libero (nessun requisito di concorrenza reale/stesso istante — solo indipendenza di esito)

## Fuori scope (esplicitamente escluso, YAGNI)

- Nessun versionamento esplicito del template (solo lock di stato)
- Nessun log evento-per-evento dei download (solo campi aggregati per recipient, non tabella `download_events`)
- Nessuna concorrenza reale (thread/promise simultanee) per App IO, solo indipendenza di esito
- Nessuna riattivazione di campagne `CANCELLED`

## Note di rischio

- Timeline stretta: batch TARI attende il completamento di questo contratto prima di partire. Le 5 aree toccano storage, cron, DB migration, 2 nuovi endpoint pubblici e modifica al processor BullMQ — stimare con cura in fase di piano.
- Migrazione DB su tabella `recipient` con dati già esistenti (batch precedenti): migration deve avere default sicuri e non rompere righe esistenti.
