# Tracking avanzamento SEND: barra stato + report CSV dedicati (attuale/storico)

## Contesto

Dettaglio campagna oggi mostra solo `sendStatus` corrente (badge) per
destinatario e un blocco "Progressione SEND" con conteggi sulla pipeline
interna (queued/protocollato/inviato/fallito) — non riflette gli 11 stati
reali `NotificationStatusV26` di PN. L'export CSV è generico
(`export-download-report.csv`), niente colonne SEND-specifiche (IUN,
domicilio digitale, date per stato).

Verificato su spec raw PN (`pagopa/pn-delivery`,
`docs/openapi/api-external-b2b-pa-bundle.yaml`, non un riassunto): la
risposta di `GET /delivery/v2.9/notifications/sent/{iun}` include sia
`notificationStatusHistory` (array `{status, activeFrom, relatedTimelineElements}`)
sia `timeline` (eventi dettagliati). L'evento categoria `SEND_DIGITAL_DOMICILE`
(workflow digitale) o `SEND_ANALOG_DOMICILE` (workflow cartaceo fallback)
porta i dettagli `SendDigitalDetails`/analogo con `digitalAddress.type`
(PEC/REM/SERCQ/SMS/EMAIL/APPIO) e `digitalAddressSource`. Questi dati oggi
non vengono letti né persistiti da `send-status-sync.service.ts`.

Scope: SOLO canale SEND. POSTAL avrà spec separato successivo, stesso
pattern (barra stato + CSV dedicato) ma stati/campi propri (GlobalCom).

## Data model

Due colonne jsonb nuove su `notification_attempts` (migration manuale,
enum non toccato):

- `send_status_history`: `Array<{ status: string; activeFrom: string }>` —
  copia diretta di `notificationStatusHistory` da PN, **overwrite intero**
  ad ogni poll (PN lo restituisce già completo, nessun merge incrementale
  necessario).
- `send_digital_domicile`: `{ type: string; address: string | null; source: string } | null` —
  estratto dall'ultimo evento timeline con categoria `SEND_DIGITAL_DOMICILE`
  o `SEND_ANALOG_DOMICILE` (il più recente per `elementId`/ordine array,
  cartaceo vince se presente essendo l'ultimo tentativo in caso di fallback
  digitale→analogico).

`send-status-sync.service.ts` → `updateStatuses()`: oltre a salvare
`sendStatus`/`sendStatusUpdatedAt` come oggi, parsare anche
`notificationStatusHistory` e `timeline` dalla stessa risposta JSON già
fetchata (nessuna chiamata HTTP aggiuntiva) e popolare le due colonne.
Nessuna modifica al meccanismo di stop-poll: resta `TERMINAL_STATUSES`
esistente (riga 11), già corretto.

## Backend — endpoint aggregazione barra

