# Pipeline a demoni per SEND (protocollazione + invio disaccoppiati) — Design

## Contesto

Terzo sotto-progetto della serie SEND (dopo: connettore Protocollo, invio SEND
reale). Oggi `SendStrategy.send()` fa tutto sincrono dentro un job BullMQ
lanciato da `launch()`/`retryRecipient()`: protocollazione SOAP + generazione
PDF + upload allegati su S3 + costruzione payload + POST a PN, tutto in una
singola invocazione. Questo ha due problemi concreti:

1. **Non serve real-time**: la protocollazione è una chiamata SOAP esterna
   lenta, l'invio a PN è async per natura (PN risponde solo `202 Accepted`,
   lo stato reale arriva ore/giorni dopo via `SendStatusSyncService`). Non
   c'è motivo per cui la protocollazione debba bloccare il job di invio.
2. **Rischio residuo aperto** (dal sotto-progetto precedente, review
   finale): un redelivery BullMQ tra "PN ha accettato (202)" e "scrittura
   DB del successo" può far ripartire `send()` da capo, che rifà la
   protocollazione (nuovo `paProtocolNumber` reale) mantenendo lo stesso
   `idempotenceToken` — PN non riconosce più il duplicato. La mitigazione
   attuale (guardia scrittura intermedia) riduce la finestra ma non la
   chiude del tutto.

La soluzione: **disaccoppiare in 3 stadi indipendenti**, ciascuno un demone
schedulato che pollano lo stato su DB, nessuno sincrono dentro BullMQ:

1. **Protocollazione** (generico, non SEND-specifico) — protocolla i
   tentativi con `channelConfig.protocolla=true` non ancora protocollati.
2. **Invio SEND** (SEND-specifico) — invia a PN i tentativi SEND già
   protocollati e non ancora inviati.
3. **Stato SEND** (esistente, invariato, `SendStatusSyncService`) — risolve
   IUN e stato reale dei tentativi SEND già inviati.

Questo chiude strutturalmente il rischio residuo: quando il demone invio
gira, la protocollazione è già avvenuta e persistita — un retry del demone
invio (per qualunque motivo: crash, errore di rete) non richiede mai una
nuova protocollazione, riusa sempre lo stesso `paProtocolNumber` già in DB.

## Stato attuale (riferimento esatto)

- `campaigns.service.ts:259-358` (`launch()`): inserisce `NotificationAttempt`
  (`status: QUEUED`) in bulk, poi `notificationQueues.addBulk(channelType,
  jobs)` con `opts.jobId = attemptId` (`:347`) — **stesso pattern per tutti
  i canali**, nessuna specializzazione SEND oggi a questo livello.
- `campaigns.service.ts:770-808` (`retryRecipient()`): stesso pattern,
  singolo attempt.
- `campaigns.service.ts:360-435` (`cancel()`): per ogni attempt `QUEUED`,
  `notificationQueues.getJob(channelType, attempt.id)` + `job.remove()`
  (`:383-386`), poi marca `CANCELLED`. Se `!job`, salta silenziosamente
  (`:384`, bug latente già esistente per job già `active`).
- `queue/notification-job.types.ts:6-12`: una coda BullMQ per canale
  (`CHANNEL_QUEUES.SEND` = `notifications-send`).
- `queue/channel-processors.ts`: `SendNotificationProcessor` (sottoclasse
  vuota di `NotificationProcessor`, `@Processor(CHANNEL_QUEUES.SEND)`).
- `queue/notification-queues.service.ts`: `addBulk`/`getJob`/pausa/log per
  canale, usato anche dalla UI Motori.
- `entities/notification-attempt.entity.ts`: `status: AttemptStatus`
  (`QUEUED|PROCESSING|SUCCESS|FAILED|CANCELLED`), `responsePayload: jsonb`
  (oggi contiene sia `notificationRequestId` sia `protocollo.{numeroProtocollo,
  annoProtocollo,dataProtocollazione}`), più `iun`/`sendStatus`/
  `sendStatusUpdatedAt` (dal sotto-progetto precedente).
- `entities/campaign.entity.ts`: `channelConfig: jsonb` contiene
  `protocolla: true/false` (letto oggi solo da `SendStrategy`).
