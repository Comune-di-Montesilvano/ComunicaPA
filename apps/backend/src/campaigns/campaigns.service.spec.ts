import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { NotificationQueuesService } from '../queue/notification-queues.service';

const mockCampaign: Partial<Campaign> = {
  id: 'uuid-1',
  name: 'Test',
  description: null,
  channelType: 'EMAIL',
  channelConfig: {},
  status: CampaignStatus.DRAFT,
  createdBy: 'op1',
  totalRecipients: 0,
  sentCount: 0,
  failedCount: 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  completedAt: null,
  recipients: [],
};

describe('CampaignsService', () => {
  let service: CampaignsService;

  const mockCampaignQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockCampaignRepo = {
    find: jest.fn().mockResolvedValue([mockCampaign]),
    findOne: jest.fn().mockResolvedValue(mockCampaign),
    findOneBy: jest.fn().mockResolvedValue(mockCampaign),
    existsBy: jest.fn().mockResolvedValue(false),
    create: jest.fn().mockReturnValue(mockCampaign),
    save: jest.fn().mockResolvedValue(mockCampaign),
    update: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(mockCampaignQb),
  };
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    }),
  };
  const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: NotificationQueuesService, useValue: mockQueue },
      ],
    }).compile();
    service = module.get<CampaignsService>(CampaignsService);
    jest.clearAllMocks();
    mockCampaignRepo.find.mockResolvedValue([mockCampaign]);
    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);
    mockCampaignRepo.findOneBy.mockResolvedValue(mockCampaign);
    mockCampaignRepo.existsBy.mockResolvedValue(false);
    mockCampaignRepo.create.mockReturnValue(mockCampaign);
    mockCampaignRepo.save.mockResolvedValue(mockCampaign);
    mockCampaignRepo.update.mockResolvedValue(undefined);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    mockRecipientRepo.find.mockResolvedValue([]);
  });

  it('findAll returns array', async () => {
    const result = await service.findAll();
    expect(result).toEqual([mockCampaign]);
    expect(mockCampaignRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('findOne returns campaign by id', async () => {
    const result = await service.findOne('uuid-1');
    expect(result).toEqual(mockCampaign);
  });

  it('findOne throws NotFoundException for unknown id', async () => {
    mockCampaignRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('create saves and returns campaign with createdBy', async () => {
    const dto = { name: 'Test', channelType: 'EMAIL' as const };
    const result = await service.create(dto, 'op1');
    expect(result).toEqual(mockCampaign);
    expect(mockCampaignRepo.save).toHaveBeenCalled();
  });

  it('launch throws BadRequestException when no pending recipients', async () => {
    // atomic UPDATE succeeds (affected: 1), campaign fetched, but no recipients
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(mockCampaign);
    mockRecipientRepo.find.mockResolvedValueOnce([]);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws BadRequestException when campaign not in DRAFT', async () => {
    // atomic UPDATE fails because campaign is not in DRAFT (affected: 0) and exists
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });
    mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws NotFoundException when campaign does not exist', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });
    mockCampaignRepo.existsBy.mockResolvedValueOnce(false);
    await expect(service.launch('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('launch() usa UPDATE atomico WHERE status=draft invece di findOneBy+update separati', async () => {
    // Setup: createQueryBuilder returns affected: 0 — launch must throw BadRequestException
    const mockQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    mockCampaignRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb);
    mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
    mockRecipientRepo.find = jest.fn().mockResolvedValue([]);

    await expect(service.launch('camp-1')).rejects.toThrow('Only draft campaigns can be launched');
    expect(mockQb.execute).toHaveBeenCalled();
  });

  it('uploadCsv uses increment for totalRecipients instead of update (no overwrite)', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(
      service.uploadCsv('no-campaign', '/tmp/nonexistent.csv'),
    ).rejects.toThrow(NotFoundException);
    expect(mockCampaignRepo.increment).not.toHaveBeenCalled();
  });

  it('getStats calcola aggregati corretti', async () => {
    mockRecipientRepo.find.mockResolvedValueOnce([
      { downloadCount: 2, lastDownloadedAt: new Date('2026-06-26') },
      { downloadCount: 0, lastDownloadedAt: null },
    ]);
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, totalRecipients: 2, sentCount: 2 });

    const stats = await service.getStats('uuid-1');

    expect(stats).toEqual({
      campaignId: 'uuid-1',
      totalRecipients: 2,
      totalSent: 2,
      totalDownloaded: 1,
      downloadPercentage: 50,
      lastDownloadAt: new Date('2026-06-26'),
    });
  });

  it('getStats lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.getStats('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('getRecipientStats pagina i risultati', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(mockCampaign);
    mockRecipientRepo.findAndCount = jest.fn().mockResolvedValue([
      [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'CF1', downloadCount: 1, firstDownloadedAt: new Date(), lastDownloadedAt: new Date(), attachmentDeletedAt: null }],
      1,
    ]);

    const page = await service.getRecipientStats('uuid-1', 1, 20);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(mockRecipientRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: 'uuid-1' }, skip: 0, take: 20 }),
    );
  });

  it('assertDraftForAttachments passa per campagna DRAFT', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
    await expect(service.assertDraftForAttachments('uuid-1')).resolves.toBeUndefined();
  });

  it('assertDraftForAttachments lancia BadRequestException per campagna QUEUED', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.QUEUED });
    await expect(service.assertDraftForAttachments('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('assertDraftForAttachments lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.assertDraftForAttachments('no-exist')).rejects.toThrow(NotFoundException);
  });
});
