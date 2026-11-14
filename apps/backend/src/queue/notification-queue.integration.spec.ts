import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { NotificationQueuesService } from './notification-queues.service.js';
import { OrphanReconciliationService } from './orphan-reconciliation.service.js';
import {
  CHANNEL_QUEUES,
  NOTIFICATION_JOB_SEND,
  PROTOCOLLAZIONE_JOB_OPTIONS,
  PROTOCOLLAZIONE_QUEUE,
} from './notification-job.types.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { RecipientStatus } from '../entities/recipient.entity.js';
import { CampaignStatus } from '../entities/campaign.entity.js';

/**
 * BullMQ su Redis reale (dev: Redis del compose; CI: job integration-tests).
 * Ogni run del file usa un prefisso random `test-<uuid>`: nessuna collisione
 * con le code vere del backend dev (prefisso default `bull`) né con un altro
 * run parallelo (maxForks: 2, doppio passaggio TZ in CI). In afterAll
 * obliterate + close di ogni coda: nessuna chiave `test-*` residua.
 * Repository Postgres mockati: qui si verifica il comportamento della coda.
 */
describe.skipIf(!process.env.REDIS_URL)('BullMQ su Redis reale', () => {
  const prefix = `test-${randomUUID()}`;
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  // Stessa derivazione host/port di QueueModule (BullModule.forRootAsync).
  const connection = { host: redisUrl.hostname, port: Number(redisUrl.port) || 6379 };

  const queues: Queue<NotificationJobData>[] = [];
  const workers: Worker[] = [];
  let notificationQueues: NotificationQueuesService;

  function makeQueue(name: string, defaultJobOptions?: Record<string, unknown>): Queue<NotificationJobData> {
    const q = new Queue<NotificationJobData>(name, { connection, prefix, defaultJobOptions });
    queues.push(q);
    return q;
  }

  function makeWorker(name: string, processor: (job: Job) => Promise<unknown>): Worker {
    const w = new Worker(name, processor, { connection, prefix });
    workers.push(w);
    return w;
  }

  /**
   * Attende lo stato del job via polling dello stato Redis (nessun sleep fisso).
   * Lo stato si legge PRIMA del job: rileggere l'hash dopo aver visto lo stato
   * terminale evita di restituire una copia presa a metà retry (attemptsMade
   * ancora al tentativo precedente — visto con run paralleli sotto carico).
   */
  async function waitForState(queue: Queue, jobId: string, expected: string, timeoutMs = 10_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await queue.getJobState(jobId)) === expected) {
        const job = await queue.getJob(jobId);
        if (job) return job;
      }
      if (Date.now() > deadline) throw new Error(`Job ${jobId} non arrivato a '${expected}' entro ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function jobData(attemptId: string, channel: NotificationJobData['channel'] = 'PEC'): NotificationJobData {
    return { campaignId: 'camp-1', recipientId: 'rec-1', attemptId, channel };
  }

  beforeAll(() => {
    notificationQueues = new NotificationQueuesService(
      makeQueue(CHANNEL_QUEUES.EMAIL),
      makeQueue(CHANNEL_QUEUES.PEC),
      makeQueue(CHANNEL_QUEUES.APP_IO),
      makeQueue(CHANNEL_QUEUES.POSTAL),
      // Come BullModule.registerQueue in QueueModule: retry protocollazione come defaultJobOptions.
      makeQueue(PROTOCOLLAZIONE_QUEUE, { ...PROTOCOLLAZIONE_JOB_OPTIONS }),
    );
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    for (const q of queues) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  it('stesso jobId → un solo job', async () => {
    const attemptId = randomUUID();
    const job = { name: NOTIFICATION_JOB_SEND, data: jobData(attemptId), opts: { jobId: attemptId } };

    await notificationQueues.addBulk('PEC', [job]);
    await notificationQueues.addBulk('PEC', [job]);

    const counts = await notificationQueues.getQueue('PEC').getJobCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);
    expect((await notificationQueues.getJob('PEC', attemptId))?.id).toBe(attemptId);

    await notificationQueues.getQueue('PEC').remove(attemptId);
  });

  it('protocollazione: retry fino a fallimento', async () => {
    // Coda dedicata (nome distinto) con le opzioni reali accorciate: il backoff
    // esponenziale 40s di produzione renderebbe il test lungo minuti.
    const name = `${PROTOCOLLAZIONE_QUEUE}-retry`;
    const queue = makeQueue(name, { ...PROTOCOLLAZIONE_JOB_OPTIONS, attempts: 2, backoff: { type: 'fixed', delay: 50 } });
    const attemptId = randomUUID();
    let calls = 0;
    makeWorker(name, async () => {
      calls++;
      throw new Error('TINN non raggiungibile');
    });

    await queue.add(NOTIFICATION_JOB_SEND, jobData(attemptId, 'SEND'), { jobId: attemptId });

    const failed = await waitForState(queue, attemptId, 'failed');
    expect(failed.attemptsMade).toBe(2);
    expect(failed.failedReason).toBe('TINN non raggiungibile');
    expect(calls).toBe(2);
  });

  it('protocollazione: la coda di produzione eredita attempts 5 e backoff esponenziale 40s', async () => {
    const attemptId = randomUUID();
    await notificationQueues.addBulk('PROTOCOLLAZIONE', [
      { name: NOTIFICATION_JOB_SEND, data: jobData(attemptId, 'SEND'), opts: { jobId: attemptId } },
    ]);

    const job = await notificationQueues.getJob('PROTOCOLLAZIONE', attemptId);
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 40_000 });

    await notificationQueues.getQueue('PROTOCOLLAZIONE').remove(attemptId);
  });

  describe('OrphanReconciliationService.reconcileEngine con code reali', () => {
    const MINUTE = 60_000;

    interface Row {
      attemptId: string;
      recipientId: string;
      channelType: string;
      campaignId: string;
      campaignChannelType: string;
      protocolla: boolean | null;
      attemptStatus: 'queued' | 'processing';
      createdAt: Date;
    }

    /**
     * QueryBuilder finto che applica davvero la soglia `a.created_at < :threshold`
     * passata dal servizio: restituisce solo le righe più vecchie di 30 minuti.
     */
    function buildService(rows: Row[]) {
      const qb: any = {
        threshold: undefined as Date | undefined,
        innerJoin: () => qb,
        where: () => qb,
        andWhere: (_sql: string, params: { threshold: Date }) => {
          qb.threshold = params.threshold;
          return qb;
        },
        select: () => qb,
        getRawMany: async () =>
          rows.filter((r) => r.createdAt < qb.threshold).map(({ createdAt: _c, ...raw }) => raw),
      };
      const attemptUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const attemptRepo: any = { createQueryBuilder: () => qb, update: attemptUpdate };
      const recipientRepo: any = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      const campaignRepo: any = { increment: jest.fn().mockResolvedValue(undefined) };
      const campaignCompletion: any = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };
      const service = new OrphanReconciliationService(
        attemptRepo,
        recipientRepo,
        campaignRepo,
        notificationQueues,
        campaignCompletion,
      );
      return { service, attemptUpdate };
    }

    function row(attemptStatus: Row['attemptStatus'], ageMinutes = 31): Row {
      return {
        attemptId: randomUUID(),
        recipientId: randomUUID(),
        channelType: 'PEC',
        campaignId: randomUUID(),
        campaignChannelType: 'PEC',
        protocolla: null,
        attemptStatus,
        createdAt: new Date(Date.now() - ageMinutes * MINUTE),
      };
    }

    it('queued senza job → riaccodato (repaired: 1); secondo giro → repaired: 0', async () => {
      const orphan = row('queued');
      const fresh = row('queued', 5); // sotto soglia: non è un candidato
      const { service } = buildService([orphan, fresh]);

      const first = await service.reconcileEngine('PEC');
      expect(first).toEqual({ checked: 1, repaired: 1, markedFailed: 0 });
      const job = await notificationQueues.getJob('PEC', orphan.attemptId);
      expect(job?.id).toBe(orphan.attemptId);
      expect(job?.data).toEqual({
        campaignId: orphan.campaignId,
        recipientId: orphan.recipientId,
        attemptId: orphan.attemptId,
        channel: 'PEC',
      });
      expect(await notificationQueues.getJob('PEC', fresh.attemptId)).toBeUndefined();

      // Il DB (mock) lo vede ancora 'queued', ma il job ora esiste ed è in attesa.
      const second = await service.reconcileEngine('PEC');
      expect(second).toEqual({ checked: 1, repaired: 0, markedFailed: 0 });

      await notificationQueues.getQueue('PEC').remove(orphan.attemptId);
    });

    it('processing senza job → markedFailed: 1, nessun job accodato', async () => {
      const orphan = row('processing');
      const { service, attemptUpdate } = buildService([orphan]);

      const result = await service.reconcileEngine('PEC');

      expect(result).toEqual({ checked: 1, repaired: 0, markedFailed: 1 });
      expect(await notificationQueues.getJob('PEC', orphan.attemptId)).toBeUndefined();
      expect(attemptUpdate).toHaveBeenCalledWith(
        { id: orphan.attemptId, status: 'processing' },
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('job completed → markedFailed: 1, non riaccodato', async () => {
      // Coda/worker su un motore dedicato (APP_IO) per non processare i job degli altri test.
      const orphan = { ...row('queued'), channelType: 'APP_IO', campaignChannelType: 'APP_IO' };
      const appIoQueue = notificationQueues.getQueue('APP_IO');
      makeWorker(CHANNEL_QUEUES.APP_IO, async () => 'ok');
      await appIoQueue.add(NOTIFICATION_JOB_SEND, jobData(orphan.attemptId, 'APP_IO'), { jobId: orphan.attemptId });
      await waitForState(appIoQueue, orphan.attemptId, 'completed');
      const countsBefore = await appIoQueue.getJobCounts();

      const { service, attemptUpdate } = buildService([orphan]);
      const result = await service.reconcileEngine('APP_IO');

      expect(result).toEqual({ checked: 1, repaired: 0, markedFailed: 1 });
      expect(attemptUpdate).toHaveBeenCalledWith(
        { id: orphan.attemptId, status: 'queued' },
        expect.objectContaining({ status: 'failed' }),
      );
      expect(await appIoQueue.getJobCounts()).toEqual(countsBefore);
      expect(await (await appIoQueue.getJob(orphan.attemptId))?.getState()).toBe('completed');
    });
  });

  describe('CampaignsService.retryRecipient con coda reale', () => {
    /**
     * Repository mockati (stessa forma di campaigns.service.spec.ts), coda vera:
     * il nuovo attempt ha un id nuovo (INSERT … RETURNING id) e il job usa
     * jobId = nuovo attemptId, quindi non viene deduplicato dal job precedente
     * dello stesso destinatario, ancora presente in coda come 'failed'.
     */
    it('il nuovo job ha jobId diverso dal precedente e viene aggiunto (non deduplicato)', async () => {
      const campaignId = randomUUID();
      const recipientId = randomUUID();
      const oldAttemptId = randomUUID();
      const newAttemptId = randomUUID();
      const emailQueue = notificationQueues.getQueue('EMAIL');

      // Job del tentativo precedente, fallito davvero da un worker poi chiuso:
      // resta in coda come 'failed' e il nuovo job non viene processato.
      const failingWorker = makeWorker(CHANNEL_QUEUES.EMAIL, async () => {
        throw new Error('SMTP timeout');
      });
      await emailQueue.add(
        NOTIFICATION_JOB_SEND,
        { campaignId, recipientId, attemptId: oldAttemptId, channel: 'EMAIL' },
        { jobId: oldAttemptId },
      );
      await waitForState(emailQueue, oldAttemptId, 'failed');
      await failingWorker.close();

      const campaignRepo: any = {
        findOneBy: jest.fn().mockResolvedValue({ id: campaignId, channelType: 'EMAIL', status: CampaignStatus.RUNNING, channelConfig: {} }),
        decrement: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const recipientRepo: any = {
        findOne: jest.fn().mockResolvedValue({ id: recipientId, campaignId, status: RecipientStatus.FAILED }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const attemptRepo: any = {
        findOne: jest.fn().mockResolvedValue({ id: oldAttemptId, attemptNumber: 1, channelType: 'EMAIL' }),
        createQueryBuilder: () => ({
          insert: () => ({ into: () => ({ values: () => ({ returning: () => ({ execute: async () => ({ raw: [{ id: newAttemptId }] }) }) }) }) }),
        }),
      };
      const unused: any = {};
      const service = new CampaignsService(
        campaignRepo, recipientRepo, attemptRepo, unused, notificationQueues,
        unused, unused, unused, unused, unused, unused, unused, unused, unused,
      );

      const result = await service.retryRecipient(campaignId, recipientId);

      expect(result).toEqual({ requeued: true, attemptId: newAttemptId });
      expect(newAttemptId).not.toBe(oldAttemptId);
      const newJob = await emailQueue.getJob(newAttemptId);
      expect(newJob?.id).toBe(newAttemptId);
      expect(newJob?.data).toEqual({ campaignId, recipientId, attemptId: newAttemptId, channel: 'EMAIL' });
      expect(await newJob!.getState()).toBe('waiting');
      expect(await (await emailQueue.getJob(oldAttemptId))?.getState()).toBe('failed');
    });
  });
});
