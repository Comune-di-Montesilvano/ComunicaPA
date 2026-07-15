import { Test } from '@nestjs/testing';
import { SendLegalFactsService } from './send-legal-facts.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

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

  it('downloadLegalFact: ritorna ready:false con retryAfterSeconds se il file non è pronto', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ filename: 'attestazione.pdf', contentLength: 0, retryAfter: 30 })),
    });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, retryAfterSeconds: 30 });
  });

  it('downloadLegalFact: ritorna ready:false con error se PN risponde errore', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, error: 'Errore PN: HTTP 500' });
  });
});
