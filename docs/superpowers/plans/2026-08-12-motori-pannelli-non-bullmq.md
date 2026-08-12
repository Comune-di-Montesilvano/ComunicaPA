# Motori — pannelli non-BullMQ coerenti Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rimuovere la card SEND fasulla/duplicata dalla tab Motori, disabilitare Pausa/Riprendi/Vedi-job-falliti per INAD (stesso bug, bottone morto), aggiungere un pannello "Verifica Stato POSTAL" che mostra se il demone `PostalStatusSyncService` sta girando bene o è in starvation.

**Architecture:** Backend: `EnginesController.list()` smette di fabbricare un'entry SEND finta (già coperta dalla card `sendStageCounts` esistente), aggiunge un flag `pausable` per distinguere code BullMQ reali da demoni Cron travestiti da coda. Nuovo metodo `PostalStatusSyncService.getQueueHealth()` (riusa lo stesso query-builder di selezione candidati del cron, estratto in `getCandidatesQuery()`) espone candidati in coda, età del più vecchio non ricontrollato, verificati, errori — nuovo endpoint `GET /admin/engines/postal/queue-health`. Frontend: nasconde i bottoni quando `pausable === false`, aggiunge una card di salute POSTAL subito dopo la card "Postalizzazione" esistente.

**Tech Stack:** NestJS 10, TypeORM 0.3 (QueryBuilder), Jest (`--maxWorkers=2` sempre), React 19 (frontend-admin).

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-08-12-motori-pannelli-non-bullmq-design.md`.
- Soglia di warning sull'età del candidato più vecchio: **15 minuti**, hardcoded (non configurabile da UI).
- Nessuna colonna DB nuova — `oldestCandidateAgeMinutes` si calcola da `COALESCE(postal_last_checked_at, created_at)`, già esistente.
- Test backend sempre: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`. Type-check: `docker compose exec backend node_modules/.bin/tsc --noEmit`. Type-check frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Dopo modifiche a `apps/backend/src/`, il watch NestJS spesso non vede i cambi sul bind mount Windows — verificare `docker compose restart backend` se un endpoint appena modificato risponde ancora col comportamento vecchio.

---

### Task 1: `PostalStatusSyncService.getQueueHealth()`

**Files:**
- Modify: `apps/backend/src/channels/postal/postal-status-sync.service.ts`
- Test: `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`

**Interfaces:**
- Produces: `export interface PostalQueueHealth { candidatesCount: number; oldestCandidateAgeMinutes: number | null; verifiedCount: number; errorCount: number }`, `PostalStatusSyncService.getQueueHealth(): Promise<PostalQueueHealth>`.
- Consumes: nessuna dipendenza da altri task.

- [ ] **Step 1: Estendi l'helper di test `makeQueryBuilder` con i metodi mancanti**

In `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`, sostituisci la funzione `makeQueryBuilder` (righe 23-32):

```ts
  function makeQueryBuilder(rows: any[]) {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
      getCount: jest.fn().mockResolvedValue(rows.length),
      getRawOne: jest.fn().mockResolvedValue(undefined),
    };
    return qb;
  }
```

- [ ] **Step 2: Write the failing test**

