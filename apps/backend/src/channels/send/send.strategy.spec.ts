import { Test } from '@nestjs/testing';
import { SendStrategy } from './send.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
  'send.senderTaxId': '01234567890',
  'brand.name': 'Comune di Prova',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockProtocollo = { protocolla: jest.fn(async () => ({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' })) };
const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
const mockUpload = { preloadAndUpload: jest.fn(async (_b: string, _v: string, _buf: Buffer, _ct: string, preloadIdx: string) => ({ key: `key-${preloadIdx}`, versionToken: `vt-${preloadIdx}`, sha256Base64: 'abc123==' })) };

function makeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData: {},
    ...overrides,
  };
}

function makeCampaign(channelConfig: Record<string, unknown>) {
  return { id: 'camp-1', name: 'TARI', description: '', channelConfig };
}

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockProtocollo.protocolla.mockClear();
    mockAttachments.generatePdfBuffer.mockClear();
    mockUpload.preloadAndUpload.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ notificationRequestId: 'req-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        SendStrategy,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: SendAttachmentUploadService, useValue: mockUpload },
      ],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('lancia errore se protocolla non è true (obbligatorio per SEND)', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({ subject: 'Avviso', protocolla: false });
    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/Protocollazione obbligatoria per SEND/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('costruisce il payload v2.6/requests con un documento e nessun pagamento', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({
      subject: 'Avviso TARI 2026',
      protocolla: true,
      taxonomyCode: '010101P',
      physicalCommunicationType: 'AR_REGISTERED_LETTER',
    });

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-0');

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    expect(sendCall).toBeDefined();
    const [, init] = sendCall!;
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
    const payload = JSON.parse(init.body as string);

    expect(payload.paProtocolNumber).toBe('111/2026');
    expect(payload.subject).toBe('Avviso TARI 2026');
    expect(payload.senderTaxId).toBe('01234567890');
    expect(payload.senderDenomination).toBe('Comune di Prova');
    expect(payload.taxonomyCode).toBe('010101P');
    expect(payload.physicalCommunicationType).toBe('AR_REGISTERED_LETTER');
    expect(payload.notificationFeePolicy).toBe('FLAT_RATE');
    expect(payload.recipients).toEqual([{
      recipientType: 'PF',
      taxId: 'RSSMRA85M01H501Z',
      denomination: 'Mario Rossi',
    }]);
    expect(payload.documents).toEqual([{
      ref: { key: 'key-doc-0', versionToken: 'vt-doc-0' },
      title: 'Avviso TARI 2026',
      digests: { sha256: 'abc123==' },
      contentType: 'application/pdf',
      docIdx: 0,
    }]);

    expect(result.messageId).toBe('req-001');
    expect(result.responsePayload).toEqual(expect.objectContaining({
      notificationRequestId: 'req-001',
      protocollo: { numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' },
    }));
  });

  it('include payments nel destinatario se paymentConfig risolve dati validi', async () => {
    const recipient = makeRecipient({ extraData: { importo: '50', avviso: '999888777', cf_ente: '00223344556' } });
    const campaign = makeCampaign({
      subject: 'Avviso',
      protocolla: true,
      taxonomyCode: '010101P',
      paymentConfig: {
        enabled: true,
        amountColumn: 'importo',
        amountType: 'euro',
        noticeNumberColumn: 'avviso',
        payeeFiscalCodeType: 'column',
        payeeFiscalCodeColumn: 'cf_ente',
      },
    });

    await strategy.send(recipient as never, campaign as never);

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].payments).toEqual([
      { pagoPa: { noticeCode: '999888777', creditorTaxId: '00223344556', applyCost: true } },
    ]);
  });

  it('carica più documenti se sono configurati più allegati', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({
      subject: 'Avviso',
      protocolla: true,
      taxonomyCode: '010101P',
      attachments: [{ key: 'a1', label: 'Primo' }, { key: 'a2', label: 'Secondo' }],
    });

    await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 1);
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-0');
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-1');

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.documents).toHaveLength(2);
    expect(payload.documents[1].docIdx).toBe(1);
  });

  it('lancia errore leggibile se PN risponde diverso da 202', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === 'https://send.test/delivery/v2.6/requests') {
        return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('{"errors":["bad"]}') });
      }
      return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ notificationRequestId: 'req-001' }) });
    });
    const recipient = makeRecipient();
    const campaign = makeCampaign({ subject: 'Avviso', protocolla: true, taxonomyCode: '010101P' });
    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/SEND API error: HTTP 400/);
  });
});
