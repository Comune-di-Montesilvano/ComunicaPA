import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { NotificationQueuesService } from './notification-queues.service';
import { CHANNEL_QUEUES } from './notification-job.types';

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
        { provide: getQueueToken(CHANNEL_QUEUES.SEND), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
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
