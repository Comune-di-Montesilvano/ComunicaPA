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

      // Nessun update di stato (già FAILED) — l'unico recipientRepo.update
      // atteso è quello della firma contenuto (fix wave 2 fix B), non uno
      // status update duplicato.
      expect(recipientRepo.update).not.toHaveBeenCalledWith('rec-1', { status: RecipientStatus.FAILED });
      // La firma è ora un hash SHA-256 hex (64 char), non raw JSON.stringify
      expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', {
        lastContentResendSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
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
      // merge, non replace: envelope del canale primario resta. La firma
      // contenuto (fix wave 2 fix B) NON vive più su responsePayload — vive
      // su Recipient.lastContentResendSignature, scritta con un update
      // dedicato separato. Fix wave 3: la firma è un hash SHA-256 hex.
      expect(attemptRepo.update).toHaveBeenCalledWith('att-1', {
        responsePayload: {
          envelope: { to: ['x'] },
          appIo: { success: true, messageId: 'io-2' },
        },
      });
      expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', {
        lastContentResendSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
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

    describe('fix review finale #2 / fix wave 2 fix A: guardia CANCELLED unica per ENTRAMBI i branch', () => {
      it('campagna CANCELLED, canale effettivo POSTAL/SEND: skipped, nessun invio App IO reale, nessun throw', async () => {
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

      it('campagna CANCELLED, canale effettivo già sicuro (PEC, es. dirottato INAD): skipped PRIMA di qualunque mutazione — nessun forzato FAILED, nessun tocco contatori, nessun retryRecipient', async () => {
        campaignRepo.findOneBy.mockResolvedValue({ ...campaign, status: 'cancelled' });
        recipientRepo.findOne.mockResolvedValue({ ...recipient, status: RecipientStatus.SENT });
        attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(recipientRepo.update).not.toHaveBeenCalled();
        expect(campaignRepo.decrement).not.toHaveBeenCalled();
        expect(campaignRepo.increment).not.toHaveBeenCalled();
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

    describe('idempotenza per firma contenuto (fix doppio invio da categorie sovrapposte) — fix wave 2 fix B: firma su Recipient, non su NotificationAttempt.responsePayload', () => {
      // NOTA: fix wave 3 — la firma è ora un hash SHA-256 hex (64 char), non raw JSON.stringify
      // Per il test baseline (campaign fixture vuota), il JSON.stringify di ['',''] produce uno string
      // che quando hashato genera un hash fisso — ma il test non lo hardcoda per evitare fragilità.
      // Invece usa expect().toMatch(/^[a-f0-9]{64}$/) per verificare che il risultato sia sempre un hex 64-char.
      const getCurrentSignatureHash = () => {
        const { createHash } = require('crypto');
        return createHash('sha256').update(JSON.stringify(['', ''])).digest('hex');
      };

      it('recipient.lastContentResendSignature già uguale alla firma corrente → skipped, nessun branch eseguito', async () => {
        const currentSignature = getCurrentSignatureHash();
        recipientRepo.findOne.mockResolvedValue({ ...recipient, lastContentResendSignature: currentSignature });
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {},
        });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('skipped');
        expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
      });

      it('canale sicuro, lastContentResendSignature assente/stale: procede al retry e scrive la firma su Recipient (non su NotificationAttempt)', async () => {
        const currentSignature = getCurrentSignatureHash();
        recipientRepo.findOne.mockResolvedValue({ ...recipient, lastContentResendSignature: 'stale-signature' });
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {},
        });
        campaignsService.retryRecipient.mockResolvedValue({ requeued: true, attemptId: 'att-new' });

        const result = await service.resendSafe('camp-1', 'rec-1');

        expect(result).toBe('resent');
        expect(campaignsService.retryRecipient).toHaveBeenCalledWith('camp-1', 'rec-1');
        expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', {
          lastContentResendSignature: currentSignature,
        });
        // mai più su responsePayload di un attempt (fix B): NotificationProcessor
        // rimpiazza sempre l'intero responsePayload quando il job del retry
        // completa, quindi una firma scritta lì sarebbe silenziosamente persa.
        expect(attemptRepo.update).not.toHaveBeenCalled();
      });

      it('scenario reale del bug: due click consecutivi (App IO parallela + Dirottato INAD) sullo stesso destinatario → il secondo si ferma, ANCHE dopo che NotificationProcessor ha rimpiazzato responsePayload del nuovo attempt', async () => {
        const currentSignature = getCurrentSignatureHash();
        // Primo click: nessuna firma pregressa, procede e scrive la firma su Recipient.
        recipientRepo.findOne.mockResolvedValueOnce({ ...recipient, lastContentResendSignature: undefined });
        attemptRepo.findOne.mockResolvedValueOnce({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {},
        });
        campaignsService.retryRecipient.mockResolvedValueOnce({ requeued: true, attemptId: 'att-new' });

        const first = await service.resendSafe('camp-1', 'rec-1');
        expect(first).toBe('resent');
        expect(campaignsService.retryRecipient).toHaveBeenCalledTimes(1);
        expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', {
          lastContentResendSignature: currentSignature,
        });

        // Secondo click (altro pulsante, stesso destinatario): il job del primo
        // resend è nel frattempo passato per NotificationProcessor, che ha
        // RIMPIAZZATO l'intero responsePayload del nuovo attempt ('att-new')
        // con un payload fresco senza alcuna traccia di firma — simulato qui
        // non impostando affatto contentSignature su responsePayload. La
        // firma su Recipient invece sopravvive intatta (mai toccata dal
        // processor), quindi il guard la trova comunque.
        recipientRepo.findOne.mockResolvedValueOnce({ ...recipient, lastContentResendSignature: currentSignature });
        attemptRepo.findOne.mockResolvedValueOnce({
          id: 'att-new', channelType: 'PEC', attemptNumber: 2,
          responsePayload: { messageId: 'external-id-from-processor' },
        });

        const second = await service.resendSafe('camp-1', 'rec-1');

        expect(second).toBe('skipped');
        // Nessuna seconda chiamata: il conteggio resta fermo a quello del primo click.
        expect(campaignsService.retryRecipient).toHaveBeenCalledTimes(1);
        expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe('fix wave 3: firma SHA-256 hash (64 char), mai raw JSON.stringify — overflow varchar(512) impossibile', () => {
      it('body lunghissimo (1500+ char): firma sempre hash fisso 64-char, mai exceeds varchar(512)', async () => {
        // Campaign fixture ha body vuoto — sostituisci con uno lunghissimo
        // per provare che il hash non cresce al crescere del body
        const hugeBody = 'X'.repeat(1500); // 1500 char, ben oltre il limit del raw JSON.stringify
        const campaignWithHugeBody = {
          ...campaign,
          channelConfig: { ...campaign.channelConfig, subject: 'Test', body: hugeBody },
        };
        campaignRepo.findOneBy.mockResolvedValue(campaignWithHugeBody);
        recipientRepo.findOne.mockResolvedValue({ ...recipient, lastContentResendSignature: undefined });
        attemptRepo.findOne.mockResolvedValue({
          id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {},
        });
        campaignsService.retryRecipient.mockResolvedValue({ requeued: true, attemptId: 'att-new' });

        await service.resendSafe('camp-1', 'rec-1');

        // Verifica che l'update della firma abbia un valore che sia:
        // 1. Un hash hex (64 caratteri, solo [a-f0-9])
        // 2. MAI il raw JSON.stringify del contenuto (che sarebbe 1000+ char)
        const updateCalls = recipientRepo.update.mock.calls;
        const signatureUpdate = updateCalls.find((call: any) => call[1]?.lastContentResendSignature);
        expect(signatureUpdate).toBeDefined();

        const signature = signatureUpdate[1].lastContentResendSignature;
        expect(signature).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex = 64 char
        expect(signature.length).toBe(64); // Esplicitamente 64, mai variable
        // Bonus: se avessero usato raw JSON.stringify, sarebbe centinaio+ di char
        expect(signature).not.toMatch(/XXX/); // Nessuna traccia del body reale
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
