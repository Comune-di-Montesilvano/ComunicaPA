# Invio SEND reale (payload v2.6/requests) — Design

## Contesto

Secondo di 3 sotto-progetti sequenziali (dopo il connettore Protocollo,
completato e verificato contro produzione reale) per portare SEND a
funzionare davvero. Oggi `SendStrategy.send()` chiama un endpoint
placeholder (`POST /delivery/notifications/sent`) con un payload minimale
inventato — nessuna notifica reale viene mai creata su PN (Piattaforma
Notifiche). Questo documento disegna l'implementazione del payload reale
(`POST /delivery/v2.6/requests`), inclusi upload allegati e dati di
pagamento.

Terzo sotto-progetto (stato/timeline reale nel portale cittadino/operatore,
che consumerà le colonne `iun`/`sendStatus` popolate dal demone incluso
qui) resta
fuori scope qui — deciso esplicitamente con l'utente.

## Riferimento API (verificato riga per riga sullo YAML ufficiale)

Fonte: `https://raw.githubusercontent.com/pagopa/pn-delivery/pn-openapi-devportal/docs/openapi/api-external-b2b-pa-bundle.yaml`.
**Attenzione**: un primo giro di analisi fatto con un fetch riassunto da un
modello ha prodotto alcune informazioni sbagliate (campi richiesti errati,
nome campo `pagoPaForm` invece di `attachment`, posizione di `payments`);
tutti i dettagli sotto sono stati riverificati leggendo direttamente lo YAML
scaricato, non fidandosi del riassunto automatico.

### 1. Upload allegati (prima dell'invio)

**`POST /delivery/attachments/preload`** — array di richieste, max 15 per
chiamata:
```json
[{ "preloadIdx": "doc-0", "contentType": "application/pdf", "sha256": "<base64 sha256 del file>" }]
```
`sha256` è **obbligatorio nella richiesta stessa** (non solo nel payload
finale) — va calcolato prima di chiamare preload, non dopo.

Risposta, un elemento per richiesta:
```json
[{ "preloadIdx": "doc-0", "secret": "...", "httpMethod": "PUT", "url": "https://...", "key": "PN_NOTIFICATION_ATTACHMENTS-..." }]
```

**Upload del file** (per ogni documento, verso `url` con metodo
`httpMethod`):
- Header `content-type`: uguale al `contentType` dichiarato in preload
- Header `x-amz-meta-secret`: valore `secret` dalla risposta preload
- Header `trailer`: `x-amz-checksum-sha256`
- **Trailer HTTP** (non header) `x-amz-checksum-sha256`: stesso digest
  sha256 base64 già inviato in preload

Il digest va quindi calcolato **una volta sola** e riusato sia nella
richiesta di preload sia come trailer nell'upload.

Risposta upload: `200 OK`, header `x-amz-version-id` → questo è il
`versionToken` da usare nel payload finale insieme a `key`.

**Nota tecnica critica**: l'invio di un trailer HTTP reale non è supportato
dalla `fetch` globale di Node/undici in modo semplice. Il modulo nativo
`https`/`http` di Node supporta i trailer via `request.addTrailers({...})`
prima di `request.end()`, ma solo se la richiesta usa `Transfer-Encoding:
chunked` (cioè senza impostare esplicitamente `Content-Length` — di default
Node usa chunked se non lo si imposta). L'upload va quindi implementato con
`https.request`/`http.request` raw, non con `fetch`.

### 2. Corpo della notifica

**`POST /delivery/v2.6/requests`** — schema `NewNotificationRequestV26`.

Campi **required** (verificati nello YAML, sezione `NewNotificationRequestV26.required`):
`paProtocolNumber`, `subject`, `recipients`, `documents`,
`physicalCommunicationType`, `notificationFeePolicy`, `senderDenomination`,
`senderTaxId`, `taxonomyCode`.

`abstract` **non è obbligatorio** (contrariamente a quanto ipotizzato in un
primo momento).

