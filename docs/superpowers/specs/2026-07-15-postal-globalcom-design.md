# Postalizzazione reale via GlobalCom SOAP — Design

Data: 2026-07-15

## Contesto

Il canale `POSTAL` oggi (`apps/backend/src/channels/postal/postal.strategy.ts`)
non fa invio reale: si limita a timbrare un PDF con un numero di protocollo
ad-hoc (`PdfService.stampWithProtocol`) e restituisce l'id del PDF timbrato
come `messageId`. Nessuna spedizione fisica avviene — presumibilmente il PDF
timbrato veniva stampato/spedito manualmente fuori da ComunicaPA.

Il Comune ha un'utenza sul servizio di postalizzazione **GlobalCom**
(`corrispondenzadigitale.it`, web service SOAP `GBCWebservice.asmx`) che
spedisce realmente lettere/raccomandate tramite Poste Italiane. Obiettivo:
integrare l'invio reale, mantenendo lo stesso comportamento multicanale già
disponibile per gli altri canali (App IO parallela/esclusiva, protocollazione
facoltativa), invece di introdurre un percorso speciale come è stato
necessario per SEND.

Fonti verificate: WSDL raw (`GBCWebservice.asmx?wsdl`) e manuale tecnico
ufficiale GlobalCom v5.26 (24/06/2025, scaricato e letto con `pdftotext`) —
non ci si è fidati di un riassunto AI del solo WSDL, che aveva inizialmente
fatto concludere (erroneamente) che non esistesse un'operazione di poll-stato.

## Perché POSTAL resta un canale BullMQ (a differenza di SEND)

SEND è diventato "pipeline a demoni" (`SendDispatchService`+
`SendStatusSyncService` pollano `NotificationAttempt` fuori da BullMQ) per un
motivo specifico: l'invio a PN è un atto legale, e un retry BullMQ automatico
su un job "fallito" per un timeout di rete rischiava una seconda notifica
legale reale. GlobalCom non ha questo rischio nella stessa misura — resta
comunque protetto da `idempotenceToken`-equivalente lato nostro (nessun
retry automatico BullMQ configurato oltre il default), e **beneficia** di
restare su BullMQ: pausa/riprendi/job falliti/log per singolo invio dalla tab
Motori, gratis, senza reinventare l'endpoint bespoke che SEND ha dovuto
costruire (`admin/engines/send/stage-counts`) per compensare l'assenza della
UI generica.

Quindi: **`POSTAL` resta un `EngineName`/`NotificationChannel` su BullMQ**,
`PostalStrategy.send()` viene riscritta per fare l'invio reale invece di
limitarsi a timbrare un PDF, la coda/processor/UI esistenti restano invariati.

## 1. `PostalStrategy.send()` — invio reale

Rimuove la timbratura ad-hoc (`PdfService.stampWithProtocol`, stamp
`TARI/<CF>/<data>` generato al volo) — non serve più: se la campagna ha
`channelConfig.protocolla=true`, il numero di protocollo vero arriva già
scritto su `attempt.protocolNumber`/`protocolYear` dal
`ProtocollazioneProcessor` (stesso meccanismo generico già usato da SEND e
opzionale per gli altri canali — **nessuna modifica lì**, POSTAL già passa
per quel path oggi tramite `channelConfig.protocolla`).

Il PDF da spedire si genera con `AttachmentService.generatePdfBuffer()`
(stesso metodo usato da SEND/`ProtocollazioneProcessor`, riusa il template e
gli allegati configurati in `channelConfig` via `resolveAttachmentsConfig`)
invece del vecchio `pdfTemplateId` singolo scalare.

### Libreria SOAP

Nuova dipendenza `soap` (npm) — nessuna dipendenza SOAP esiste oggi nel
backend. Va aggiunta a `apps/backend/package.json` seguendo la procedura
`pnpm-lock.yaml` documentata in CLAUDE.md (install --lockfile-only fuori
Docker, poi rebuild immagine + rimozione volume `node_modules`).

### Sessione

Il web service usa autenticazione a sessione con cookie ASP.NET (confermato
dal manuale, ogni esempio usa `CookieContainer` condiviso fra `Login` e le
chiamate successive sullo stesso client). Pattern: un client SOAP nuovo per
ogni `send()`, jar di cookie dedicato, `Login(user, password, gruppo)` poi
`invio_ext_singolo(Invio)` sullo stesso client — nessun riuso di sessione fra
richieste diverse (stateless fra pod, evita gestione scadenza sessione
condivisa). `Login` fallito → eccezione retryable (comportamento BullMQ
standard, job va in retry/failed come per gli altri canali in caso di errore
di rete/credenziali).

