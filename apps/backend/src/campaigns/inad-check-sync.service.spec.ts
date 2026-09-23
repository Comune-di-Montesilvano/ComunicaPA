import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InadCheckSyncService } from './inad-check-sync.service.js';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { InadService, InadQuotaExceededError } from '../channels/inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';
import { CampaignsService } from './campaigns.service.js';

describe('InadCheckSyncService', () => {
  let service: InadCheckSyncService;
  const mockCampaignRepo = { find: jest.fn(), save: jest.fn() };
  const mockRecipientRepo = { find: jest.fn() };
  const mockInadService = { getBulkState: jest.fn(), startBulkExtraction: jest.fn() };
  const mockRegistroImpreseVerifyQueue = { isCampaignJobDone: jest.fn() };
  const mockCampaignsService = { finalizeInadCheck: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        InadCheckSyncService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: InadService, useValue: mockInadService },
        { provide: RegistroImpreseVerifyQueueService, useValue: mockRegistroImpreseVerifyQueue },
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

  it('chiama finalizeInadCheck quando i batch INAD sono vuoti ma tutti i job PIVA sono conclusi', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c-piva',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [], pivaRecipientIds: ['r1', 'r2'] } },
      },
    ]);
    mockRegistroImpreseVerifyQueue.isCampaignJobDone.mockResolvedValue(true);

    await service.handleCron();

    expect(mockRegistroImpreseVerifyQueue.isCampaignJobDone).toHaveBeenCalledWith('c-piva', 'r1');
    expect(mockRegistroImpreseVerifyQueue.isCampaignJobDone).toHaveBeenCalledWith('c-piva', 'r2');
    expect(mockCampaignsService.finalizeInadCheck).toHaveBeenCalledWith('c-piva');
  });

  it('non chiama finalizeInadCheck se un job PIVA non è ancora concluso', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c-piva-pending',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [], pivaRecipientIds: ['r1'] } },
      },
    ]);
    mockRegistroImpreseVerifyQueue.isCampaignJobDone.mockResolvedValue(false);

    await service.handleCron();

    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('non interroga i job PIVA se un batch INAD è ancora pending (short-circuit)', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c-mix',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b1', done: false }], pivaRecipientIds: ['r1'] } },
      },
    ]);
    mockInadService.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    expect(mockRegistroImpreseVerifyQueue.isCampaignJobDone).not.toHaveBeenCalled();
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('ri-sottomette un batch non ancora inviato (id:null, quota esaurita al lancio) e salva l\'id assegnato', async () => {
    const campaign = {
      id: 'c-unsent',
      status: CampaignStatus.CHECKING_INAD,
      channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: null, recipientIds: ['r1', 'r2'], done: false }] } },
    };
    mockCampaignRepo.find.mockResolvedValue([campaign]);
    mockRecipientRepo.find.mockResolvedValue([{ codiceFiscale: 'CF1' }, { codiceFiscale: 'CF2' }]);
    mockInadService.startBulkExtraction.mockResolvedValue({ id: 'batch-new' });

    await service.handleCron();

    expect(mockRecipientRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: expect.anything() } }),
    );
    expect(mockInadService.startBulkExtraction).toHaveBeenCalledWith(['CF1', 'CF2'], 'comunicapa-campagna-c-unsent');
    expect(mockCampaignRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        channelConfig: expect.objectContaining({
          inadCheck: expect.objectContaining({ batches: [expect.objectContaining({ id: 'batch-new', done: false })] }),
        }),
      }),
    );
    // Appena sottomesso, poll stato nello stesso giro (mock non configurato -> non DISPONIBILE): nessun finalize.
    expect(mockInadService.getBulkState).toHaveBeenCalledWith('batch-new');
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('quota ancora esaurita alla ri-sottomissione: batch resta id:null, nessun crash, nessun save', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c-still-blocked',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: null, recipientIds: ['r1'], done: false }] } },
      },
    ]);
    mockRecipientRepo.find.mockResolvedValue([{ codiceFiscale: 'CF1' }]);
    mockInadService.startBulkExtraction.mockRejectedValue(new InadQuotaExceededError('ancora esaurita'));

    await expect(service.handleCron()).resolves.not.toThrow();

    expect(mockCampaignRepo.save).not.toHaveBeenCalled();
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });
});
