# Annulla Campagna — Design

## Obiettivo

Permettere all'operatore di annullare una campagna in corso (`status: QUEUED`),
eliminando i soli job BullMQ ancora in coda (non ancora processati) e i
relativi record, **senza toccare** i destinatari già inviati (`SENT`) o già
falliti (`FAILED`). Azione irreversibile: la campagna annullata non è
rilanciabile — per reinviare ai destinatari residui serve una nuova campagna.

## Stati coinvolti

Nuovi valori enum (richiedono migration Postgres `ALTER TYPE ... ADD VALUE`):

- `CampaignStatus.CANCELLED` (`apps/backend/src/entities/campaign.entity.ts`)
- `RecipientStatus.CANCELLED` (`apps/backend/src/entities/recipient.entity.ts`)
- `AttemptStatus.CANCELLED` (`apps/backend/src/entities/notification-attempt.entity.ts`)

## Prerequisito: jobId esplicito

Oggi `launch()` e `retryRecipient()` accodano job BullMQ con id
auto-generato — nessun collegamento diretto a un `attemptId`. Per poter
rimuovere i job di una campagna senza scansionare l'intera coda del canale
(che può contenere job di altre campagne), entrambi i punti che chiamano
`notificationQueues.addBulk(...)` vengono modificati per passare
`opts: { jobId: attemptId }`. L'`attemptId` è un UUID, già univoco: nessuna
migration richiesta, solo modifica al codice che costruisce il job.

File coinvolti:
- `apps/backend/src/campaigns/campaigns.service.ts` → `launch()` (bulk insert
  con `JOB_CHUNK`) e `retryRecipient()`
- `apps/backend/src/queue/notification-queues.service.ts` → `addBulk()` deve
  accettare/propagare `opts` per job (oggi non lo fa, va esteso)

## `cancel(campaignId)` — nuovo metodo in `campaigns.service.ts`

1. **Guard stato:** carica la campagna; se non esiste → `NotFoundException`;
   se `status !== CampaignStatus.QUEUED` → `BadRequestException` ("Solo
   campagne in corso possono essere annullate").
2. **Individua destinatari in coda:** `recipientRepo.find({ where: {
   campaignId, status: RecipientStatus.QUEUED }, select: ['id'] })`.
3. **Individua gli attempt "vivi":** `attemptRepo.find({ where: {
   recipientId: In(recipientIds), status: AttemptStatus.QUEUED } })` — per
   ogni recipient in coda esiste esattamente un attempt `QUEUED` alla volta
   (il più recente; eventuali attempt precedenti dello stesso recipient sono
   già `FAILED`/`SUCCESS`).
4. **Rimozione job, per singolo attempt:**
   - `const job = await queue.getJob(attempt.id)` (id = attemptId, grazie al
     prerequisito sopra)
   - `await job?.remove()` in try/catch: se il job è `active` (worker lo sta
     già processando in questo istante — race fisiologica), `remove()`
     lancia eccezione: si logga a `warn` e si **salta** quel recipient, che
     resterà intatto e si chiuderà da solo in `SENT`/`FAILED` a fine invio.
   - Solo gli attempt rimossi con successo finiscono nella lista da marcare
     come annullati.
5. **Aggiorna DB solo per i rimossi:**
   - `attemptRepo.update({ id: In(removedAttemptIds) }, { status:
     AttemptStatus.CANCELLED })`
   - `recipientRepo.update({ id: In(removedRecipientIds) }, { status:
     RecipientStatus.CANCELLED })`
6. **Chiudi la campagna**, stesso pattern guard già usato in
   `checkAndCompleteCampaign()`:
   ```sql
   UPDATE campaigns SET status = 'cancelled', completed_at = now()
   WHERE id = :id AND status = 'queued'
   ```
   Se nel frattempo (mentre si rimuovevano i job) l'ultimo destinatario in
   volo è stato processato e `checkAndCompleteCampaign()` ha già portato la
   campagna a `COMPLETED`, questo update non tocca nulla — nessuna race,
   la campagna resta `COMPLETED` (corretto: non c'era più nulla da
   annullare). Riuso `completed_at` come timestamp di chiusura sia per
   `COMPLETED` che per `CANCELLED`, niente nuova colonna.
7. **Ritorno:** `{ cancelled: number, campaignId: string }` dove `cancelled`
   = numero di destinatari effettivamente rimossi dalla coda.

## Endpoint

`POST admin/campaigns/:id/cancel` in `campaigns.controller.ts`, nessun
override di `@Roles` — eredita il default della classe (`user`, `admin`),
stesso livello di permesso di `launch`.

## Frontend (`apps/frontend-admin/src/App.tsx`)

- Nuovo bottone "Annulla Campagna" (`btn-outline-danger`), reso solo quando
  `campaign.status === 'queued'`, accanto al bottone "Lancia Campagna"
  (visibile solo per `status === 'draft'` — mai contemporaneamente).
- Handler `handleCancelCampaign`, stesso pattern di `handleLaunchCampaign`:
  `window.confirm(...)` con testo esplicito su irreversibilità e sul fatto
  che i messaggi già inviati non vengono toccati, poi `POST
  {ADMIN_API_BASE}/campaigns/:id/cancel`, `alert()` su esito, infine
  `fetchCampaignDetail(campaign.id)` per refresh stato/contatori.
- Stato locale `cancelling` (boolean) per disabilitare il bottone durante la
  richiesta, analogo a `launching`.

## Fuori scope

- Nessuna UI per "riprendere" una campagna annullata — è stato terminale.
- Nessuna modifica al comportamento di `pause`/`resume` coda (quelli sono
  per canale, non per campagna, e restano invariati).
- Nessuna gestione speciale per attempt `PROCESSING` in corso: completano
  normalmente, fuori dal perimetro dell'annullamento.