### Payload `invio_ext_singolo` (`InfoGUIDExt`)

| Campo | Valore |
|---|---|
| `Servizio` | `channelConfig.postalServiceType` (`Lettera` \| `Raccomandata`, default `Raccomandata`) |
| `RicevutaDiRitorno` | `channelConfig.postalReturnReceipt` (bool, AR — ha senso solo con `Raccomandata`) |
| `Mittente` | da settings `postal.mittente.*` se configurato; altrimenti `UsaMittentePredefinito=true` (usa mittente predefinito dell'utenza GlobalCom, feature disponibile dalla v4.0.0.20 del loro servizio) |
| `Destinatari[0]` | da `resolvePhysicalAddress(recipient, channelConfig.physicalAddressConfig)` — **riuso diretto** dell'utility già scritta per SEND (`apps/backend/src/channels/payment-config.util.ts`), stesso meccanismo di column-mapping CSV via `extraData`, nessuna nuova colonna su `Recipient` |
| `Protocollo` | `${attempt.protocolNumber}/${attempt.protocolYear}` se protocollazione attiva, altrimenti omesso |
| `Note` | `attempt.id` (UUID) — usato come token di dedup, vedi sotto |
| `Files[0]` | PDF via `generatePdfBuffer()`, `MD5` calcolato con `crypto.createHash('md5')` sul buffer, `filetype: 'pdf'` |
| `CentrodiCosto` | da settings `postal.centroDiCosto`, opzionale |
| `DaConfermare` | non impostato (default `false`) — vedi nota sotto |
| `UserData1` | opzionale, da `channelConfig.userDataColumn` — riconciliazione col gestionale tributi, vedi sotto |

### Riconciliazione gestionale tributi (`UserData1`)

Nessun campo dedicato "OCR"/"Maggioli" nell'API — `UserData1`/`UserData2` su
`InfoGUIDExt` sono testo libero, salvati verbatim nello storico GlobalCom e
quindi presenti nel tracciato esportabile dal portale, introdotti apposta
per "customizzazioni specifiche cliente" (manuale §3.5). È il meccanismo
giusto per portare un riferimento (es. numero avviso/codice pratica) che il
gestionale tributi (Maggioli o altro) possa poi riassociare importando
l'export GlobalCom.

Valore per-destinatario, non fisso per campagna: `channelConfig.userDataColumn`
(nome colonna CSV, risolta via `getColumnValue(recipient, columnName)` —
stessa utility già usata da `resolvePhysicalAddress`, in
`payment-config.util.ts`). Campo opzionale nel wizard: se non configurato,
`UserData1` resta vuoto, nessun impatto sull'invio.

### Dedup su retry — GlobalCom non ha `IdempotenceToken` su `InfoGUIDExt`

A differenza di PN/SEND (`InfoGUIDPND.IdempotenceToken`, verificato nel
manuale — quel campo esiste **solo** sulla classe usata da SEND, non su
`InfoGUIDExt`), l'endpoint Lettera/Raccomandata non ha idempotenza nativa:
un retry BullMQ dopo un crash "ambiguo" (la richiesta SOAP è partita, ma non
sappiamo se GlobalCom l'ha accettata prima del crash) rischierebbe un
doppio invio reale — e quindi un doppio addebito, a differenza di EMAIL/PEC
dove un reinvio duplicato è solo fastidioso.

Il rischio esiste solo sui **retry**, non al primo tentativo (`job.attemptsMade
=== 0`): la prima volta non può esserci ambiguità, niente è ancora stato
tentato. `IChannelStrategy.send()` viene esteso con un parametro opzionale
`attemptsMade?: number` (passato da `job.attemptsMade` in
`notification.processor.ts:187`); le altre strategy lo ignorano.

Quando `attemptsMade > 0`, prima di chiamare `invio_ext_singolo`,
`PostalStrategy` cerca su GlobalCom stesso un invio precedente per questo
attempt: `lista_documenti(Filtri: { Testo: attempt.id, SoloTesto: true,
Limite: 1 })` — la ricerca testuale del manuale (§3.6) cerca su
`PROTOCOLLO`/`LOTTO`/**`NOTE`**, campo dove scriviamo l'`attempt.id`.

- Trovato un risultato con `Stato` diverso da `Errore`/`Eliminato` → **non
  reinvio**: riuso l'`IDPRO` trovato come `messageId`, log esplicito
  ("invio già presente su GlobalCom per questo attempt, salto reinvio
  duplicato").
- Nessun risultato, o solo risultati `Errore`/`Eliminato` (il tentativo
  precedente è davvero fallito/rimosso) → procedo con `invio_ext_singolo`
  normale.

Verifica fatta contro il database di GlobalCom stesso (fonte di verità
esterna), non contro il nostro DB — più robusto della guardia generica
anti-redelivery già presente in `notification.processor.ts:93-124`, che
controlla la chiave `notificationRequestId` nel `responsePayload` (retaggio
SEND) e quindi non copre POSTAL, il cui `responsePayload` non ha quella
chiave.

Se `resolvePhysicalAddress` ritorna `null` (colonne indirizzo non mappate o
vuote per quel destinatario), il job fallisce con errore esplicito
("indirizzo destinatario non risolvibile, verifica mapping colonne CSV in
configurazione canale") — stesso trattamento di un campo obbligatorio
mancante negli altri canali (es. PEC senza `recipient.pec`).

**Nota `DaConfermare`**: verificato sul manuale che la conferma post-invio
(`lista_documenti_da_confermare`/`AutorizzaLottoInvio`) scatta solo se
l'utenza GlobalCom configurata ha soli diritti di "inserimento" (non invio),
oppure se si imposta esplicitamente `DaConfermare=true`. Non è un preventivo
di costo obbligatorio (quello, `RichiestaCostoTelegramma`, esiste solo per
`Telegramma`, non pertinente a Lettera/Raccomandata). V1: si presuppone che
l'utenza GlobalCom configurata in Impostazioni abbia diritti di invio pieni
— nessuna gestione della coda "da autorizzare" (YAGNI, si aggiunge se serve
in futuro).

### Esito

- `Risposta.Stato === 'Errore'` → eccezione (job `FAILED`, coerente con gli
  altri canali — l'operatore vede l'errore e può "Rimetti in coda").
- Altrimenti (`Accettato`, `Verificato`, ecc.) → successo,
  `messageId = Risposta.IDPRO`,
  `responsePayload = { stato: Risposta.Stato, idPro: Risposta.IDPRO }`.

## 2. Tracking consegna — `PostalStatusSyncService` (nuovo demone `@Cron`)

Verificato nel manuale tecnico: esiste un'operazione dedicata di poll-stato,
`dettagli_documento(IDPRO) → GBCDocStatus2` (assente nel solo WSDL, il
riassunto iniziale del WSDL grezzo l'aveva mancata — errore corretto dopo
lettura del manuale). Restituisce `Stato` (stesso enum `GBCStatus` di
`invio_ext_singolo`) e `StatoDestinatari[]` (stato/data consegna per
destinatario).

**Stati terminali** (`GBCStatus`, dal §3.1 del manuale):
`Consegnato`, `NonConsegnato`, `ConsegnaParziale`, `Errore`, `Eliminato`.
Tutti gli altri (`Accettato`, `Sospeso`, `Verificato`, `Normalizzazione`,
`Inviato`, `Elaborato`, `AttesaStampa`, `Confermato`, `Rimandato`) sono
transitori.

`PostalStatusSyncService`, `@Cron('*/5 * * * *')` (stesso intervallo di
`SendStatusSyncService`): interroga `NotificationAttempt` con
`channel_type='POSTAL'`, `status=SUCCESS`, `postal_tracking_id IS NOT NULL`,
`postal_status` non in stati terminali (o null), batch 200, oldest first.
Per ognuno: nuovo client SOAP (Login + `dettagli_documento(IDPRO)`),
aggiorna `postalStatus`/`postalStatusUpdatedAt` se cambiato.

**Nessuna chiamata a `CampaignCompletionService.checkAndComplete()`** da
questo servizio — il completamento campagna è già deciso a livello di
submission (`SUCCESS`/`FAILED` scritto da `PostalStrategy.send()` via il
`NotificationProcessor` BullMQ standard, che già chiama `checkAndComplete()`
come per gli altri canali). `postalStatus` è tracking downstream puro,
esattamente come `sendStatus` per SEND (stesso ragionamento già validato:
l'accettazione/invio conta come esito, lo stato di consegna successivo è
informativo).

## 3. Modello dati

`NotificationAttempt` (nuove colonne nullable, popolate solo per
`channelType='POSTAL'`, stesso pattern di `iun`/`sendStatus` per SEND):

```ts
@Column({ name: 'postal_tracking_id', type: 'varchar', length: 50, nullable: true })
postalTrackingId!: string | null;   // IDPRO GlobalCom

@Column({ name: 'postal_status', type: 'varchar', length: 30, nullable: true })
postalStatus!: string | null;       // valore GBCStatus

@Column({ name: 'postal_status_updated_at', type: 'timestamptz', nullable: true })
postalStatusUpdatedAt!: Date | null;
```

Migration generata con DB temporaneo (procedura standard CLAUDE.md).

Nessuna modifica a `Recipient` — l'indirizzo destinatario passa dal
column-mapping CSV già esistente (`resolvePhysicalAddress`/
`physicalAddressConfig`), non da nuove colonne strutturate.

## 4. Multicanale (App IO parallela/esclusiva)

`apps/backend/src/queue/notification.processor.ts:138`: `isMailChannel`
oggi è `channel === 'EMAIL' || channel === 'PEC'` — allargato a includere
`POSTAL`. Zero altro codice nuovo: il meccanismo di co-delivery App IO
(parallelo/esclusivo, `resolveSecondaryAppIoConfig`) è già generico, gated
solo da questo flag.

## 5. Settings (Impostazioni → Postal, nuova tab)

`apps/backend/src/settings/settings.registry.ts`, nuove chiavi:

```ts
'postal.baseUrl':          { type: 'string', default: 'https://<da configurare>/gbcweb/GBCWebservice.asmx' },
'postal.user':             { type: 'string', default: '' },
'postal.password':         { type: 'string', secret: true, default: '' },
'postal.group':            { type: 'string', default: '' },
'postal.centroDiCosto':    { type: 'string', default: '' },
'postal.mittente.denominazione1': { type: 'string', default: '' },
'postal.mittente.indirizzo1':     { type: 'string', default: '' },
'postal.mittente.cap':            { type: 'string', default: '' },
'postal.mittente.citta':          { type: 'string', default: '' },
'postal.mittente.provincia':      { type: 'string', default: '' },
```

`baseUrl` è specifico per installazione (sottodominio
`<comune>.corrispondenzadigitale.it`) — mai hardcoded, nessun default valido
generico. Campi mittente tutti opzionali: se `denominazione1` è vuoto, si usa
`UsaMittentePredefinito=true` invece di popolare `Mittente`.

## 6. Wizard campagna (canale POSTAL)

Nuovi campi in `channelConfig` quando `wizChannel === 'POSTAL'` (mirror dei
campi SEND-only già esistenti in `App.tsx` da riga 3852):

- Select `postalServiceType`: `Lettera` \| `Raccomandata` (default
  `Raccomandata`)
- Checkbox `postalReturnReceipt` (AR), visibile solo se `Raccomandata`
- Sezione mapping colonne indirizzo destinatario (`physicalAddressConfig`:
  `addressColumn`/`municipalityColumn`/`zipColumn`/`provinceColumn`) — stessi
  4 select già usati per SEND, stesso componente se già estratto in comune,
  altrimenti duplicato (piccola porzione di UI, non giustifica
  un'astrazione prematura se SEND non l'ha già isolata)
- Select `userDataColumn` (opzionale) — colonna CSV da riportare in
  `UserData1` per riconciliazione col gestionale tributi
- Checkbox `protocolla` — già generico, nessuna modifica

## 7. Frontend — badge stato e dettaglio

`POSTAL_STATUS_META` in `App.tsx` (mirror `SEND_STATUS_META`, righe 65-77):
mappa i valori `GBCStatus` (14 valori, vedi tabella §2) a
`{label, badge, icon}`. Colonne `postalTrackingId`/`postalStatusUpdatedAt`
aggiunte a riga storico tentativi e dettaglio destinatario dove oggi c'è
`messageId` generico per POSTAL — stesso pattern di resa già usato per
`iun`/`sendStatusUpdatedAt` (righe 5056-5059, 7289-7292).

## Fuori scope (v1)

- Gestione coda "da autorizzare" (`DaConfermare`/`AutorizzaLottoInvio`) —
  presuppone utenza con diritti di invio pieni.
- Servizi GlobalCom diversi da Lettera/Raccomandata (Telegramma, Fax, bollettini
  H2H, camerali, PND — fuori perimetro TARI/avvisi PA).
- Verifica/correzione indirizzo pre-invio (`CorreggiIndirizzo`/
  `CorreggiIndirizzi`) — GlobalCom la fa comunque internamente in fase di
  invio (stato `Normalizzazione`/`Verificato`), non serve duplicarla
  client-side per v1.