Nuovo endpoint `GET /admin/campaigns/:id/send-status-breakdown`:
query diretta su `notification_attempts` filtrata per `campaign` (via join
recipient) e `channel_type = 'SEND'`, `GROUP BY send_status`. Ritorna
`Array<{ status: string | null; count: number }>` (status `null` =
attempt non ancora sincronizzato/IUN non risolto, mostrato come "In
attesa" nella barra). Nessun parsing di history qui — la barra riflette
solo lo stato corrente, già colonna esistente.

## Frontend — barra impilata

Sostituisce il blocco "Progressione SEND" (righe ~7861-7885 di
`App.tsx`) quando `campaign.channelType === 'SEND'`. Nuovo componente
`SendStatusBar`: barra orizzontale, un segmento per stato presente nel
breakdown, larghezza proporzionale al conteggio, colore/icona/label presi
da `SEND_STATUS_META` già esistente (righe 65-77) — nessun mapping
duplicato. Tooltip on-hover mostra label italiana + conteggio + %.
Segmento aggiuntivo grigio "In attesa" per `status === null`.

Fetch on mount/refresh insieme agli altri dati campagna (stesso pattern
di `fetchChannelBreakdown`).

## Backend — CSV export dedicato (2 varianti)

Il vecchio `export-download-report.csv` generico sparisce per le campagne
SEND (il conteggio download non è un dato significativo qui: l'accesso
del cittadino è già tracciato meglio dallo stato `VIEWED`). Due nuovi
endpoint sostituiscono il bottone unico nel dettaglio campagna:

- `GET /admin/campaigns/:id/export-send-report-attuale.csv` — foto
  istantanea, un solo stato+data per destinatario.
- `GET /admin/campaigns/:id/export-send-report-storico.csv` — tutte le
  date per tutti gli stati attraversati.

`handleExportDownloadReport` sceglie l'URL in base a
`campaign.channelType`; per SEND diventa un menu/dropdown a due voci
("Esporta Attuale" / "Esporta Storico") invece di un bottone singolo.

Query comune: tutti i recipient della campagna con ultimo
`NotificationAttempt` (stesso pattern `getRecipientStats`/
`getDownloadReportRows` già in `campaigns.service.ts`), proiettando anche
`sendStatusHistory`, `sendDigitalDomicile` e — se la campagna ha
co-consegna App IO configurata (`resolveSecondaryAppIoConfig`, stesso
helper di `getChannelBreakdown()`) — `responsePayload.appIo` del primo
attempt (`attemptNumber = 1`, stesso vincolo già documentato in
`getChannelBreakdown()`: il segnale App IO esiste solo lì, mai sui retry).

### CSV "Attuale"

Colonne (`;`-separated, stesso stile `download-report-csv.util.ts`):

| Colonna | Fonte |
|---|---|
| Codice Fiscale | recipient |
| Nominativo | recipient |
| IUN | attempt.iun |
| Tipo Domicilio Digitale | `send_digital_domicile.type`, italianizzato (PEC / SERCQ / App IO / SMS / Email / Raccomandata cartacea) |
| Indirizzo Domicilio | `send_digital_domicile.address` |
| Stato | label italiana da mapping stati (vedi sotto), non stato grezzo PN |
| Data Stato | `activeFrom` dell'ultima voce di `send_status_history` (= stato corrente) |
| Esito App IO | solo se co-consegna configurata sulla campagna: "Consegnato"/"Fallito: \<errore\>"/vuoto se non ancora tentato; colonna assente (non solo vuota) se la campagna non ha co-consegna App IO |

### CSV "Storico"

Stesse colonne identificative (CF, Nominativo, IUN, Tipo/Indirizzo
Domicilio, Esito App IO se applicabile) + una colonna data fissa per
ciascuno dei 10 stati (PAID escluso, deprecato in V26):

Data In Validazione, Data Accettazione, Data Rifiuto, Data In Consegna,
Data Consegna, Data Visualizzazione, Data Perfezionamento, Data
Irreperibilità, Data Annullamento, Data Restituzione al Mittente —
ciascuna da `send_status_history` → `activeFrom` per quello stato,
vuota se mai raggiunto.

Date formattate `it-IT`/`Europe/Rome` come CSV esistente in entrambe le
varianti.

Mapping stati italiano per "Stato"/"Stato Attuale": riutilizza le stesse
label di `SEND_STATUS_META` (già italiane) — da centralizzare in un util
condiviso backend (nuovo `send-status-labels.util.ts`, mirror del
mapping frontend) per evitare hardcoding duplicato nei due CSV builder.

## Edge case

- Attempt senza IUN risolto (`iun IS NULL`): CSV "Attuale" mostra "In
  attesa accettazione" come Stato, Data Stato vuota; CSV "Storico" tutte
  le colonne data vuote.
- Attempt `REFUSED` prima di ottenere IUN (via `resolveMissingIun`, righe
  82-87 di `send-status-sync.service.ts`): non ha `notificationStatusHistory`
  da PN (mai stato accettato) — colonna "Data Rifiuto" resta vuota anche se
  `sendStatus = REFUSED`; solo "Stato"/"Stato Attuale" riporta il rifiuto.
  Nota esplicita nel CSV non necessaria (comportamento coerente con "mai
  raggiunto quello stato via history ufficiale").
- Campagna con 0 attempt SEND ancora processati: barra vuota / entrambi i
  CSV con sole righe "In attesa".
- Campagna senza co-consegna App IO: colonna "Esito App IO" omessa da
  entrambi i CSV (non generata vuota) — evita colonne fantasma su
  campagne che non hanno mai configurato la co-consegna.

## Testing

- `send-status-sync.service.spec.ts`: estendere test esistenti per
  verificare che `updateStatuses()` popoli `sendStatusHistory` e
  `sendDigitalDomicile` da una risposta mock con `timeline`/
  `notificationStatusHistory` realistici (fixture basata su esempio
  spec PN).
- Nuovo `send-report-csv.util.spec.ts`: verifica per entrambe le varianti
  (attuale/storico) colonne data vuote per stati non raggiunti, mapping
  italiano stati/domicilio, colonna Esito App IO presente solo se
  co-consegna configurata, escaping CSV.
- `campaigns.controller.spec.ts`: nuovi endpoint breakdown + export
  (attuale/storico), verifica 403/404 se campagna non SEND o non trovata.
