import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES } from '../channels/channel.interface';
import { NOTIFICATION_QUEUE } from './notification-job.types';
import type { NotificationJobData } from '@comunicapa/shared-types';

const mockAttemptRepo = {
  update: jest.fn(),
};

const mockCampaignRepo = {
  findOne: jest.fn(),
  increment: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockRecipientRepo = {
  findOne: jest.fn(),
  update: jest.fn(),
};

const mockStrategy = {
  send: jest.fn(),
};

const mockStrategies = new Map([['EMAIL', mockStrategy]]);

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;

  const mockJob = (data: NotificationJobData) =>
    ({ id: '1', data } as unknown as Job<NotificationJobData>);

  const baseData: NotificationJobData = {
    campaignId: 'camp-1',
    recipientId: 'rec-1',
    attemptId: 'att-1',
    channel: 'EMAIL',
  };

  const mockCampaign = {
    id: 'camp-1',
    status: CampaignStatus.QUEUED,
    name: 'TARI',
    channelType: 'EMAIL',
    channelConfig: {},
    sentCount: 0,
    failedCount: 0,
    totalRecipients: 1,
  };

  const mockRecipient = {
    id: 'rec-1',
    email: 'mario@example.com',
    pec: null,
    fullName: 'Mario',
    codiceFiscale: 'RSSMRA85M01H501Z',
  };

  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);
    mockRecipientRepo.findOne.mockResolvedValue(mockRecipient);
    mockRecipientRepo.update.mockResolvedValue(undefined);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockStrategy.send.mockResolvedValue({ messageId: 'msg-001', responsePayload: {} });

    const module = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: CHANNEL_STRATEGIES, useValue: mockStrategies },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: {} },
      ],
    }).compile();

    processor = module.get(NotificationProcessor);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  it('process() aggiorna attempt PROCESSING → SUCCESS e chiama strategy', async () => {
    await processor.process(mockJob(baseData));

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', { status: AttemptStatus.PROCESSING });
    expect(mockStrategy.send).toHaveBeenCalledWith(mockRecipient, mockCampaign);
    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.SUCCESS,
      responsePayload: expect.any(Object),
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', { status: RecipientStatus.SENT });
  });

  it('process() aggiorna attempt PROCESSING → FAILED e rilancia se strategy lancia', async () => {
    mockStrategy.send.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP timeout');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.FAILED,
      errorMessage: 'SMTP timeout',
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', { status: RecipientStatus.FAILED });
  });

  it('process() lancia Error se nessuna strategy per channel', async () => {
    const data: NotificationJobData = { ...baseData, channel: 'POSTAL' };

    await expect(processor.process(mockJob(data))).rejects.toThrow('Nessuna strategy per channel POSTAL');
  });

  describe('checkAndCompleteCampaign', () => {
    it('should set campaign COMPLETED when all recipients processed', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        id: 'camp-1',
        status: CampaignStatus.RUNNING,
        sentCount: 2,
        failedCount: 0,
        totalRecipients: 2,
      });
      mockQb.execute.mockResolvedValueOnce({ affected: 1 });

      await (processor as any).checkAndCompleteCampaign('camp-1');

      expect(mockCampaignRepo.createQueryBuilder).toHaveBeenCalled();
      expect(mockQb.andWhere).toHaveBeenCalledWith('sent_count + failed_count >= total_recipients');
      expect(mockQb.execute).toHaveBeenCalled();
    });

    it('should not complete campaign when recipients still pending', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        id: 'camp-1',
        status: CampaignStatus.RUNNING,
        sentCount: 1,
        failedCount: 0,
        totalRecipients: 2,
      });

      await (processor as any).checkAndCompleteCampaign('camp-1');

      expect(mockCampaignRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
