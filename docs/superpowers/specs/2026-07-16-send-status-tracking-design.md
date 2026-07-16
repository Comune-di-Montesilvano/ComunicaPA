# Tracking avanzamento SEND: barra stato + report CSV dedicato

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

## Backend — CSV export dedicato

Nuovo endpoint `GET /admin/campaigns/:id/export-send-report.csv`,
sostituisce (solo per campagne SEND) l'endpoint generico nel bottone
frontend — `handleExportDownloadReport` sceglie l'URL in base a
`campaign.channelType`.

Query: tutti i recipient della campagna con ultimo `NotificationAttempt`
(stesso pattern `getRecipientStats`/`getDownloadReportRows` già in
`campaigns.service.ts`), proiettando anche `sendStatusHistory` e
`sendDigitalDomicile`.

Colonne CSV (`;`-separated, stesso stile `download-report-csv.util.ts`),
tutte con intestazione italiana:

| Colonna | Fonte |
|---|---|
| Codice Fiscale | recipient |
| Nominativo | recipient |
| IUN | attempt.iun |
| Stato Attuale | label italiana da mapping stati (vedi sotto), non stato grezzo PN |
| Tipo Domicilio Digitale | `send_digital_domicile.type`, italianizzato (PEC / SERCQ / App IO / SMS / Email / Raccomandata cartacea) |
| Indirizzo Domicilio | `send_digital_domicile.address` |
| Data In Validazione | history → `activeFrom` per status `IN_VALIDATION` |
| Data Accettazione | history → `ACCEPTED` |
| Data Rifiuto | history → `REFUSED` |
| Data In Consegna | history → `DELIVERING` |
| Data Consegna | history → `DELIVERED` |
| Data Visualizzazione | history → `VIEWED` |
| Data Perfezionamento | history → `EFFECTIVE_DATE` |
| Data Irreperibilità | history → `UNREACHABLE` |
| Data Annullamento | history → `CANCELLED` |
| Data Restituzione al Mittente | history → `RETURNED_TO_SENDER` |

`PAID` escluso (deprecato in V26, mai valorizzato per notifiche nuove).
Colonne data vuote se lo stato non è presente in `send_status_history`
(mai raggiunto). Date formattate `it-IT`/`Europe/Rome` come CSV esistente.

Mapping stati italiano per "Stato Attuale": riutilizza le stesse label di
`SEND_STATUS_META` (già italiane) — da centralizzare in un util condiviso
backend (nuovo `send-status-labels.util.ts`, mirror del mapping frontend)
per evitare hardcoding duplicato nel CSV builder.

## Edge case

- Attempt senza IUN risolto (`iun IS NULL`): CSV mostra "In attesa
  accettazione" come Stato Attuale, tutte le colonne data vuote.
- Attempt `REFUSED` prima di ottenere IUN (via `resolveMissingIun`, righe
  82-87 di `send-status-sync.service.ts`): non ha `notificationStatusHistory`
  da PN (mai stato accettato) — colonna "Data Rifiuto" resta vuota anche se
  `sendStatus = REFUSED`; solo "Stato Attuale" riporta il rifiuto. Nota
  esplicita nel CSV non necessaria (comportamento coerente con "mai
  raggiunto quello stato via history ufficiale").
- Campagna con 0 attempt SEND ancora processati: barra vuota / CSV con
  sole righe "In attesa".

## Testing

- `send-status-sync.service.spec.ts`: estendere test esistenti per
  verificare che `updateStatuses()` popoli `sendStatusHistory` e
  `sendDigitalDomicile` da una risposta mock con `timeline`/
  `notificationStatusHistory` realistici (fixture basata su esempio
  spec PN).
- Nuovo `send-report-csv.util.spec.ts`: verifica colonne data vuote per
  stati non raggiunti, mapping italiano stati/domicilio, escaping CSV.
- `campaigns.controller.spec.ts`: nuovo endpoint breakdown + export,
  verifica 403/404 se campagna non SEND o non trovata.