Aggiungi in fondo al file (nuovo `describe`, dopo l'ultimo test esistente):

```ts
describe('PostalStatusSyncService.getQueueHealth', () => {
  let service: PostalStatusSyncService;
  let globalCom: jest.Mocked<GlobalComClient>;
  let providers: jest.Mocked<PostalProvidersService>;
  let attemptRepo: { find: jest.Mock; findOne: jest.Mock; findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    const mockGlobalCom = { dettagliDocumento: jest.fn(), invioExtSingolo: jest.fn(), cercaPerTesto: jest.fn(), listaRiaccodamentiDocumento: jest.fn() };
    const mockProviders = { getActive: jest.fn(async () => activeProvider) };
    attemptRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((partial) => partial),
      save: jest.fn(async (entity) => entity),
      createQueryBuilder: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        PostalStatusSyncService,
        { provide: GlobalComClient, useValue: mockGlobalCom },
        { provide: PostalProvidersService, useValue: mockProviders },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
      ],
    }).compile();

    service = module.get(PostalStatusSyncService);
    globalCom = module.get(GlobalComClient) as any;
    providers = module.get(PostalProvidersService) as any;
  });

  it('calcola candidati, età del più vecchio, verificati ed errori', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T12:00:00.000Z'));

    const candidatesQb = makeQueryBuilder([{}, {}]);
    candidatesQb.getCount.mockResolvedValue(2);
    const oldestQb = makeQueryBuilder([]);
    oldestQb.getRawOne.mockResolvedValue({ oldest: '2026-08-12T11:40:00.000Z' });
    const totalSentQb = makeQueryBuilder([]);
    totalSentQb.getCount.mockResolvedValue(5);
    const errorQb = makeQueryBuilder([]);
    errorQb.getCount.mockResolvedValue(1);

    attemptRepo.createQueryBuilder
      .mockReturnValueOnce(candidatesQb)
      .mockReturnValueOnce(oldestQb)
      .mockReturnValueOnce(totalSentQb)
      .mockReturnValueOnce(errorQb);

    const health = await service.getQueueHealth();

    expect(health).toEqual({
      candidatesCount: 2,
      oldestCandidateAgeMinutes: 20,
      verifiedCount: 3,
      errorCount: 1,
    });

    jest.useRealTimers();
  });

  it('ritorna oldestCandidateAgeMinutes null e verifiedCount 0 a coda vuota', async () => {
    const candidatesQb = makeQueryBuilder([]);
    candidatesQb.getCount.mockResolvedValue(0);
    const totalSentQb = makeQueryBuilder([]);
    totalSentQb.getCount.mockResolvedValue(0);
    const errorQb = makeQueryBuilder([]);
    errorQb.getCount.mockResolvedValue(0);

    attemptRepo.createQueryBuilder
      .mockReturnValueOnce(candidatesQb)
      .mockReturnValueOnce(totalSentQb)
      .mockReturnValueOnce(errorQb);

    const health = await service.getQueueHealth();

    expect(health).toEqual({ candidatesCount: 0, oldestCandidateAgeMinutes: null, verifiedCount: 0, errorCount: 0 });
  });
});
```

Nota: `activeProvider`, `GlobalComClient`, `PostalProvidersService`, `NotificationAttempt`, `getRepositoryToken`, `Test` sono già importati/definiti in cima al file esistente — non ridichiararli.

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: FAIL — `service.getQueueHealth is not a function`

- [ ] **Step 4: Write minimal implementation**

In `apps/backend/src/channels/postal/postal-status-sync.service.ts`, sostituisci il metodo `handleCron` (righe 37-91) con la versione che usa un nuovo metodo privato `getCandidatesQuery()`, e aggiungi `getQueueHealth()` subito dopo. Aggiungi anche l'export dell'interfaccia `PostalQueueHealth` in cima al file, dopo gli import:

```ts
export interface PostalQueueHealth {
  candidatesCount: number;
  oldestCandidateAgeMinutes: number | null;
  verifiedCount: number;
  errorCount: number;
}
```

Sostituisci il corpo di `handleCron`:

```ts
  @Cron('*/1 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.getCandidatesQuery()
      .orderBy('COALESCE(attempt.postal_last_checked_at, attempt.created_at)', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;

    const provider = await this.providers.getActive();
    if (!provider) return;
    const creds = provider.creds;

    for (const attempt of attempts) {
      try {
        await this.syncOne(attempt, creds);
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }

  /**
   * Query dei candidati al poll GlobalCom — estratta da handleCron perché
   * riusata anche da getQueueHealth() (pannello "salute" della coda, tab
   * Motori). Un solo punto di verità sul filtro: chi lo cambia in futuro
   * lo cambia qui una volta sola, niente drift tra cron reale e pannello.
   */
  private getCandidatesQuery() {
    return this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      .andWhere(
        '(attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal) OR attempt.cost_cents IS NULL OR attempt.cost_cents = 0 OR attempt.postal_delivery_status IS NULL OR (attempt.postal_status = :eliminato AND attempt.postal_requeue_checked_at IS NULL))',
        { terminal: TERMINAL_STATUSES, eliminato: 'Eliminato' },
      );
  }

  /**
   * Stato di salute della coda di verifica POSTAL per la tab Motori —
   * candidatesCount/oldestCandidateAgeMinutes rispondono alla domanda "sta
   * girando bene o è bloccata?" (stessa colonna anti-starvation già usata
   * dall'ORDER BY del cron, vedi CLAUDE.md sui bug reali di starvation su
   * questo demone). oldestCandidateAgeMinutes: null a coda vuota.
   */
  async getQueueHealth(): Promise<PostalQueueHealth> {
    const candidatesCount = await this.getCandidatesQuery().getCount();

    let oldestCandidateAgeMinutes: number | null = null;
    if (candidatesCount > 0) {
      const raw = await this.getCandidatesQuery()
        .select('COALESCE(attempt.postal_last_checked_at, attempt.created_at)', 'oldest')
        .orderBy('COALESCE(attempt.postal_last_checked_at, attempt.created_at)', 'ASC')
        .limit(1)
        .getRawOne<{ oldest: string }>();
      if (raw?.oldest) {
        oldestCandidateAgeMinutes = Math.max(0, Math.floor((Date.now() - new Date(raw.oldest).getTime()) / 60000));
      }
    }

    const totalSentCount = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      .getCount();
    const verifiedCount = Math.max(0, totalSentCount - candidatesCount);

    const errorCount = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.postal_status = :errore', { errore: 'Errore' })
      .getCount();

    return { candidatesCount, oldestCandidateAgeMinutes, verifiedCount, errorCount };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: PASS — tutti i test del file (esistenti + 2 nuovi).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/postal-status-sync.service.ts apps/backend/src/channels/postal/postal-status-sync.service.spec.ts
git commit -m "feat(motori): PostalStatusSyncService.getQueueHealth per pannello salute coda POSTAL

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `EnginesController` — rimuovi SEND fasullo, INAD non pausabile, endpoint POSTAL health

**Files:**
- Modify: `apps/backend/src/engines/engines.controller.ts`
- Modify: `apps/backend/src/engines/engines.module.ts`
- Test: `apps/backend/src/engines/engines.controller.spec.ts`

**Interfaces:**
- Consumes: `PostalStatusSyncService.getQueueHealth(): Promise<PostalQueueHealth>` (Task 1).
- Produces: `GET /admin/engines` risponde con `engines: Array<{channel, queueName, paused, pausable, counts}>` (6 entry: EMAIL/PEC/APP_IO/POSTAL/PROTOCOLLAZIONE con `pausable:true`, INAD con `pausable:false` — SEND non più presente). Nuovo `GET /admin/engines/postal/queue-health` → `PostalQueueHealth`.

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/engines/engines.controller.spec.ts`, sostituisci l'intero file:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EnginesController } from './engines.controller';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { BadRequestException } from '@nestjs/common';

describe('EnginesController', () => {
  let controller: EnginesController;
  const mockQueuesService = {
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    pause: jest.fn(),
    resume: jest.fn(),
    getJobsDetail: jest.fn().mockResolvedValue([{ jobId: 'j1' }]),
  };
  const mockAttemptRepo = { count: jest.fn(), createQueryBuilder: jest.fn() };
  const mockCampaignRepo = { count: jest.fn().mockResolvedValue(0) };
  const mockRecipientRepo = { count: jest.fn().mockResolvedValue(0) };
  const mockPostalStatusSync = { getQueueHealth: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        { provide: NotificationQueuesService, useValue: mockQueuesService },
        { provide: PostalStatusSyncService, useValue: mockPostalStatusSync },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
      ],
    }).compile();

    controller = module.get<EnginesController>(EnginesController);
  });

  it('list() ritorna 6 motori (5 code BullMQ pausabili + INAD non pausabile), nessun SEND', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(6);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      pausable: true,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
    expect(res.engines.map((e: any) => e.channel)).not.toContain('SEND');
    const inad = res.engines.find((e: any) => e.channel === 'INAD');
    expect(inad).toBeDefined();
    expect(inad.pausable).toBe(false);
  });

  it('pause() mette in pausa un canale valido', async () => {
    const res = await controller.pause('email');
    expect(res).toEqual({ success: true, channel: 'EMAIL', paused: true });
    expect(mockQueuesService.pause).toHaveBeenCalledWith('EMAIL');
  });

  it('pause() lancia BadRequestException per un canale non valido', async () => {
    await expect(controller.pause('invalid')).rejects.toThrow(BadRequestException);
    expect(mockQueuesService.pause).not.toHaveBeenCalled();
  });

  it('resume() riattiva un canale valido', async () => {
    const res = await controller.resume('pec');
    expect(res).toEqual({ success: true, channel: 'PEC', paused: false });
    expect(mockQueuesService.resume).toHaveBeenCalledWith('PEC');
  });

  it('jobs() ritorna i job del canale richiesto', async () => {
    const result = await controller.jobs('email', 'failed', '10');
    expect(mockQueuesService.getJobsDetail).toHaveBeenCalledWith('EMAIL', 'failed', 10);
    expect(result).toEqual({ channel: 'EMAIL', status: 'failed', jobs: [{ jobId: 'j1' }] });
  });

  it('jobs() rifiuta un canale sconosciuto', async () => {
    await expect(controller.jobs('fax', 'failed', '10')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET send/stage-counts ritorna i contatori (senza queued, ora nel motore protocollazione)', async () => {
    mockAttemptRepo.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(1);

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ protocollato: 2, inviato: 10, fallito: 1 });
  });

  it('GET postal/queue-health delega a PostalStatusSyncService.getQueueHealth()', async () => {
    mockPostalStatusSync.getQueueHealth.mockResolvedValue({
      candidatesCount: 3, oldestCandidateAgeMinutes: 5, verifiedCount: 100, errorCount: 2,
    });

    const result = await controller.postalQueueHealth();

    expect(result).toEqual({ candidatesCount: 3, oldestCandidateAgeMinutes: 5, verifiedCount: 100, errorCount: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2`
Expected: FAIL — `res.engines` ha ancora 7 elementi (include SEND), `pausable` assente, `controller.postalQueueHealth is not a function`.

- [ ] **Step 3: Write minimal implementation**

Sostituisci l'intero file `apps/backend/src/engines/engines.controller.ts`:

```ts
import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service';
import { ENGINE_NAMES, type EngineName } from '../queue/notification-job.types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';

function isEngineName(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    private readonly postalStatusSync: PostalStatusSyncService,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines: Array<{
      channel: EngineName | 'INAD';
      queueName: string;
      paused: boolean;
      pausable: boolean;
      counts: Record<string, number>;
    }> = await Promise.all(
      ENGINE_NAMES.map(async (name) => {
        const [paused, counts] = await Promise.all([
          this.queues.isPaused(name),
          this.queues.getJobCounts(name),
        ]);
        return {
          channel: name,
          queueName: `notifications-${name.toLowerCase()}`,
          paused,
          pausable: true,
          counts,
        };
      }),
    );

    const [inadCheckingCampaigns, inadPendingRecipients, inadTotalCheckedRecipients] = await Promise.all([
      this.campaignRepo.count({ where: { status: CampaignStatus.CHECKING_INAD } }),
      this.recipientRepo.count({ where: { status: RecipientStatus.PENDING, campaign: { status: CampaignStatus.CHECKING_INAD } } }),
      this.recipientRepo.count({ where: { inadCheck: Not(IsNull()) } }),
    ]);

    engines.push({
      channel: 'INAD',
      queueName: 'inad-check-bulk',
      paused: false,
      pausable: false,
      counts: {
        active: inadPendingRecipients,
        completed: inadTotalCheckedRecipients,
        failed: 0,
        delayed: 0,
        waiting: inadCheckingCampaigns,
        paused: 0,
      },
    });

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

  @Get('postal/queue-health')
  @Roles('admin', 'user')
  async postalQueueHealth() {
    return this.postalStatusSync.getQueueHealth();
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

Aggiorna `apps/backend/src/engines/engines.module.ts` per importare `ChannelModule` (esporta già `PostalStatusSyncService`):

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { ChannelModule } from '../channels/channel.module';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule, ChannelModule, TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient])],
  controllers: [EnginesController],
})
export class EnginesModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2`
Expected: PASS (8 test)

- [ ] **Step 5: Type-check e verifica assenza cicli di modulo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore. Se compare un errore di dipendenza circolare tra moduli all'avvio reale (Step 4 di Task 4 lo verificherà), rivedere l'import — `ChannelModule` non importa `EnginesModule`, verificato in fase di design, non dovrebbe accadere.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/engines/engines.controller.ts apps/backend/src/engines/engines.module.ts apps/backend/src/engines/engines.controller.spec.ts
git commit -m "fix(motori): rimuovi SEND fasullo, INAD non pausabile, endpoint salute coda POSTAL

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — nasconde bottoni non pausabili, pannello salute POSTAL

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET /admin/engines` → entry con `pausable: boolean` (Task 2, nessun tipo esplicito da rispettare: `engines` è tipizzato `any[]` nel frontend). `GET /admin/engines/postal/queue-health` → `{candidatesCount, oldestCandidateAgeMinutes, verifiedCount, errorCount}` (Task 1/2).

- [ ] **Step 1: Aggiungi lo stato e il fetch per la salute POSTAL**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga (2264):
```tsx
  const [sendStageCounts, setSendStageCounts] = useState<{ protocollato: number; inviato: number; fallito: number } | null>(null);
```
aggiungi:
```tsx
  const [postalQueueHealth, setPostalQueueHealth] = useState<{ candidatesCount: number; oldestCandidateAgeMinutes: number | null; verifiedCount: number; errorCount: number } | null>(null);
```

Nella funzione `fetchEngines` (righe 3975-3995), dopo il blocco:
```tsx
      const stageRes = await fetch(`${ADMIN_API_BASE}/engines/send/stage-counts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (stageRes.ok) setSendStageCounts(await stageRes.json());
```
aggiungi, prima del `catch`:
```tsx
      const postalHealthRes = await fetch(`${ADMIN_API_BASE}/engines/postal/queue-health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (postalHealthRes.ok) setPostalQueueHealth(await postalHealthRes.json());
```

- [ ] **Step 2: Nascondi Pausa/Riprendi/Vedi-job-falliti quando `eng.pausable === false`, e inserisci la card di salute POSTAL subito dopo la card "Postalizzazione"**

Nel blocco `{engines.map((eng) => { ... return ( <div key={eng.channel} ...> ... </div> ); })}` (righe 14661-14809):

1. Sposta `key={eng.channel}` dal `<div className="card ...">` a un `<React.Fragment key={eng.channel}>` che avvolge sia la card esistente sia (condizionalmente) la nuova card di salute POSTAL. Il `<div className="card ...">` esistente perde `key={eng.channel}` (ora sul Fragment).

2. Sostituisci il blocco bottoni Pausa/Riprendi (righe 14721-14749):

```tsx
                                          <div>
                                            {eng.pausable === false ? (
                                              <span className={`badge ${total > 0 ? 'bg-primary' : 'bg-secondary'}`}>
                                                {total > 0 ? <><Loader2 className="icon-spin me-1" />Attivo ({total})</> : <><Check className="me-1" />Idle</>}
                                              </span>
                                            ) : eng.paused ? (
                                              <div className="d-flex flex-column align-items-center gap-1">
                                                <span className="badge bg-warning text-dark mb-1"><Pause className="me-1" />In Pausa</span>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm btn-success d-flex align-items-center gap-1"
                                                  onClick={() => handleEngineAction(eng.channel, 'resume')}
                                                  disabled={loadingEngines}
                                                >
                                                  <Play /> Riprendi
                                                </button>
                                              </div>
                                            ) : (
                                              <div className="d-flex flex-column align-items-center gap-1">
                                                <span className={`badge ${total > 0 ? 'bg-primary' : 'bg-secondary'} mb-1`}>
                                                  {total > 0 ? <><Loader2 className="icon-spin me-1" />Attivo ({total})</> : <><Check className="me-1" />Idle</>}
                                                </span>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm btn-outline-warning d-flex align-items-center gap-1"
                                                  onClick={() => handleEngineAction(eng.channel, 'pause')}
                                                  disabled={loadingEngines}
                                                >
                                                  <Pause /> Pausa
                                                </button>
                                              </div>
                                            )}
                                          </div>
```

3. Racchiudi il blocco "Vedi job falliti" (righe 14753-14805, il `<div className="mt-2">...</div>` con il bottone e la tabella job falliti) in `{eng.pausable !== false && ( ... )}`.

4. Subito dopo la chiusura del `<div className="card ...">` esistente (dove prima c'era `</div>);` a chiusura del `return`), aggiungi la card di salute POSTAL e chiudi il Fragment:

```tsx
                                    {eng.channel === 'POSTAL' && postalQueueHealth && (() => {
                                      const isStale = (postalQueueHealth.oldestCandidateAgeMinutes ?? 0) > 15;
                                      return (
                                        <div className={`card border shadow-sm ${isStale ? 'border-danger' : 'border-light'}`}>
                                          <div className="card-body p-3">
                                            <div className="d-flex align-items-center gap-3 mb-2">
                                              <div
                                                className="d-flex align-items-center justify-content-center rounded"
                                                style={{ width: 44, height: 44, flexShrink: 0, background: isStale ? '#fff' : '#6c757d', border: isStale ? '2px solid #dc3545' : undefined }}
                                              >
                                                <Clock size={22} className={isStale ? 'text-danger' : 'text-white'} />
                                              </div>
                                              <div>
                                                <div className="fw-bold text-dark">Verifica Stato POSTAL</div>
                                                <div className="text-muted small">Interrogazione periodica GlobalCom per lo stato di consegna (demone schedulato)</div>
                                              </div>
                                              {isStale && (
                                                <span className="badge bg-danger-subtle text-danger border border-danger-subtle ms-auto">
                                                  <AlertTriangle className="me-1" size={14} />In ritardo
                                                </span>
                                              )}
                                            </div>
                                            <div className="d-flex gap-3 text-center">
                                              <div>
                                                <div className="fw-bold text-primary">{postalQueueHealth.candidatesCount}</div>
                                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>In coda</div>
                                              </div>
                                              <div>
                                                <div className={`fw-bold ${isStale ? 'text-danger' : 'text-muted'}`}>
                                                  {postalQueueHealth.oldestCandidateAgeMinutes === null ? '—' : `${postalQueueHealth.oldestCandidateAgeMinutes} min`}
                                                </div>
                                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Più vecchio in attesa da</div>
                                              </div>
                                              <div>
                                                <div className="fw-bold text-success">{postalQueueHealth.verifiedCount}</div>
                                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Verificato</div>
                                              </div>
                                              <div>
                                                <div className={`fw-bold ${postalQueueHealth.errorCount > 0 ? 'text-danger' : 'text-muted'}`}>{postalQueueHealth.errorCount}</div>
                                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Errore</div>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })()}
                                  </React.Fragment>
```

(la card esistente resta invariata nel mezzo — solo l'apertura `<React.Fragment key={eng.channel}>` prima del `<div className="card ...">` e la chiusura sopra vanno aggiunte).

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale rapida**

Non c'è test automatico per questo file (component render condizionale, nessuna infrastruttura di test frontend in questo repo per la pagina Motori). Verificare a occhio dopo il rebuild (Task 4) che: SEND compaia una sola volta, INAD non abbia bottoni Pausa/Riprendi/Vedi-job-falliti, la card "Verifica Stato POSTAL" compaia subito dopo "Postalizzazione".

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(motori): nascondi bottoni non pausabili, pannello salute coda POSTAL

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Verifica finale

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`) + tutti i nuovi test di questo piano passano.

- [ ] **Step 2: Type-check backend e frontend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore in entrambi.

- [ ] **Step 3: Rebuild e verifica boot reale**

```bash
docker compose restart backend
docker compose logs backend --tail=60
```
Expected: `Starting Nest application...`, nessuna eccezione di dipendenza (`ChannelModule`↔`EnginesModule`), route `postal/queue-health` mappata nei log.

- [ ] **Step 4: Chiamata reale all'endpoint (senza frontend)**

```bash
docker compose exec backend node -e '
const jwt=require("/app/node_modules/.pnpm/node_modules/jsonwebtoken");
const token=jwt.sign({sub:"debug",username:"debug",role:"admin",type:"operator"},process.env.JWT_SECRET,{expiresIn:"5m"});
(async () => {
  const r1 = await fetch("http://localhost:8080/admin/engines", {headers:{Authorization:"Bearer "+token}});
  const j1 = await r1.json();
  console.log("engines:", j1.engines.map(e=>e.channel+"(pausable="+e.pausable+")"));
  const r2 = await fetch("http://localhost:8080/admin/engines/postal/queue-health", {headers:{Authorization:"Bearer "+token}});
  console.log("postal health:", r2.status, await r2.json());
})();
'
```
Expected: `engines` non contiene `SEND`, contiene `INAD(pausable=false)`; `postal health` risponde 200 con i 4 campi.

- [ ] **Step 5: Se tutto verde, nessun commit aggiuntivo — il piano è completo**
