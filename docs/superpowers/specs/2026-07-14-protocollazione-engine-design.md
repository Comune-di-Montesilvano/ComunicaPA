# Motore Protocollazione separato (coda/UI/log dedicati) — Design

Data: 2026-07-14

## Contesto

Terzo giro della serie SEND (dopo: connettore Protocollo, invio SEND reale,
pipeline a demoni, audit completamento/dettaglio). Oggi `ProtocollazioneSyncService`
è un demone `@Cron` generico (non SEND-specifico, ma solo SEND lo usa in
pratica: `launch()` impone `channelConfig.protocolla=true` obbligatorio per
ogni campagna SEND) che interroga il DB ogni 2 minuti per attempt da
protocollare. Due problemi concreti:

1. **Retry infinito silenzioso**: su fallimento della protocollazione,
   l'attempt resta `QUEUED`/`protocolledAt=null` e viene ritentato ad ogni
   giro, per sempre — nessun tetto, nessun log consultabile dalla UI, nessun
   modo per l'operatore di vedere "quanti tentativi falliti, con che errore"
   se non nei log applicativi grezzi.
2. **Nessuna gestione operativa**: a differenza degli altri 4 canali (EMAIL/
   PEC/APP_IO/POSTAL, tutti su BullMQ con pausa/riprendi/job falliti/log per
   job dalla tab Motori), la protocollazione non ha nulla di tutto questo —
   è invisibile finché non si guardano i log del container.

## Obiettivo

Convertire la protocollazione in un motore BullMQ vero, con la stessa UI/
gestione operativa degli altri 4 canali (tab Motori: pausa, riprendi, job
falliti con motivo, log per job). Come effetto collaterale, questo risolve
anche il retry infinito: un job BullMQ senza `attempts` esplicito fallisce
una volta sola, finisce nel bucket "failed" (visibile, con log), richiede
intervento manuale — stesso comportamento già in uso per gli altri canali.

**Non tocca** `SendDispatchService` (resta poll-based, decisione esplicita
del sotto-progetto "pipeline a demoni" per evitare il rischio di redelivery
BullMQ su un invio legale reale — invariato, già verificato che non ha
retry automatico: un attempt fallito resta `FAILED` per sempre, richiede
"Rimetti in coda" manuale, comportamento già identico agli altri canali).

**Non tocca** il retry dell'operatore (`retryRecipient()`): già eredita
`protocolNumber/protocolYear/protocolledAt` se l'ultimo attempt era già
protocollato (nessuna riprotocollazione inutile) — verificato, già corretto.

## Architettura

### 1. Coda BullMQ dedicata

`apps/backend/src/queue/notification-job.types.ts`: nuova costante
`PROTOCOLLAZIONE_QUEUE = 'notifications-protocollazione'`. Nuovo tipo
`ENGINE_QUEUES = { ...CHANNEL_QUEUES, PROTOCOLLAZIONE: PROTOCOLLAZIONE_QUEUE }`
— generalizza il concetto da "canale" a "motore" (la protocollazione non è
un `NotificationChannel`, ma va gestita con lo stesso meccanismo generico).

### 2. `NotificationQueuesService` esteso

Aggiunge una 5ª coda iniettata (`@InjectQueue(PROTOCOLLAZIONE_QUEUE)`), tipo
`EngineName = keyof typeof ENGINE_QUEUES` al posto di `QueuedChannel` per
tutti i metodi esistenti (`addBulk`/`getJob`/`getJobCounts`/`isPaused`/
`pause`/`resume`/`getJobsDetail`/`getJobLogs`) — stessa interfaccia, un
parametro in più nell'union type. Nessun nuovo metodo, solo il tipo esteso.

### 3. `ProtocollazioneProcessor` (nuovo, sostituisce il cron)

