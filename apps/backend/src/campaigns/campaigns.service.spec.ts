import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { NOTIFICATION_QUEUE } from '../queue/notification-job.types';

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

  const mockCampaignRepo = {
    find: jest.fn().mockResolvedValue([mockCampaign]),
    findOneBy: jest.fn().mockResolvedValue(mockCampaign),
    create: jest.fn().mockReturnValue(mockCampaign),
    save: jest.fn().mockResolvedValue(mockCampaign),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
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
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: mockQueue },
      ],
    }).compile();
    service = module.get<CampaignsService>(CampaignsService);
    jest.clearAllMocks();
    mockCampaignRepo.find.mockResolvedValue([mockCampaign]);
    mockCampaignRepo.findOneBy.mockResolvedValue(mockCampaign);
    mockCampaignRepo.create.mockReturnValue(mockCampaign);
    mockCampaignRepo.save.mockResolvedValue(mockCampaign);
    mockCampaignRepo.update.mockResolvedValue(undefined);
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
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.findOne('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('create saves and returns campaign with createdBy', async () => {
    const dto = { name: 'Test', channelType: 'EMAIL' as const };
    const result = await service.create(dto, 'op1');
    expect(result).toEqual(mockCampaign);
    expect(mockCampaignRepo.save).toHaveBeenCalled();
  });

  it('launch throws BadRequestException when no pending recipients', async () => {
    mockRecipientRepo.find.mockResolvedValueOnce([]);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws BadRequestException when campaign not in DRAFT', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      status: CampaignStatus.QUEUED,
    });
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });
});
