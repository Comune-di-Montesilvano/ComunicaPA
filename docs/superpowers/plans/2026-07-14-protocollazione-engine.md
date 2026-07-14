# Motore Protocollazione separato Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertire `ProtocollazioneSyncService` (cron poll con retry infinito silenzioso) in un motore BullMQ vero, con la stessa gestione operativa (pausa/riprendi/job falliti/log) degli altri 4 canali, più una barra a 4 stadi nel dettaglio campagna SEND.

**Architecture:** Nuova coda `notifications-protocollazione` gestita dallo stesso `NotificationQueuesService` generico (tipo esteso da "canale" a "motore"). `campaigns.service.ts#launch()`/`retryRecipient()` accodano job invece di lasciare al cron. Un fallimento di protocollazione riceve lo stesso trattamento di un fallimento SEND vero (attempt/recipient FAILED, `CampaignCompletionService` chiamato), poi rilancia l'errore così BullMQ lo registra come job fallito.

**Tech Stack:** NestJS 10 + BullMQ (backend), React 19 (frontend-admin), Jest.

## Global Constraints

- Test suite backend: SEMPRE `--maxWorkers=2`.
- Baseline nota: 1 fallimento preesistente (`app.controller.spec.ts`, `isLdapMock`) — non toccare.
- `SendDispatchService` NON viene toccato in questo piano (resta poll-based, decisione già presa e confermata: nessun retry automatico serve, un attempt fallito si ferma già al primo tentativo).
- `retryRecipient()` già eredita `protocolNumber/protocolYear/protocolledAt` se l'ultimo attempt era protocollato — non toccare quella logica, solo aggiungere la scelta se accodare o no il job protocollazione.
- Nessuna migration DB: nessuna nuova colonna, solo nuova coda BullMQ + nuovi endpoint.

---

### Task 1: Infrastruttura coda — tipi + `NotificationQueuesService` + wiring modulo

**Files:**
- Modify: `apps/backend/src/queue/notification-job.types.ts`
- Modify: `apps/backend/src/queue/notification-queues.service.ts`
- Modify: `apps/backend/src/queue/queue.module.ts`
- Test: `apps/backend/src/queue/notification-queues.service.spec.ts` (se esiste — verificare prima di scrivere, altrimenti nessun test esistente da adattare per questo task, solo verifica type-check)

**Interfaces:**
- Produces: `PROTOCOLLAZIONE_QUEUE` (stringa), `ENGINE_QUEUES` (oggetto `as const`), `EngineName` (tipo unione `'EMAIL'|'PEC'|'APP_IO'|'POSTAL'|'PROTOCOLLAZIONE'`), `ENGINE_NAMES` (array). `NotificationQueuesService` tutti i metodi ora accettano `EngineName` invece di `QueuedChannel`. Consumato da Task 2 (processor), Task 3 (campaigns.service), Task 5 (engines.controller).

- [ ] **Step 1: Verificare se esiste un test file per `NotificationQueuesService`**

Run: `docker compose exec backend ls src/queue/notification-queues.service.spec.ts 2>&1 || echo "non esiste"`

Se non esiste, questo task procede senza step di test dedicato (la verifica passa da `tsc --noEmit` + i test esistenti di `engines.controller.spec.ts`/`campaigns.service.spec.ts` che lo usano già mockato, aggiornati nei task successivi).

- [ ] **Step 2: Estendere `notification-job.types.ts`**

Sostituire il contenuto di `apps/backend/src/queue/notification-job.types.ts`:

```ts
import type { NotificationChannel } from '@comunicapa/shared-types';

export const NOTIFICATION_JOB_SEND = 'send';

/**
 * Una coda BullMQ dedicata per ogni canale, ECCETTO SEND: SEND non passa più
 * da BullMQ per l'invio (vedi SendDispatchService, poll-based) — vedi
 * docs/superpowers/specs/2026-07-14-pipeline-demoni-send-design.md.
 */
export const CHANNEL_QUEUES: Record<Exclude<NotificationChannel, 'SEND'>, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  POSTAL: 'notifications-postal',
};

export const QUEUED_CHANNELS = Object.keys(CHANNEL_QUEUES) as Array<Exclude<NotificationChannel, 'SEND'>>;

/** Coda dedicata alla protocollazione (channel-agnostica: oggi solo SEND la usa, campaign.channelConfig.protocolla=true). */
export const PROTOCOLLAZIONE_QUEUE = 'notifications-protocollazione';

/**
 * "Motori" gestiti con lo stesso meccanismo generico (pausa/riprendi/job
 * falliti/log) dei canali BullMQ — PROTOCOLLAZIONE non è un NotificationChannel
 * (è channel-agnostica), ma va gestita identicamente dalla tab Motori.
 */
export const ENGINE_QUEUES = {
  ...CHANNEL_QUEUES,
  PROTOCOLLAZIONE: PROTOCOLLAZIONE_QUEUE,
} as const;

export type EngineName = keyof typeof ENGINE_QUEUES;
export const ENGINE_NAMES = Object.keys(ENGINE_QUEUES) as EngineName[];

export const THROTTLE_REDIS = 'THROTTLE_REDIS';
```

- [ ] **Step 3: Estendere `NotificationQueuesService`**

