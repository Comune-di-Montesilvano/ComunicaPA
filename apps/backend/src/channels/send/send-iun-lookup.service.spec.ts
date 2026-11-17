import { Test } from '@nestjs/testing';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { SendIunLookupService } from './send-iun-lookup.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';
import { SendLegalFactsService } from './send-legal-facts.service.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

let settingsValues: Record<string, unknown>;
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockLegalFacts = {
  listDocuments: jest.fn(async () => [{ legalFactId: 'safestorage://PN_AAR-1', category: 'AAR' }]),
  downloadNotifiedDocument: jest.fn(async () => ({ ready: false, retryAfterSeconds: 30 })),
  downloadLegalFact: jest.fn(async () => ({ ready: false, retryAfterSeconds: 10 })),
};

function pnResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

const REQUEST_STATUS = {
  iun: 'ABCD-EFGH-IJKL-202601-A-1',
  notificationRequestStatus: 'ACCEPTED',
  paProtocolNumber: '12345',
  recipients: [{ taxId: 'RSSMRA80A01H501U', denomination: 'ROSSI MARIO' }],
};
const DETAIL = {
  iun: 'ABCD-EFGH-IJKL-202601-A-1',
  notificationStatus: 'DELIVERING',
  paProtocolNumber: '12345',
  subject: 'Comunicazione di prova',
  sentAt: '2026-11-10T09:00:00Z',
  group: 'Ufficio Prove',
  recipients: [
    { recipientType: 'PF', taxId: 'RSSMRA80A01H501U', denomination: 'ROSSI MARIO' },
    { recipientType: 'PG', taxId: '01234567890', denomination: 'ACME SRL' },
  ],
};

