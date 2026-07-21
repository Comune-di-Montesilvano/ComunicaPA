import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { ConfigService } from '@nestjs/config';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { InadService } from '../channels/inad/inad.service';

describe('CampaignsService - Cost and Savings', () => {
  let service: CampaignsService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let settingsService: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: jest.fn() };
    recipientRepo = { find: jest.fn(), count: jest.fn() };
    attemptRepo = { find: jest.fn() };
    settingsService = { get: jest.fn(async () => 100) };

    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: settingsService },
        { provide: ConfigService, useValue: {} },
        { provide: InadService, useValue: {} },
      ],
    }).compile();

    service = module.get(CampaignsService);
  });

  describe('getCampaignCost', () => {
    it('somma costCents degli attempt SEND/POSTAL della campagna per canale, escludendo quelli senza costo calcolato', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1' });
      recipientRepo.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
      attemptRepo.find.mockResolvedValue([
        { recipientId: 'r1', channelType: 'SEND', costCents: 100 },
        { recipientId: 'r2', channelType: 'SEND', costCents: null },
        { recipientId: 'r3', channelType: 'POSTAL', costCents: 431 },
      ]);

      const result = await service.getCampaignCost('c1');

      expect(result.totalCostCents).toBe(531);
      expect(result.byChannel).toEqual(expect.arrayContaining([
        { channel: 'SEND', totalCostCents: 100, uncalculatedCount: 1 },
        { channel: 'POSTAL', totalCostCents: 431, uncalculatedCount: 0 },
      ]));
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepo.findOneBy.mockResolvedValue(null);

      await expect(service.getCampaignCost('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCampaignCostSavings', () => {
    it('calcola risparmio SEND solo per destinatari dirottati/senza attempt a pagamento (fallback base fee)', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
      recipientRepo.find.mockResolvedValue([
        { id: 'r1', inadCheck: null },
        { id: 'r2', inadCheck: { diverted: true } },
      ]);
      attemptRepo.find.mockResolvedValue([
        { recipientId: 'r1', channelType: 'SEND', costCents: 100 },
        // r2: nessun attempt SEND (dirottato/skippato) → costo reale incorso 0
      ]);
      settingsService.get.mockResolvedValue(100);

      const result = await service.getCampaignCostSavings('c1');

      expect(result.totalSavingCents).toBe(100);
      expect(result.postalNotEstimableCount).toBe(0);
    });

    it('campagna POSTAL: nessun risparmio stimato, solo conteggio dirottati N/D', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL' });
      recipientRepo.count.mockResolvedValue(1);

      const result = await service.getCampaignCostSavings('c1');

      expect(result.totalSavingCents).toBe(0);
      expect(result.postalNotEstimableCount).toBe(1);
    });
  });
});