Sostituire il contenuto di `apps/backend/src/queue/notification-queues.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE, type EngineName } from './notification-job.types';

@Injectable()
export class NotificationQueuesService {
  private readonly queues: Map<EngineName, Queue<NotificationJobData>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUES.EMAIL) emailQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.PEC) pecQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.APP_IO) appIoQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.POSTAL) postalQueue: Queue<NotificationJobData>,
    @InjectQueue(PROTOCOLLAZIONE_QUEUE) protocollazioneQueue: Queue<NotificationJobData>,
  ) {
    this.queues = new Map([
      ['EMAIL', emailQueue],
      ['PEC', pecQueue],
      ['APP_IO', appIoQueue],
      ['POSTAL', postalQueue],
      ['PROTOCOLLAZIONE', protocollazioneQueue],
    ]);
  }

  getQueue(channel: EngineName): Queue<NotificationJobData> {
    const queue = this.queues.get(channel);
    if (!queue) throw new Error(`Nessuna coda registrata per il motore ${channel}`);
    return queue;
  }

  addBulk(
    channel: EngineName,
    jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>,
  ) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJob(channel: EngineName, jobId: string) {
    return this.getQueue(channel).getJob(jobId);
  }

  getJobCounts(channel: EngineName): Promise<Record<string, number>> {
    return this.getQueue(channel).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed') as Promise<Record<string, number>>;
  }

  isPaused(channel: EngineName): Promise<boolean> {
    return this.getQueue(channel).isPaused();
  }

  pause(channel: EngineName): Promise<void> {
    return this.getQueue(channel).pause();
  }

  resume(channel: EngineName): Promise<void> {
    return this.getQueue(channel).resume();
  }

  async getJobsDetail(
    channel: EngineName,
    status: 'failed' | 'completed' | 'active' | 'waiting' | 'delayed',
    limit = 50,
  ): Promise<Array<{
    jobId: string;
    campaignId: string;
    recipientId: string;
    attemptId: string;
    failedReason?: string;
    attemptsMade: number;
    timestamp: number;
    finishedOn?: number;
  }>> {
    const jobs = await this.getQueue(channel).getJobs([status], 0, limit - 1);
    return jobs.map((job) => ({
      jobId: String(job.id),
      campaignId: job.data.campaignId,
      recipientId: job.data.recipientId,
      attemptId: job.data.attemptId,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
    }));
  }

  async getJobLogs(channel: EngineName, jobId: string): Promise<string[]> {
    const { logs } = await this.getQueue(channel).getJobLogs(jobId);
    return logs;
  }
}
```

- [ ] **Step 4: Registrare la nuova coda e i moduli necessari in `queue.module.ts`**

In `apps/backend/src/queue/queue.module.ts`, sostituire l'import:
```ts
import { CHANNEL_QUEUES, THROTTLE_REDIS } from './notification-job.types';
```
con:
```ts
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE, THROTTLE_REDIS } from './notification-job.types';
import { ProtocolloModule } from '../protocollo/protocollo.module';
import { AttachmentModule } from '../attachments/attachment.module';
```

Sostituire:
```ts
    BullModule.registerQueue(
      ...Object.values(CHANNEL_QUEUES).map((name) => ({ name })),
    ),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
```
con:
```ts
    BullModule.registerQueue(
      ...Object.values(CHANNEL_QUEUES).map((name) => ({ name })),
      { name: PROTOCOLLAZIONE_QUEUE },
    ),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
    ProtocolloModule,
    AttachmentModule,
```

(`ProtocollazioneProcessor`, aggiunto al Task 2, ha bisogno di `ProtocolloService`/`AttachmentService` — importare i moduli qui invece che modificare `ChannelModule`, che già li importa per altri scopi ma non li esporta.)

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (nessun consumer usa ancora `EngineName`/`ENGINE_QUEUES` in modo incompatibile — i consumer esistenti passano sempre stringhe letterali `'EMAIL'`/`'PEC'`/etc, compatibili col tipo più ampio)

- [ ] **Step 6: Eseguire i test esistenti che usano `NotificationQueuesService`**

Run: `docker compose exec backend node_modules/.bin/jest engines.controller campaigns.service --maxWorkers=2`
Expected: PASS (nessuna regressione — i mock esistenti passano già le stesse stringhe di canale, compatibili col tipo esteso)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/queue/notification-job.types.ts apps/backend/src/queue/notification-queues.service.ts apps/backend/src/queue/queue.module.ts
git commit -m "refactor(backend): estende NotificationQueuesService da canale a motore (EngineName), aggiunge coda protocollazione"
```

---

### Task 2: `ProtocollazioneProcessor` — sostituisce il cron

**Files:**
- Create: `apps/backend/src/queue/protocollazione.processor.ts`
- Test: `apps/backend/src/queue/protocollazione.processor.spec.ts`
- Modify: `apps/backend/src/queue/queue.module.ts` (registra il processor come provider)
- Modify: `apps/backend/src/channels/channel.module.ts` (rimuove `ProtocollazioneSyncService`)
- Delete: `apps/backend/src/channels/protocollazione-sync.service.ts`
- Delete: `apps/backend/src/channels/protocollazione-sync.service.spec.ts`

**Interfaces:**
- Consumes: `ProtocolloService.protocolla(input): Promise<ProtocollaResult>` (`{numeroProtocollo, annoProtocollo}`), `AttachmentService.generatePdfBuffer(recipient, index): Promise<Buffer>`, `splitFullName(fullName): {nome, cognome}` (`send/name.util.ts`), `CampaignCompletionService.checkAndComplete(campaignId): Promise<void>` (Task 1 del piano precedente, già in prod).
- Produces: nessuna nuova interfaccia esterna — un `@Processor(PROTOCOLLAZIONE_QUEUE)` consumato solo da BullMQ stesso.

- [ ] **Step 1: Scrivere il test che deve fallire**

Creare `apps/backend/src/queue/protocollazione.processor.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProtocollazioneProcessor } from './protocollazione.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';

