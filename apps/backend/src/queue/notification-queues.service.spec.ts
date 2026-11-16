import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { NotificationQueuesService, countFailedSince } from './notification-queues.service.js';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE } from './notification-job.types.js';

describe('NotificationQueuesService.getJobsDetail', () => {
  const mockJob = {
    id: 'job-1',
    data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'a1', channel: 'EMAIL' },
    failedReason: 'SMTP timeout',
    attemptsMade: 3,
    timestamp: 1700000000000,
    finishedOn: 1700000005000,
  };

  it('ritorna i job nello stato richiesto con dati normalizzati', async () => {
    const getJobs = jest.fn().mockResolvedValue([mockJob]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJobs } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJobsDetail('EMAIL', 'failed', 50);

    expect(getJobs).toHaveBeenCalledWith(['failed'], 0, 49);
    expect(result).toEqual([
      {
        jobId: 'job-1',
        campaignId: 'c1',
        campaignName: null,
        recipientId: 'r1',
        attemptId: 'a1',
        failedReason: 'SMTP timeout',
        attemptsMade: 3,
        timestamp: 1700000000000,
        finishedOn: 1700000005000,
      },
    ]);
  });

  it('ordina per più recente prima (finishedOn se presente, altrimenti timestamp) — BullMQ non garantisce ordine su completed/failed', async () => {
    const older = { ...mockJob, id: 'job-old', finishedOn: 1700000001000 };
    const newer = { ...mockJob, id: 'job-new', finishedOn: 1700000009000 };
    const noFinish = { ...mockJob, id: 'job-active', finishedOn: undefined, timestamp: 1700000005000 };
    const getJobs = jest.fn().mockResolvedValue([older, newer, noFinish]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJobs } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(NotificationQueuesService);

    const result = await service.getJobsDetail('EMAIL', 'failed', 50);

    expect(result.map((j) => j.jobId)).toEqual(['job-new', 'job-active', 'job-old']);
  });
});

describe('NotificationQueuesService.getLastFailedAt', () => {
  async function buildService(getFailed: ReturnType<typeof jest.fn>) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getFailed } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: {} },
      ],
    }).compile();
    return moduleRef.get(NotificationQueuesService);
  }

  it("ritorna l'ISO timestamp del job fallito più recente", async () => {
    const getFailed = jest.fn().mockResolvedValue([{ finishedOn: 1700000000000 }]);
    const service = await buildService(getFailed);

    const result = await service.getLastFailedAt('EMAIL');

    expect(getFailed).toHaveBeenCalledWith(0, 0);
    expect(result).toBe(new Date(1700000000000).toISOString());
  });

  it('ritorna null se non ci sono job falliti', async () => {
    const getFailed = jest.fn().mockResolvedValue([]);
    const service = await buildService(getFailed);

    const result = await service.getLastFailedAt('EMAIL');

    expect(result).toBeNull();
  });
});

describe('NotificationQueuesService.getJob', () => {
  it('recupera un job per id dalla coda del canale corretto', async () => {
    const mockJob = { id: 'attempt-123', remove: jest.fn() };
    const getJob = jest.fn().mockResolvedValue(mockJob);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJob } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJob('EMAIL', 'attempt-123');

    expect(getJob).toHaveBeenCalledWith('attempt-123');
    expect(result).toBe(mockJob);
  });

  it('ritorna undefined se il job non esiste piu (gia rimosso/completato)', async () => {
    const getJob = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJob } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJob('EMAIL', 'gone-123');

    expect(result).toBeUndefined();
  });

  describe('countFailedSince', () => {
    /** ZSET `failed` finto: [id, score] dal più recente, servito a pagine da zrevrange. */
    function fakeQueue(scores: number[]) {
      const flat = scores.flatMap((s, i) => [`job-${i}`, String(s)]);
      const zrevrange = jest.fn(async (_key: string, start: number, end: number) => flat.slice(start * 2, (end + 1) * 2));
      const queue: any = { toKey: (t: string) => `bull:q:${t}`, getBackend: () => ({ client: Promise.resolve({ zrevrange }) }) };
      return { queue, zrevrange };
    }

    it('conta solo i falliti dopo la soglia e si ferma al primo più vecchio', async () => {
      const { queue, zrevrange } = fakeQueue([900, 800, 700, 100, 50]);
      expect(await countFailedSince(queue, 500)).toBe(3);
      expect(zrevrange).toHaveBeenCalledTimes(1);
      expect(zrevrange).toHaveBeenCalledWith('bull:q:failed', 0, 499, { WITHSCORES: true });
    });

    it('scorre più pagine se i falliti recenti sono più di una pagina', async () => {
      const { queue, zrevrange } = fakeQueue([...Array(1200).fill(1000), 10]);
      expect(await countFailedSince(queue, 500)).toBe(1200);
      expect(zrevrange).toHaveBeenCalledTimes(3);
    });

    it('nessun fallito → 0', async () => {
      const { queue } = fakeQueue([]);
      expect(await countFailedSince(queue, 0)).toBe(0);
    });
  });

  it('removeFailedJob toglie il job solo dove è failed, mai se in corso/in attesa', async () => {
    const failedJob = { getState: jest.fn().mockResolvedValue('failed'), remove: jest.fn() };
    const activeJob = { getState: jest.fn().mockResolvedValue('active'), remove: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJob: jest.fn().mockResolvedValue(failedJob) } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: { getJob: jest.fn().mockResolvedValue(activeJob) } },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: { getJob: jest.fn().mockResolvedValue(undefined) } },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: { getJob: jest.fn().mockResolvedValue(undefined) } },
        { provide: getQueueToken(PROTOCOLLAZIONE_QUEUE), useValue: { getJob: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    const removed = await moduleRef.get(NotificationQueuesService).removeFailedJob('attempt-1');

    expect(removed).toBe(1);
    expect(failedJob.remove).toHaveBeenCalledTimes(1);
    expect(activeJob.remove).not.toHaveBeenCalled();
  });
});
