# Costo Notifiche — Design

Data: 2026-07-21

## Obiettivo

Tracciare il costo reale delle notifiche per i canali a pagamento (SEND,
POSTAL) e mostrarlo in dashboard, statistiche e dettaglio campagna. EMAIL,
PEC, APP_IO restano sempre gratuiti (nessun costo tracciato). Calcolare
anche il risparmio generato dai dirottamenti INAD/App IO esclusiva che
evitano un canale a pagamento.

## Contesto verificato

- **SEND (PN)**: `GET /delivery/v2.9/notifications/sent/{iun}` ritorna già
  `timeline` completa (con dettagli per categoria evento), ma
  `send-status-sync.service.ts` oggi estrae solo `notificationStatus`,
  `notificationStatusHistory` e il domicilio digitale — il resto della
  timeline viene scaricato ma scartato. Spec ufficiale PN (repo
  `pagopa/pn-delivery-push`, `docs/openapi/schemas-pn-timeline-external.yaml`)
  conferma che gli eventi `SEND_ANALOG_DOMICILE`/`SEND_SIMPLE_REGISTERED_LETTER`
  portano dettagli tipati (`SendAnalogDetails`/`SimpleRegisteredLetterDetails`)
  con `analogCost` (eurocent, costo reale del singolo invio cartaceo),
  `productType` (`AR`/`890`/`RIR` su recapito A/R, `RS`/`RIS` su raccomandata
  semplice), `envelopeWeight`, `numberOfPages`. Il costo digitale base
  (~1€ "gestione piattaforma", voce `sendFee` in `NotificationPriceResponseV23`,
  repo `pagopa/pn-delivery`, `docs/openapi/api-external-b2b-pa.yaml` righe
  859-894) sta invece su un endpoint separato `GET
  /delivery/v2.3/price/{paTaxId}/{noticeCode}`, legato a un notice pagoPA —
  non sempre disponibile per ogni notifica.
- **POSTAL (GlobalCom)**: verificato dal vivo (2026-07-21, campagna reale
  "TEST REALE GlobalCom 2 - RaccomandataMarket4", log debug XML grezzo
  `dettagli_documento`) che la risposta SOAP contiene un blocco `Valori`
  con `Costo` (netto reale in euro, es. `4.31`), `NumeroPagine`,
  `DettaglioBilling` (`ImportoPostaleNetto`/`ImportoStampaNetto`/
  `ImportoARNetto` separati), oltre a `Nazionale` (bool),
  `CodiceContratto`, `TipoDocumento`. Questi campi esistono nella risposta
  reale ma sono oggi ignorati da `mapDocStatus()`
  (`globalcom-client.service.ts:77-84`), che legge solo
  `IDPRO`/`Stato`/`CodiceErrore`/`Descrizione`. **Nessun tariffario manuale
  necessario**: il costo reale è già disponibile via API, stesso pattern di
  SEND.
- **`NotificationAttempt`**: nessuna colonna costo oggi. `responsePayload`
  è scritto solo al dispatch iniziale, mai aggiornato dai sync di stato —
  serve estendere `sendStatusHistory`-style pattern con nuove colonne
  dedicate.
- **INAD/App IO override**: `Recipient.inadCheck.diverted` (non `.found`) è
  la fonte di verità per un dirottamento reale (vedi CLAUDE.md, matrice
  comportamenti campagne). Un retry crea sempre un nuovo `NotificationAttempt`
  con IUN proprio — un attempt ha sempre un solo IUN, ma la timeline di
  quell'IUN può avere più eventi analogici (es. primo tentativo +
  rispedizione) da sommare.

## Modello dati

### `NotificationAttempt` — nuove colonne (migration)

- `cost_cents` (int, nullable): costo totale attempt in centesimi. `null`
  = non calcolato/non applicabile. Mai scritto per EMAIL/PEC/APP_IO — in
  fase di aggregazione questi canali sono trattati come costo 0 senza
  bisogno di popolare la colonna (nessun impatto sulle scritture per il
  grosso volume di attempt gratuiti).
- `cost_calculated_at` (timestamp, nullable).
- `cost_breakdown` (jsonb, nullable): dettaglio trasparente per audit/UI —
  per SEND `{ baseFeeCents, analogEvents: [{productType, analogCost,
  envelopeWeight, numberOfPages, eventTimestamp}] }`; per POSTAL
  `{ costoNetto, numeroPagine, nazionale, importoPostaleNetto,
  importoStampaNetto, importoARNetto, tipoDocumento, codiceContratto }`.

### Settings — nuova chiave in `settings.registry.ts`

- `send.digitalBaseFeeCents` (int, default 100 = 1,00€): fallback usato
  quando l'endpoint `price/{paTaxId}/{noticeCode}` non è disponibile
  (notifica senza notice pagoPA associato, o chiamata fallita).

Nessuna nuova chiave/tabella per POSTAL: il costo arriva già completo
dalla risposta `dettagli_documento`.

## Logica di calcolo

### SEND — estensione `send-status-sync.service.ts`

Ad ogni sync (già chiama `GET notifications/sent/{iun}` e scarica la
timeline completa):