- `send.strategy.ts:40-164`: blocco protocollazione (`:64-80`) → blocco
  upload allegati (`:82-96`) → blocco pagamento+payload (`:98-137`) → POST
  PN (`:139-153`) → parsing risposta (`:155-163`). `idempotenceToken:
  attemptId` (`:122`, dal fix precedente).
- `notification.processor.ts:91-122`: guardia redelivery BullMQ (da
  rimuovere per SEND, non più necessaria — resta per gli altri canali,
  invariata).

## Decisioni

- **Stato "protocollato"**: nuove colonne dedicate su `NotificationAttempt`
  (non riuso di `responsePayload.protocollo` via JSON path) — stesso
  pattern già usato per `iun`/`sendStatus`. Motivazione esplicita
  dell'utente: la protocollazione sarà bloccante anche per altri canali in
  futuro, quindi merita colonne di prima classe, non un campo annidato in
  JSON pensato solo per SEND.
- **Upload allegati**: solo nel demone invio, mai nel demone
  protocollazione — evita il rischio di URL S3 presigned scaduti (validità
  1h) se passa tempo tra i due stadi. Il demone protocollazione genera il
  proprio PDF (per la chiamata SOAP Protocollo) e lo scarta; il demone
  invio rigenera il proprio PDF (stesso contenuto deterministico da
  `AttachmentService`) e lo carica fresco su PN.
- **Coda BullMQ SEND**: rimossa. `launch()`/`retryRecipient()` per SEND non
  accodano più nulla — inseriscono solo l'attempt `QUEUED`, i demoni lo
  raccolgono pollando. `cancel()` per SEND: update diretto su DB.
- **Genericità del demone protocollazione**: query per
  `channelConfig.protocolla=true`, non hardcoded su `channelType=SEND` —
  pronto per altri canali in futuro, ma il consumo dei dati protocollati
  (leggerli e usarli in un payload) resta implementato solo per SEND in
  questo giro. Nessun altro canale viene toccato.

## Architettura

### Migration — nuove colonne `NotificationAttempt`

```ts
protocolNumber: number | null    // varchar? no: numero e anno separati come oggi in ProtocollaResult
protocolYear: number | null
protocolledAt: Date | null       // timestamptz, popolato solo a protocollazione riuscita
```

Tipi: `protocolNumber`/`protocolYear` come `integer nullable` (rispecchiano
`ProtocolloService.ProtocollaResult.numeroProtocollo`/`annoProtocollo`, già
`number` in TS). `protocolledAt` come `timestamptz nullable`.

### `apps/backend/src/channels/protocollazione-sync.service.ts` (nuovo, generico)

Pattern `@Cron` identico a `RetentionCleanupService`/`SendStatusSyncService`.
Intervallo: ogni 2 minuti (`*/2 * * * *`) — più frequente del demone di
stato (15 min) perché sta sul percorso critico prima dell'invio, non è
semplice monitoraggio.

```ts
const BATCH_SIZE = 200;

@Injectable()
export class ProtocollazioneSyncService {
  @Cron('*/2 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .innerJoin('attempt.recipient', 'recipient')
      .innerJoin('recipient.campaign', 'campaign')
      .where('attempt.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('attempt.protocolled_at IS NULL')
      .andWhere("campaign.channel_config ->> 'protocolla' = 'true'")
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();
    // relations complete via leftJoinAndSelect su recipient+campaign per avere i dati serviti a ProtocolloService

    for (const attempt of attempts) {
      try {
        const buffer = await this.attachments.generatePdfBuffer(attempt.recipient, 0);
        const { nome, cognome } = splitFullName(attempt.recipient.fullName);
        const result = await this.protocollo.protocolla({
          oggetto: attempt.recipient.campaign.channelConfig?.subject ?? attempt.recipient.campaign.name,
          destinatario: { codiceFiscale: attempt.recipient.codiceFiscale, nome, cognome, denominazione: attempt.recipient.fullName ?? attempt.recipient.codiceFiscale },
          documentBuffer: buffer,
          documentFilename: `${attempt.recipient.codiceFiscale}.pdf`,
        });
        attempt.protocolNumber = result.numeroProtocollo;
        attempt.protocolYear = result.annoProtocollo;
        attempt.protocolledAt = new Date();
        await this.attemptRepo.save(attempt);
      } catch (err: any) {
        this.logger.warn(`Protocollazione fallita per attempt ${attempt.id}: ${err.message}`);
        // non tocca status: resta QUEUED, riprovato al prossimo giro.
        // Nessun retry-limit in questo giro (fuori scope, coerente con SendStatusSyncService che non ne ha).
      }
    }
  }
}
```

