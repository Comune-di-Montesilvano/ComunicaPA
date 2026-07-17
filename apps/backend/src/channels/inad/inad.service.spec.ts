import { Test } from '@nestjs/testing';
import { InadService } from './inad.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSettings = { get: jest.fn(async (key: string) => (key === 'inad.prod.purposeId' ? 'purpose-inad-prod' : undefined)) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('InadService.extractDigitalAddress', () => {
  let service: InadService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        InadService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(InadService);
  });

  it('restituisce found:true e i dati quando INAD risponde 200', async () => {
    const body = {
      codiceFiscale: 'RRANGL74M28R701V',
      since: '2017-07-21T17:32:28Z',
      digitalAddress: [
        { digitalAddress: 'example@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01T00:00:00Z' } },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

    const result = await service.extractDigitalAddress('RRANGL74M28R701V');

    expect(result).toEqual({ found: true, data: body });
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-inad-prod');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/extract/RRANGL74M28R701V?practicalReference=comunicapa-verifica-domicilio',
    );
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('restituisce found:false quando INAD risponde 404 (nessun domicilio)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"status":"404","type":"NOT_FOUND"}') });

    const result = await service.extractDigitalAddress('RRANGL74M28R701V');

    expect(result).toEqual({ found: false });
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('{"status":"401","type":"UNAUTHORIZED"}') });

    await expect(service.extractDigitalAddress('RRANGL74M28R701V')).rejects.toThrow(
      /INAD extract fallito: HTTP 401/,
    );
  });

  it('propaga l\'errore se il purposeId prod non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.extractDigitalAddress('RRANGL74M28R701V')).rejects.toThrow();
  });
});

describe('InadService — metodi bulk', () => {
  let service: InadService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        InadService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(InadService);
  });

  it('startBulkExtraction invia POST /listDigitalAddress e ritorna l\'id dalla Location', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: (h: string) => (h === 'location' ? 'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/state/abc-123' : null) },
      text: () => Promise.resolve('{"state":"PRESA_IN_CARICO","id":"abc-123"}'),
    });

    const result = await service.startBulkExtraction(['CF1', 'CF2'], 'rif-test');

    expect(result).toEqual({ id: 'abc-123' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ codiciFiscali: ['CF1', 'CF2'], praticalReference: 'rif-test' });
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('startBulkExtraction lancia errore leggibile se manca la Location', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: () => Promise.resolve('{}'),
    });
    await expect(service.startBulkExtraction(['CF1'], 'rif')).rejects.toThrow(/INAD bulk fallito: nessun header Location/);
  });

  it('getBulkState ritorna lo stato dal body JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"state":"IN_ELABORAZIONE","message":"..."}'),
    });
    const state = await service.getBulkState('abc-123');
    expect(state).toBe('IN_ELABORAZIONE');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/state/abc-123');
  });

  it('getBulkState riconosce DISPONIBILE anche su risposta 303', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 303,
      text: () => Promise.resolve('{"state":"DISPONIBILE","message":"..."}'),
    });
    const state = await service.getBulkState('abc-123');
    expect(state).toBe('DISPONIBILE');
  });

  it('getBulkResult ritorna la lista dal body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"list":[{"codiceFiscale":"CF1","since":"2026-01-01T00:00:00Z","digitalAddress":[{"digitalAddress":"a@pec.it","usageInfo":{"motivation":"CESSAZIONE_VOLONTARIA","dateEndValidity":"2020-01-01T00:00:00Z"}}]},{"codiceFiscale":"CF2","since":"2026-01-01T00:00:00Z"}]}'),
    });
    const result = await service.getBulkResult('abc-123');
    expect(result).toHaveLength(2);
    expect(result[0].codiceFiscale).toBe('CF1');
    expect(result[0].digitalAddress?.[0].digitalAddress).toBe('a@pec.it');
    expect(result[1].digitalAddress).toBeUndefined();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/response/abc-123');
  });
});
