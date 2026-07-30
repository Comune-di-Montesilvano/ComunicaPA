import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignBulkRetryProcessor } from './campaign-bulk-retry.processor';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus } from '../entities/campaign-bulk-retry-job.entity';
import { CampaignsService } from './campaigns.service';

describe('CampaignBulkRetryProcessor', () => {
  let processor: CampaignBulkRetryProcessor;
  const jobRepoMock = { findOneBy: jest.fn(), update: jest.fn() };
  const campaignsServiceMock = { retryRecipient: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignBulkRetryProcessor,
        { provide: getRepositoryToken(CampaignBulkRetryJob), useValue: jobRepoMock },
        { provide: CampaignsService, useValue: campaignsServiceMock },
      ],
    }).compile();
    processor = moduleRef.get(CampaignBulkRetryProcessor);
  });

  it('ritenta ogni destinatario, conta successi/fallimenti e marca DONE', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-1',
      campaignId: 'c1',
      recipientIds: ['r1', 'r2', 'r3'],
    });
    campaignsServiceMock.retryRecipient.mockImplementation(async (_campaignId: string, recipientId: string) => {
      if (recipientId === 'r2') throw new Error('Solo i destinatari in stato FAILED possono essere rimessi in coda');
      return { requeued: true, attemptId: `a-${recipientId}` };
    });

    await processor.process({ data: { jobId: 'job-1' } } as any);

    expect(campaignsServiceMock.retryRecipient).toHaveBeenCalledTimes(3);
    expect(campaignsServiceMock.retryRecipient).toHaveBeenCalledWith('c1', 'r1');

    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === CampaignBulkRetryJobStatus.DONE);
    expect(doneCall).toBeDefined();
    const [, patch] = doneCall;
    expect(patch.requeuedCount).toBe(2);
    expect(patch.processedCount).toBe(3);
    expect(patch.failed).toEqual([{ recipientId: 'r2', reason: 'Solo i destinatari in stato FAILED possono essere rimessi in coda' }]);
  });

  it('gestisce migliaia di destinatari a batch senza saltarne nessuno', async () => {
    const recipientIds = Array.from({ length: 3205 }, (_, i) => `r${i}`);
    jobRepoMock.findOneBy.mockResolvedValue({ id: 'job-2', campaignId: 'c1', recipientIds });
    campaignsServiceMock.retryRecipient.mockResolvedValue({ requeued: true, attemptId: 'a1' });

    await processor.process({ data: { jobId: 'job-2' } } as any);

    expect(campaignsServiceMock.retryRecipient).toHaveBeenCalledTimes(3205);
    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === CampaignBulkRetryJobStatus.DONE);
    expect(doneCall[1].requeuedCount).toBe(3205);
    expect(doneCall[1].processedCount).toBe(3205);
  });

  it('job non trovato: nessuna eccezione, nessun update', async () => {
    jobRepoMock.findOneBy.mockResolvedValue(null);
    await processor.process({ data: { jobId: 'missing' } } as any);
    expect(jobRepoMock.update).not.toHaveBeenCalled();
  });

  it('marca FAILED se la scrittura finale del job fallisce (es. DB down a fine job)', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({ id: 'job-3', campaignId: 'c1', recipientIds: ['r1'] });
    campaignsServiceMock.retryRecipient.mockResolvedValue({ requeued: true, attemptId: 'a1' });
    jobRepoMock.update.mockImplementation(async (_id: string, patch: any) => {
      if (patch.status === CampaignBulkRetryJobStatus.DONE) throw new Error('DB down');
    });

    await processor.process({ data: { jobId: 'job-3' } } as any);

    const failedCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === CampaignBulkRetryJobStatus.FAILED);
    expect(failedCall).toBeDefined();
  });
});
