import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InadCheckSyncService } from './inad-check-sync.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { InadService } from '../channels/inad/inad.service';
import { CampaignsService } from './campaigns.service';

describe('InadCheckSyncService', () => {
  let service: InadCheckSyncService;
  const mockCampaignRepo = { find: jest.fn() };
  const mockInadService = { getBulkState: jest.fn() };
  const mockCampaignsService = { finalizeInadCheck: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        InadCheckSyncService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: InadService, useValue: mockInadService },
        { provide: CampaignsService, useValue: mockCampaignsService },
      ],
    }).compile();
    service = module.get(InadCheckSyncService);
  });

  it('chiama finalizeInadCheck quando tutti i batch pending sono DISPONIBILE', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c1',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b1', done: false }, { id: 'b2', done: true }] } },
      },
    ]);
    mockInadService.getBulkState.mockResolvedValue('DISPONIBILE');

    await service.handleCron();

    expect(mockInadService.getBulkState).toHaveBeenCalledWith('b1');
    expect(mockCampaignsService.finalizeInadCheck).toHaveBeenCalledWith('c1');
  });

  it('non chiama finalizeInadCheck se un batch è ancora IN_ELABORAZIONE', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c2',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b1', done: false }] } },
      },
    ]);
    mockInadService.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('ignora campagne senza inadCheck bulk (es. extract-loop, o senza channelConfig)', async () => {
    mockCampaignRepo.find.mockResolvedValue([{ id: 'c3', status: CampaignStatus.CHECKING_INAD, channelConfig: {} }]);

    await service.handleCron();

    expect(mockInadService.getBulkState).not.toHaveBeenCalled();
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('un errore su una campagna non blocca le altre nello stesso ciclo', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      { id: 'c-err', status: CampaignStatus.CHECKING_INAD, channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b-err', done: false }] } } },
      { id: 'c-ok', status: CampaignStatus.CHECKING_INAD, channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b-ok', done: false }] } } },
    ]);
    mockInadService.getBulkState.mockImplementation(async (id: string) => {
      if (id === 'b-err') throw new Error('errore rete');
      return 'DISPONIBILE';
    });

    await service.handleCron();

    expect(mockCampaignsService.finalizeInadCheck).toHaveBeenCalledWith('c-ok');
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalledWith('c-err');
  });
});
