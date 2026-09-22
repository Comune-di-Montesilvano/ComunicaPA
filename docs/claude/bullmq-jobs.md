# BullMQ & stato job/campagna

## Job BullMQ e stato campagna/destinatario — pattern jobId = attemptId

`launch()`, `retryRecipient()` e `cancel()` in `campaigns.service.ts` accodano
ogni job BullMQ con `opts.jobId` impostato esplicitamente = `NotificationAttempt.id`
(via `NotificationQueuesService.addBulk`). Questo permette lookup diretto
(`notificationQueues.getJob(channel, attemptId)`) senza scansionare l'intera
coda del canale — indispensabile per annullare/gestire job di UNA campagna
quando la coda è condivisa tra più campagne dello stesso canale. Se aggiungi
un nuovo punto che accoda job (`addBulk`), passa sempre `opts.jobId` con lo
stesso attemptId, altrimenti quel job diventa invisibile a `cancel()`.

**Ogni campo `channelConfig[...]` letto da una strategy di invio deve
rispettare lo stesso branch su `campaign.channelType` di `mailConfigId`, non
solo quello.** Bug reale: `PecStrategy` sceglieva correttamente
`pecReserveMailConfigId` su dirottamento INAD (campagna EMAIL→PEC), ma
leggeva comunque `channelConfig['from']` (indirizzo EMAIL configurato) come
envelope MAIL FROM — mismatch con l'account PEC autenticato, il server PEC
rigetta (`553 MAIL FROM does not match authenticated user name`). Fix:
`from` usa `channelConfig['from']` solo se `campaign.channelType==='PEC'`,
altrimenti sempre `smtp.fromAddress` della config risolta.