```json
{
  "paProtocolNumber": "44724/2026",
  "idempotenceToken": "<uuid casuale, opzionale>",
  "notificationFeePolicy": "FLAT_RATE",
  "physicalCommunicationType": "AR_REGISTERED_LETTER",
  "senderDenomination": "Comune di Montesilvano",
  "senderTaxId": "<CF/PIVA ente, 11 cifre>",
  "taxonomyCode": "010101P",
  "subject": "Avviso TARI 2026",
  "recipients": [
    {
      "recipientType": "PF",
      "taxId": "RSSMRA85M01H501Z",
      "denomination": "Mario Rossi",
      "payments": [
        { "pagoPa": { "noticeCode": "...", "creditorTaxId": "...", "applyCost": true } }
      ]
    }
  ],
  "documents": [
    {
      "ref": { "key": "...", "versionToken": "..." },
      "title": "Avviso TARI 2026",
      "digests": { "sha256": "..." },
      "contentType": "application/pdf",
      "docIdx": 0
    }
  ]
}
```

Dettagli verificati:
- **`recipients[].payments`** (non `payments` a livello root — errore nel
  primo riassunto automatico). Schema `NotificationRecipientV24`: required
  solo `denomination`, `recipientType`, `taxId` — `digitalDomicile` e
  `physicalAddress` restano **opzionali e omessi** (PN li risolve da
  ANPR/INAD).
- **`payments[].pagoPa`** (schema `PagoPaPayment`): required
  `noticeCode`, `creditorTaxId`, `applyCost` — il campo `attachment`
  (nome reale, non `pagoPaForm` come riportato erroneamente in un primo
  giro) **non è required**: si può inviare un pagamento pagoPA con soli
  dati, senza nessun PDF bollettino allegato. Confermato dall'utente e
  dallo YAML: **nessun generatore di bollettino PDF va costruito**.
- **`documents`**: array, minimo 1 elemento, un documento o più (non solo
  uno) — riusa il pattern multi-allegato già esistente
  (`resolveAttachmentsConfig` + `AttachmentService.generatePdfBuffer`).
- **`taxonomyCode`**: 7 caratteri, pattern `^([0-9]{6}[A-Z]{1})$`, dalla
  tabella ufficiale tassonomia SEND
  (`developer.pagopa.it/it/send/guides/knowledge-base/v2.5/tassonomia-send`).
  Struttura: prime 2 cifre = tipo ente (01 = Comune), poi codice
  procedimento, ultimo carattere `P` (prevede pagamento) o `N` (non
  prevede pagamento). **Non hardcodo alcun codice specifico nel software**:
  un riassunto automatico della tabella ha prodotto valori di esempio che
  non sono verificabili con certezza come corretti al 100% — usare codici
  sbagliati in un sistema legale/di protocollo è un rischio reale, quindi
  la lista dei codici abilitati va inserita manualmente dall'operatore
  (che ha accesso alla tabella ufficiale) da Impostazioni.
- **`physicalCommunicationType`**: obbligatorio ma NON implica raccogliere
  un indirizzo fisico (recipient non lo richiede) — dichiara solo quale
  fallback cartaceo usare se la consegna digitale fallisce del tutto,
  gestito internamente da PN.
- **`senderDenomination`**: riusa la setting esistente `brand.name` (nome
  ente già configurato globalmente) — nessuna nuova chiave.

### Risposta

`202 Accepted`: `{ "notificationRequestId": "<uuid>" }`. Lo stato
definitivo (`ACCEPTED`/`REFUSED`, IUN) si ottiene con
`GET /delivery/v2.6/requests?requestId=...`, che può restare `WAITING` per
un tempo non determinato. `SendStrategy.send()` si considera riuscito già
al 202, salvando `notificationRequestId` in `responsePayload` — la
risoluzione IUN e il monitoraggio dello stato **sono incluse in questo
sotto-progetto** (decisione aggiornata rispetto alla bozza iniziale, che le
rimandava a un sotto-progetto futuro), vedi sezione "Demone di
sincronizzazione stato SEND" più sotto.

### 3. Dettaglio/stato notifica (per il demone)

**`GET /delivery/v2.9/notifications/sent/{iun}`** — campi rilevanti:
`notificationStatus` (enum: `ACCEPTED`, `DELIVERING`, `DELIVERED`,
`VIEWED`, `EFFECTIVE_DATE`, `UNREACHABLE`, `CANCELLED`,
`RETURNED_TO_SENDER`). Stati **terminali** (il demone smette di
interrogare quell'attempt): `VIEWED`, `EFFECTIVE_DATE`, `UNREACHABLE`,
`CANCELLED`, `RETURNED_TO_SENDER`. Stati non terminali (si continua a
interrogare): `ACCEPTED`, `DELIVERING`, `DELIVERED` (attenzione:
`DELIVERED` ≠ perfezionata — la notifica è perfezionata solo con `VIEWED`
o `EFFECTIVE_DATE`, che sono eventi successivi).

## Decisioni con l'utente

- **taxonomyCode**: gestito da Impostazioni → sezione "Tassonomie SEND
  abilitate" (lista codice+etichetta, inserita manualmente dall'operatore
  copiando dalla tabella ufficiale, filtrata per tipo ente). Nel wizard,
  select filtrata dinamicamente: se il checkbox "Integrazione pagamenti"
  (spostato allo step 1) è attivo mostra solo codici che finiscono per
  `P`, altrimenti solo quelli che finiscono per `N`.