describe('SendIunLookupService', () => {
  let service: SendIunLookupService;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPdndAuth.getVoucher.mockClear();
    Object.values(mockLegalFacts).forEach((m) => m.mockClear());
    settingsValues = {
      'send.environment': 'produzione',
      'send.prod.baseUrl': 'https://send.prod',
      'send.prod.apiKey': 'apikey-invio',
      'send.prod.lookupApiKey': 'apikey-ricerca',
      'send.prod.purposeId': 'purpose-prod',
    };
    const module = await Test.createTestingModule({
      providers: [
        SendIunLookupService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: SendLegalFactsService, useValue: mockLegalFacts },
      ],
    }).compile();
    service = module.get(SendIunLookupService);
  });

  it('isEnabled: true solo con la chiave di ricerca dell\'ambiente attivo', async () => {
    expect(await service.isEnabled()).toBe(true);
    settingsValues['send.prod.lookupApiKey'] = '';
    expect(await service.isEnabled()).toBe(false);
    settingsValues['send.prod.lookupApiKey'] = 'apikey-ricerca';
    settingsValues['send.environment'] = 'collaudo';
    expect(await service.isEnabled()).toBe(false);
  });

  it('lookup senza chiave di ricerca: NotFoundException, nessuna chiamata a PN (mai la chiave di invio)', async () => {
    settingsValues['send.prod.lookupApiKey'] = '   ';
    await expect(service.lookup('12345')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lookup: usa la chiave di ricerca, token "null" di default, protocollo codificato; poi legge il dettaglio', async () => {
    mockFetch
      .mockResolvedValueOnce(pnResponse(200, { ...REQUEST_STATUS, paProtocolNumber: '4321/2026' }))
      .mockResolvedValueOnce(pnResponse(200, DETAIL));

    const result = await service.lookup('4321/2026');

    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-prod');
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://send.prod/delivery/v2.6/requests?paProtocolNumber=4321%2F2026&idempotenceToken=null',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-ricerca', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://send.prod/delivery/v2.9/notifications/sent/ABCD-EFGH-IJKL-202601-A-1',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-ricerca', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(result).toEqual({
      found: true,
      iun: 'ABCD-EFGH-IJKL-202601-A-1',
      paProtocolNumber: '4321/2026',
      requestStatus: 'ACCEPTED',
      notificationStatus: 'DELIVERING',
      subject: 'Comunicazione di prova',
      sentAt: '2026-11-10T09:00:00Z',
      group: 'Ufficio Prove',
      recipients: [
        { index: 0, recipientType: 'PF', denomination: 'ROSSI MARIO', taxId: 'RSSMRA80A01H501U' },
        { index: 1, recipientType: 'PG', denomination: 'ACME SRL', taxId: '01234567890' },
      ],
    });
  });

  it('lookup: token esplicito passato così com\'è', async () => {
    mockFetch.mockResolvedValueOnce(pnResponse(200, REQUEST_STATUS)).mockResolvedValueOnce(pnResponse(200, DETAIL));
    await service.lookup(' 12345 ', ' tok-123 ');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://send.prod/delivery/v2.6/requests?paProtocolNumber=12345&idempotenceToken=tok-123',
    );
  });

  it('lookup: 404 PN → found false', async () => {
    mockFetch.mockResolvedValueOnce(pnResponse(404, { errors: [{ code: 'PN_DELIVERY_NOTIFICATIONNOTFOUND' }] }));
    expect(await service.lookup('99999')).toEqual({ found: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('lookup: 400 PN → BadRequestException con i codici errore', async () => {
    mockFetch.mockResolvedValueOnce(pnResponse(400, { errors: [{ code: 'PN_GENERIC_INVALIDPARAMETER_REQUIRED' }] }));
    await expect(service.lookup('12345')).rejects.toThrow(/PN_GENERIC_INVALIDPARAMETER_REQUIRED/);
    mockFetch.mockResolvedValueOnce(pnResponse(400, {}));
    await expect(service.lookup('12345')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lookup: 403/5xx PN → BadGatewayException', async () => {
    mockFetch.mockResolvedValueOnce(pnResponse(403, { message: 'Forbidden' }));
    await expect(service.lookup('12345')).rejects.toBeInstanceOf(BadGatewayException);
    mockFetch.mockResolvedValueOnce(pnResponse(502, {}));
    await expect(service.lookup('12345')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('lookup: dettaglio non leggibile → restituisce comunque IUN e stato della richiesta', async () => {
    mockFetch.mockResolvedValueOnce(pnResponse(200, REQUEST_STATUS)).mockResolvedValueOnce(pnResponse(500, {}));
    expect(await service.lookup('12345')).toEqual({
      found: true,
      iun: 'ABCD-EFGH-IJKL-202601-A-1',
      paProtocolNumber: '12345',
      requestStatus: 'ACCEPTED',
      recipients: [{ index: 0, recipientType: '', denomination: 'ROSSI MARIO', taxId: 'RSSMRA80A01H501U' }],
    });
  });

  it('lookup: protocollo vuoto o troppo lungo → BadRequestException senza chiamare PN', async () => {
    await expect(service.lookup('   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.lookup('x'.repeat(257))).rejects.toBeInstanceOf(BadRequestException);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('getNotification', () => {
    const FULL = {
      ...DETAIL,
      abstract: 'Testo di prova',
      senderDenomination: 'Comune di Prova',
      documentsAvailable: true,
      documents: [{ docIdx: '0', title: 'Atto di prova' }],
      notificationStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-11-10T09:05:00Z' }],
      timeline: [
        { category: 'AAR_GENERATION', timestamp: '2026-11-10T09:06:00Z', details: { recIndex: 1, generatedAarUrl: 'safestorage://PN_AAR-1' } },
        { category: 'SEND_ANALOG_DOMICILE', timestamp: '2026-11-10T10:00:00Z', details: { recIndex: 0, taxId: 'RSSMRA80A01H501U' } },
      ],
    };

    it('legge la notifica con la chiave di ricerca e passa la timeline a listDocuments', async () => {
      mockFetch.mockResolvedValueOnce(pnResponse(200, FULL));

      const d = await service.getNotification('ABCD-EFGH-IJKL-202601-A-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://send.prod/delivery/v2.9/notifications/sent/ABCD-EFGH-IJKL-202601-A-1',
        expect.objectContaining({ headers: { 'x-api-key': 'apikey-ricerca', Authorization: 'Bearer voucher-abc' } }),
      );
      expect(mockLegalFacts.listDocuments).toHaveBeenCalledWith('ABCD-EFGH-IJKL-202601-A-1', 'lookupApiKey', FULL.timeline);
      expect(d).toMatchObject({
        iun: 'ABCD-EFGH-IJKL-202601-A-1',
        paProtocolNumber: '12345',
        subject: 'Comunicazione di prova',
        abstract: 'Testo di prova',
        senderDenomination: 'Comune di Prova',
        notificationStatus: 'DELIVERING',
        documentsAvailable: true,
        statusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-11-10T09:05:00Z' }],
        notifiedDocuments: [{ docIdx: 0, title: 'Atto di prova' }],
        sendDocuments: [{ legalFactId: 'safestorage://PN_AAR-1', category: 'AAR' }],
      });
      expect(d.recipients).toHaveLength(2);
      expect(d.timeline.map((e) => e.details?.recIndex)).toEqual([1, 0]);
      // La timeline non porta dati di identità (sono già nei destinatari).
      expect(JSON.stringify(d.timeline)).not.toContain('RSSMRA80A01H501U');
    });

    it('documentsAvailable false → atti notificati segnalati come non più disponibili', async () => {
      mockFetch.mockResolvedValueOnce(pnResponse(200, { ...FULL, documentsAvailable: false }));
      expect((await service.getNotification('ABCD-EFGH-IJKL-202601-A-1')).documentsAvailable).toBe(false);
    });

    it('404 PN → NotFoundException; IUN malformato → BadRequestException senza chiamate', async () => {
      mockFetch.mockResolvedValueOnce(pnResponse(404, {}));
      await expect(service.getNotification('ABCD-EFGH-IJKL-202601-A-1')).rejects.toBeInstanceOf(NotFoundException);
      mockFetch.mockReset();
      await expect(service.getNotification('../etc')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('senza chiave di ricerca → NotFoundException, mai la chiave di invio', async () => {
      settingsValues['send.prod.lookupApiKey'] = '';
      await expect(service.getNotification('ABCD-EFGH-IJKL-202601-A-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.downloadNotifiedDocument('ABCD-EFGH-IJKL-202601-A-1', 0)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.downloadSendDocument('ABCD-EFGH-IJKL-202601-A-1', 'x')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLegalFacts.downloadNotifiedDocument).not.toHaveBeenCalled();
    });

    it('download: delegati a SendLegalFactsService con la chiave di ricerca', async () => {
      await service.downloadNotifiedDocument('ABCD-EFGH-IJKL-202601-A-1', 0);
      await service.downloadSendDocument('ABCD-EFGH-IJKL-202601-A-1', 'safestorage://PN_AAR-1');
      expect(mockLegalFacts.downloadNotifiedDocument).toHaveBeenCalledWith('ABCD-EFGH-IJKL-202601-A-1', 0, 'lookupApiKey');
      expect(mockLegalFacts.downloadLegalFact).toHaveBeenCalledWith('ABCD-EFGH-IJKL-202601-A-1', 'safestorage://PN_AAR-1', 'lookupApiKey');
    });
  });
});
