import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { NotificationQueuesService } from './notification-queues.service';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE } from './notification-job.types';

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
        recipientId: 'r1',
        attemptId: 'a1',
        failedReason: 'SMTP timeout',
        attemptsMade: 3,
        timestamp: 1700000000000,
        finishedOn: 1700000005000,
      },
    ]);
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
});
