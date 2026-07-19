import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignCompletionService } from './campaign-completion.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';

describe('CampaignCompletionService', () => {
  let service: CampaignCompletionService;
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mockCampaignRepo = {
    createQueryBuilder: jest.fn(() => mockQb),
    findOneBy: jest.fn(),
    delete: jest.fn(),
  };
  const mockRecipientRepo = { count: jest.fn(), find: jest.fn(), delete: jest.fn() };
  const mockAttemptRepo = { delete: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockCampaignRepo.findOneBy.mockResolvedValue(null);
    mockRecipientRepo.find.mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        CampaignCompletionService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
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

  it('cancella a cascata la campagna test collegata quando la madre completa', async () => {
    mockRecipientRepo.count.mockResolvedValue(0); // nessun PENDING/QUEUED residuo
    const updateExec = jest.fn().mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: updateExec,
    });
    const testChild = { id: 'child-1', parentCampaignId: 'parent-1', isTest: true };
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(testChild); // lookup child by parentCampaignId
    mockAttemptRepo.delete.mockResolvedValue(undefined);
    mockRecipientRepo.delete.mockResolvedValue(undefined);
    mockCampaignRepo.delete.mockResolvedValue(undefined);

    await service.checkAndComplete('parent-1');

    expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ parentCampaignId: 'parent-1', isTest: true });
    expect(mockCampaignRepo.delete).toHaveBeenCalledWith('child-1');
  });

  it('non fa nulla se non esiste campagna test collegata', async () => {
    mockRecipientRepo.count.mockResolvedValue(0);
    const updateExec = jest.fn().mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: updateExec,
    });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);

    await service.checkAndComplete('parent-1');

    expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
    expect(mockAttemptRepo.delete).not.toHaveBeenCalled();
    expect(mockRecipientRepo.delete).not.toHaveBeenCalled();
  });

  it('NON cancella la cascata se lo UPDATE non ha modificato righe (campagna già COMPLETED/altro stato)', async () => {
    mockRecipientRepo.count.mockResolvedValue(0); // nessun PENDING/QUEUED residuo, si supera il primo guard
    const updateExec = jest.fn().mockResolvedValue({ affected: 0 }); // WHERE status = QUEUED non ha matchato nulla
    mockCampaignRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: updateExec,
    });

    await service.checkAndComplete('parent-1');

    expect(mockCampaignRepo.findOneBy).not.toHaveBeenCalled();
    expect(mockAttemptRepo.delete).not.toHaveBeenCalled();
    expect(mockRecipientRepo.delete).not.toHaveBeenCalled();
    expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
  });
});
