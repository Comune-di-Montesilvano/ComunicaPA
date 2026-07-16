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