describe('ProtocollazioneProcessor', () => {
  let processor: ProtocollazioneProcessor;

  const mockAttemptRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const mockRecipientRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const mockCampaignRepo = { increment: jest.fn().mockResolvedValue(undefined) };
  const mockProtocollo = { protocolla: jest.fn() };
  const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
  const mockCompletion = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };

  function makeAttempt(overrides: Partial<NotificationAttempt> = {}): NotificationAttempt {
    return {
      id: 'att-1',
      status: AttemptStatus.QUEUED,
      recipientId: 'r1',
      recipient: {
        id: 'r1',
        fullName: 'Mario Rossi',
        codiceFiscale: 'RSSMRA85M01H501Z',
        campaign: { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso TARI' } } as unknown as Campaign,
      } as unknown as Recipient,
      ...overrides,
    } as NotificationAttempt;
  }

  function mockJob(attemptId = 'att-1', recipientId = 'r1', campaignId = 'camp-1') {
    return { data: { attemptId, recipientId, campaignId, channel: 'SEND' }, log: jest.fn() } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.update.mockResolvedValue({ affected: 1 });
    const module = await Test.createTestingModule({
      providers: [
        ProtocollazioneProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: CampaignCompletionService, useValue: mockCompletion },
      ],
    }).compile();
    processor = module.get(ProtocollazioneProcessor);
  });

  it('protocolla con successo e scrive le colonne, senza toccare status', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt());
    mockProtocollo.protocolla.mockResolvedValueOnce({ numeroProtocollo: 123, annoProtocollo: 2026 });

    await processor.process(mockJob());

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', {
      protocolNumber: 123,
      protocolYear: 2026,
      protocolledAt: expect.any(Date),
    });
    expect(mockCompletion.checkAndComplete).not.toHaveBeenCalled();
  });

  it('su fallimento marca attempt/recipient FAILED, chiama checkAndComplete, poi rilancia', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt());
    mockProtocollo.protocolla.mockRejectedValueOnce(new Error('Protocollo non raggiungibile'));

    await expect(processor.process(mockJob())).rejects.toThrow('Protocollo non raggiungibile');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      { id: 'att-1', status: AttemptStatus.QUEUED },
      { status: AttemptStatus.FAILED, errorMessage: 'Protocollo non raggiungibile' },
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', { status: RecipientStatus.FAILED });
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    expect(mockCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
  });

  it('salta silenziosamente se l\'attempt non è più QUEUED (cancel() concorrente)', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt({ status: AttemptStatus.CANCELLED }));

    await processor.process(mockJob());

    expect(mockProtocollo.protocolla).not.toHaveBeenCalled();
    expect(mockAttemptRepo.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest protocollazione.processor --maxWorkers=2`
Expected: FAIL — `Cannot find module './protocollazione.processor'`

- [ ] **Step 3: Creare il processor**

Creare `apps/backend/src/queue/protocollazione.processor.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
import { splitFullName } from '../channels/send/name.util';
import { PROTOCOLLAZIONE_QUEUE } from './notification-job.types';

/**
 * Sostituisce ProtocollazioneSyncService (cron poll): ogni attempt da
 * protocollare passa da un job BullMQ dedicato invece che da un poll ogni 2
 * minuti — stessa gestione operativa (pausa/riprendi/job falliti/log) degli
 * altri 4 canali. Un fallimento riceve lo stesso trattamento di un
 * fallimento SEND vero (attempt/recipient FAILED, CampaignCompletionService
 * chiamato), poi rilancia l'errore così BullMQ registra il job come failed
 * — un job senza `attempts` esplicito fallisce una volta sola, risolvendo
 * il retry infinito silenzioso del vecchio cron.
 */
@Injectable()
@Processor(PROTOCOLLAZIONE_QUEUE)
export class ProtocollazioneProcessor extends WorkerHost {
  private readonly logger = new Logger(ProtocollazioneProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
    private readonly campaignCompletion: CampaignCompletionService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { attemptId, recipientId, campaignId } = job.data;
    const jobLog = (msg: string) => job.log(msg);

    // Fresh read: guardia contro cancel() concorrente, stesso spirito del
    // guard in SendDispatchService.markSuccess/markFailed — un attempt
    // non più QUEUED (es. CANCELLED) non va protocollato.
    const attempt = await this.attemptRepo.findOne({ where: { id: attemptId }, relations: { recipient: { campaign: true } } });
    if (!attempt || attempt.status !== AttemptStatus.QUEUED) {
      const msg = `Attempt ${attemptId} non più QUEUED (probabile cancel() concorrente) — protocollazione saltata.`;
      this.logger.warn(msg);
      jobLog(msg);
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
        destinatario: {
          codiceFiscale: recipient.codiceFiscale,
          nome,
          cognome,
          denominazione: recipient.fullName ?? recipient.codiceFiscale,
        },
        documentBuffer: buffer,
        documentFilename: `${recipient.codiceFiscale}.pdf`,
      });
      await this.attemptRepo.update(attemptId, {
        protocolNumber: result.numeroProtocollo,
        protocolYear: result.annoProtocollo,
        protocolledAt: new Date(),
      });
      const msg = `Attempt ${attemptId} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`;
      this.logger.log(msg);
      jobLog(msg);
    } catch (err: any) {
      const msg = `Protocollazione fallita per attempt ${attemptId}: ${err.message}`;
      this.logger.warn(msg);
      jobLog(msg);
      // Stesso trattamento di un fallimento SendDispatchService.markFailed:
      // la protocollazione è un prerequisito legale all'invio, un suo
      // fallimento è un fallimento reale del destinatario. Guardia su
      // status=QUEUED: se cancel() ha già annullato l'attempt tra la
      // find() sopra e qui, non sovrascrivere.
      const result = await this.attemptRepo.update(
        { id: attemptId, status: AttemptStatus.QUEUED },
        { status: AttemptStatus.FAILED, errorMessage: err.message },
      );
      if (result.affected) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
        await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
        await this.campaignCompletion.checkAndComplete(campaignId);
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest protocollazione.processor --maxWorkers=2`
Expected: PASS (3/3)

- [ ] **Step 5: Registrare il processor in `queue.module.ts`**

In `apps/backend/src/queue/queue.module.ts`, aggiungere l'import:
```ts
import { ProtocollazioneProcessor } from './protocollazione.processor';
```
Nell'array `providers`, aggiungere `ProtocollazioneProcessor,` (es. dopo `PostalNotificationProcessor,`).

- [ ] **Step 6: Rimuovere `ProtocollazioneSyncService` da `channel.module.ts`**

In `apps/backend/src/channels/channel.module.ts`:
- Rimuovere la riga `import { ProtocollazioneSyncService } from './protocollazione-sync.service';`
- Rimuovere `ProtocollazioneSyncService,` dall'array `providers`.

- [ ] **Step 7: Eliminare i vecchi file del cron**

```bash
git rm apps/backend/src/channels/protocollazione-sync.service.ts apps/backend/src/channels/protocollazione-sync.service.spec.ts
```

- [ ] **Step 8: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 9: Eseguire l'intera suite backend e verificare nessuna regressione**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure-set della baseline (1 fallimento noto `app.controller.spec.ts`, nessun altro)

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/queue/protocollazione.processor.ts apps/backend/src/queue/protocollazione.processor.spec.ts apps/backend/src/queue/queue.module.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): ProtocollazioneProcessor su BullMQ sostituisce il cron poll (retry infinito risolto)"
```

---

### Task 3: `campaigns.service.ts` — `launch()`/`retryRecipient()`/`cancel()` accodano/rimuovono job protocollazione

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`launch()` righe ~344-365, `retryRecipient()` righe ~889-893, `cancel()` righe ~410-427)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `NotificationQueuesService.addBulk('PROTOCOLLAZIONE', jobs)`, `.getJob('PROTOCOLLAZIONE', attemptId)` (Task 1).

- [ ] **Step 1: Scrivere i test che devono fallire**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, leggere prima i `describe` esistenti per `launch()`/`retryRecipient()`/`cancel()` per allineare i nomi dei mock (`mockNotificationQueues`/`notificationQueues` o simili — verificare il nome reale, non indovinare). Aggiungere test equivalenti a questi (adattando i nomi):

```ts
describe('launch() — accoda job protocollazione per SEND', () => {
  it('accoda un job PROTOCOLLAZIONE per attempt con jobId=attemptId', async () => {
    // Setup: campagna SEND con channelConfig.protocolla=true, 1 destinatario PENDING,
    // nessun allegato mancante (findMissingAttachments mockato vuoto).
    // ... (usare lo stesso setup delle altre describe di launch() già nel file)

    await service.launch('camp-1');

    expect(mockNotificationQueues.addBulk).toHaveBeenCalledWith(
      'PROTOCOLLAZIONE',
      expect.arrayContaining([
        expect.objectContaining({ opts: { jobId: expect.any(String) } }),
      ]),
    );
  });
});

describe('retryRecipient() — accoda job protocollazione solo se non eredita un protocollo', () => {
  it('accoda PROTOCOLLAZIONE se l\'ultimo attempt non era protocollato', async () => {
    // ultimo attempt: protocolledAt=null
    await service.retryRecipient('camp-1', 'rec-1');
    expect(mockNotificationQueues.addBulk).toHaveBeenCalledWith('PROTOCOLLAZIONE', expect.any(Array));
  });

  it('NON accoda nulla se l\'ultimo attempt era già protocollato', async () => {
    // ultimo attempt: protocolledAt=<data>, protocolNumber=55, protocolYear=2026
    await service.retryRecipient('camp-1', 'rec-1');
    expect(mockNotificationQueues.addBulk).not.toHaveBeenCalled();
  });
});

describe('cancel() — rimuove job protocollazione pendenti per SEND', () => {
  it('tenta job.remove() sulla coda PROTOCOLLAZIONE per gli attempt annullati', async () => {
    const mockJob = { remove: jest.fn().mockResolvedValue(undefined) };
    mockNotificationQueues.getJob.mockResolvedValueOnce(mockJob);

    await service.cancel('camp-1');

    expect(mockNotificationQueues.getJob).toHaveBeenCalledWith('PROTOCOLLAZIONE', expect.any(String));
    expect(mockJob.remove).toHaveBeenCalled();
  });

  it('non fallisce se il job non esiste più (già consumato)', async () => {
    mockNotificationQueues.getJob.mockResolvedValueOnce(null);
    await expect(service.cancel('camp-1')).resolves.toBeDefined();
  });
});
```

Adattare i tre blocchi al setup reale già presente nel file (campagna, recipient, attempt mock — riusare gli helper/factory già esistenti nelle describe limitrofe di `launch()`/`retryRecipient()`/`cancel()`, non duplicarli).

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "protocollazione" --maxWorkers=2`
Expected: FAIL — `addBulk`/`getJob` con `'PROTOCOLLAZIONE'` mai chiamati

- [ ] **Step 3: `launch()` — accoda job protocollazione per SEND**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituire il blocco (righe ~344-365):

```ts
    // SEND non passa da BullMQ: i demoni ProtocollazioneSyncService/SendDispatchService
    // pollano gli attempt QUEUED e li portano avanti a stadi (protocollato → inviato).
    if (campaign.channelType !== 'SEND') {
      // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo grandi)
      const JOB_CHUNK = 1000;
      for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
        const chunk = recipients.slice(i, i + JOB_CHUNK);
        await this.notificationQueues.addBulk(
          campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>,
          chunk.map((r, idx) => ({
            name: NOTIFICATION_JOB_SEND,
            data: {
              campaignId,
              recipientId: r.id,
              attemptId: attemptIds[i + idx],
              channel: campaign.channelType,
            },
            opts: { jobId: attemptIds[i + idx] },
          })),
        );
      }
    }