```ts
@Processor(PROTOCOLLAZIONE_QUEUE)
export class ProtocollazioneProcessor extends WorkerHost {
  constructor(
    @InjectRepository(NotificationAttempt) private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient) private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
    private readonly campaignCompletion: CampaignCompletionService,
  ) { super(); }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { attemptId, recipientId, campaignId } = job.data;
    const jobLog = (msg: string) => job.log(msg);

    // Fresh read: guardia contro cancel() concorrente (stesso spirito del
    // guard in SendDispatchService.markSuccess/markFailed) — un attempt
    // CANCELLED nel frattempo non va protocollato.
    const attempt = await this.attemptRepo.findOne({ where: { id: attemptId }, relations: { recipient: { campaign: true } } });
    if (!attempt || attempt.status !== AttemptStatus.QUEUED) {
      jobLog(`Attempt ${attemptId} non più QUEUED (probabile cancel() concorrente) — protocollazione saltata.`);
      return;
    }

    const recipient = attempt.recipient;
    const campaign = recipient.campaign;
    const cfg = campaign.channelConfig as Record<string, unknown>;
    const subject = (cfg['subject'] as string) ?? campaign.name;

    try {
      const { nome, cognome } = splitFullName(recipient.fullName);
      const buffer = await this.attachments.generatePdfBuffer(recipient, 0);
      const result = await this.protocollo.protocolla({
        oggetto: subject,
        destinatario: { codiceFiscale: recipient.codiceFiscale, nome, cognome, denominazione: recipient.fullName ?? recipient.codiceFiscale },
        documentBuffer: buffer,
        documentFilename: `${recipient.codiceFiscale}.pdf`,
      });
      await this.attemptRepo.update(attemptId, {
        protocolNumber: result.numeroProtocollo,
        protocolYear: result.annoProtocollo,
        protocolledAt: new Date(),
      });
      jobLog(`Attempt ${attemptId} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`);
    } catch (err: any) {
      jobLog(`Protocollazione fallita: ${err.message}`);
      // Stesso trattamento di un fallimento SendDispatchService.markFailed:
      // la protocollazione è un prerequisito legale all'invio, un suo
      // fallimento è un fallimento reale del destinatario, non un errore
      // interno da nascondere. Guardia su status=QUEUED (stesso motivo).
      const result = await this.attemptRepo.update(
        { id: attemptId, status: AttemptStatus.QUEUED },
        { status: AttemptStatus.FAILED, errorMessage: err.message },
      );
      if (result.affected) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
        await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
        await this.campaignCompletion.checkAndComplete(campaignId);
      }
      throw err; // BullMQ registra il job come failed (visibile in Motori con log)
    }
  }
}
```

`ProtocollazioneSyncService` (il vecchio cron) **rimosso interamente** —
sostituito da questo processor. `splitFullName` resta importato da
`send/name.util.ts` (invariato).

### 4. `launch()`/`retryRecipient()` accodano il job

`campaigns.service.ts#launch()`: il blocco attuale "SEND non passa da
BullMQ" (righe ~344-365) diventa, per `campaign.channelType === 'SEND'`
(che ha sempre `protocolla=true`, enforced a monte): accoda un job
protocollazione per attempt, stesso pattern chunk+`jobId=attemptId` già
usato per gli altri 4 canali (`NotificationQueuesService.addBulk('PROTOCOLLAZIONE', ...)`).

`retryRecipient()`: dopo aver calcolato `inheritedProtocol` (righe ~852-859),
se **non** eredita un protocollo già fatto (`!inheritedProtocol.protocolledAt`),
accoda un job protocollazione per il nuovo attempt — se invece eredita,
l'attempt è già pronto per `SendDispatchService` (nessuna coda da toccare,
comportamento invariato).

### 5. `cancel()` — rimozione job protocollazione best-effort

Nel branch SEND di `cancel()` (righe ~398-427), dopo l'update
`CANCELLED` sugli attempt ancora `QUEUED`, tentativo best-effort di
rimuovere il job BullMQ corrispondente (stesso try/catch già usato nel
branch non-SEND per gli altri canali) — difesa aggiuntiva insieme al guard
nel processor (punto 3), non sostitutiva.

### 6. `EnginesController`/UI Motori — riga Protocollazione

`list()` itera su `Object.keys(ENGINE_QUEUES)` invece di `QUEUED_CHANNELS`
— la protocollazione compare come 5° motore con paused/counts. Gli
endpoint `pause`/`resume`/`jobs`/`jobs/:jobId/logs` estendono il type guard
per accettare anche `PROTOCOLLAZIONE`. Frontend (`App.tsx`, tab Motori):
nessuna nuova sezione JSX — il rendering è già generico sull'array
`engines` restituito da `GET admin/engines` (verificare in
implementazione: se il rendering oggi ha logica speciale per
canale/icona, aggiungere `PROTOCOLLAZIONE` a `CHANNEL_META`-equivalente
con label "Protocollazione", icona `fa-stamp`, badge neutro).