`splitFullName` va estratta da `send.strategy.ts` in un'utility condivisa
(oggi è una funzione privata del file) — spostarla in
`apps/backend/src/channels/send/name.util.ts` o simile, usata da entrambi.

### `apps/backend/src/channels/send/send-dispatch.service.ts` (nuovo, sostituisce la logica sincrona)

Stesso pattern `@Cron`, ogni 2 minuti.

```ts
@Cron('*/2 * * * *')
async handleCron(): Promise<void> {
  const attempts = await this.attemptRepo
    .createQueryBuilder('attempt')
    .where('attempt.channel_type = :ch', { ch: 'SEND' })
    .andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED })
    .andWhere('attempt.protocolled_at IS NOT NULL')
    .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NULL")
    .orderBy('attempt.created_at', 'ASC')
    .take(BATCH_SIZE)
    .getMany();

  for (const attempt of attempts) {
    try {
      // 1. genera PDF fresco, preload+upload (uno o più documenti)
      // 2. costruisce payload v2.6/requests con attempt.protocolNumber/protocolYear
      //    (paProtocolNumber = `${attempt.protocolNumber}/${attempt.protocolYear}`)
      // 3. idempotenceToken = attempt.id (stabile, invariato dal fix precedente)
      // 4. POST a PN
      // 5. su 202: responsePayload = { notificationRequestId }, status = SUCCESS,
      //    aggiorna recipient.status/sentCount della campagna (stessa logica
      //    di completeSuccess() in notification.processor.ts, da riusare/estrarre)
    } catch (err: any) {
      // su errore: status = FAILED, errorMessage, aggiorna failedCount
      // (stessa logica di gestione errore attuale del processor)
    }
  }
}
```

**Riuso**: la logica di "genera documenti + payments + payload + POST" va
estratta da `SendStrategy.send()` in un metodo/servizio riusabile (es.
`SendPayloadBuilder`/mantenere dentro `SendStrategy` ma chiamato dal
demone invece che dal processor) — decisione di file-structure lasciata al
piano di implementazione, il punto fermo è: **stesso codice di costruzione
payload, nuovo punto di chiamata** (demone invece di job BullMQ).

**Guardia idempotente**: la query stessa (`notificationRequestId IS NULL`)
è già la guardia — non serve altro. Se per qualche motivo il demone
processa due volte lo stesso attempt in run concorrenti (non dovrebbe
accadere con `@Cron` singolo processo, ma da considerare se si scala a più
istanze), la history esistente su NestJS `@Cron` non previene
sovrapposizioni tra istanze multiple del backend — annotare come rischio
noto se il deployment prevede repliche del servizio backend (fuori scope
verificarlo ora, il deployment attuale è mono-istanza).

### `notification.processor.ts` — rimozione del branch SEND

Il processor generico smette di gestire `SEND` (la coda non esiste più per
quel canale): rimuovere `CHANNEL_QUEUES.SEND` da
`queue/notification-job.types.ts`, rimuovere `SendNotificationProcessor` da
`queue/channel-processors.ts`, rimuovere la relativa registrazione in
`queue.module.ts` (`BullModule.registerQueue` non include più la coda
SEND). La guardia redelivery in `notification.processor.ts:91-122` resta
per gli altri 4 canali, invariata — SEND semplicemente non passa più da lì.

`CHANNEL_STRATEGIES`/`channel.module.ts`: `SendStrategy` come DI provider
diventa `SendDispatchService`'s dependency diretta, non più registrata nella
map `CHANNEL_STRATEGIES` (quella serve solo ai canali ancora su BullMQ).

### `campaigns.service.ts` — `launch()`/`retryRecipient()`/`cancel()`

