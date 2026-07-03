import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { AppSettingsService } from '../settings/app-settings.service';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES } from '../channels/channel.interface';
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

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'downloadLink.secret': 'test-secret',
    };
    return cfg[key];
  },
};

const settingsValues: Record<string, unknown> = {
  'retention.maxDays': 90,
  'system.publicUrl': 'http://api.test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;

  const mockJob = (data: NotificationJobData, attemptsMade = 0) =>
    ({ id: '1', data, attemptsMade } as unknown as Job<NotificationJobData>);

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
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
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
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({
      status: RecipientStatus.SENT,
      attachmentExpiresAt: expect.any(Date),
    }));
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

  describe('App IO indipendente dal canale primario', () => {
    const mockCampaignWithAppIo = {
      id: 'camp-1',
      status: CampaignStatus.QUEUED,
      name: 'TARI',
      channelType: 'EMAIL',
      channelConfig: { appIo: { apiKey: 'key', baseUrl: 'http://io.test' } },
      retentionDays: null,
      sentCount: 0,
      failedCount: 0,
      totalRecipients: 1,
    };

    let originalFetch: any;

    beforeEach(() => {
      originalFetch = (global as any).fetch;
      mockCampaignRepo.findOne.mockResolvedValue(mockCampaignWithAppIo);
    });

    afterEach(() => {
      (global as any).fetch = originalFetch;
    });

    it("tenta comunque App IO quando il canale primario (EMAIL) fallisce, poi rilancia l'errore primario", async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: false, status: 500 }); // send message

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP down');

      expect((global as any).fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/messages'),
        expect.any(Object),
      );
      expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({ status: RecipientStatus.FAILED }));
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({ status: AttemptStatus.FAILED }));
    });

    it('C1: NON ri-tenta App IO ai retry (job.attemptsMade > 0), evitando push duplicate', async () => {
      // Retry del job (primo canale continua a fallire): App IO NON deve essere re-inviato.
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn();

      await expect(processor.process(mockJob(baseData, 1))).rejects.toThrow('SMTP down');

      // Nessuna chiamata App IO (né profilo né invio messaggio) al retry.
      expect((global as any).fetch).not.toHaveBeenCalled();
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({ status: RecipientStatus.FAILED }),
      );
    });

    it('I2: imposta attachmentExpiresAt quando App IO consegna il link anche se il canale primario fallisce', async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'appio-1' }) }); // send message (successo)

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP down');

      // Recipient FAILED ma con attachmentExpiresAt impostato → la retention lo cancellerà.
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({
          status: RecipientStatus.FAILED,
          attachmentExpiresAt: expect.any(Date),
        }),
      );
      expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    });

    it('percorso di successo: imposta attachmentExpiresAt e sentCount, non lancia errori', async () => {
      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-1', responsePayload: {} });
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'appio-1' }) }); // send message

      await processor.process(mockJob(baseData));

      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({ status: RecipientStatus.SENT, attachmentExpiresAt: expect.any(Date) }),
      );
      expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
    });
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