```

con:

```ts
    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo
    // grandi). SEND non ha una propria coda di invio (SendDispatchService resta
    // poll-based, vedi pipeline-demoni-send-design) ma la protocollazione
    // (sempre richiesta per SEND, enforced sopra) sì: motore dedicato con
    // coda/UI/log come gli altri canali.
    const JOB_CHUNK = 1000;
    const engineName = campaign.channelType === 'SEND' ? 'PROTOCOLLAZIONE' : campaign.channelType;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
      await this.notificationQueues.addBulk(
        engineName,
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: campaign.channelType,
          },
          opts: { jobId: attemptIds[i + idx] },
        })),
      );
    }
```

- [ ] **Step 4: `retryRecipient()` — accoda job protocollazione solo se serve**

Sostituire il blocco (righe ~889-893):

```ts
    if (campaign.channelType !== 'SEND') {
      await this.notificationQueues.addBulk(campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    }
```

con:

```ts
    if (campaign.channelType !== 'SEND') {
      await this.notificationQueues.addBulk(campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    } else if (!inheritedProtocol.protocolledAt) {
      // Non eredita un protocollo già fatto: va (ri)protocollato dal motore
      // dedicato. Se invece eredita (branch inheritedProtocol sopra), l'attempt
      // è già pronto per SendDispatchService, nessuna coda da toccare.
      await this.notificationQueues.addBulk('PROTOCOLLAZIONE', [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    }
```

- [ ] **Step 5: `cancel()` — rimuove job protocollazione pendenti per SEND**

Nel branch SEND di `cancel()`, subito dopo la riga:
```ts
          removedRecipientIds = removedAttemptIds.map((id) => recipientByAttemptId.get(id)!);
```
aggiungere:
```ts
          for (const removedId of removedAttemptIds) {
            try {
              const job = await this.notificationQueues.getJob('PROTOCOLLAZIONE', removedId);
              if (job) await job.remove();
            } catch (err) {
              this.logger.warn(`Job protocollazione ${removedId} non rimosso: ${err instanceof Error ? err.message : err}`);
            }
          }
```

(Attenzione: questo va DENTRO il blocco `if (candidateAttemptIds.length > 0) { ... }` esistente, dopo l'assegnazione di `removedRecipientIds`, prima della chiusura di quel blocco `if`. Verificare l'indentazione esatta leggendo il file corrente prima di inserire.)

- [ ] **Step 6: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi (file grande — nessuna regressione sugli altri canali)

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): launch()/retryRecipient()/cancel() SEND accodano/rimuovono job protocollazione dedicato"
```

---

### Task 4: Endpoint conteggi a stadi per singola campagna

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (nuovo metodo)
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (nuovo endpoint)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `GET admin/campaigns/:id/send-stage-counts` → `{ queued: number; protocollato: number; inviato: number; fallito: number }` (scoped alla campagna, non globale). Consumato da Task 7 (frontend).

- [ ] **Step 1: Scrivere il test che deve fallire**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, aggiungere (allineando i nomi dei mock repo a quelli reali del file):

```ts
describe('CampaignsService.getSendStageCounts', () => {
  it('conta gli attempt SEND per stadio, filtrati per campagna', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-1', channelType: 'SEND' });
    const mockQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn()
        .mockResolvedValueOnce(3)  // queued (non protocollato)
        .mockResolvedValueOnce(2)  // protocollato non inviato
        .mockResolvedValueOnce(10) // inviato
        .mockResolvedValueOnce(1), // fallito
    };
    mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);

    const result = await service.getSendStageCounts('camp-1');

    expect(result).toEqual({ queued: 3, protocollato: 2, inviato: 10, fallito: 1 });
  });

  it('lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.getSendStageCounts('camp-inesistente')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getSendStageCounts" --maxWorkers=2`
Expected: FAIL — `service.getSendStageCounts is not a function`

- [ ] **Step 3: Implementare il metodo**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungere (vicino a `getChannelBreakdown`, stesso stile):

```ts
  async getSendStageCounts(campaignId: string): Promise<{ queued: number; protocollato: number; inviato: number; fallito: number }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const baseQb = () =>
      this.attemptRepo
        .createQueryBuilder('attempt')
        .innerJoin('attempt.recipient', 'recipient')
        .where('recipient.campaignId = :campaignId', { campaignId })
        .andWhere('attempt.channel_type = :ch', { ch: 'SEND' });

    const [queued, protocollato, inviato, fallito] = await Promise.all([
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED }).andWhere('attempt.protocolled_at IS NULL').getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED }).andWhere('attempt.protocolled_at IS NOT NULL').getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS }).getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.FAILED }).getCount(),
    ]);

    return { queued, protocollato, inviato, fallito };
  }
```

- [ ] **Step 4: Aggiungere l'endpoint**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungere (vicino a `:id/channel-stats`):

```ts
  @Get(':id/send-stage-counts')
  getSendStageCounts(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getSendStageCounts(id);
  }
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi

- [ ] **Step 6: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts
git commit -m "feat(backend): endpoint GET campaigns/:id/send-stage-counts per barra a stadi nel dettaglio campagna"
```

---

### Task 5: `EnginesController` — 5° motore + widget globale a 3 colonne

**Files:**
- Modify: `apps/backend/src/engines/engines.controller.ts`
- Test: `apps/backend/src/engines/engines.controller.spec.ts`

**Interfaces:**
- Produces: `GET admin/engines` include ora 5 motori (`EMAIL/PEC/APP_IO/POSTAL/PROTOCOLLAZIONE`). `GET admin/engines/send/stage-counts` ritorna solo `{ protocollato, inviato, fallito }` (senza `queued`, ora ridondante col motore Protocollazione).

- [ ] **Step 1: Aggiornare i test esistenti (li rompe questo task, sistemarli prima)**

In `apps/backend/src/engines/engines.controller.spec.ts`, sostituire:

```ts
  it('list() ritorna lo stato di tutti i canali', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(4);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
  });
```

con:

```ts
  it('list() ritorna lo stato di tutti i motori (4 canali + protocollazione)', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(5);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
  });
```

E sostituire:

```ts
  it('GET send/stage-counts ritorna i contatori per stadio SEND', async () => {
    mockAttemptRepo.count
      .mockResolvedValueOnce(3) // queued (non protocollato)
      .mockResolvedValueOnce(2) // protocollato non inviato
      .mockResolvedValueOnce(10) // inviato
      .mockResolvedValueOnce(1); // fallito

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ queued: 3, protocollato: 2, inviato: 10, fallito: 1 });
  });
```

con:

```ts
  it('GET send/stage-counts ritorna i contatori (senza queued, ora nel motore protocollazione)', async () => {
    mockAttemptRepo.count
      .mockResolvedValueOnce(2) // protocollato non inviato
      .mockResolvedValueOnce(10) // inviato
      .mockResolvedValueOnce(1); // fallito

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ protocollato: 2, inviato: 10, fallito: 1 });
  });
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2`
Expected: FAIL (il controller non è ancora stato modificato)

- [ ] **Step 3: Aggiornare `engines.controller.ts`**

Sostituire l'intero file `apps/backend/src/engines/engines.controller.ts`:

```ts
import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { ENGINE_NAMES, type EngineName } from '../queue/notification-job.types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';

function isEngineName(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
  ) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines = await Promise.all(
      ENGINE_NAMES.map(async (name) => {
        const [paused, counts] = await Promise.all([
          this.queues.isPaused(name),
          this.queues.getJobCounts(name),
        ]);
        return {
          channel: name,
          queueName: `notifications-${name.toLowerCase()}`,
          paused,
          counts,
        };
      }),
    );
    return { engines };
  }

  @Get('send/stage-counts')
  @Roles('admin', 'user')
  async sendStageCounts() {
    const [protocollato, inviato, fallito] = await Promise.all([
      this.attemptRepo.count({
        where: { channelType: 'SEND', status: AttemptStatus.QUEUED, protocolledAt: Not(IsNull()) },
      }),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.SUCCESS } }),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.FAILED } }),
    ]);
    return { protocollato, inviato, fallito };
  }

  @Post(':channel/pause')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async pause(@Param('channel') channel: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    await this.queues.pause(uc);
    return { success: true, channel: uc, paused: true };
  }

  @Post(':channel/resume')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('channel') channel: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    await this.queues.resume(uc);
    return { success: true, channel: uc, paused: false };
  }

  @Get(':channel/jobs')
  @Roles('admin', 'user')
  async jobs(
    @Param('channel') channel: string,
    @Query('status') status = 'failed',
    @Query('limit') limit = '50',
  ) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    const allowedStatuses = ['failed', 'completed', 'active', 'waiting', 'delayed'] as const;
    if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
      throw new BadRequestException(`Status ${status} non supportato`);
    }
    const parsedLimit = parseInt(limit, 10);
    const jobs = await this.queues.getJobsDetail(
      uc,
      status as (typeof allowedStatuses)[number],
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    );
    return { channel: uc, status, jobs };
  }

  @Get(':channel/jobs/:jobId/logs')
  @Roles('admin', 'user')
  async jobLogs(@Param('channel') channel: string, @Param('jobId') jobId: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    const logs = await this.queues.getJobLogs(uc, jobId);
    return { channel: uc, jobId, logs };
  }
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2`
Expected: PASS, tutti i test del file verdi

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/engines/engines.controller.ts apps/backend/src/engines/engines.controller.spec.ts
git commit -m "feat(backend): EnginesController espone il motore Protocollazione, stage-counts globale senza queued"
```

---

### Task 6: Frontend — tab Motori, riga Protocollazione + widget SEND a 3 colonne

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (righe ~6351-6364 mappe label/icona, righe ~712 tipo stato, righe ~6497-6529 widget SEND)

**Interfaces:**
- Consumes: `GET admin/engines` (ora include un elemento con `channel: 'PROTOCOLLAZIONE'`), `GET admin/engines/send/stage-counts` (ora senza `queued`).

- [ ] **Step 1: Aggiungere Protocollazione alle mappe label/icona**

In `apps/frontend-admin/src/App.tsx`, dentro `engines.map((eng) => {...})` (righe ~6351-6364), sostituire:

```tsx
                                const channelLabel: Record<string, string> = {
                                  EMAIL: 'Mail (SMTP)',
                                  PEC: 'PEC',
                                  APP_IO: 'App IO',
                                  SEND: 'SEND',
                                  POSTAL: 'Postale',
                                };
                                const channelIcon: Record<string, string> = {
                                  EMAIL: 'fa-envelope',
                                  PEC: 'fa-envelope-open-text',
                                  APP_IO: 'fa-mobile-alt',
                                  SEND: 'fa-paper-plane',
                                  POSTAL: 'fa-mail-bulk',
                                };
```

con:

```tsx
                                const channelLabel: Record<string, string> = {
                                  EMAIL: 'Mail (SMTP)',
                                  PEC: 'PEC',
                                  APP_IO: 'App IO',
                                  SEND: 'SEND',
                                  POSTAL: 'Postale',
                                  PROTOCOLLAZIONE: 'Protocollazione',
                                };
                                const channelIcon: Record<string, string> = {
                                  EMAIL: 'fa-envelope',
                                  PEC: 'fa-envelope-open-text',
                                  APP_IO: 'fa-mobile-alt',
                                  SEND: 'fa-paper-plane',
                                  POSTAL: 'fa-mail-bulk',
                                  PROTOCOLLAZIONE: 'fa-stamp',
                                };
```

- [ ] **Step 2: Aggiornare il tipo dello stato `sendStageCounts`**

Alla riga ~712, sostituire:

```ts
  const [sendStageCounts, setSendStageCounts] = useState<{ queued: number; protocollato: number; inviato: number; fallito: number } | null>(null);
```

con:

```ts
  const [sendStageCounts, setSendStageCounts] = useState<{ protocollato: number; inviato: number; fallito: number } | null>(null);
```

- [ ] **Step 3: Widget SEND — rimuovere la colonna "In coda (da protocollare)"**

Sostituire il blocco (righe ~6497-6529):

```tsx
                              {sendStageCounts && (
                                <div className="card border shadow-sm border-light">
                                  <div className="card-body p-3">
                                    <div className="d-flex align-items-center gap-3 mb-2">
                                      <div className="rounded-circle d-flex align-items-center justify-content-center text-white bg-primary" style={{ width: 40, height: 40 }}>
                                        <i className="fas fa-paper-plane"></i>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-dark">SEND</div>
                                        <div className="text-muted small">Pipeline a stadi (nessuna coda BullMQ): protocollazione e invio girano come demoni schedulati.</div>
                                      </div>
                                    </div>
                                    <div className="d-flex gap-3 text-center">
                                      <div>
                                        <div className="fw-bold text-primary">{sendStageCounts.queued}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>In coda (da protocollare)</div>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-info">{sendStageCounts.protocollato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (da inviare)</div>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-success">{sendStageCounts.inviato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                                      </div>
                                      <div>
                                        <div className={`fw-bold ${sendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{sendStageCounts.fallito}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
```

con:

```tsx
                              {sendStageCounts && (
                                <div className="card border shadow-sm border-light">
                                  <div className="card-body p-3">
                                    <div className="d-flex align-items-center gap-3 mb-2">
                                      <div className="rounded-circle d-flex align-items-center justify-content-center text-white bg-primary" style={{ width: 40, height: 40 }}>
                                        <i className="fas fa-paper-plane"></i>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-dark">SEND</div>
                                        <div className="text-muted small">Invio (nessuna coda BullMQ, demone schedulato) — la protocollazione ha il suo motore dedicato sopra.</div>
                                      </div>
                                    </div>
                                    <div className="d-flex gap-3 text-center">
                                      <div>
                                        <div className="fw-bold text-info">{sendStageCounts.protocollato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (da inviare)</div>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-success">{sendStageCounts.inviato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                                      </div>
                                      <div>
                                        <div className={`fw-bold ${sendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{sendStageCounts.fallito}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): tab Motori mostra il motore Protocollazione, widget SEND senza colonna ridondante"
```

---

### Task 7: Frontend — barra a 4 stadi nel dettaglio campagna (SEND)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuovo state vicino a riga ~739, nuova funzione fetch vicino a `fetchChannelBreakdown`, chiamata nel selettore campagna righe ~2850-2862, nuovo blocco JSX dopo riga ~6826)

**Interfaces:**
- Consumes: `GET campaigns/:id/send-stage-counts` (Task 4).

- [ ] **Step 1: Nuovo state**

In `apps/frontend-admin/src/App.tsx`, dopo la riga 739 (`const [channelBreakdown, ...] = useState<...>(null);`), aggiungere:

```ts
  const [campaignSendStageCounts, setCampaignSendStageCounts] = useState<{ queued: number; protocollato: number; inviato: number; fallito: number } | null>(null);
```

- [ ] **Step 2: Nuova funzione fetch**

Dopo la funzione `fetchChannelBreakdown` (subito prima o dopo, stesso stile), aggiungere:

```ts
  const fetchCampaignSendStageCounts = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/send-stage-counts`);
      if (!res.ok) return;
      setCampaignSendStageCounts(await res.json());
    } catch {
      // Non bloccante: il dettaglio campagna resta usabile senza la barra a stadi.
    }
  };
```

- [ ] **Step 3: Chiamarla e resettarla nel selettore campagna**

Nella funzione che seleziona una campagna (righe ~2850-2862), sostituire:

```ts
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setFailureGroups([]);
    setChannelBreakdown(null);
    setDownloadCombinations(null);
    setRecipientsPage(null);
    setRecipientsSearch('');
    setRecipientsPageNum(1);
    fetchCampaignDetail(id);
    fetchFailureGroups(id);
    fetchChannelBreakdown(id);
    fetchDownloadCombinationStats(id);
  };
```

con:

```ts
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setFailureGroups([]);
    setChannelBreakdown(null);
    setCampaignSendStageCounts(null);
    setDownloadCombinations(null);
    setRecipientsPage(null);
    setRecipientsSearch('');
    setRecipientsPageNum(1);
    fetchCampaignDetail(id);
    fetchFailureGroups(id);
    fetchChannelBreakdown(id);
    fetchCampaignSendStageCounts(id);
    fetchDownloadCombinationStats(id);
  };
```

- [ ] **Step 4: Nuovo blocco JSX — barra a 4 stadi**

Nel dettaglio campagna, subito dopo la chiusura del blocco "Stato dell'Invio" (dopo la riga `</div>` che chiude quel blocco, prima di `{channelBreakdown && (`), aggiungere:

```tsx
                        {campaign.channelType === 'SEND' && campaignSendStageCounts && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-stamp me-1 text-primary"></i>Progressione SEND
                            </h4>
                            <div className="d-flex gap-3 text-center small">
                              <div>
                                <div className="fw-bold text-secondary">{campaignSendStageCounts.queued}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>In attesa protocollo</div>
                              </div>
                              <div>
                                <div className="fw-bold text-info">{campaignSendStageCounts.protocollato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (in attesa invio)</div>
                              </div>
                              <div>
                                <div className="fw-bold text-success">{campaignSendStageCounts.inviato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                              </div>
                              <div>
                                <div className={`fw-bold ${campaignSendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{campaignSendStageCounts.fallito}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                              </div>
                            </div>
                          </div>
                        )}
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 6: Verifica manuale in browser**

Stack dev avviato, aprire una campagna SEND esistente: sotto "Stato dell'Invio" compare "Progressione SEND" con 4 contatori. Aprire una campagna EMAIL/PEC: nessun blocco nuovo (invariato).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): barra a 4 stadi (protocollo/inviato/fallito) nel dettaglio campagna SEND"
```

---

### Task 8: Verifica finale end-to-end

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure-set della baseline (1 fallimento noto, non nostro).

- [ ] **Step 2: Type-check completo**

Run:
```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore in entrambi.

- [ ] **Step 3: Riavviare il backend dev (gotcha bind-mount Windows)**

Run: `docker compose restart backend`, verificare boot pulito nei log (nessun errore DI su `ProtocollazioneProcessor`/coda mancante).

- [ ] **Step 4: Verifica manuale end-to-end**

Lanciare una campagna SEND di test (con credenziali reali se disponibili, altrimenti osservare almeno il flusso fino al fallimento atteso): verificare che compaia un job nella coda "Protocollazione" (tab Motori), che al successo scriva `protocolNumber/protocolYear/protocolledAt` (visibile nel dettaglio destinatario), che un fallimento di protocollazione (es. Protocollo non raggiungibile) compaia sia come job failed con log in Motori sia come destinatario FAILED nel dettaglio campagna, retryabile con "Rimetti in coda". Annullare una campagna SEND con job protocollazione ancora in coda e verificare che il job venga rimosso (non compare più in "job falliti"/non viene processato in ritardo).