### 7. Barra a 4 stadi nel dettaglio campagna (SEND)

Nuovo endpoint `GET campaigns/:id/send-stage-counts` in
`campaigns.controller.ts`/`campaigns.service.ts` — stessa forma di
`GET admin/engines/send/stage-counts` esistente (`{queued, protocollato,
inviato, fallito}`), ma filtrato per `campaignId` invece che globale.
Frontend: nel dettaglio campagna, per `campaign.channelType === 'SEND'`,
seconda barra/contatori "In attesa protocollo / Protocollato (in attesa
invio) / Inviato / Fallito" **aggiunta accanto** alla barra "Stato
dell'Invio" esistente (successo/errori) — non la sostituisce, framing
diverso (l'esistente è binaria successo/fallito sul totale, la nuova
mostra la progressione a stadi). Altri canali: nessun cambiamento.

## Testing

- Unit test `ProtocollazioneProcessor`: successo (scrive colonne, non
  tocca status), fallimento (marca FAILED + failedCount + chiama
  `checkAndComplete`, poi rilancia l'errore), guardia status non più
  QUEUED (no-op, nessun protocollo chiamato).
- Unit test `launch()`: per SEND, verifica `addBulk('PROTOCOLLAZIONE', ...)`
  chiamato con jobId=attemptId per ogni attempt creato.
- Unit test `retryRecipient()`: con protocollo ereditato → nessun
  `addBulk`; senza → `addBulk('PROTOCOLLAZIONE', ...)` chiamato per il
  nuovo attempt.
- Unit test `cancel()`: branch SEND tenta `getJob('PROTOCOLLAZIONE', ...)`
  + `job.remove()` best-effort (non fallisce se il job non esiste più).
- Unit test nuovo endpoint `send-stage-counts` per campagna (conteggi
  scoped, non globali — due campagne SEND diverse non si mescolano).
- Verifica manuale: lanciare campagna SEND, osservare la riga
  "Protocollazione" nella tab Motori (job in coda→completato, log
  visibili), la barra a 4 stadi nel dettaglio campagna progredire, un
  fallimento di protocollazione (es. Protocollo non raggiungibile)
  comparire come job failed con motivo nella tab Motori E come
  destinatario FAILED nel dettaglio campagna (stesso posto di un
  fallimento SEND vero, retryabile con "Rimetti in coda").
- `tsc --noEmit` backend/frontend-admin, `jest --maxWorkers=2` (nessuna
  regressione sugli altri 4 canali, invariati).

## Fuori scope

- Retry automatico con backoff per `SendDispatchService`: non esiste un
  bisogno reale oggi (nessun loop infinito, un attempt fallito si ferma
  già al primo tentativo, identico agli altri canali) — confermato con
  l'utente, non lo costruiamo.
- Timeline eventi PN con date reali di consegna (per il report CSV
  finale): resta il gap già annotato nello spec dell'audit precedente,
  non toccato qui.

## File coinvolti

- `apps/backend/src/queue/notification-job.types.ts` (nuova coda + `ENGINE_QUEUES`)
- `apps/backend/src/queue/notification-queues.service.ts` (tipo esteso `EngineName`)
- `apps/backend/src/queue/channel-processors.ts` o nuovo file (`ProtocollazioneProcessor`)
- `apps/backend/src/queue/queue.module.ts` (registra la nuova coda+processor)
- `apps/backend/src/channels/protocollazione-sync.service.ts` (rimosso)
- `apps/backend/src/channels/channel.module.ts` (rimuove `ProtocollazioneSyncService` dai provider se lì registrato — verificare in implementazione dove va spostato `ProtocollazioneProcessor`, probabilmente `queue.module.ts` per coerenza con gli altri processor)
- `apps/backend/src/campaigns/campaigns.service.ts` (`launch()`/`retryRecipient()`/`cancel()`, nuovo `getSendStageCountsForCampaign()`)
- `apps/backend/src/campaigns/campaigns.controller.ts` (nuovo endpoint `:id/send-stage-counts`)
- `apps/backend/src/engines/engines.controller.ts` (estende a `ENGINE_QUEUES`)
- `apps/frontend-admin/src/App.tsx` (tab Motori: label/icona Protocollazione se serve; dettaglio campagna: nuova barra a 4 stadi per SEND)
