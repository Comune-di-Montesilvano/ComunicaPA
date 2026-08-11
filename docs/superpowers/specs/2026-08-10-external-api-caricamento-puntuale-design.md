# API esterna per caricamento puntuale — design

Data: 2026-08-10

## Obiettivo

Permettere a un sistema PA esterno di far partire, via chiamata API server-to-server, una notifica puntuale (un destinatario per chiamata) su uno qualunque dei canali esistenti (EMAIL/PEC/APP_IO/SEND/POSTAL), senza passare dal wizard admin. Ogni chiamata crea ex-novo una campagna a singolo destinatario con canale/oggetto/testo/allegati passati nel payload stesso.

## Fuori scope (YAGNI, v1)

- Restrizione canali abilitati per client (tutti i client possono usare tutti i canali).
- Co-consegna App IO secondaria dal path esterno (solo canale primario).
- Rate limiting applicativo per client (nessun caso d'uso noto che lo richieda oggi).
- mTLS / esposizione diretta backend fuori dai nginx frontend esistenti.

## Architettura

Nuovo modulo backend `apps/backend/src/external-api/`:

- **Entity `ExternalApiClient`** (`external_api_clients`): `id`, `name`, `apiKeyHash` (SHA-256), `active` (bool), `createdAt`, `lastUsedAt`. Nuova migration.
- **`Campaign`** guadagna colonna nullable `externalClientId` (FK verso `external_api_clients`) — stesso ruolo di scoping già svolto da `createdBy` per gli operatori (`assertOwnership()`), qui usato per il polling stato. Migration separata o accorpata.
- **`ApiKeyGuard`**: legge header `X-Api-Key`, hash SHA-256, lookup client `active=true`, attacca `req.apiClient`. Aggiorna `lastUsedAt` (fire-and-forget, non blocca la risposta).
- **Prefix bare `external/v1/*`** (non `admin/*`/`citizen/*`, stesso trattamento di `public/download/*`). Controller marcato `@Public()` (bypassa `JwtAuthGuard`/`RolesGuard` globali via `APP_GUARD`) + `@UseGuards(ApiKeyGuard)` proprio.
- **Nessuna modifica nginx**: `/api/` su frontend-admin già stripa il prefisso e proxya tutto a `backend:8080/` (vedi gotcha "Topologia API" in CLAUDE.md) — `/api/external/v1/...` funziona da subito.
- **CRUD gestione client** sotto `admin/external-clients` (dentro guardie JWT standard, `@Roles('admin')`), stesso pattern di `PostalProvidersController`.

## Gestione errori — SEMPRE HTTP 200

Il reverse proxy esterno di produzione (davanti ai frontend, vedi CLAUDE.md "Reverse proxy esterno in produzione — gotcha critico") sostituisce il body di qualunque risposta non-2xx con una pagina HTML propria, rendendo illeggibile un payload di errore JSON per un chiamante esterno.

Tutto `external/v1/*` risponde **sempre HTTP 200**, esito espresso nel body:

```json
// successo lancio
{ "success": true, "campaignId": "...", "status": "QUEUED" }

// successo polling
{ "success": true, "campaignId": "...", "status": "...", "channelType": "...", "delivery": { ... } }

// errore (validazione, auth, not-found, interno)
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [ ... ] } }
```

Codici errore usati: `UNAUTHORIZED` (api key mancante/invalida/revocata), `VALIDATION_ERROR` (payload non valido), `NOT_FOUND` (campagna non trovata o non di proprietà del client — mai distinguere i due casi nel messaggio, per non fare enumeration), `LAUNCH_BLOCKED` (bloccato da `launch()`, es. allegato mancante), `INTERNAL_ERROR` (fallback).

Implementazione: `ExternalApiExceptionFilter` (`@Catch()` globale sul modulo, applicato via `@UseFilters` a livello di controller) intercetta QUALUNQUE eccezione (HttpException di Nest, errori di class-validator, errori non gestiti) e la normalizza sempre a `200 { success:false, error:{...} }`. Nessun endpoint di questo modulo deve lanciare un'eccezione che sfugge al filtro.

## Endpoint

### 1. Upload allegato (opzionale — solo se il payload di lancio referenzia `attachmentTokens`)

Riusa `chunked-upload.util.ts` (stesso pattern già usato da campagne/allegati/arricchimento/io-services):

- `POST external/v1/attachments/upload/init` → `{ success:true, uploadId }`
- `POST external/v1/attachments/upload/chunk` (multipart, stesso binario 512KB lato client)
- `POST external/v1/attachments/upload/complete` → `{ success:true, attachmentToken }`

`attachmentToken` è un id opaco che referenzia il file assemblato in una cartella scoped per client (`getUploadsDir()/external/<clientId>/<token>.pdf` o equivalente). TTL pulizia: nuovo cron leggero (stesso schema di `EnrichmentRetentionService`), es. 24h — un token non consumato da un lancio entro quella finestra viene eliminato.

### 2. Lancio — `POST external/v1/notifications`

Payload (`CreateExternalNotificationDto`, discriminato per `channelType`):

- `channelType`: `EMAIL|PEC|APP_IO|SEND|POSTAL`
- dati destinatario: `codiceFiscale`, `nome`, `cognome`, e il campo canale-specifico obbligatorio (`email`/`pec`/indirizzo postale completo per POSTAL/SEND)
- `subject`, `body` (per canali con contenuto testuale — non usato per POSTAL, vedi gotcha "channelConfig.body/subject NON sono il contenuto reale inviato" in CLAUDE.md, resta comunque richiesto per App IO co-consegnata se in futuro riabilitata)
- `attachmentTokens: string[]` (obbligatorio non-vuoto per SEND/POSTAL)
- `protocolla: boolean` (obbligatorio `true` per SEND, stesso vincolo di `assertSendProtocolConfigured`)

Flusso server-side (`ExternalApiService.createAndLaunch()`):

1. Valida DTO (vedi sezione Validazione sotto) → su fallimento, `VALIDATION_ERROR`.
2. Risolve `attachmentTokens` in path reali su disco, costruisce `channelConfig.attachments`.
3. Crea `Campaign` (`channelType`, `channelConfig` con `wizSingleMode: true` e `attachments`, `externalClientId: req.apiClient.id`, `createdBy: 'external:' + client.name`, status `DRAFT`).
4. Crea singolo `Recipient` da payload.
5. Chiama `campaignsService.launch(campaign.id)` — **riuso diretto**, nessuna duplicazione: eredita gratis il check protocollo SEND, il blocco allegato mancante, lo skip INAD (già gated su `wizSingleMode===true`).
6. Se `launch()` ritorna `{ blocked:true, message }` → risposta `{ success:false, error:{ code:'LAUNCH_BLOCKED', message } }` (stesso 200).
7. Successo → `{ success:true, campaignId, status:'QUEUED' }`.
8. Audit log: `AuditLogsService.log({ campaignId, operator:'external:'+client.name, action:'EXTERNAL_API_CREATE', details:{ channelType } })`.

### 3. Stato — `GET external/v1/notifications/:campaignId`

- Verifica `campaign.externalClientId === req.apiClient.id`, altrimenti `{ success:false, error:{code:'NOT_FOUND'} }` (stesso messaggio sia per "non esiste" sia per "non tuo", niente enumeration).
- Ritorna `status` campagna + stato canale-specifico dell'unico attempt/recipient (`sendStatus`/`postalStatus`/errori se presenti) — stessa logica di lettura già usata da `getSendStatusBreakdown`/`getPostalStatusBreakdown`, applicata a singolo recipient.

## Validazione — gate nuovo, oggi non esiste lato backend

CF/email/lunghezza App IO sono validati **solo lato frontend wizard** (`App.tsx`) — nessun controllo equivalente esiste oggi nel backend. Questa API bypassa il wizard: deve essere l'unico gate, quindi introduce validazione server-side mai esistita finora in questo repo:

- Regex CF (16 alfanumerici, pattern standard italiano)
- Regex email/PEC basic
- Campo destinazione canale-specifico obbligatorio in base a `channelType`
- App IO: `subject` lunghezza [10,120], `body` lunghezza [80,10000] — stesso vincolo PagoPA già noto (`APP_IO_SUBJECT_MIN/MAX` lato frontend), replicato qui per la prima volta lato backend
- SEND/POSTAL: `attachmentTokens` non vuoto (fail-fast leggibile prima di toccare `launch()`, che lo ribloccherebbe comunque ma con messaggio meno specifico)
- `protocolla: true` obbligatorio se `channelType==='SEND'`

Implementata con `class-validator` + validator custom per il discriminante canale (`@ValidateIf` su `channelType`).

## UI admin — gestione client esterni

Nuova tab Impostazioni "API Esterne", stesso pattern di `renderPostalProvidersTab` (`App.tsx`):

- Tabella: nome, stato (attivo/revocato), creato il, ultimo utilizzo (`lastUsedAt`)
- "Nuovo client" → modal, genera key random (32 byte, base64url), mostrata **una sola volta** in chiaro subito dopo la creazione (solo l'hash SHA-256 viene persistito) con bottone copia
- "Rigenera key" → invalida vecchio hash, mostra nuova key una volta (stesso modal)
- "Revoca" → `active=false`, non cancella il record (storico audit/chiamate resta consultabile)
- Nessuna restrizione per-canale in v1 (YAGNI)

Backend: `admin/external-clients` CRUD (`list` mascherato senza hash, `create`, `regenerate-key`, `revoke`), `@Roles('admin')`, loggato su `AuditLogsService` come le altre azioni admin.

## Test

- `ApiKeyGuard`: key valida / mancante / invalida / client revocato
- `CreateExternalNotificationDto`: casi limite per canale (App IO lunghezza subject/body ai bordi, CF malformato, campo destinazione mancante, SEND senza `protocolla`, SEND/POSTAL senza `attachmentTokens`)
- `ExternalApiExceptionFilter`: verifica che OGNI tipo di eccezione lanciata dentro il modulo produca sempre status 200
- `ExternalApiService.createAndLaunch()`: mock di `campaignsService.launch()` per i tre esiti (successo, `blocked`, eccezione)
- `admin/external-clients`: CRUD + verifica che la key in chiaro non sia mai ritornata da `list()`/`regenerate-key` response oltre alla creazione/rigenerazione stessa

## Addendum — discovery capacità istanza + lookup domicilio digitale (auto-descrittività)

Emerso in revisione: il client esterno sceglieva `channelType` alla cieca, senza modo di sapere se quel canale è realmente configurato su questa istanza (mail server attivo? provider POSTAL attivo con quali Servizio/contratti? servizio App IO configurato? SEND con quali codici tassonomia?), scoprendolo solo a posteriori da un `LAUNCH_BLOCKED`. Inoltre, per evitare che INAD dirotti a sorpresa un canale scelto dal client (comportamento bulk oggi disabilitato per `wizSingleMode`, ma il client non ha comunque modo di sapere a priori il vero domicilio digitale del CF), serve un endpoint di lookup dedicato — lo stesso principio già in uso per l'operatore in wizard (step1 "Carica dati ANPR", che risolve il domicilio A MANO prima di scegliere il canale).

### `GET external/v1/capabilities`

Riflette lo stato configurato REALE dell'istanza, stessa fonte dati che alimenta la UI wizard — nessun valore hardcoded/duplicato:

```json
{
  "success": true,
  "channels": {
    "EMAIL": { "active": true },
    "PEC": { "active": true },
    "APP_IO": { "active": false },
    "SEND": { "active": true, "enabledTaxonomyCodes": ["..."], "requiresGroup": true },
    "POSTAL": { "active": true, "enabledServiceTypes": ["Raccomandata1Market", "..."], "contratti": [{ "codiceContratto": "...", "descrizione": "...", "tipologia": "...", "estero": false }] }
  },
  "appIoSecondary": { "available": false }
}
```

Fonti (sola lettura, nessuna nuova persistenza):
- EMAIL/PEC: `MailConfigsService.listMasked()`, `active = entries.some(e => e.type === X && e.active)`
- APP_IO / `appIoSecondary`: `IoServicesService.resolveApiKey()` → `active = risultato !== null`
- SEND: `AppSettingsService.get('send.enabledTaxonomyCodes')` (parse array) + `send.{environment}.group` per `requiresGroup`
- POSTAL: `PostalProvidersService.getActive()` → `active = risultato !== null`, `enabledServiceTypes`/`contratti` dal provider attivo (stesso dato già scoperto dal tasto "Test" — vedi sezione POSTAL principale di CLAUDE.md)

Endpoint pubblico dietro `ApiKeyGuard` (stesso auth degli altri), nessun audit log (sola lettura di configurazione, nessun dato personale coinvolto).

### `POST external/v1/domicilio/cerca`

Wrapper diretto di `DomicilioService.cercaDomicilio(codiceFiscale, operatorLabel)` — stesso orchestratore ANPR+INAD+App IO già usato da `admin/domicilio/cerca` per l'operatore in wizard, nessuna logica duplicata. Payload `{ codiceFiscale: string }`, risposta (sempre 200, pattern comune al modulo):

```json
{ "success": true, "codiceFiscale": "...", "inad": {...}, "appIo": {...}, "anpr": {...}, "anprEsistenzaInVita": {...} }
```

Il client interroga il CF **prima** di chiamare `POST notifications`, legge da `inad`/`appIo`/`anpr` il domicilio digitale reale del destinatario, sceglie `channelType` di conseguenza. Poiché la campagna nasce già con `wizSingleMode: true` (vedi `ExternalApiService.createAndLaunch`), il check INAD automatico bulk resta skippato lato server — la responsabilità della scelta canale è del client, informato da questo endpoint.

**Audit log obbligatorio** (gotcha noto: "ogni endpoint che consulta un registro esterno con dati personali deve loggare operatore+CF cercato"): `AuditLogsService.log({ operator: 'external:'+client.name, action: 'EXTERNAL_DOMICILIO_SEARCH', details: { codiceFiscale } })`.

### Eccezione — App IO parallela

Anche con canale primario già risolto correttamente dal client via lookup, resta un caso legittimo di multi-canale: co-consegna App IO in parallelo (mai esclusiva — l'esclusiva presuppone un check di dirottamento che qui il client ha già fatto interrogando `domicilio/cerca`, non ha senso riproporlo). `CreateExternalNotificationDto` guadagna:

```typescript
secondaryAppIo?: { subjectOverride?: string; bodyOverride?: string }
```

Mappato da `ExternalApiService` su `channelConfig.secondaryChannels = [{ channel: 'APP_IO', mode: 'parallel', subjectOverride, bodyOverride }]` — stesso formato già risolto da `resolveSecondaryAppIoConfig()` (`secondary-channels.util.ts`), nessuna nuova logica di invio lato canale, solo nuovo punto di scrittura della config.

## Addendum — regole subject/body per canale, parità con la UI wizard

Investigazione mirata (durante l'implementazione, in fase di code review) su quale gate reale del wizard admin governa l'obbligatorietà di `subject`/`body` per ciascun canale, per garantire che `CreateExternalNotificationDto` rifiuti esattamente ciò che il wizard rifiuterebbe — nessuna divergenza silenziosa tra i due percorsi di creazione campagna.

**Attenzione al gate giusto**: `ExternalApiService.createAndLaunch()` imposta sempre `channelConfig.wizSingleMode = true` — l'equivalente wizard di ogni chiamata esterna è **sempre** un invio singolo, mai bulk-CSV. In `wizSingleMode`, lo step "Template" (dove vive il gate più visibile, `App.tsx` righe ~10455-10469/10672-10686) viene **saltato del tutto per SEND e POSTAL** (`wizSingleNeedsTemplateStep = channelType==='EMAIL'||'PEC'||'APP_IO'`, `App.tsx:1855` — SEND/POSTAL esclusi). Il gate realmente eseguito per questi due canali in modalità singola è quello dei bottoni finali "Avvia Test"/"Conferma ed Avvia Campagna" (`App.tsx:11021`/`:11029`, duplicato `:11172`/`:11180`):

```js
disabled = wizSending || (wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim())
```

Per SEND/POSTAL questo si riduce a `!wizSubject.trim()` **incondizionato** — un bug reale è stato inizialmente introdotto in questo stesso branch usando il gate step4 (mai raggiunto per questi canali), che rendeva `subject` opzionale per POSTAL invece che sempre obbligatorio. Qualunque futura modifica alle regole di contenuto per SEND/POSTAL deve partire da QUESTO gate, non dal gate step4/Riepilogo.

### Tabella finale per canale (verificata riga per riga contro `App.tsx`)

| Canale | `subject` | `body` | `secondaryAppIo` |
|---|---|---|---|
| EMAIL | obbligatorio | obbligatorio (lunghezza libera) | opzionale; se assente override, il fallback su subject/body principali deve rispettare comunque [10,120]/[80,10000] (vincolo PagoPA — `body` misurato su testo HTML-stripped, non caratteri di markup grezzi) |
| PEC | obbligatorio | obbligatorio (lunghezza libera) | idem EMAIL |
| APP_IO | obbligatorio, [10,120] | obbligatorio, [80,10000] su testo HTML-stripped | **rifiutato** — selettore mai renderizzato nel wizard per canale primario App IO |
| SEND | obbligatorio (gate step6 single-mode) | **rifiutato se valorizzato** — campo mai renderizzato per SEND | **rifiutato** — n/a nel wizard |
| POSTAL | **obbligatorio sempre** (gate step6 single-mode, incondizionato — non legato a `secondaryAppIo`) | **rifiutato se valorizzato** — POSTAL non ha mai contenuto testuale reale (l'invio è l'allegato) | opzionale; se presente, `subjectOverride`+`bodyOverride` **entrambi obbligatori** — non per parità wizard-gate stretta, ma perché senza override `app-io-delivery.service.ts` ricadrebbe su `channelConfig.body` (sempre assente per POSTAL) → stringa vuota → PagoPA rifiuta con HTTP 400 al momento dell'invio reale; bloccato qui in validazione invece di fallire asincronamente a valle |

Lunghezza `body` misurata con `stripHtmlForLength()` (stessa regex del wizard, `wizPlainTextLength()`: strip tag HTML + `&nbsp;` + trim) — mai sui caratteri HTML grezzi, altrimenti un body con markup pesante e poco testo visibile passerebbe a torto sotto al minimo reale, o un body riccamente formattato verrebbe rifiutato sopra un massimo mai realmente raggiunto in testo visibile. `subject` resta misurato su `.length` grezzo (campo plain-text, non HTML).

## Specifica OpenAPI

Il modulo `external-api` è l'unica superficie di questo backend pensata per essere consumata da terzi esterni senza contesto pregresso (a differenza di `admin/*`/`citizen/*`, integrati coi rispettivi frontend nello stesso repo) — richiede quindi una spec OpenAPI 3.x dedicata, non solo Swagger decorator generici:

- File `apps/backend/openapi/external-api.yaml`, scritto/mantenuto a mano (non solo auto-generato da `@nestjs/swagger`, per poter documentare esplicitamente il pattern "sempre 200 con `success:false`" — un tool di generazione automatica da decorator Nest tende a inferire status code standard 4xx/5xx dagli `HttpException`, che qui non riflettono la realtà del filtro).
- Copre i 5 endpoint (`attachments/upload/{init,chunk,complete}`, `notifications` POST, `notifications/{campaignId}` GET), schema request/response completo per ognuno, inclusi tutti gli `error.code` enumerati sopra.
- `securitySchemes`: `apiKey` (`in: header`, `name: X-Api-Key`).
- Esempi realistici per ciascun `channelType` (payload minimo EMAIL/PEC vs payload completo SEND/POSTAL con `attachmentTokens`+`protocolla`).
- Validare la spec con un linter OpenAPI (es. Spectral, se già disponibile nella toolchain, altrimenti solo validazione sintattica YAML) prima di considerarla parte della definizione di "fatto" per questa feature.

## Migration

Due migration (o una unica se generate insieme dallo stesso diff):

1. `CreateExternalApiClients` — nuova tabella `external_api_clients`
2. `AddExternalClientIdToCampaign` — colonna nullable + FK su `campaigns`

Generate con DB temporaneo (pattern standard CLAUDE.md), registrate esplicitamente nell'array `migrations` di `database.module.ts` (gotcha noto: migration scritta ma non registrata è invisibile, nessun errore).
