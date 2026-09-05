import { Test } from '@nestjs/testing';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSettings = { get: jest.fn(async (key: string) => (key === 'registroImprese.prod.purposeId' ? 'purpose-ri-prod' : undefined)) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('RegistroImpreseService.dettaglioImpresa', () => {
  let service: RegistroImpreseService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        RegistroImpreseService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(RegistroImpreseService);
  });

  it('restituisce found:true e il raw XML quando risponde 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve('<impresa><denominazione>ACME SRL</denominazione></impresa>'),
    });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result).toEqual({ found: true, raw: '<impresa><denominazione>ACME SRL</denominazione></impresa>' });
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-ri-prod');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://pdnd.registroimprese.it/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=12345678901');
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('restituisce found:false su 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('') });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result).toEqual({ found: false, raw: '' });
  });

  it('lancia RegistroImpreseRateLimitError su 429 con Retry-After', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'Retry-After' ? '30' : null) },
      text: () => Promise.resolve('limite superato'),
    });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(RegistroImpreseRateLimitError);
    try {
      await service.dettaglioImpresa('12345678901');
    } catch (err) {
      expect((err as RegistroImpreseRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, text: () => Promise.resolve('non abilitato') });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/Registro Imprese dettaglio fallito: HTTP 401/);
  });

  it('propaga errore se il purposeId non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/purposeId non impostato/);
  });

  it('estrae pec/denominazione dallo schema reale (dati-identificativi + indirizzo-posta-certificata)', async () => {
    // Forma confermata con chiamata reale (2026-09-05) — dati qui fittizi,
    // vedi CLAUDE.md "No PII reale nel codice".
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi c-fonte="RI" fonte="Registro Imprese" denominazione="ROSSI ESEMPIO S.R.L." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1">' +
      '<forma-giuridica c="SR">SOCIETA\' A RESPONSABILITA\' LIMITATA</forma-giuridica>' +
      '<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(xml) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(true);
    expect(result.denominazione).toBe('ROSSI ESEMPIO S.R.L.');
    expect(result.pec).toBe('esempio@pec.it');
  });

  it('lascia pec/denominazione undefined se lo schema atteso non è presente', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('<blocchi-impresa/>') });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.denominazione).toBeUndefined();
    expect(result.pec).toBeUndefined();
  });
});