- **physicalCommunicationType**: selezionabile nel wizard (step 1),
  default `AR_REGISTERED_LETTER`. Alert informativo con struttura costi
  reale (fonte: listino ufficiale PagoPA, vedi sotto) — **generica, non
  con cifre di una regione specifica hardcoded**: ComunicaPA è
  open-source e distribuibile da enti di regioni diverse, ognuno con
  tariffe di lotto diverse (il costo cartaceo varia per regione/zona di
  recapito). L'alert mostra la struttura (fasce di peso, differenza
  A/R vs 890, IVA esclusa) e linka il listino ufficiale aggiornato
  (`https://notifichedigitali.pagopa.it/static/documents/Prezzi%20Ente%202024.pdf`)
  perché l'operatore verifichi le cifre esatte del proprio lotto/regione.

  **Dati reali verificati** (listino ufficiale, in vigore dal 1/2/2024,
  scaricato e letto direttamente — non un riassunto automatico): costo
  notifica digitale (gestione piattaforma) **€1,00 + IVA**, sempre
  addebitato indipendentemente dall'esito. Fallback cartaceo, solo se la
  consegna digitale fallisce del tutto: **A/R è sistematicamente più
  economica di 890** a parità di fascia di peso (es. Abruzzo, Lotto 13
  vs Lotto 30: fino a 20g **890 = €8,47** contro **A/R = €2,70–3,46**
  a seconda della zona di recapito AM/CP/EU). Il costo omnicomprensivo
  copre 1 foglio, +€0,03/foglio successivo; limiti piattaforma: max 99
  fogli se A/R, max 17 fogli se 890. Zone AM/CP/EU sono assegnate
  automaticamente da PN in base al recapitista, non selezionabili
  dall'ente. Questo conferma che il default `AR_REGISTERED_LETTER`
  proposto è anche la scelta economicamente più sensata nella grande
  maggioranza dei casi.
- **payments**: nessun PDF bollettino da generare (confermato dallo
  schema: `attachment` opzionale). Riuso della logica di risoluzione dati
  già esistente per App IO (`noticeCode`/`creditorTaxId`/importo), estratta
  in utility condivisa.
- **Demone di sincronizzazione stato/IUN**: incluso in questo
  sotto-progetto (decisione aggiornata — inizialmente rimandato, poi
  richiesto esplicitamente qui). Job schedulato ogni 15 minuti, risolve
  IUN e aggiorna lo stato reale per ogni tentativo SEND non ancora
  terminale. Serve anche per il futuro export di tracciati con stati/date
  di consegna reali verso altri software.

## Architettura

### `apps/backend/src/channels/payment-config.util.ts` (nuovo)

Estrae la logica oggi duplicata in `app-io.strategy.ts:81-124` e
`notification.processor.ts:316-360` (risoluzione `noticeCode` da colonna
CSV, importo in centesimi da colonna con `amountType` euro/cents, CF
creditore statico o da colonna). Esporta:

```ts
export interface ResolvedPaymentData {
  noticeCode: string;
  amountCents: number;
  creditorTaxId: string;
  dueDateIso: string | null;
}
export function resolvePaymentData(
  recipient: Recipient,
  paymentConfig: PaymentConfig | undefined,
): ResolvedPaymentData | null
```