**"Motore" ≠ canale**: `NotificationQueuesService`/`EnginesController` usano
`EngineName` (`notification-job.types.ts`), non `NotificationChannel` — un
motore può essere channel-agnostico (es. `PROTOCOLLAZIONE`, usato solo da
SEND oggi ma non specifico a SEND). Convertire un demone `@Cron` poll-based
in un motore BullMQ vero (stessa UI pausa/riprendi/job falliti/log degli
altri) richiede sempre toccare gli stessi 3 punti in `campaigns.service.ts`:
`launch()` (produzione job in bulk al lancio campagna), `retryRecipient()`
(produzione condizionale — valuta se serve davvero un nuovo job o se lo
stato esistente basta), `cancel()` (rimozione best-effort del job pendente,
oltre all'update di stato). Un fallimento del job deve marcare il record
terminale (FAILED) PRIMA di rilanciare l'errore — altrimenti BullMQ registra
il job come fallito ma il destinatario resta bloccato in uno stato intermedio
per sempre (nessun "Rimetti in coda" possibile, la UI non lo mostra tra i
falliti).

**`createAttemptsAndEnqueue` — la coda BullMQ va calcolata PER DESTINATARIO, mai
una sola volta per l'intero batch.** Bug reale in produzione: `engineName`
derivato solo da `campaign.channelType`, ignorando `channelOverrides`
(dirottamento INAD) — un destinatario dirottato POSTAL→PEC finiva comunque
accodato sulla coda POSTAL (con `job.data.channel` corretto, quindi la
strategy giusta veniva chiamata, ma sullo stesso worker/concurrency del
motore sbagliato). Se GlobalCom è fermo, anche i PEC dirottati restano
bloccati dietro, indistinguibile da un problema PEC. Fix: raggruppare i job
per motore effettivo (`channelOverrides.get(recipientId) ?? campaign.channelType`,
protocollazione resta channel-agnostica) prima di `addBulk`. Diagnosticabile
dal vivo verificando se l'attempt "queued" è realmente `waiting` nella coda
giusta via `Queue.getJob(id)` (bullmq diretto, stesso pattern debug già noto).

Quando aggiungi un nuovo stato "terminale" a `CampaignStatus`/`RecipientStatus`
(es. `CANCELLED`), audit obbligatorio: TUTTI i metodi che mutano quel record
devono guardare contro il nuovo stato, non solo il metodo che lo introduce.
Bug reale: `retryRecipient()` non controllava `campaign.status`, quindi un
destinatario `FAILED` (lasciato intatto da `cancel()` apposta) poteva essere
rimesso in coda su una campagna già `CANCELLED` — inviando davvero un
messaggio su una campagna "annullata".

**Se un canale bypassa BullMQ** (demone `@Cron` invece di job, es. SEND dal
refactor "pipeline a demoni"): il check di completamento campagna
(`CampaignCompletionService.checkAndComplete()`, estratto da
`notification.processor.ts`) NON scatta da solo — va chiamato esplicitamente
dal demone dopo ogni esito terminale (successo/fallimento), esattamente come
fa il processor per gli altri canali. Bug reale: dimenticarlo lascia la
campagna bloccata in `QUEUED` per sempre anche a invio terminato per tutti i
destinatari — nessun errore visibile, solo uno stato mai aggiornato.

**L'inverso è altrettanto reale: un retry che rimette destinatari in coda
deve riportare `campaign.status` FUORI da uno stato terminale.** Bug
confermato dal vivo: `retryRecipient()` (chiamato da retry singolo, bulk
retry, e content-correction) rimetteva `Recipient.status` a `QUEUED` ma non
toccava mai `campaign.status` — una campagna già `COMPLETED`/`FAILED` a cui
si rimettono in coda centinaia di destinatari FAILED resta "Completata" in
UI per sempre, nonostante il lavoro reale ancora in corso. Fix: se
`campaign.status` è `COMPLETED`/`FAILED` al momento del retry, riportarlo a
`QUEUED` (`completedAt: null`) — `checkAndComplete()` la richiuderà da sola
quando anche l'ultimo retry sarà terminale.

## Riconciliazione job orfani (`OrphanReconciliationService`)

Attempt `status='queued'` il cui job BullMQ è andato perso (Redis riavviato
prima dell'AOF, o race window scrittura DB/Redis non transazionale) —
incidente reale: campagna PEC, 2557 attempt orfani, motore "idle" nonostante
migliaia "in coda". Cron giornaliero (03:00) + bottone manuale "Job orfani"
nel pannello Motori, sui 5 motori BullMQ reali (EMAIL/PEC/APP_IO/POSTAL/
PROTOCOLLAZIONE). **La coda di destinazione si calcola dalla CAMPAGNA
(channelType/protocolla), mai da `attempt.channelType` da solo** — un
attempt dirottato da INAD (es. campagna EMAIL, attempt.channelType='PEC') va
cercato/riparato nella coda EMAIL se la campagna non richiede
protocollazione, stesso identico calcolo di
`CampaignsService.createAttemptsAndEnqueue` (`engineName`). Fuori scope
deliberato: registro imprese/verifica IO/firma/enrichment/bulk-retry (stesso
schema BullMQ, tabelle/payload diversi, nessun incidente osservato lì).

**Esteso (incidente reale: Postgres riavviato durante invio) a due casi in
più.** (1) Job BullMQ già terminale (`failed`/`completed`) ma attempt
rimasto `queued` — la scrittura dello stato terminale era fallita a sua
volta (stesso DB down), invisibile a "Job orfani" perché un job Redis
esiste davvero: marcato FAILED (mai riaccodato con lo stesso jobId, dedup
BullMQ silenzioso). (2) Attempt rimasto `status='processing'` (worker
crashato mentre già in lavorazione) — query estesa a
`status IN (queued, processing)`. Se per un `processing` il job è
**assente**, l'invio potrebbe essere già partito: marcato FAILED con
avviso di rischio doppio invio, mai riaccodato in automatico (diverso da
`queued` assente, sempre sicuro da riaccodare).

**Un `error_message` mostrato in "Destinatari con invio fallito" può
essere un messaggio CONGELATO di un incidente passato** (riparazione
manuale, o job BullMQ vecchio) — non assumere sia un errore live in corso
solo perché il testo dice "database system is shutting down": controllare
`created_at` prima di sospettare un'interruzione ancora attiva (falso
allarme reale già capitato).

## Metodo bulk privato chiamato con un sottoinsieme — ogni mutazione va scoped, mai alla campagna intera

`CampaignsService.createAttemptsAndEnqueue()` chiudeva con un update di stato
`{ campaignId, status: PENDING } → QUEUED` **non scoped** ai `recipients`
passati al metodo — innocuo quando il chiamante passa sempre "tutti i PENDING
della campagna" (`launch()`/`finalizeInadCheck()`), ma un nuovo chiamante con
un array di un solo destinatario (`resolvePecReview()`, vedi sotto) flippava
a QUEUED anche altri PENDING indipendenti della stessa campagna **senza mai
creargli un attempt/job reale** — incidente vero: 3199 destinatari PEC
"fantasma" (QUEUED, zero job in coda, zero log, campagna bloccata a metà per
ore, nessuna traccia diagnosticabile finché non si è contato manualmente via
SQL). Fix: `{ id: In(recipients.map(r => r.id)), status: PENDING }`. Ogni
futuro metodo bulk-oriented richiamabile con un sottoinsieme va verificato
per lo stesso rischio — mai un WHERE che si allarga oltre gli id passati.
Riparazione di righe già corrotte da prima del deploy della fix:
`apps/backend/src/debug/repair-ghost-queued-recipients.cjs` (dry-run di
default, `--apply` per scrivere).

## BullMQ — `queue.add()` con jobId esistente è no-op silenzioso, mai un errore

Riaggiungere un job con lo stesso `opts.jobId` di uno già presente in Redis
(**qualunque** stato: completed/failed/active) non lancia eccezioni e non
logga nulla — semplicemente non rieseguirà mai il job. Un demone di
"resume/retry" che riusa l'id originale come dedup naïve resta bloccato per
sempre nonostante un log di successo apparente (bug reale, verificato dal
vivo con crash reale simulato via `docker compose restart` — vedi
`enrichment-resume.service.ts`). Ma rimuovere sempre `opts.jobId` non è la
correzione giusta: se il vecchio job è ancora `active` (worker crashato,
lock scaduto — questo repo non chiama `app.enableShutdownHooks()`, opzioni
BullMQ default), lo stalled-job recovery di BullMQ lo riprende da solo
entro il `stalledInterval` (default 30s) — aggiungerne un secondo in quel
caso produce due processor concorrenti sullo stesso job applicativo
(checkpoint/file scritti due volte, race reale). Prima di un re-add:
`queue.getJob(id)` + `.getState()` — `active/waiting/delayed` → non
toccare, lascialo al recovery automatico; `completed/failed/assente` →
`.remove()` esplicito poi `add()` con lo stesso jobId (ripristina la dedup
come rete di sicurezza).

**Il dedup per jobId vale nell'INTERA coda, non per singolo job NAME.**
Due job type diversi (es. `merge-batch` poi `enrich`) che riusano lo stesso
jobId nella stessa coda collidono: il secondo `queue.add()` è no-op
silenzioso anche se il job name è diverso — bug reale, l'`enrich` non
partiva mai dopo un `merge-batch` completato con lo stesso jobId. Se due
fasi diverse dello stesso record applicativo usano job BullMQ separati,
dare loro jobId distinti (es. prefisso `merge-${id}`), non lo stesso id.

## BullMQ `queue.getJobs(['completed'|'failed'], ...)` — ordine non garantito "più recenti prima"

Nessun campo data mostrato in UI + ordine non ordinato ha causato una diagnosi
reale sbagliata durante un incidente live (un errore SMTP di una campagna di
3 mesi prima scambiato per l'errore della campagna corrente, perché in cima
alla lista). `NotificationQueuesService.getJobsDetail()` ora ordina
esplicitamente per `finishedOn ?? timestamp` DESC — qualunque nuovo punto
che legge `getJobs()` su questi due stati deve fare lo stesso, mai assumere
che il primo risultato sia il più recente.

## Cron/coda con batch fisso — round-robin obbligatorio, mai ORDER BY statico

Un demone che processa un batch limitato (`LIMIT N`) da una coda più grande
deve ordinare per "ultimo controllato", mai per un campo statico come
`created_at` — bug reale: `PostalStatusSyncService` ordinava per
`created_at ASC` fisso; con >200 (`BATCH_SIZE`) candidati totali (390 in
produzione), i record più vecchi che non progrediscono mai (stato non
terminale permanente) monopolizzano per sempre le prime posizioni,
affamando i record più nuovi — mai ripescati dal cron, solo un
"Ricontrolla stato" manuale li aggiornava. Fix: nuova colonna
`postal_last_checked_at` (aggiornata ad OGNI controllo, anche se lo stato
non cambia — non basta il campo "ultimo cambio" esistente,
`postal_status_updated_at`, che non avanza mai per un record fermo),
`ORDER BY COALESCE(postal_last_checked_at, created_at) ASC`. Qualunque
futuro cron con batch+limit va verificato per lo stesso rischio.

**Ogni nuova condizione di re-check su un attempt POSTAL terminale (es.
controllo riaccodamento su `Eliminato`) va aggiunta ANCHE alla WHERE di
`PostalStatusSyncService.handleCron`, non solo alla logica di `syncOne`.**
Bug reale: `checkRequeue()` era corretto ma il filtro del cron escludeva a
priori un `Eliminato` con `cost_cents` già valorizzato (caso comune) — il
controllo automatico non veniva mai raggiunto. Il manuale (`refreshOne`)
bypassa questo filtro (legge per id) e può sembrare funzionare mentre
l'automatico resta silenziosamente rotto — testare sempre entrambi.

**`postal_last_checked_at` va aggiornato ANCHE quando `dettagli_documento`
lancia (SOAP fault/timeout/IDPRO non più valido), non solo su risposta
riuscita.** Bug reale su una campagna con 4000+ POSTAL: un IDPRO che fallisce
sempre non avanzava mai quel timestamp, restando per sempre il candidato più
"vecchio" in cima all'`ORDER BY ASC` — riselezionato a ogni giro cron,
falliva di nuovo, occupava uno slot del batch (200/min) senza mai avanzare,
affamando gli altri destinatari dietro in coda (stato/costo fermi da giorni,
nessun errore visibile lato UI). Fix in `syncOne`: try/catch attorno alla
chiamata, timestamp aggiornato comunque prima di rilanciare l'errore.

**GlobalCom risponde spesso `Costo:0` mentre il documento è ancora in
lavorazione — è un placeholder, MAI un costo reale finale.** `cost_cents = 0`
va trattato come "non ancora calcolato" alla pari di `NULL` in OGNI punto che
legge/aggrega il costo: filtro WHERE del cron, gate di aggiornamento in
`syncOne`, media in `getCampaignCostSavings` (POSTAL), conteggio
"non calcolati" in `getCampaignCost`. 3 bug reali corretti nella stessa
sessione per lo stesso motivo (`cost_cents !== null` bastava a considerarlo
"già costato per sempre", bloccando il vero costo che GlobalCom calcola più
tardi) — qualunque nuovo punto che legge `cost_cents` va controllato contro
questo stesso caso.

## Stato consegna POSTAL/SEND post-accettazione — mai riflesso su recipient.status

Un errore di consegna arrivato DOPO l'accettazione del provider (es.
GlobalCom `Stato=Accettato` ma poi `CodiceErrore!=='0'` su
`postalStatusHistory`, stesso principio già noto per `sendStatus`) non fa
MAI transitare `NotificationAttempt.status`/`Recipient.status` a FAILED —
nessun demone lo fa oggi (`postal-status-sync.service.ts`/
`send-status-sync.service.ts` aggiornano solo `postalStatus`/`sendStatus`,
mai lo status). Conseguenza pratica: `retryRecipient()` (richiede
`RecipientStatus.FAILED`) rifiuta questi destinatari finché qualcosa non
forza la transizione — vedi `updateRecipientAddressAndRetry()` in
`campaigns.service.ts`, che la forza SOLO in risposta a un'azione operatore
esplicita (mai in automatico, per non rischiare di marcare FAILED uno stato
GlobalCom transitorio come "Rimandato").

