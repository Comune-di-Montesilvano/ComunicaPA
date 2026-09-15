import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE } from './signature-verification-job.types.js';

describe('SignatureVerificationBulkService', () => {
  let service: SignatureVerificationBulkService;
  let jobRepo: { create: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    jobRepo = {
      create: vi.fn((v) => v),
      save: vi.fn((v) => Promise.resolve({ id: 'job-1', ...v })),
      findOne: vi.fn(),
    };
    queue = { add: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureVerificationBulkService,
        { provide: getRepositoryToken(SignatureVerificationJob), useValue: jobRepo },
        { provide: getQueueToken(SIGNATURE_VERIFICATION_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(SignatureVerificationBulkService);
  });

  describe('startForCampaign', () => {
    it('crea un nuovo job e lo accoda', async () => {
      const result = await service.startForCampaign('camp-1');

      expect(jobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'camp-1', status: SignatureVerificationJobStatus.QUEUED }));
      expect(queue.add).toHaveBeenCalledWith('verify', { jobId: 'job-1', campaignId: 'camp-1' }, { jobId: 'job-1' });
      expect(result).toEqual({ jobId: 'job-1' });
    });
  });

  describe('getLatestStatus', () => {
    it('ritorna null se nessun job esiste per la campagna', async () => {
      jobRepo.findOne.mockResolvedValueOnce(null);
      const result = await service.getLatestStatus('camp-1');
      expect(result).toBeNull();
    });

    it('ritorna lo stato dell\'ultimo job per la campagna', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        id: 'job-1', campaignId: 'camp-1', status: SignatureVerificationJobStatus.DONE,
        totalRows: 10, validCount: 9, invalidCount: 1, errorMessage: null,
      });
      const result = await service.getLatestStatus('camp-1');
      expect(result).toEqual(expect.objectContaining({ status: SignatureVerificationJobStatus.DONE, invalidCount: 1 }));
    });
  });
});
