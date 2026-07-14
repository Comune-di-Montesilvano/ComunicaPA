import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignCompletionService } from './campaign-completion.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';

describe('CampaignCompletionService', () => {
  let service: CampaignCompletionService;
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mockCampaignRepo = { createQueryBuilder: jest.fn(() => mockQb) };
  const mockRecipientRepo = { count: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    const module = await Test.createTestingModule({
      providers: [
        CampaignCompletionService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
      ],
    }).compile();
    service = module.get(CampaignCompletionService);
  });

  it('marca la campagna COMPLETED quando non restano destinatari PENDING/QUEUED', async () => {
    mockRecipientRepo.count.mockResolvedValueOnce(0);

    await service.checkAndComplete('camp-1');

    expect(mockRecipientRepo.count).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1', status: expect.anything() },
    });
    expect(mockCampaignRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.COMPLETED, completedAt: expect.any(Date) }),
    );
  });

  it('NON marca la campagna se restano destinatari da processare', async () => {
    mockRecipientRepo.count.mockResolvedValueOnce(3);

    await service.checkAndComplete('camp-1');

    expect(mockCampaignRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
