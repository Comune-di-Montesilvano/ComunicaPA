# Performance dettaglio campagna, validazione CF App IO, errori raggruppati

Data: 2026-07-08

## Contesto

Campagna App IO con 20591 destinatari (12940 FAILED). Il dettaglio campagna
è lentissimo da caricare e non mostra alcun grafico. Segnalati anche:
righe caricate con Partita IVA che App IO rifiuta solo al momento
dell'invio reale (spreco di un tentativo, errore HTTP 400 leggibile solo
nei log), e una lista errori piatta impossibile da usare per un retry
mirato su 12940 righe.

## Root cause (diagnosi)

1. **`CampaignsService.findOne()`** (`campaigns.service.ts:55-62`) carica
   `relations: ['recipients', 'recipients.attempts']` — l'intera tabella
   destinatari + tutti i tentativi, ad ogni apertura del dettaglio
   campagna. Con 20591 righe è il costo dominante del caricamento.
2. **`CampaignsService.getFailures()`** (`campaigns.service.ts:672-703`)
   esegue un `attemptRepo.findOne` per ciascun destinatario FAILED dentro
   un `Promise.all` — N+1 query, N=12940 in questo caso. Chiamata ad ogni
   apertura dettaglio campagna (`fetchCampaignFailures`).
3. **Grafici assenti**: sia il pannello "Dettaglio Consegna Multicanale"
   (`getChannelBreakdown`) sia il nuovo grafico "Download per Combinazione
   Canali" (`getDownloadCrossChannelStats`, introdotto oggi) sono gated su
   `resolveSecondaryAppIoConfig(channelConfig)` — vero solo per campagne
   con App IO come canale **secondario di co-consegna**. Questa campagna
   ha App IO come canale primario puro: nessuna co-consegna configurata,
   quindi entrambi i pannelli restano `null` e non renderizzano nulla. Non
   è un bug del codice introdotto oggi, è un gap di design per le campagne
   APP_IO pure (mai avuto un grafico dedicato).
4. **Validazione CF nel wizard** (`App.tsx` `handleWizValidation`,
   `cfRegex = /^[A-Z0-9]{16}$/i`, `pivaRegex = /^\d{11}$/`) accetta la
   Partita IVA come alternativa valida al CF anche quando il canale
   coinvolge App IO. PagoPA (App IO) accetta solo CF di persona fisica nel
   formato reale (6 lettere, 2 cifre/lettere, lettera mese, 2 cifre/lettere,
   lettera, 3 cifre/lettere, lettera di controllo) — una P.IVA non passa
   mai questo pattern, e l'errore emerge solo alla spedizione reale
   (`HTTP 400 — value [...] is not a valid [string that matches the
   pattern ...]`), dopo aver già consumato un tentativo.

## Decisioni

- **Grafico fallback per App IO puro**: pie/bar semplice SENT/FAILED e
  scaricato/non scaricato, costruito da dati già disponibili
  (`campaign.sentCount`/`failedCount`, `downloadByChannel`) — nessuna
  nuova query backend.
- **CF non conforme al pattern App IO**: scartato nel wizard, in fase di
  validazione CSV, come errore bloccante (mai arriva a creare il
  recipient) — non a livello di coda/invio.
- **Errori raggruppati**: nuovo endpoint che raggruppa i destinatari
  FAILED per `errorMessage`, con conteggio e possibilità di rimettere in
  coda tutti i destinatari di un gruppo con un'unica azione.

## Ambito

### Backend

1. Estrarre `escapeCsvField` in un util condiviso (`csv.util.ts`), riuso
   da `never-downloaded-csv.util.ts` e dal nuovo export report download.
2. Riscrivere `getFailures()` senza N+1 (query singola con subquery
   `DISTINCT ON` sull'ultimo tentativo per destinatario).
3. Nuovo `getFailuresByReason()`: raggruppa l'output di `getFailures()`
   per `errorMessage`, ordinato per conteggio decrescente.
4. Nuovo `retryRecipientsBulk(campaignId, recipientIds[])`: richiama
   `retryRecipient` per ciascun id, ritorna `{ requeued, failed[] }`
   (un fallimento singolo — es. destinatario non più FAILED nel frattempo
   — non deve bloccare gli altri).
5. Estendere `getRecipientStats()`: aggiungere `email`, `pec`, `status`
   alla selezione esistente, aggiungere parametro opzionale `search`
   (ILIKE su `fullName` o `codiceFiscale`).
6. Nuovo `getDownloadReportRows()` + endpoint CSV streaming
   `GET :id/export-download-report.csv` — sostituisce l'export
   client-side attuale (`handleExportDownloadReport`, che richiede
   l'intero array `campaign.recipients` in memoria).
7. `findOne()`: rimuovere `relations: ['recipients', 'recipients.attempts']`
   una volta che frontend non dipende più da `campaign.recipients`
   (tabella e export migrati sui nuovi endpoint paginato/CSV).

### Frontend

8. Wizard: validazione CF stretta (pattern reale) quando il canale
   coinvolge App IO (`wizChannel === 'APP_IO' || wizAppIoInvolved`),
   errore bloccante distinto da quello generico CF/P.IVA.
9. Tabella "Destinatari Caricati": sostituire `campaign.recipients.map`
   con fetch paginato su `getRecipientStats` esteso, controlli
   pagina/pagina-successiva, input di ricerca (debounce) per nominativo/CF.
   Mantenere `onClick` riga → `openNotificationDetail` (introdotto oggi).
10. Bottone "Esporta Report Download": puntare al nuovo endpoint CSV
    backend invece di costruire il CSV client-side.
11. Pannello "Destinatari con Invio Fallito": sostituire la lista piatta
    con gruppi per motivazione errore (conteggio + bottone "Rimetti in
    coda tutti" per gruppo).
12. Card "Grafici" per campagne App IO pure (senza co-consegna): pie/bar
    fallback da dati già disponibili.

## Fuori ambito

- Nessuna modifica al meccanismo di co-consegna esistente
  (`getChannelBreakdown`/`getDownloadCrossChannelStats` restano invariati
  per le campagne che hanno co-consegna configurata).
- Nessuna modifica al wizard oltre alla nuova regola di validazione CF
  per App IO.
- Nessun nuovo importer/creator di campagne (resta il wizard unico).

## Testing

- Backend: unit test per `getFailures` (query singola, nessuna
  regressione sui casi esistenti), `getFailuresByReason`,
  `retryRecipientsBulk` (successi parziali), `getRecipientStats` con
  `search`, `getDownloadReportRows`/CSV builder.
- Frontend: verifica manuale — validazione wizard blocca P.IVA su canale
  App IO, tabella destinatari pagina e cerca, export scarica CSV non
  vuoto, gruppi errori mostrano conteggi corretti e il retry bulk rimette
  in coda, grafico fallback visibile solo su campagne App IO pure senza
  co-consegna.