1. Estrae dalla timeline tutti gli eventi con dettagli analogici
   (`SendAnalogDetails`/`SimpleRegisteredLetterDetails`) per l'IUN
   dell'attempt, somma `analogCost` (già in eurocent) su tutti gli eventi
   trovati (retry/rispedizioni multiple sullo stesso IUN).
2. Calcola il base fee: se disponibile un notice pagoPA per la notifica,
   prova `GET price/{paTaxId}/{noticeCode}` e usa `sendFee`; altrimenti (o
   se la chiamata fallisce) usa `send.digitalBaseFeeCents` configurato.
3. `cost_cents = baseFeeCents + sum(analogCost)`, salva `cost_breakdown`
   con il dettaglio degli eventi.
4. Servono nuove interfacce TypeScript per i dettagli timeline (oggi
   assenti — solo `SendStatusHistoryEntry`/`SendDigitalDomicile` esistono
   in `send-status-history.util.ts`).
5. **Solo da ora in poi**: nessun backfill sulle notifiche SEND storiche
   già concluse prima del deploy di questa feature — restano senza costo
   (`cost_cents = null`, escluse silenziosamente dai totali, vedi sotto).

### POSTAL — estensione `postal-status-sync.service.ts` / `globalcom-client.service.ts`

1. Estendere `GbcDocStatus`/`mapDocStatus()` per leggere anche `Valori`
   (`Costo`, `NumeroPagine`, `Nazionale`) e `DettaglioBilling`
   (`ImportoPostaleNetto`/`ImportoStampaNetto`/`ImportoARNetto`) dalla
   risposta di `dettagli_documento`.
2. Quando il campo `Costo` è presente e valorizzato, `cost_cents =
   round(Costo * 100)`, `cost_breakdown` con il dettaglio billing
   completo.
3. **Solo da ora in poi**: stesso criterio di SEND, nessun backfill
   storico.

### Risparmio da dirottamento — formula unificata

Per ogni destinatario di una campagna SEND/POSTAL:

```
risparmio = costo_nominale_stimato_canale_campagna − costo_reale_incorso
```

dove `costo_reale_incorso` è la somma di `cost_cents` sugli attempt
effettivi del destinatario per quella campagna (0 se il destinatario è
stato dirottato su un canale gratuito o l'invio a pagamento è stato
saltato per App IO esclusiva), e `costo_nominale_stimato` è una stima del
costo che si sarebbe sostenuta sul canale nominale della campagna:

- **POSTAL**: nessuna stima possibile senza un invio reale (il costo
  dipende da pagine/tipologia effettive) — il risparmio per destinatari
  POSTAL dirottati via INAD non viene calcolato in questa iterazione
  (nessun dato affidabile senza aver generato il documento). Mostrato
  come "N/D" nel breakdown, non incluso nel totale risparmio.
- **SEND**: stima nominale = solo `send.digitalBaseFeeCents` configurato
  (il costo analogico reale non è stimabile per un invio mai avvenuto —
  limite noto, documentato in UI con tooltip "stima basata solo su costo
  digitale base, non include eventuale recapito cartaceo evitato").

Questa formula copre automaticamente sia il dirottamento INAD (canale
finale gratuito, costo reale 0) sia l'App IO esclusiva che salta il
canale a pagamento (costo reale 0) — nessun caso speciale hardcoded per
i due meccanismi.

## Aggregazione statistiche

- Notifiche senza `cost_cents` calcolato (SEND/POSTAL storiche pre-deploy,
  o sync fallito) sono **escluse silenziosamente** dai totali — nessun
  contatore "N/D" separato in UI (scelta esplicita: keep it simple, il
  totale rappresenta la somma di quanto effettivamente noto).
- EMAIL/PEC/APP_IO: costo implicitamente 0, mai sommati né mostrati come
  "notifiche senza costo".

## UI

- **Dettaglio campagna**: nuovo blocco costo totale campagna + risparmio
  dirottamento, accanto al breakdown canale/`effectiveChannelBreakdown`
  già esistente (`App.tsx:4877-4893`).
- **Dashboard**: nuovo widget costo totale nel periodo corrente, accanto
  ai widget esistenti (`fetchGlobalStats`, `App.tsx:4955`) — richiede
  polling esistente pattern (nessun refresh automatico globale, vedi
  CLAUDE.md "Liste e pannelli con stato lato server").
- **Statistiche**: nuova sezione trend/aggregato costo e risparmio nel
  tempo, filtrabile per periodo (vista Statistiche, `App.tsx:5225,5307`).
- Nuovi endpoint backend in `campaigns.controller.ts`/`campaigns.service.ts`
  seguendo il pattern esistente di `getSendStatusBreakdown`/
  `getPostalStatusBreakdown` (`campaigns.service.ts:1532,1612`).

## Fuori scope (YAGNI)

- Backfill costo su notifiche storiche.
- Stima risparmio POSTAL per destinatari dirottati (nessun dato
  affidabile disponibile).
- Tariffario manuale configurabile per POSTAL (il costo reale è già
  disponibile via API GlobalCom).
- Lettura opportunistica di eventuali campi costo aggiuntivi non ancora
  verificati sulla risposta SEND (`price` endpoint) oltre a `sendFee` —
  se in futuro serve maggiore precisione, verificare dal vivo come fatto
  per POSTAL prima di estendere.