- `launch()` (`:259-358`): per `campaign.channelType === 'SEND'`, salta il
  blocco `addBulk` (righe `:333-350`) — inserisce solo gli attempt
  `QUEUED`. Per gli altri canali, comportamento invariato.
- `retryRecipient()` (`:770-808`): stesso branch — per SEND, insert
  dell'attempt `QUEUED` senza `addBulk`.
- `cancel()` (`:360-435`): per `campaign.channelType === 'SEND'`, sostituire
  il blocco `getJob`/`job.remove()` (`:383-386`) con un update diretto:
  ```ts
  await this.attemptRepo.update(
    { id: In(attemptIds), status: AttemptStatus.QUEUED },
    { status: AttemptStatus.CANCELLED },
  );
  ```
  Questo annulla solo gli attempt ancora `QUEUED` (non protocollati e non
  inviati, o protocollati-ma-non-ancora-inviati — in entrambi i casi lo
  status resta `QUEUED` finché il demone invio non lo marca `SUCCESS`).
  Un attempt già `SUCCESS` (inviato a PN) non è più annullabile — invariato
  rispetto a oggi (un invio legale reale non si può disfare).

### UI Motori — adattamento per SEND

`notification-queues.service.ts`/tab Motori: per il canale SEND, niente più
job BullMQ da mostrare (`getJobCounts`/pausa/log non hanno senso). Sostituire
con contatori per stadio via query diretta su `notification_attempts`:
`queued` (non protocollato), `protocollato` (protocolled_at not null, non
ancora inviato), `inviato` (`SUCCESS`), `fallito` (`FAILED`). Nuovo endpoint
backend (es. `GET admin/engines/send/stage-counts`) + adattamento minimo
della tab Motori lato frontend per il canale SEND (gli altri 4 canali
restano invariati, mostrano ancora i contatori BullMQ esistenti).

## Verifica

- Unit test per `ProtocollazioneSyncService` (query, successo, fallimento
  non bloccante, generic-channel query).
- Unit test per `SendDispatchService` (query, successo end-to-end mockato,
  fallimento, guardia idempotente via query).
- Unit test aggiornati per `campaigns.service.ts` (`launch()`/
  `retryRecipient()`/`cancel()` branch SEND vs altri canali).
- Migration testata su DB temporaneo (sez. "Migration DB" CLAUDE.md).
- `tsc --noEmit` backend/frontend, `jest --maxWorkers=2` (nessuna
  regressione sugli altri 4 canali, che restano su BullMQ invariati).
- Verifica manuale UI: lancio campagna SEND, osservare progressione
  queued→protocollato→inviato nei nuovi contatori Motori, annullamento
  campagna SEND con attempt ancora in stadio queued/protocollato.
- Nessun test contro PN reale (stesso limite dei sotto-progetti precedenti).

## File coinvolti

- `apps/backend/src/database/migrations/<timestamp>-AddProtocolColumns.ts` (nuova)
- `apps/backend/src/entities/notification-attempt.entity.ts` (nuove colonne)
- `apps/backend/src/channels/protocollazione-sync.service.ts` (nuovo)
- `apps/backend/src/channels/send/send-dispatch.service.ts` (nuovo)
- `apps/backend/src/channels/send/send.strategy.ts` (logica payload estratta/riusata, il file stesso potrebbe sparire o restare solo come contenitore di funzioni riusate — deciso nel piano)
- `apps/backend/src/channels/send/name.util.ts` (nuovo, `splitFullName` estratta)
- `apps/backend/src/queue/notification-job.types.ts`, `channel-processors.ts`, `queue.module.ts` (rimozione coda SEND)
- `apps/backend/src/queue/notification.processor.ts` (nessuna modifica funzionale, SEND semplicemente non ci passa più)
- `apps/backend/src/campaigns/campaigns.service.ts` (`launch()`/`retryRecipient()`/`cancel()` branch SEND)
- `apps/backend/src/channels/channel.module.ts` (wiring nuovi servizi, rimozione SEND da CHANNEL_STRATEGIES)
- `apps/backend/src/engines/` (nuovo endpoint stage-counts per SEND)
- `apps/frontend-admin/src/App.tsx` (tab Motori: contatori per stadio per SEND)
