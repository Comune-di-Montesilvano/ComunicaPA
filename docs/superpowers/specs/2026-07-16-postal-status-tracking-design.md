# Tracking avanzamento POSTAL: barra stato + report CSV dedicati (attuale/storico)

## Contesto

Dettaglio campagna oggi mostra solo `postalStatus` corrente (badge, 14
valori `GBCStatus` già mappati in italiano da `POSTAL_STATUS_META`,
`App.tsx` righe 91-106) — nessuna sezione di andamento aggregato (a
differenza di SEND non esiste nemmeno un blocco "Progressione" da
sostituire). Export CSV generico (`export-download-report.csv`) non ha
senso per POSTAL: il conteggio download è significativo solo se il
messaggio è arrivato anche via App IO (co-consegna) — per posta cartacea
pura non esiste un "link" da scaricare per il cittadino.

Stesso pattern del [[2026-07-16-send-status-tracking-design]] approvato
per SEND (barra stato + CSV attuale/storico), ma asimmetria importante
verificata sul codice reale (non su un riassunto del manuale, coerente
col gotcha POSTAL già in CLAUDE.md): il webservice GlobalCom **non
fornisce storico stati con date**. `dettagli_documento`
(`globalcom-client.service.ts` righe 222-227, mappato da `mapDocStatus`
riga 77-84) ritorna solo `{ idPro, stato, codiceErrore, descrizione }` —
uno snapshot, mai un array di transizioni con timestamp. A differenza di
PN/SEND, qui lo storico va costruito da noi osservando i cambi di stato
ad ogni poll.

## Data model

Una colonna jsonb nuova su `notification_attempts`:

- `postal_status_history`: `Array<{ stato: string; rilevatoIl: string }>`
  — **append-only**, un elemento per ogni transizione di stato rilevata
  dal poll. `rilevatoIl` è il momento del nostro poll (ogni 5 minuti), non
  l'istante esatto lato GlobalCom — limite intrinseco del provider, da
  documentare in UI/CSV se necessario ma non altrimenti risolvibile.

`postal-status-sync.service.ts` (`handleCron()`, righe 32-62): il
confronto `stato.stato !== attempt.postalStatus` a riga 53 già rileva la
transizione — va solo esteso per appendere `{ stato: stato.stato,
rilevatoIl: new Date().toISOString() }` a `postal_status_history` nello
stesso salvataggio, oltre ad aggiornare `postalStatus`/
`postalStatusUpdatedAt` come già fa. Nessuna chiamata SOAP aggiuntiva.
Nessuna modifica al meccanismo di stop-poll: resta `TERMINAL_STATUSES`
esistente (riga 12), già corretto — un attempt in stato terminale
(`Consegnato`/`NonConsegnato`/`ConsegnaParziale`/`Errore`/`Eliminato`)
smette di essere ripollato.

Il primo stato osservato (tipicamente `Accettato`, esito sincrono di
`invio_ext_singolo` al momento dell'invio) va scritto in
`postal_status_history` al momento dell'invio stesso (in
`postal.strategy.ts`, non solo dal cron) — altrimenti lo storico
partirebbe dal secondo stato osservato, perdendo la prima transizione
reale.

## Backend — endpoint aggregazione barra

Nuovo endpoint `GET /admin/campaigns/:id/postal-status-breakdown`: query
diretta su `notification_attempts` filtrata per campagna (via join
recipient) e `channel_type = 'POSTAL'`, `GROUP BY postal_status`. Ritorna
`Array<{ status: string | null; count: number }>` (`null` = attempt non
ancora sincronizzato, mostrato come "In corso" nella barra — stessa label
già usata da `PostalStatusBadge` per stato assente, riga 109 `App.tsx`).

## Frontend — barra impilata

Nuova sezione nel dettaglio campagna quando `campaign.channelType ===
'POSTAL'` (nessun blocco esistente da rimuovere). Riusa lo stesso
componente `SendStatusBar` disegnato per SEND, generalizzato a
`ChannelStatusBar` (accetta breakdown + mapping meta come prop) per non
duplicare la barra impilata — colori/icone/label da `POSTAL_STATUS_META`
già esistente, nessun mapping duplicato.

## Backend — CSV export dedicato (2 varianti)

Il generico sparisce per le campagne POSTAL, sostituito da:

- `GET /admin/campaigns/:id/export-postal-report-attuale.csv`
- `GET /admin/campaigns/:id/export-postal-report-storico.csv`

