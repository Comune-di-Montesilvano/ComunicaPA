import { AppIoDeliveryService } from './app-io-delivery.service';
import * as templateHelper from '../template.helper';
import * as attachmentService from '../../attachments/attachment.service';
import * as retentionUtil from '../../campaigns/retention.util';
import * as paymentUtil from '../payment-config.util';

jest.mock('../template.helper');
jest.mock('../../attachments/attachment.service');
jest.mock('../../campaigns/retention.util');
jest.mock('../payment-config.util');

describe('AppIoDeliveryService', () => {
  let config: any;
  let settings: any;
  let service: AppIoDeliveryService;
  const originalFetch = global.fetch;

  const campaign = {
    id: 'camp-1', name: 'TARI', channelType: 'POSTAL',
    channelConfig: { subject: 'Oggetto campagna', body: 'Corpo campagna' },
  } as any;
  const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi' } as any;

  beforeEach(() => {
    config = { get: jest.fn(() => 'secret') };
    settings = {
      get: jest.fn(async (key: string) => {
        if (key === 'system.publicUrl') return 'https://example.it';
        if (key === 'retention.maxDays') return 30;
        return null;
      }),
    };
    service = new AppIoDeliveryService(config, settings);

    // Mock template helper functions
    (templateHelper.processTemplate as jest.Mock).mockImplementation((content) => content);
    (templateHelper.buildParallelChannelNotice as jest.Mock).mockImplementation((_recipient, channel) => `Notifica parallela via ${channel}`);
    (templateHelper.formatAppIoMarkdown as jest.Mock).mockImplementation((markdown, opts) => {
      return opts?.parallelNotice ? `${markdown}\n\n${opts.parallelNotice}` : markdown;
    });
    (templateHelper.resolveCitizenPortalUrl as jest.Mock).mockResolvedValue('https://example.it/portal');

    // Mock attachment service functions
    (attachmentService.resolveAttachmentsConfig as jest.Mock).mockReturnValue([]);
    (attachmentService.resolveAttachmentLabel as jest.Mock).mockReturnValue('label');

    // Mock retention utility
    (retentionUtil.getEffectiveRetentionDays as jest.Mock).mockReturnValue(30);

    // Mock payment utility
    (paymentUtil.resolvePaymentData as jest.Mock).mockReturnValue(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('checkProfile', () => {
    it('sender_allowed true → true', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ sender_allowed: true }) }) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(true);
    });

    it('404 (profilo mai attivato) → false, nessun log di errore rumoroso', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(false);
    });

    it('eccezione di rete → false, non propaga', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('successo: usa subjectOverride/bodyOverride quando presenti', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-1' }) }) as any;
      const result = await service.sendMessage(campaign, recipient, {
        apiKey: 'key', baseUrl: 'https://api.io', subjectOverride: 'Oggetto App IO', bodyOverride: 'Testo App IO markdown lungo abbastanza per superare il minimo di ottanta caratteri richiesto da PagoPA.',
      });
      expect(result).toEqual({ success: true, messageId: 'io-msg-1' });
      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.content.subject).toBe('Oggetto App IO');
      expect(body.content.markdown).toContain('Testo App IO markdown');
    });

    it('senza override: fallback su channelConfig.subject/body', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-2' }) }) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(true);
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.content.subject).toBe('Oggetto campagna');
      expect(body.content.markdown).toContain('Corpo campagna');
    });

    it('HTTP non-ok da PagoPA → success:false con dettaglio errore', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid message structure' }) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    it('parallelPrimaryChannel: inserisce il notice di cortesia nel markdown', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-3' }) }) as any;
      await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' }, undefined, 'PEC');
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.content.markdown.toLowerCase()).toContain('pec');
    });

    it('eccezione di rete → success:false, non propaga', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNRESET');
    });
  });
});
