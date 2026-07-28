import { RecipientStatus } from '../entities/recipient.entity';
import { CampaignContentCorrectionService } from './campaign-content-correction.service';

describe('CampaignContentCorrectionService', () => {
  let attemptRepo: any;
  let recipientRepo: any;
  let campaignRepo: any;
  let campaignsService: any;
  let appIoDelivery: any;
  let ioServices: any;
  let service: CampaignContentCorrectionService;

  const campaign = {
    id: 'camp-1', name: 'TARI', channelType: 'POSTAL',
    channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1' }] },
  };
  const recipient = { id: 'rec-1', codiceFiscale: 'RSSMRA85M01H501Z', status: RecipientStatus.SENT };

  beforeEach(() => {
    attemptRepo = { findOne: jest.fn(), update: jest.fn(async () => undefined) };
    recipientRepo = { findOne: jest.fn(async () => recipient), update: jest.fn(async () => undefined) };
    campaignRepo = { findOneBy: jest.fn(async () => campaign) };
    campaignsService = { retryRecipient: jest.fn(async () => ({ requeued: true, attemptId: 'att-new' })) };
    appIoDelivery = { checkProfile: jest.fn(async () => true), sendMessage: jest.fn(async () => ({ success: true, messageId: 'io-2' })) };
    ioServices = { resolveApiKey: jest.fn(async () => ({ apiKey: 'key', idService: 'svc-1' })) };
    service = new CampaignContentCorrectionService(attemptRepo, recipientRepo, campaignRepo, campaignsService, appIoDelivery, ioServices);
  });

  describe('resendSafe', () => {
    it('canale effettivo PEC (dirottato INAD): forza FAILED se necessario e riusa retryRecipient esistente', async () => {
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('resent');
      expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', { status: RecipientStatus.FAILED });
      expect(campaignsService.retryRecipient).toHaveBeenCalledWith('camp-1', 'rec-1');
    });

    it('canale effettivo già FAILED: non tocca lo stato una seconda volta, poi retry', async () => {
      recipientRepo.findOne.mockResolvedValue({ ...recipient, status: RecipientStatus.FAILED });
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'EMAIL', attemptNumber: 1, responsePayload: {} });

      await service.resendSafe('camp-1', 'rec-1');

      expect(recipientRepo.update).not.toHaveBeenCalled();
      expect(campaignsService.retryRecipient).toHaveBeenCalled();
    });

    it('canale effettivo POSTAL con co-consegna App IO pregressa: richiama solo AppIoDeliveryService, mai retryRecipient', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
        responsePayload: { appIo: { success: true, messageId: 'io-1' }, envelope: { to: ['x'] } },
      });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('resent');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      expect(appIoDelivery.sendMessage).toHaveBeenCalled();
      // merge, non replace: envelope del canale primario resta
      expect(attemptRepo.update).toHaveBeenCalledWith('att-1', {
        responsePayload: expect.objectContaining({ envelope: { to: ['x'] }, appIo: { success: true, messageId: 'io-2' } }),
      });
    });

    it('canale effettivo SEND con co-consegna App IO pregressa: richiama solo AppIoDeliveryService, mai retryRecipient', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'SEND', attemptNumber: 1,
        responsePayload: { appIo: { success: true } },
      });
      const result = await service.resendSafe('camp-1', 'rec-1');
      expect(result).toBe('resent');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
    });

    it('canale effettivo POSTAL SENZA co-consegna App IO pregressa: skipped, nessuna azione', async () => {
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'POSTAL', attemptNumber: 1, responsePayload: {} });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('skipped');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
    });

    it('POSTAL con appIo pregresso ma cittadino ha disattivato App IO nel frattempo: skipped', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
        responsePayload: { appIo: { success: true } },
      });
      appIoDelivery.checkProfile.mockResolvedValue(false);

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('skipped');
      expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
    });

    it('nessun attempt trovato → skipped', async () => {
      attemptRepo.findOne.mockResolvedValue(null);
      const result = await service.resendSafe('camp-1', 'rec-1');
      expect(result).toBe('skipped');
    });
  });

  describe('resendSafeBulk', () => {
    it('più di 500 recipientIds → throw', async () => {
      const many = Array.from({ length: 501 }, (_, i) => `r${i}`);
      await expect(service.resendSafeBulk('camp-1', many)).rejects.toThrow();
    });

    it('un errore su un recipientId non abortisce gli altri', async () => {
      attemptRepo.findOne
        .mockResolvedValueOnce({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} })
        .mockRejectedValueOnce(new Error('DB down'));

      const results = await service.resendSafeBulk('camp-1', ['rec-1', 'rec-2']);

      expect(results).toEqual([
        { recipientId: 'rec-1', result: 'resent' },
        { recipientId: 'rec-2', result: 'error', message: 'DB down' },
      ]);
    });
  });
});
