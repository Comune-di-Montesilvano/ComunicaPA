# API esterna v2 — design

Data: 2026-10-01 · Branch: `feat/external-api-v2`

## Contesto e problema

L'API esterna `external/v1` (modulo `apps/backend/src/external-api/`) è ferma
alla migrazione ESM e non segue le funzionalità arrivate con le versioni 1.8.x.
Da una lettura del codice risulta che oggi:

- **SEND non funziona**: `send-dispatch.service.ts` legge
  `channelConfig.taxonomyCode`, che l'API non imposta mai e non accetta in
  input. PN rifiuta la notifica (confermato dall'utente).
- **POSTAL non funziona**: `postal.strategy.ts` lancia "indirizzo destinatario
  non risolvibile" senza `channelConfig.physicalAddressConfig`, che l'API non
  imposta mai.
- `/capabilities` espone valori (tassonomie, tipi servizio, contratti) che il
  client **non può usare**, perché il DTO di creazione non ha i campi
  corrispondenti. `enabledTaxonomyCodes` inoltre è dichiarato `string[]` ma il
  setting è `Array<{code,label,isDefault}>`.
- `v1` imposta `channelConfig.wizSingleMode = true`, e quel flag fa saltare il
  check INAD al lancio (`campaigns.service.ts` `launch()`): nessun
  dirottamento al domicilio digitale.
- Destinatari impresa (P.IVA) non sono supportati: DTO limitato a CF di 16
  caratteri, sia in `/notifications` sia in `/domicilio/cerca`.
- Il nome del destinatario passa solo dalla chiave non documentata
  `extraData.full_name`.
- `GET /notifications/:id` non espone IUN, data legale SEND, esito legale
  POSTAL, dirottamento, protocollo, costo.
- Bug collaterale fuori dall'API: `send-dispatch.service.ts` usa
  `recipientType: 'PF'` fisso, anche per i destinatari P.IVA da CSV.

## Obiettivo

Un client esterno deve poter inviare davvero su tutti i canali passando tutti
i dati necessari, e scoprire da `/capabilities` i valori ammessi, senza
conoscere dettagli interni.

## Decisioni (prese con l'utente)

| # | Decisione |
|---|---|
| D1 | Nessuna retrocompatibilità: nuovo namespace `external/v2`, `v1` rimosso. |
| D2 | Campi tipizzati nel body (niente `extraData` libero né chiavi "magiche"). |
| D3 | Un destinatario per chiamata ora; il contratto non deve impedire un futuro endpoint a lotto. L'unità del contratto è la **notifica** (`notificationId` = `recipient.id`), non la campagna. |
| D4 | Destinatari persona fisica (CF) e persona giuridica (P.IVA). |
| D5 | Dirottamento al domicilio digitale come da lancio UI (INAD per PF, Registro Imprese per PG). |
| D6 | PEC su PG con PEC diversa da Registro Imprese → `PENDING_REVIEW` come da UI, decisione operatore. |
| D7 | Esito solo via polling ora; modello `events[]` progettato per aggiungere webhook dopo senza cambiare contratto. |
| D8 | Architettura: adapter sottile sopra `CampaignsService` (campagna mono-destinatario), nessuna pipeline dedicata. |
| D9 | `Idempotency-Key` obbligatorio su `POST /notifications`. |
| D10 | SEND sempre protocollato (`protocolla: true` forzato, non più richiesto al client). |

## Contratto

Base `/api/external/v2`, header `X-Api-Key`. Tutte le risposte sono **HTTP
200** con esito nel campo `success` (un reverse proxy esterno in produzione
sostituisce il body delle risposte non-2xx). Ogni handler `@Post()` ha
`@HttpCode(HttpStatus.OK)` esplicito.

| Metodo | Path | Scopo |
|---|---|---|
| GET | `/capabilities` | canali attivi e tutti i valori ammessi |
| POST | `/domicilio/cerca` | `{ taxId }`: CF → INAD+App IO+ANPR; P.IVA → Registro Imprese |
| POST | `/attachments/upload/init` | `{ filename, totalChunks }` → `uploadId` |
| POST | `/attachments/upload/chunk` | multipart `uploadId`, `index`, `chunk` |
| POST | `/attachments/upload/complete` | `{ uploadId }` → `attachmentToken` (TTL 24h, monouso) |
| POST | `/notifications` | crea e lancia (header `Idempotency-Key`) |
| GET | `/notifications/{notificationId}` | stato, esito, eventi |

Il flusso allegati resta quello di `v1` (`external-attachments.controller.ts`,
`ExternalAttachmentTokensService`), solo spostato sotto `v2`.

### `GET /capabilities`

Espone solo ciò che è configurato e attivo, con etichette e default. Nessun
segreto (niente host/username/password SMTP, niente API key).

```jsonc
{
  "success": true,
  "recipientTypes": ["PF", "PG"],
  "limits": {
    "attachment": { "chunkMaxBytes": 2097152, "chunkRecommendedBytes": 524288, "tokenTtlHours": 24 },
    "appIo": { "subject": [10, 120], "body": [80, 10000] },
    "idempotencyKeyTtlHours": 24
  },
  "channels": {
    "EMAIL":  { "active": true, "senders": [{ "id": "uuid", "name": "Tributi", "fromAddress": "noreply@ente.it", "default": true }] },
    "PEC":    { "active": true, "senders": [{ "id": "uuid", "name": "Protocollo", "fromAddress": "protocollo@pec.ente.it", "default": true }] },
    "APP_IO": { "active": true, "services": [{ "id": "uuid", "name": "Tributi", "default": true }], "parallelAvailable": true },
    "SEND": {
      "active": true,
      "environment": "test",
      "taxonomies": [{ "code": "010101N", "label": "...", "description": "...", "requiresPayment": false, "default": true }],
      "physicalCommunicationTypes": [
        { "value": "AR_REGISTERED_LETTER", "default": true },
        { "value": "REGISTERED_LETTER_890", "default": false }
      ]
    },
    "POSTAL": {
      "active": true,
      "serviceTypes": [{ "value": "Raccomandata", "returnReceiptAvailable": true, "agol": false, "default": true }],
      "contracts": [{ "code": "...", "description": "...", "type": "...", "foreign": false }],
      "defaults": { "color": false, "duplex": true, "returnReceipt": false },
      "agol": {
        "notifierTypes": ["NonUtilizzato", "UfficialeGiudiziario", "Procuratore", "ParteIstante"],
        "secondAttemptOptions": ["NonRichiedere", "Concordato", "Automatico"]
      }
    }
  }
}
```

Fonti:
- `senders`: `MailConfigsService.listMasked(type)`, solo config attive, campi
  `id`, `name`, `fromAddress`, default di sistema.
- `services`: `IoServicesService.listMasked()`, campi `id`, `nome`,
  `isDefault`.
- `taxonomies`: setting `send.enabledTaxonomyCodes` (`{code,label,isDefault}`)
  arricchito con `description` dal catalogo ufficiale. `requiresPayment` =
  suffisso `P` (regola già applicata dal wizard, `App.tsx`: codici `P` solo
  con pagamento, `N` senza).
- `SEND.active`: stessa regola di `v1` (apiKey + purposeId dell'ambiente
  attivo).
- `POSTAL`: `PostalProvidersService.getActive()` (`enabledServiceTypes`,
  `contratti`). `returnReceiptAvailable`/`agol` derivati dal nome servizio
  con la stessa regola di `postal.strategy.ts` (`startsWith('Agol')`,
  `startsWith('Raccomandata')`).
- Un canale non attivo compare con `active: false` e liste vuote.

Refactor di supporto:
- Il catalogo tassonomie SEND (`apps/frontend-admin/src/data/sendTaxonomy.ts`)
  si sposta in `@comunicapa/shared-types`; il frontend lo importa da lì.
- Le enumerazioni `physicalCommunicationType`, Agol `tipoNotificante` e
  `secondoTentativoRecapito` diventano costanti condivise in
  `@comunicapa/shared-types`, usate da capabilities e validazione `v2`.
  `postal.strategy.ts`, `send-dispatch.service.ts` e `App.tsx` mantengono
  per ora gli stessi letterali (valori identici; sostituirli è un refactor
  separato).

### `POST /notifications`

Header `Idempotency-Key` (stringa 1–255 caratteri) obbligatorio.

```jsonc
{
  "channel": "EMAIL|PEC|APP_IO|SEND|POSTAL",
  "externalReference": "PROT-2026-123",
  "recipient": {
    "type": "PF|PG",
    "taxId": "RSSMRA80A01H501U",
    "fullName": "Mario Rossi",
    "email": "mario.rossi@example.com",
    "pec": "mario.rossi@pec.example.com",
    "address": { "street": "Via Roma 1", "zip": "00100", "municipality": "Roma", "province": "RM", "country": "Italia" }
  },
  "content": { "subject": "Avviso TARI 2026", "body": "<p>...</p>" },
  "attachments": [{ "token": "uuid", "label": "Avviso di pagamento" }],
  "payment": { "noticeCode": "302000000000000000", "amountCents": 12300, "creditorTaxId": "00000000000", "dueDate": "2026-12-31" },
  "sender": { "mailConfigId": "uuid", "pecReserveMailConfigId": "uuid", "ioServiceId": "uuid" },
  "appIoParallel": { "subject": "...", "body": "..." },
  "send": { "taxonomyCode": "010101N", "physicalCommunicationType": "AR_REGISTERED_LETTER" },
  "postal": {
    "serviceType": "Raccomandata", "contractCode": "...", "returnReceipt": true,
    "color": false, "duplex": true, "coverPageId": "...",
    "agol": { "notifierType": "NonUtilizzato", "secondAttempt": "NonRichiedere", "notifierName": "...", "chronologicalNumber": "..." }
  }
}
```

#### Regole di validazione

Statiche (class-validator):

| Campo | Regola |
|---|---|
| `channel` | obbligatorio, enum |
| `externalReference` | opzionale, stringa ≤ 100 |
| `recipient.type` | obbligatorio; `PF` → `taxId` alfanumerico 16; `PG` → `taxId` 11 cifre |
| `recipient.fullName` | obbligatorio per SEND/POSTAL (denominazione PN / intestazione busta); opzionale altrove |
| `recipient.email` | obbligatorio per EMAIL |
| `recipient.pec` | obbligatorio per PEC |
| `recipient.address` | obbligatorio per SEND/POSTAL; vietato altrove. `street`, `municipality` obbligatori; `province` obbligatoria se `country` assente o Italia; `municipality` abbreviato con `abbreviateLongMunicipality` e rifiutato oltre 30 caratteri |
| `content.subject` | obbligatorio per tutti i canali (regola wizard `v1`); APP_IO 10–120 |
| `content.body` | obbligatorio per EMAIL/PEC/APP_IO; **vietato** per SEND/POSTAL; APP_IO 80–10000 su testo HTML-stripped |
| `attachments` | obbligatorio (≥1) per SEND/POSTAL; `token` `@IsUUID` (anti path traversal) |
| `payment` | ammesso solo per SEND e APP_IO; `amountCents` intero > 0; `dueDate` ISO `YYYY-MM-DD` |
| `appIoParallel` | ammesso solo per EMAIL/PEC/POSTAL; per POSTAL `subject`+`body` obbligatori; testo effettivo (override o fallback su `content`) entro i vincoli App IO |
| `send` | ammesso solo per SEND; `taxonomyCode` obbligatorio |
| `postal` | ammesso solo per POSTAL; `agol` ammesso solo se `serviceType` è Agol |

Le regole subject/body/appIoParallel riprendono senza modifiche quelle già
verificate in `create-external-notification.dto.ts` (`IsValidChannelText`,
`IsValidSecondaryAppIo`), adattate ai nuovi nomi dei campi.

Dinamiche (`ExternalCapabilitiesService`, stessa fonte del controller
`/capabilities`, così regole e capabilities non divergono):
- canale attivo, altrimenti `CHANNEL_INACTIVE`;
- `send.taxonomyCode` tra quelli abilitati; suffisso `P` ⇔ `payment`
  presente;
- `send.physicalCommunicationType`, `postal.serviceType`,
  `postal.contractCode`, enum Agol tra i valori ammessi;
- `sender.*` riferiti a config/servizi esistenti e attivi del tipo giusto.

Ogni violazione dà `VALIDATION_ERROR` con `details[]` =
`{ field, message, allowed? }` (`allowed` valorizzato per i valori enumerati).

Campi opzionali omessi → default dichiarato in `/capabilities` (stesso
fallback runtime già presente in strategy/dispatch).

#### Risposta

```jsonc
{ "success": true, "notificationId": "uuid", "status": "accepted" }
```

## Mapping interno

`ExternalNotificationService.create(dto, client, idempotencyKey)`:

### 1. Idempotenza (Redis)

- Chiave `ext:idem:<clientId>:<sha256(Idempotency-Key)>`, TTL 24h.
- `SET NX` con `{ state: 'pending', requestHash }`, dove `requestHash` =
  sha256 del body JSON canonico (chiavi ordinate).
- Chiave esistente:
  - stesso hash e `state: 'done'` → risposta salvata, nessuna nuova notifica;
  - stesso hash e `state: 'pending'` → `IDEMPOTENCY_IN_PROGRESS`;
  - hash diverso → `IDEMPOTENCY_CONFLICT`.
- A creazione riuscita: `{ state: 'done', requestHash, response }`.
- Su errore di validazione/blocco/eccezione: la chiave viene cancellata, il
  client può riprovare con la stessa chiave.

### 2. Validazione dinamica

Vedi sopra.

### 3. Campagna

`CampaignsService.create()` con:
- `name`: `[API] <client.name> — <externalReference ?? ISO timestamp>`;
- `channelType` = `channel`;
- `channelConfig.source = 'external'`;
- **nessun `wizSingleMode`**.

Poi `setExternalClientId(campaign.id, client.id)` come in `v1`.

`wizSingleMode` oggi ha 4 usi in `campaigns.service.ts` (step UI wizard,
skip check firma PDF, skip INAD in `launch()` e in `launchTestSend`, filtro
in una query). Per ciascuno il piano deve verificare il comportamento corretto
per `source = 'external'`. Vincoli già decisi: INAD **attivo** (D5); la
campagna esterna deve comparire nel backoffice come le altre.

### 4. `channelConfig`

| DTO v2 | `channelConfig` |
|---|---|
| `content.subject` / `content.body` | `subject` / `body` |
| `send.taxonomyCode` | `taxonomyCode` |
| `send.physicalCommunicationType` | `physicalCommunicationType` |
| SEND (sempre) | `protocolla: true` |
| `postal.serviceType` | `postalServiceType` |
| `postal.contractCode` | `postalCodiceContratto` |
| `postal.returnReceipt` / `color` / `duplex` | `postalReturnReceipt` / `postalColorPrint` / `postalDuplex` |
| `postal.coverPageId` | `postalIdCoverPage` |
| `postal.agol.notifierType` / `secondAttempt` / `notifierName` / `chronologicalNumber` | `postalAgolTipoNotificante` / `postalAgolSecondoTentativo` / `postalAgolNomeNotificante` / `postalAgolNumeroCronologico` |
| `sender.mailConfigId` / `pecReserveMailConfigId` / `ioServiceId` | stesse chiavi |
| `appIoParallel` | `secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', subjectOverride, bodyOverride }]` |
| `recipient.address` | `physicalAddressConfig: { enabled: true, addressColumn: '_extStreet', zipColumn: '_extZip', municipalityColumn: '_extMunicipality', provinceColumn: '_extProvince', countryColumn: '_extCountry' }` |
| `payment` | `paymentConfig: { enabled: true, amountType: 'cents', noticeNumberColumn: '_extNoticeCode', amountColumn: '_extAmountCents', payeeFiscalCodeType: 'static', payeeFiscalCodeStatic: creditorTaxId, dueDateColumn: '_extDueDate' }` |

Lo schema `physicalAddressConfig` con colonne dedicate è lo stesso già usato
da `updateRecipientAddressAndRetry` (self-bootstrap `_edit*`).

### 5. Destinatario

`addSingleRecipient` viene esteso con `fullName` esplicito (rimosso il
fallback `extraData.full_name`):
- `codiceFiscale` = `recipient.taxId` (P.IVA inclusa, come da CSV);
- `fullName`, `email`, `pec`;
- `extraData` = solo chiavi `_ext*` (indirizzo, pagamento) più
  `allegato_<i>` per gli allegati.

### 6. Allegati, lancio, audit

- Allegati: come `v1` (`tokens.resolve`, copia in `getUploadsDir`,
  `markConsumed`, `channelConfig.attachments`). Token non valido →
  `ATTACHMENT_INVALID`.
- `launch(campaign.id, { username: 'external-api', role: 'admin' })`;
  `blocked` → `LAUNCH_BLOCKED` con il messaggio di `launch()`.
- Audit `EXTERNAL_API_CREATE` con `channel`, `externalReference`, CF
  mascherato (ultime 4 cifre).

### Fix collaterale

`send-dispatch.service.ts`: `recipientType = isPartitaIva(recipient.codiceFiscale) ? 'PG' : 'PF'`.
Vale anche per le campagne da CSV.

## Stato — `GET /notifications/{notificationId}`

Ricerca per `recipient.id`; `campaign.externalClientId` deve coincidere col
client, altrimenti `NOT_FOUND` (stesso messaggio per "non esiste" e "non è
tuo", nessuna enumerazione).

```jsonc
{
  "success": true,
  "notificationId": "uuid",
  "externalReference": "PROT-2026-123",
  "createdAt": "2026-10-01T10:00:00Z",
  "requestedChannel": "POSTAL",
  "effectiveChannel": "PEC",
  "diversion": { "source": "INAD" },
  "status": "delivered",
  "legal": { "outcome": "delivered", "at": "2026-10-01T10:05:00Z", "reason": "Via PEC" },
  "send": { "iun": "...", "status": "VIEWED", "legalDate": "...", "protocol": { "number": 123, "year": 2026, "at": "..." } },
  "postal": { "trackingId": "...", "status": "Consegnato", "deliveryStatus": "...", "deliveryDate": "..." },
  "appIoParallel": { "success": true },
  "costCents": 850,
  "error": null,
  "events": [{ "id": "sha1", "type": "accepted", "at": "...", "data": {} }]
}
```

- `externalReference`: salvato in `channelConfig.externalReference`.
- `effectiveChannel`: `channelType` dell'ultimo attempt; `diversion` da
  `recipient.inadCheck.diverted`: fonte `REGISTRO_IMPRESE` se il taxId è una
  P.IVA, altrimenti `INAD`; `null` se non dirottata. L'indirizzo trovato non è
  persistito per i dirottamenti applicati e non viene esposto.
- Blocchi `send`/`postal`/`appIoParallel` presenti solo se pertinenti
  (omessi, non `null`).
- `legal`:
  - POSTAL e POSTAL dirottata: `postalLegalOutcome()` (stessa funzione delle
    viste admin, include verifica Poste e ramo dirottato);
  - SEND: `outcome: 'delivered'` con `at = sendLegalDateOf()` quando
    valorizzata; `not_delivered` su attempt `failed` o `sendStatus` in
    {`UNREACHABLE`, `CANCELLED`, `REFUSED`}; altrimenti `in_progress`;
  - EMAIL/PEC/APP_IO non dirottate: blocco omesso.
- `error`: stessa regola di `v1` (`errorMessage` su `failed`, altrimenti per
  POSTAL l'ultimo `codiceErrore !== '0'`).
- `costCents`: `attempt.costCents`.

### `status` (riassunto trasversale)

| Condizione | `status` |
|---|---|
| destinatario creato, nessun attempt, `campaign.status` ≠ `checking_inad` | `accepted` |
| `campaign.status = checking_inad` (check INAD/Registro Imprese bulk in corso) | `checking` |
| destinatario `PENDING_REVIEW` | `pending_review` |
| attempt `queued`/`processing` | `in_progress` |
| attempt `success`, `legal` assente o `in_progress` | `sent` |
| `legal.outcome = delivered` | `delivered` |
| `legal.outcome = not_delivered` | `not_delivered` |
| attempt `failed` | `failed` |
| attempt/campagna `cancelled` | `cancelled` |

EMAIL e APP_IO si fermano a `sent` (nessuna prova di consegna).

### `events[]`

Derivati in lettura, senza tabella nuova, ordinati per `at` crescente.

| Fonte | `type` |
|---|---|
| `recipient.createdAt` | `accepted` |
| `inadCheck.diverted` | `diverted` |
| `recipient` in `PENDING_REVIEW` | `pending_review` |
| `attempt.sentAt` | `sent` |
| `attempt.protocolledAt` | `protocolled` |
| `sendStatusHistory[]` | `send_status` (`data.status`) |
| `postalStatusHistory[]` | `postal_status` (`data.stato`, `data.codiceErrore?`) |
| verifica Poste (`postal_poste_tracking`) | `poste_tracking` (`data.status`) |
| attempt `failed` | `failed` (`data.error`) |

`id = sha1(type | at | valore significativo)`: stabile tra letture. Un futuro
webhook memorizzerà per notifica gli id già consegnati e invierà la
differenza, senza cambiare contratto (D7).

Al massimo 4 query per richiesta (destinatario + campagna, attempt, verifica
Poste, nessun join pesante).

## `POST /domicilio/cerca`

Body `{ taxId }`: 16 caratteri alfanumerici (CF) oppure 11 cifre (P.IVA).
Delega a `DomicilioService.cercaDomicilio()` (già instrada le P.IVA al
Registro Imprese). Risposta `{ success: true, ...DomicilioSearchResult }`,
documentata in OpenAPI con il blocco `registroImprese`. Audit
`EXTERNAL_DOMICILIO_SEARCH` con taxId mascherato.

## Errori

Forma unica `{ success: false, error: { code, message, details? } }`, HTTP
200, via `ExternalApiExceptionFilter`.

| code | quando |
|---|---|
| `UNAUTHORIZED` | `X-Api-Key` mancante o non valida |
| `VALIDATION_ERROR` | DTO non valido o valore fuori dalle capabilities (`details[]`) |
| `CHANNEL_INACTIVE` | canale non configurato o non attivo |
| `IDEMPOTENCY_CONFLICT` | stessa `Idempotency-Key` con payload diverso |
| `IDEMPOTENCY_IN_PROGRESS` | stessa chiave, richiesta precedente ancora in corso |
| `ATTACHMENT_INVALID` | token allegato scaduto, consumato o di altro client |
| `LAUNCH_BLOCKED` | `launch()` bloccato |
| `NOT_FOUND` | notifica inesistente o di altro client |
| `INTERNAL_ERROR` | eccezione non gestita (capture GlitchTip già presente) |

## Sicurezza

- `ApiKeyGuard`, hash delle chiavi e CRUD `admin/external-clients` invariati.
- Token allegato `@IsUUID`.
- Nessun PII in log applicativi; audit con taxId mascherato.
- `/capabilities` senza segreti né host/credenziali.
- Requester sintetico admin al lancio (come `v1`): il confine di sicurezza è
  `ApiKeyGuard`; bypassa l'allowlist POSTAL per design.

## Rimozioni

- Controller/DTO `v1`: `external-notifications.controller.ts`,
  `external-capabilities.controller.ts`, `external-domicilio.controller.ts`,
  `external-attachments.controller.ts` (spostati a `v2`),
  `create-external-notification.dto.ts`, `cerca-domicilio-external.dto.ts`
  e relativi spec.
- `apps/backend/openapi/external-api.yaml` → sostituito da
  `external-api-v2.yaml`.
- `CampaignsService.getExternalDeliveryStatus` e `ExternalDeliveryStatusDto`
  (sostituiti dal nuovo servizio di stato).

## Test

Unit (Vitest):
- validazione DTO: una regola per canale, casi positivi e negativi;
- validazione dinamica contro capabilities (tassonomia + suffisso P/N,
  servizio, contratto, sender, canale inattivo);
- mapping DTO → `channelConfig`/destinatario per ogni canale;
- idempotenza: replay, conflitto, in corso, cancellazione su errore;
- derivazione `status`/`legal`/`events` con fixture SEND, POSTAL, POSTAL
  dirottata, PEC PG in `PENDING_REVIEW`;
- `recipientType` PG in `send-dispatch.service.ts`.

Integrazione: estendere `external-api-http-status.integration.spec.ts`
(boot reale dell'app Nest + HTTP) per ogni endpoint `v2` — intercetta 201 vs
200 e provider non esportati (gotcha noti in
`docs/claude/external-api-module.md`).

E2E manuale in dev: script Node sotto `apps/backend/src/debug/` (upload a
chunk + creazione + polling stato) per EMAIL, PEC, APP_IO, SEND (ambiente
test PN). POSTAL contro GlobalCom reale **solo con conferma esplicita
dell'utente** (costo reale).

Criterio: failure set della suite identico alla baseline (1 fallimento noto
`app.controller.spec.ts`).

## Documentazione e rilascio

- `apps/backend/openapi/external-api-v2.yaml` (OpenAPI 3.0.3, versione 2.0.0)
  con esempi per canale.
- `docs/claude/external-api-module.md` aggiornato (contratto v2, mapping
  `_ext*`, regola `source = 'external'`).
- README: sezione API esterna aggiornata.
- Breaking change: numero di versione scelto dall'utente al tag.

## Fuori scope

- Endpoint a lotto (`POST /batches`) — reso possibile da D3, non
  implementato.
- Webhook — reso possibile da D7, non implementato.
- Rate-limit per client.