**`CampaignCompletionService.checkAndComplete()` distingue COMPLETED da
FAILED solo nel caso 100% fallito** (bug reale corretto, PR #44:
campagna a destinatario singolo con invio in errore mostrata
"Completata" invece di "Fallito" — `CampaignStatus.FAILED` esisteva già
nell'enum, mai scritto da nessun codice prima). Se nessun destinatario
è arrivato a SENT, chiude FAILED; altrimenti COMPLETED. **Il caso misto
(alcuni SENT, alcuni FAILED, o errori di consegna post-accettazione tipo
CodiceErrore/sendStatus) resta deliberatamente COMPLETED** — stessa
discussione aperta di prima, non ancora decisa: cosa conta come errore
oltre FAILED puro, se serve un enum `COMPLETED_WITH_ERRORS`, se aspettare
la consegna finale (giorni, SEND/POSTAL) o restare al solo momento di
sottomissione.

## Side-effect su NotificationAttempt dopo l'invio — solo in notification.processor.ts

Le `*Strategy.send()` (`postal.strategy.ts`, `send-dispatch.service.ts`...)
ritornano solo un `ChannelSendResult`, nessun accesso ad `attemptRepo` —
qualunque scrittura sull'attempt subito dopo un invio riuscito (es.
`postalTrackingId`, stato iniziale) va fatta in `notification.processor.ts`,
l'unico layer che chiama `attemptRepo.update()` dopo aver ricevuto il
risultato della strategy. Un design doc ha assunto una volta che questo
andasse nella strategy stessa — sbagliato, verificato solo leggendo il
codice reale, non lo spec di progettazione.

## `NotificationAttempt.responsePayload` — chiavi generiche (`messageId`/`id`) sono per canale, mai per "il messaggio App IO"

`pec.strategy.ts`/`email.strategy.ts` scrivono `messageId: info.messageId`
(Message-ID SMTP, mai pensato per essere mostrato) nello STESSO
`responsePayload` che porta anche `appIo: {messageId: ...}` quando c'è
co-consegna. Un fallback generico che legge `responsePayload.messageId`/
`.id` senza scoparlo a `channelType==='APP_IO'` mostra l'SMTP Message-ID
sotto l'etichetta "ID Messaggio App IO" — bug reale, confermato dal vivo
con query dirette sul DB (un solo attempt, nessuna riga fantasma).
Qualunque nuovo canale che scrive `responsePayload.messageId`/`.id` per
tracking proprio deve essere consapevole che quella chiave è condivisa.

