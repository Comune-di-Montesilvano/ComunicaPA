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
    id: 'camp-1', name: 'TARI', channelType: 'POSTAL', status: 'queued',
    channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1' }] },
  };
  const recipient = { id: 'rec-1', campaignId: 'camp-1', codiceFiscale: 'RSSMRA85M01H501Z', status: RecipientStatus.SENT };

  beforeEach(() => {
    attemptRepo = { findOne: jest.fn(), update: jest.fn(async () => undefined) };
    recipientRepo = { findOne: jest.fn(async () => recipient), update: jest.fn(async () => undefined) };
    campaignRepo = {
      findOneBy: jest.fn(async () => campaign),
      decrement: jest.fn(async () => undefined),
      increment: jest.fn(async () => undefined),
    };
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

    describe('fix review finale #1: sentCount/failedCount non driftano su resend canale sicuro', () => {
      it('destinatario era SENT: decrementa sentCount E incrementa failedCount PRIMA di retryRecipient (che poi decrementerà failedCount da solo)', async () => {
        recipientRepo.findOne.mockResolvedValue({ ...recipient, status: RecipientStatus.SENT });
        attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('resent');
        expect(campaignRepo.decrement).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
        expect(campaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
        // Ordine: prima il decrement/increment contatori, poi retryRecipient
        // (che farà il suo proprio decrement di failedCount, invariato).
        const decrementOrder = campaignRepo.decrement.mock.invocationCallOrder[0];
        const retryOrder = campaignsService.retryRecipient.mock.invocationCallOrder[0];
        expect(decrementOrder).toBeLessThan(retryOrder);
      });

      it('destinatario era già FAILED: nessun tocco a sentCount/failedCount qui (retryRecipient farà il proprio decrement failedCount, invariato)', async () => {
        recipientRepo.findOne.mockResolvedValue({ ...recipient, status: RecipientStatus.FAILED });
        attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

        await service.resendSafe('camp-1', 'rec-1');

        expect(campaignRepo.decrement).not.toHaveBeenCalled();
        expect(campaignRepo.increment).not.toHaveBeenCalled();
      });
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
      // merge, non replace: envelope del canale primario resta, e la firma
      // contenuto (subject/body correnti campagna, entrambi vuoti nel fixture)
      // viene apposta nello stesso update, non in una chiamata separata.
      expect(attemptRepo.update).toHaveBeenCalledWith('att-1', {
        responsePayload: expect.objectContaining({
          envelope: { to: ['x'] },
          appIo: { success: true, messageId: 'io-2' },
          contentSignature: JSON.stringify(['', '']),
        }),
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

    describe('fix review finale #2: guardia CANCELLED sul branch App IO (POSTAL/SEND)', () => {
      it('campagna CANCELLED: skipped, nessun invio App IO reale, nessun throw', async () => {
        campaignRepo.findOneBy.mockResolvedValue({ ...campaign, status: 'cancelled' });
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
          responsePayload: { appIo: { success: true } },
        });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
        expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      });
    });

    describe('fix review finale #3: ownership recipient/campagna', () => {
      it('recipient appartiene a un\'altra campagna (branch sicuro): skipped, nessun retry con contenuto sbagliato', async () => {
        recipientRepo.findOne.mockResolvedValue({ ...recipient, campaignId: 'camp-ALTRA' });
        attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      });

      it('recipient appartiene a un\'altra campagna (branch POSTAL/SEND, no retryRecipient a proteggere): skipped, nessun invio App IO con la config della campagna sbagliata', async () => {
        recipientRepo.findOne.mockResolvedValue({ ...recipient, campaignId: 'camp-ALTRA' });
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
          responsePayload: { appIo: { success: true } },
        });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
      });
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

    describe('idempotenza per firma contenuto (fix doppio invio da categorie sovrapposte)', () => {
      const currentSignature = JSON.stringify(['', '']); // campaign fixture: subject/body assenti da channelConfig

      it('lastAttempt.responsePayload.contentSignature già uguale alla firma corrente → skipped, nessun branch eseguito', async () => {
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1,
          responsePayload: { contentSignature: currentSignature },
        });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
      });

      it('canale sicuro, contentSignature assente/stale: procede al retry e appone la firma sul NUOVO attempt (non su lastAttempt)', async () => {
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1,
          responsePayload: { contentSignature: 'stale-signature' },
        });
        campaignsService.retryRecipient.mockResolvedValue({ requeued: true, attemptId: 'att-new' });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('resent');
        expect(campaignsService.retryRecipient).toHaveBeenCalledWith('camp-1', 'rec-1');
        expect(attemptRepo.update).toHaveBeenCalledWith('att-new', {
          responsePayload: { contentSignature: currentSignature },
        });
        // mai su lastAttempt: quell'attempt è superato dal nuovo creato dal retry
        expect(attemptRepo.update).not.toHaveBeenCalledWith('att-1', expect.anything());
      });

      it('scenario reale del bug: due click consecutivi (App IO parallela + Dirottato INAD) sullo stesso destinatario → il secondo si ferma', async () => {
        // Primo click: nessuna firma pregressa, procede e stampa la firma sul nuovo attempt.
        attemptRepo.findOne.mockResolvedValueOnce({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {},
        });
        campaignsService.retryRecipient.mockResolvedValueOnce({ requeued: true, attemptId: 'att-new' });

        const first = await service.resendSafe('camp-1', 'rec-1');
        expect(first).toBe('resent');
        expect(campaignsService.retryRecipient).toHaveBeenCalledTimes(1);

        // Secondo click (altro pulsante, stesso destinatario): l'ultimo attempt
        // ora è quello appena creato/firmato dal primo click.
        attemptRepo.findOne.mockResolvedValueOnce({
          id: 'att-new', channelType: 'PEC', attemptNumber: 2,
          responsePayload: { contentSignature: currentSignature },
        });

        const second = await service.resendSafe('camp-1', 'rec-1');

        expect(second).toBe('skipped');
        // Nessuna seconda chiamata: il conteggio resta fermo a quello del primo click.
        expect(campaignsService.retryRecipient).toHaveBeenCalledTimes(1);
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
      });
    });
  });

  describe('resendSafeBulk', () => {
    it('più di 100 recipientIds → throw (cap abbassato da 500, fix review finale #5: costo I/O esterno per-item App IO)', async () => {
      const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
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
