import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import type { NotificationJobData } from '@comunicapa/shared-types';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  const mockAttemptRepo = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockCampaignRepo = {
    increment: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
      ],
    }).compile();
    processor = module.get<NotificationProcessor>(NotificationProcessor);
    jest.clearAllMocks();
    mockAttemptRepo.update.mockResolvedValue(undefined);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  it('marks attempt PROCESSING then SUCCESS and increments sentCount', async () => {
    const jobData: NotificationJobData = {
      campaignId: 'c1',
      recipientId: 'r1',
      attemptId: 'a1',
      channel: 'EMAIL',
    };
    const job = { id: '1', data: jobData } as Job<NotificationJobData>;

    await processor.process(job);

    expect(mockAttemptRepo.update).toHaveBeenNthCalledWith(1, 'a1', {
      status: AttemptStatus.PROCESSING,
    });
    expect(mockAttemptRepo.update).toHaveBeenNthCalledWith(
      2,
      'a1',
      expect.objectContaining({ status: AttemptStatus.SUCCESS }),
    );
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'c1' }, 'sentCount', 1);
  });

  it('marks attempt FAILED on error, increments failedCount, re-throws', async () => {
    const jobData: NotificationJobData = {
      campaignId: 'c1',
      recipientId: 'r1',
      attemptId: 'a1',
      channel: 'PEC',
    };
    const job = { id: '2', data: jobData } as Job<NotificationJobData>;
    const networkError = new Error('network timeout');

    // Prima call (PROCESSING) ok, seconda call (SUCCESS) lancia → va nel catch
    mockAttemptRepo.update
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(networkError);

    await expect(processor.process(job)).rejects.toThrow('network timeout');

    // Terza call nel catch: FAILED
    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ status: AttemptStatus.FAILED }),
    );
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'c1' }, 'failedCount', 1);
  });
});