`app-io.strategy.ts` e `notification.processor.ts` vengono aggiornati per
usare questa utility al posto della logica duplicata (terzo consumer =
`SendStrategy`, giustifica l'estrazione, non è refactor speculativo).

### `apps/backend/src/channels/send/send-attachment-upload.service.ts` (nuovo)

```ts
@Injectable()
export class SendAttachmentUploadService {
  async preloadAndUpload(
    baseUrl: string,
    voucher: string,
    buffer: Buffer,
    contentType: 'application/pdf' | 'application/json',
    preloadIdx: string,
  ): Promise<{ key: string; versionToken: string; sha256Base64: string }>
}
```

Calcola `sha256Base64 = createHash('sha256').update(buffer).digest('base64')`,
chiama `POST {baseUrl}/delivery/attachments/preload` (voucher come Bearer),
poi esegue l'upload raw via `https.request`/`http.request` (scelto in base
al protocollo dell'`url` restituito) con headers `content-type`,
`x-amz-meta-secret`, `trailer: x-amz-checksum-sha256`, e
`request.addTrailers({ 'x-amz-checksum-sha256': sha256Base64 })` prima di
`end()`. Legge `x-amz-version-id` dagli header di risposta.

### `apps/backend/src/channels/send/send.strategy.ts` (riscritta)

- Legge `send.senderTaxId` (nuova setting), `brand.name` (esistente, per
  `senderDenomination`).
- Legge da `campaign.channelConfig`: `subject`, `abstract` (opzionale),
  `taxonomyCode`, `physicalCommunicationType`.
- `paProtocolNumber` = `` `${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}` ``
  (riusa il risultato già ottenuto da `ProtocolloService.protocolla()`,
  cablato nel sotto-progetto 1 — `protocolla` è già obbligatorio per SEND).
- `documents[]`: per ogni allegato configurato via `resolveAttachmentsConfig`
  (min 1, fallback già esistente in `AttachmentService`), genera il
  buffer, chiama `SendAttachmentUploadService.preloadAndUpload`, costruisce
  l'entry con `docIdx` progressivo.
- `recipients[0].payments`: se `resolvePaymentData()` ritorna un valore
  non-null, `[{ pagoPa: { noticeCode, creditorTaxId, applyCost: true } }]`
  (nessun campo `attachment`).
- POST reale a `${baseUrl}/delivery/v2.6/requests`, Authorization Bearer
  voucher (esistente).
- Risposta 202 → `messageId = notificationRequestId`,
  `responsePayload = { notificationRequestId, protocollo: ... }`.
- Rimosso il vecchio endpoint placeholder `/delivery/notifications/sent`.

### Settings (registry + UI)

- `send.senderTaxId` (nuova, string, non secret).
- Sezione "Tassonomie SEND abilitate" in tab SEND: lista gestita da admin
  (aggiungi/rimuovi righe `{ code, label }`), salvata come JSON in una
  nuova chiave `send.enabledTaxonomyCodes` (string, JSON serializzato —
  pattern coerente con altri campi jsonb-in-string già usati nel progetto
  per liste, es. `channelConfig.attachments`).

### Wizard (frontend-admin)

- Step 1: checkbox "Integrazione pagamenti" spostato qui da step 3 (resta
  in step 3 solo il mapping colonne CSV per notice/importo/CF/scadenza,
  già esistente). Per SEND: select "Tassonomia" filtrata (P se pagamenti
  ON, N se OFF) dalle voci abilitate in Impostazioni; select "Tipo
  comunicazione fisica" (`AR_REGISTERED_LETTER` default /
  `REGISTERED_LETTER_890`) con alert informativo (struttura costi generica
  verificata da listino ufficiale — A/R sistematicamente più economica di
  890 — + link al PDF ufficiale aggiornato per le cifre esatte del
  lotto/regione dell'ente, vedi sezione "Decisioni con l'utente").
- Step 4: nessun cambiamento aggiuntivo oltre a quanto già esiste
  (subject/body già passati per SEND dal lavoro del sotto-progetto 1).

### Demone di sincronizzazione stato SEND

**Dati**: nuove colonne su `NotificationAttempt` (migration):
- `iun` (varchar nullable) — IUN risolto, popolato quando
  `notificationRequestStatus` diventa `ACCEPTED`.
- `sendStatus` (varchar nullable) — ultimo `notificationStatus` noto
  (`ACCEPTED`/`DELIVERING`/`DELIVERED`/`VIEWED`/`EFFECTIVE_DATE`/
  `UNREACHABLE`/`CANCELLED`/`RETURNED_TO_SENDER`), o `REFUSED` se PN
  rifiuta la richiesta (stato terminale sintetico, non del vocabolario
  PN — usato per distinguere "mai accettata" da "accettata poi fallita").
  `NULL` finché non risolto nemmeno il primo stato.
  `sendStatusUpdatedAt` (timestamptz nullable) — ultimo aggiornamento.

**`apps/backend/src/channels/send/send-status-sync.service.ts`** (nuovo),
pattern identico a `RetentionCleanupService`
(`apps/backend/src/campaigns/retention-cleanup.service.ts`, `@Cron` da
`@nestjs/schedule`, già attivo in `AppModule` via `ScheduleModule.forRoot()`):

```ts
const BATCH_SIZE = 200;
const TERMINAL_STATUSES = ['VIEWED', 'EFFECTIVE_DATE', 'UNREACHABLE', 'CANCELLED', 'RETURNED_TO_SENDER', 'REFUSED'];

@Injectable()
export class SendStatusSyncService {
  @Cron('*/15 * * * *')
  async handleCron(): Promise<void> {
    // 1. Attempt SEND con notificationRequestId ma senza iun: risolvi IUN
    //    via GET /delivery/v2.6/requests?requestId=... — se ACCEPTED salva
    //    iun+sendStatus='ACCEPTED', se REFUSED salva sendStatus='REFUSED'
    //    (terminale), se WAITING non fare nulla (riprova al prossimo giro).
    // 2. Attempt SEND con iun valorizzato e sendStatus non in
    //    TERMINAL_STATUSES: GET /delivery/v2.9/notifications/sent/{iun},
    //    aggiorna sendStatus + sendStatusUpdatedAt.
    // Batch da BATCH_SIZE per query, stesso pattern retention-cleanup.
  }
}
```

Riusa `PdndAuthService.getVoucher(env, purposeId)` (stesso purposeId SEND
già configurato) per l'autenticazione verso entrambe le chiamate GET.
Nessun nuovo servizio HTTP: stesso `fetch` diretto già usato in
`send.strategy.ts`/`pdnd-auth.service.ts` (nessun trailer/upload coinvolto
qui, solo GET semplici — niente bisogno di `send-attachment-upload.service.ts`).

## Verifica

- Unit test per `payment-config.util.ts` (già coperto indirettamente dai
  test esistenti di App IO, da migrare/estendere).
- Unit test `send-attachment-upload.service.ts` con mock di `https`/`fetch`
  (verificano costruzione preload request con sha256, trailer inviato,
  parsing `x-amz-version-id`).
- Unit test `send.strategy.spec.ts` aggiornato per il nuovo payload
  completo.
- Unit test `send-status-sync.service.spec.ts` (mock fetch): risoluzione
  IUN da WAITING/ACCEPTED/REFUSED, aggiornamento stato da
  `notifications/sent/{iun}`, stop su stato terminale, batch size.
- Migration testata su DB temporaneo (sez. "Migration DB" CLAUDE.md) per
  le nuove colonne `iun`/`sendStatus`/`sendStatusUpdatedAt`.
- **Nessun test end-to-end automatico contro PN reale** (ambiente di
  collaudo PN richiederebbe credenziali dedicate collaudo, fuori scope
  verificarle in questa sessione) — un test manuale guidato con l'utente,
  analogo a quello fatto per il connettore Protocollo, prima di
  considerare l'integrazione completa.
- `tsc --noEmit` backend/frontend, `jest --maxWorkers=2` (nessuna
  regressione sul resto della suite).

## File coinvolti

- `apps/backend/src/channels/payment-config.util.ts` (nuovo)
- `apps/backend/src/channels/send/send-attachment-upload.service.ts` (nuovo)
- `apps/backend/src/channels/send/send.strategy.ts` (riscritta)
- `apps/backend/src/channels/app-io/app-io.strategy.ts` (refactor per
  usare `payment-config.util.ts`)
- `apps/backend/src/queue/notification.processor.ts` (refactor per usare
  `payment-config.util.ts`)
- `apps/backend/src/channels/send/send-status-sync.service.ts` (nuovo)
- `apps/backend/src/entities/notification-attempt.entity.ts` (nuove
  colonne `iun`, `sendStatus`, `sendStatusUpdatedAt`)
- `apps/backend/src/database/migrations/<timestamp>-AddSendStatusColumns.ts`
  (nuova)
- `apps/backend/src/settings/settings.registry.ts` (`send.senderTaxId`,
  `send.enabledTaxonomyCodes`)
- `apps/frontend-admin/src/App.tsx` (tab SEND: gestione tassonomie
  abilitate; wizard step 1: checkbox pagamenti spostato, select
  tassonomia/tipo comunicazione fisica, alert costi)
