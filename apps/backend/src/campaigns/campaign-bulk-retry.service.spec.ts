import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service';
import { Campaign } from '../entities/campaign.entity';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus } from '../entities/campaign-bulk-retry-job.entity';
import { CAMPAIGN_BULK_RETRY_QUEUE } from './campaign-bulk-retry-job.types';

describe('CampaignBulkRetryService', () => {
  let service: CampaignBulkRetryService;
  const campaignRepoMock = { findOneBy: jest.fn() };
  const jobRepoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'job-1', ...x })),
    findOneBy: jest.fn(),
  };
  const queueMock = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignBulkRetryService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(CampaignBulkRetryJob), useValue: jobRepoMock },
        { provide: getQueueToken(CAMPAIGN_BULK_RETRY_QUEUE), useValue: queueMock },
      ],
    }).compile();
    service = moduleRef.get(CampaignBulkRetryService);
  });

  describe('createJob', () => {
    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.createJob('c1', ['r1'], 'op')).rejects.toThrow(NotFoundException);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('rifiuta più di 20000 recipientIds senza creare il job', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1' });
      const tooMany = Array.from({ length: 20001 }, (_, i) => `r${i}`);
      await expect(service.createJob('c1', tooMany, 'op')).rejects.toThrow(BadRequestException);
      expect(jobRepoMock.save).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('crea il job QUEUED e lo accoda con jobId=id del job creato', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1' });
      const result = await service.createJob('c1', ['r1', 'r2'], 'op');
      expect(result).toEqual({ jobId: 'job-1' });
      expect(jobRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
        campaignId: 'c1',
        status: CampaignBulkRetryJobStatus.QUEUED,
        recipientIds: ['r1', 'r2'],
        totalCount: 2,
        createdBy: 'op',
      }));
      expect(queueMock.add).toHaveBeenCalledWith('retry', { jobId: 'job-1' }, { jobId: 'job-1' });
    });
  });

  describe('getStatus', () => {
    it('lancia NotFoundException se il job non esiste', async () => {
      jobRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(NotFoundException);
    });

    it('ritorna i campi di stato del job', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({
        status: CampaignBulkRetryJobStatus.PROCESSING,
        totalCount: 10,
        processedCount: 5,
        requeuedCount: 4,
        failed: [{ recipientId: 'r1', reason: 'boom' }],
        errorMessage: null,
      });
      const result = await service.getStatus('job-1');
      expect(result).toEqual({
        status: CampaignBulkRetryJobStatus.PROCESSING,
        totalCount: 10,
        processedCount: 5,
        requeuedCount: 4,
        failed: [{ recipientId: 'r1', reason: 'boom' }],
        errorMessage: null,
      });
    });
  });
});
