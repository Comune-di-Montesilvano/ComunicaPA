import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProtocollazioneProcessor } from './protocollazione.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
import { NotificationQueuesService } from './notification-queues.service';
import { ConfigService } from '@nestjs/config';
import { AppSettingsService } from '../settings/app-settings.service';

describe('ProtocollazioneProcessor', () => {
  let processor: ProtocollazioneProcessor;

  const mockAttemptRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const mockRecipientRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const mockCampaignRepo = { increment: jest.fn().mockResolvedValue(undefined) };
  const mockProtocollo = { protocolla: jest.fn() };
  const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
  const mockCompletion = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };
  const mockQueues = { addBulk: jest.fn().mockResolvedValue(undefined) };
  const mockConfig = { get: jest.fn(() => 'secret_secret') };
  const mockSettings = { get: jest.fn(async (key: string) => {
    if (key === 'brand.name') return 'Comune di Montesilvano';
    if (key === 'system.publicUrl') return 'https://comune.montesilvano.pe.it';
    if (key === 'retention.maxDays') return 180;
    return null;
  }) };

  function makeAttempt(overrides: Partial<NotificationAttempt> = {}): NotificationAttempt {
    return {
      id: 'att-1',
      status: AttemptStatus.QUEUED,
      recipientId: 'r1',
      recipient: {
        id: 'r1',
        fullName: 'Mario Rossi',
        codiceFiscale: 'RSSMRA85M01H501Z',
        campaign: { id: 'camp-1', name: 'TARI', channelType: 'SEND', channelConfig: { subject: 'Avviso TARI' } } as unknown as Campaign,
      } as unknown as Recipient,
      ...overrides,
    } as NotificationAttempt;
  }

  function mockJob(attemptId = 'att-1', recipientId = 'r1', campaignId = 'camp-1') {
    return { data: { attemptId, recipientId, campaignId, channel: 'SEND' }, log: jest.fn() } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.update.mockResolvedValue({ affected: 1 });
    const module = await Test.createTestingModule({
      providers: [
        ProtocollazioneProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: CampaignCompletionService, useValue: mockCompletion },
        { provide: NotificationQueuesService, useValue: mockQueues },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();
    processor = module.get(ProtocollazioneProcessor);
  });

  it('protocolla con successo e scrive le colonne, senza toccare status', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt());
    mockProtocollo.protocolla.mockResolvedValueOnce({ numeroProtocollo: 123, annoProtocollo: 2026 });

    await processor.process(mockJob());

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', {
      protocolNumber: 123,
      protocolYear: 2026,
      protocolledAt: expect.any(Date),
    });
    expect(mockCompletion.checkAndComplete).not.toHaveBeenCalled();
  });

  it('protocolla con successo per canale PEC e accoda il job sul canale PEC', async () => {
    const pecAttempt = makeAttempt();
    pecAttempt.recipient.campaign.channelType = 'PEC';
    mockAttemptRepo.findOne.mockResolvedValueOnce(pecAttempt);
    mockProtocollo.protocolla.mockResolvedValueOnce({ numeroProtocollo: 123, annoProtocollo: 2026 });

    await processor.process(mockJob());

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', {
      protocolNumber: 123,
      protocolYear: 2026,
      protocolledAt: expect.any(Date),
    });
    expect(mockQueues.addBulk).toHaveBeenCalledWith('PEC', [
      {
        name: 'send',
        data: {
          campaignId: 'camp-1',
          recipientId: 'r1',
          attemptId: 'att-1',
          channel: 'PEC',
        },
        opts: { jobId: 'att-1' },
      },
    ]);
  });

  it('su fallimento marca attempt/recipient FAILED, chiama checkAndComplete, poi rilancia', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt());
    mockProtocollo.protocolla.mockRejectedValueOnce(new Error('Protocollo non raggiungibile'));

    await expect(processor.process(mockJob())).rejects.toThrow('Protocollo non raggiungibile');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      { id: 'att-1', status: AttemptStatus.QUEUED },
      { status: AttemptStatus.FAILED, errorMessage: 'Protocollo non raggiungibile' },
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', { status: RecipientStatus.FAILED });
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    expect(mockCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
  });

  it('salta silenziosamente se l\'attempt non è più QUEUED (cancel() concorrente)', async () => {
    mockAttemptRepo.findOne.mockResolvedValueOnce(makeAttempt({ status: AttemptStatus.CANCELLED }));

    await processor.process(mockJob());

    expect(mockProtocollo.protocolla).not.toHaveBeenCalled();
    expect(mockAttemptRepo.update).not.toHaveBeenCalled();
  });
});
