import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service';
import { Campaign } from '../entities/campaign.entity';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus } from '../entities/campaign-bulk-retry-job.entity';
import { CampaignsService } from './campaigns.service';
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
  const campaignsServiceMock = { getFailedRecipientIdsByReason: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignBulkRetryService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(CampaignBulkRetryJob), useValue: jobRepoMock },
        { provide: getQueueToken(CAMPAIGN_BULK_RETRY_QUEUE), useValue: queueMock },
        { provide: CampaignsService, useValue: campaignsServiceMock },
      ],
    }).compile();
    service = moduleRef.get(CampaignBulkRetryService);
  });

  describe('createJob', () => {
    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.createJob('c1', 'timeout', 'op')).rejects.toThrow(NotFoundException);
      expect(campaignsServiceMock.getFailedRecipientIdsByReason).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('risolve i recipientId lato server dall\'errorMessage, mai dal client', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1' });
      campaignsServiceMock.getFailedRecipientIdsByReason.mockResolvedValue(['r1', 'r2']);
      const result = await service.createJob('c1', 'timeout', 'op');
      expect(campaignsServiceMock.getFailedRecipientIdsByReason).toHaveBeenCalledWith('c1', 'timeout');
      expect(result).toEqual({ jobId: 'job-1', totalCount: 2 });
      expect(jobRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
        campaignId: 'c1',
        status: CampaignBulkRetryJobStatus.QUEUED,
        recipientIds: ['r1', 'r2'],
        totalCount: 2,
        createdBy: 'op',
      }));
      expect(queueMock.add).toHaveBeenCalledWith('retry', { jobId: 'job-1' }, { jobId: 'job-1' });
    });

    it('rifiuta se nessun destinatario FAILED corrisponde all\'errorMessage', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1' });
      campaignsServiceMock.getFailedRecipientIdsByReason.mockResolvedValue([]);
      await expect(service.createJob('c1', 'inesistente', 'op')).rejects.toThrow(BadRequestException);
      expect(jobRepoMock.save).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('rifiuta più di 100000 recipientId risolti senza creare il job', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1' });
      const tooMany = Array.from({ length: 100001 }, (_, i) => `r${i}`);
      campaignsServiceMock.getFailedRecipientIdsByReason.mockResolvedValue(tooMany);
      await expect(service.createJob('c1', 'timeout', 'op')).rejects.toThrow(BadRequestException);
      expect(jobRepoMock.save).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
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