Stesso meccanismo dropdown "Esporta Attuale"/"Esporta Storico" già
previsto per SEND, `handleExportDownloadReport` instrada in base a
`channelType`.

Query comune: recipient campagna + ultimo `NotificationAttempt`,
proiettando `postalStatusHistory` e — se co-consegna App IO configurata
(`resolveSecondaryAppIoConfig`) — `responsePayload.appIo` del primo
attempt (stesso vincolo attemptNumber=1 di SEND/`getChannelBreakdown()`).

### CSV "Attuale"

| Colonna | Fonte |
|---|---|
| Codice Fiscale | recipient |
| Nominativo | recipient |
| IDPRO (tracking) | `attempt.postalTrackingId` |
| Stato | label italiana da `POSTAL_STATUS_META` |
| Data Stato | `rilevatoIl` dell'ultima voce di `postal_status_history` |
| Codice Errore | `attempt.responsePayload` (ultimo esito GBC, se presente) |
| Descrizione Errore | idem |
| Esito App IO | solo se co-consegna configurata: "Consegnato"/"Fallito: \<errore\>"/vuoto; colonna assente se la campagna non ha co-consegna |

### CSV "Storico"

Stesse colonne identificative (CF, Nominativo, IDPRO, Codice/Descrizione
Errore, Esito App IO se applicabile) + una colonna data fissa per
ciascuno dei 14 stati GBC:

Data Accettato, Data Sospeso, Data Verificato, Data Normalizzazione, Data
Inviato, Data Elaborato, Data Attesa Stampa, Data Confermato, Data
Rimandato, Data Consegnato, Data Non Consegnato, Data Consegna Parziale,
Data Errore, Data Eliminato — ciascuna da `postal_status_history` →
prima occorrenza di quello stato (uno stato transitorio come `Rimandato`
può ripresentarsi più volte sui retry GBC: si registra la prima
occorrenza, coerente con la semantica "quando è stato raggiunto la prima
volta" già scelta per SEND).

Date formattate `it-IT`/`Europe/Rome`.

Mapping stati italiano: riusa `POSTAL_STATUS_META` lato frontend; nuovo
util condiviso backend `postal-status-labels.util.ts` (mirror, stesso
pattern proposto per SEND) per evitare hardcoding duplicato nei CSV
builder.

## Edge case

- Attempt appena inviato, prima del primo poll: `postal_status_history`
  contiene già `Accettato` (scritto da `postal.strategy.ts` al momento
  dell'invio, vedi sopra) — mai storico vuoto per un invio riuscito.
- Attempt fallito all'invio stesso (`AttemptStatus.FAILED`, mai arrivato
  a GBC con un IDPRO): nessuna riga in `notification_attempts` con
  `postal_tracking_id` valorizzato — CSV mostra Stato "Fallito" (da
  `attempt.status`, non da `postal_status`) e tutte le colonne
  storiche/data vuote, coerente con "mai arrivato a GlobalCom".
- Stato `Rimandato` (ritento) ripetuto più volte prima di un terminale:
  storico registra ogni occorrenza consecutiva diversa dal precedente
  (stessa logica esistente riga 53 — cambia solo se diverso dall'ultimo
  salvato, quindi ripetizioni identiche consecutive non duplicano righe).
- Campagna con 0 attempt POSTAL ancora processati: barra vuota / entrambi
  i CSV con sole righe "In corso".
- Campagna senza co-consegna App IO: colonna "Esito App IO" omessa da
  entrambi i CSV.

## Testing

- `postal-status-sync.service.spec.ts`: estendere test esistenti per
  verificare che una transizione di stato rilevata appenda a
  `postal_status_history` invece di limitarsi a sovrascrivere
  `postalStatus`; verificare che una ri-lettura con stato identico non
  produca un nuovo elemento in history.
- `postal.strategy.spec.ts`: verificare che l'invio riuscito scriva subito
  il primo elemento `Accettato` in `postal_status_history`.
- Nuovo `postal-report-csv.util.spec.ts`: colonne data vuote per stati
  mai raggiunti, prima-occorrenza per stati ripetuti (`Rimandato`),
  colonna Esito App IO presente solo se co-consegna configurata,
  escaping CSV.
- `campaigns.controller.spec.ts`: nuovi endpoint breakdown + export
  (attuale/storico) per POSTAL, verifica 403/404 se campagna non POSTAL o
  non trovata.
