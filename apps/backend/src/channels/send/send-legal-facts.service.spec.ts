import { Test } from '@nestjs/testing';
import { SendLegalFactsService } from './send-legal-facts.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.apiKey': 'apikey-abc',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('SendLegalFactsService', () => {
  let service: SendLegalFactsService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockSettings.get.mockClear();
    mockPdndAuth.getVoucher.mockClear();

    const module = await Test.createTestingModule({
      providers: [
        SendLegalFactsService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();

    service = module.get(SendLegalFactsService);
  });

  it('listLegalFacts: mappa la risposta PN in legalFactId/category', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { iun: 'IUN-1', legalFactsId: { key: 'safestorage://key1', category: 'SENDER_ACK' } },
            { iun: 'IUN-1', legalFactsId: { key: 'safestorage://key2', category: 'DIGITAL_DELIVERY' } },
          ]),
        ),
    });

    const result = await service.listLegalFacts('IUN-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery-push/v2.0/IUN-1/legal-facts',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(result).toEqual([
      { legalFactId: 'safestorage://key1', category: 'SENDER_ACK' },
      { legalFactId: 'safestorage://key2', category: 'DIGITAL_DELIVERY' },
    ]);
  });

  it('listLegalFacts: ritorna lista vuota se PN risponde errore', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') });

    const result = await service.listLegalFacts('IUN-2');

    expect(result).toEqual([]);
  });

  it('listLegalFacts: ritorna lista vuota su errore di trasporto', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await service.listLegalFacts('IUN-3');

    expect(result).toEqual([]);
  });

  it('downloadLegalFact: scarica il contenuto quando PN fornisce un url pronto', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ filename: 'attestazione.pdf', contentLength: 4, url: 'https://safestorage/x' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('%PDF').buffer),
      });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://send.test/delivery-push/IUN-1/download/legal-facts/key1',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://safestorage/x');
    expect(result).toEqual({ ready: true, filename: 'attestazione.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') });
  });

  it('downloadLegalFact: IUN con caratteri di path (../) → rifiutato senza chiamare PN', async () => {
    const result = await service.downloadLegalFact('../../delivery/v2.9/notifications', 'key1');

    expect(result.ready).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('downloadLegalFact: legalFactId non stringa (parametro ripetuto) → rifiutato senza chiamare PN', async () => {
    const result = await service.downloadLegalFact('IUN-1', ['a', 'b'] as unknown as string);

    expect(result.ready).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('downloadLegalFact: ritorna ready:false con retryAfterSeconds se il file non è pronto', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ filename: 'attestazione.pdf', contentLength: 0, retryAfter: 30 })),
    });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, retryAfterSeconds: 30 });
  });

  describe('listDocuments', () => {
    // Timeline reale ridotta (IUN di prod, nessun dato personale): tre
    // documenti diversi arrivano tutti con categoria ANALOG_DELIVERY, il tipo
    // vero sta solo in details.attachments[].documentType dell'evento.
    const legalFacts = [
      { iun: 'IUN-1', legalFactsId: { key: 'safestorage://PN_LEGAL_FACTS-a.pdf', category: 'SENDER_ACK' } },
      { iun: 'IUN-1', legalFactsId: { key: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-b.zip', category: 'ANALOG_DELIVERY' } },
      { iun: 'IUN-1', legalFactsId: { key: 'safestorage://PN_PRINTED-c.pdf', category: 'ANALOG_DELIVERY' } },
      { iun: 'IUN-1', legalFactsId: { key: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-d.pdf', category: 'ANALOG_DELIVERY' } },
      { iun: 'IUN-1', legalFactsId: { key: 'safestorage://PN_LEGAL_FACTS-e.pdf', category: 'ANALOG_FAILURE_DELIVERY' } },
    ];
    const notification = {
      timeline: [
        { category: 'REQUEST_ACCEPTED', legalFactsIds: [{ key: 'safestorage://PN_LEGAL_FACTS-a.pdf', category: 'SENDER_ACK' }], details: {} },
        { category: 'AAR_GENERATION', legalFactsIds: [], details: { generatedAarUrl: 'safestorage://PN_AAR-x.pdf' } },
        {
          category: 'SEND_ANALOG_PROGRESS',
          legalFactsIds: [{ key: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-b.zip', category: 'ANALOG_DELIVERY' }],
          details: { deliveryDetailCode: 'RECRN001B', attachments: [{ id: '0', documentType: 'AR' }] },
        },
        {
          category: 'SEND_ANALOG_PROGRESS',
          legalFactsIds: [{ key: 'safestorage://PN_PRINTED-c.pdf', category: 'ANALOG_DELIVERY' }],
          details: { deliveryDetailCode: 'CON020', attachments: [{ id: '0', documentType: 'Copia Conforme AAR' }] },
        },
        {
          category: 'SEND_ANALOG_PROGRESS',
          legalFactsIds: [{ key: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-d.pdf', category: 'ANALOG_DELIVERY' }],
          details: { deliveryDetailCode: 'RECRN002E', attachments: [{ id: '0', documentType: 'Plico' }] },
        },
        // Stesso AAR ripetuto da ANALOG_FAILURE_WORKFLOW: va elencato una volta sola
        { category: 'ANALOG_FAILURE_WORKFLOW', legalFactsIds: [], details: { generatedAarUrl: 'safestorage://PN_AAR-x.pdf' } },
        { category: 'COMPLETELY_UNREACHABLE', legalFactsIds: [{ key: 'safestorage://PN_LEGAL_FACTS-e.pdf', category: 'ANALOG_FAILURE_DELIVERY' }], details: {} },
      ],
    };
    const okJson = (body: unknown) => ({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });

    it('arricchisce i documenti con il documentType della timeline e aggiunge l\'AAR una volta sola dopo la presa in carico', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url.includes('/legal-facts') ? okJson(legalFacts) : okJson(notification),
      );

      const result = await service.listDocuments('IUN-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://send.test/delivery/v2.9/notifications/sent/IUN-1',
        expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
      );
      expect(result).toEqual([
        { legalFactId: 'safestorage://PN_LEGAL_FACTS-a.pdf', category: 'SENDER_ACK' },
        { legalFactId: 'safestorage://PN_AAR-x.pdf', category: 'AAR' },
        { legalFactId: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-b.zip', category: 'ANALOG_DELIVERY', documentType: 'AR' },
        { legalFactId: 'safestorage://PN_PRINTED-c.pdf', category: 'ANALOG_DELIVERY', documentType: 'Copia Conforme AAR' },
        { legalFactId: 'safestorage://PN_EXTERNAL_LEGAL_FACTS-d.pdf', category: 'ANALOG_DELIVERY', documentType: 'Plico' },
        { legalFactId: 'safestorage://PN_LEGAL_FACTS-e.pdf', category: 'ANALOG_FAILURE_DELIVERY' },
      ]);
    });

    it('timeline non disponibile: ritorna gli atti PN senza documentType né AAR', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url.includes('/legal-facts') ? okJson(legalFacts.slice(0, 1)) : { ok: false, status: 500, text: () => Promise.resolve('boom') },
      );

      const result = await service.listDocuments('IUN-1');

      expect(result).toEqual([{ legalFactId: 'safestorage://PN_LEGAL_FACTS-a.pdf', category: 'SENDER_ACK' }]);
    });
  });

  it('downloadLegalFact: AAR scaricato dall\'endpoint documenti, non da legal-facts', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ filename: 'aar.pdf', contentLength: 4, url: 'https://safestorage/aar' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('%PDF').buffer),
      });

    const result = await service.downloadLegalFact('IUN-1', 'safestorage://PN_AAR-x.pdf');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://send.test/delivery-push/IUN-1/document/AAR?documentId=safestorage%3A%2F%2FPN_AAR-x.pdf',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(result).toEqual({ ready: true, filename: 'aar.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') });
  });

  it('downloadLegalFact: ritorna ready:false con error se PN risponde errore', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, error: 'Errore PN: HTTP 500' });
  });
});
