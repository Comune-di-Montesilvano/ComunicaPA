import { Test } from '@nestjs/testing';
import { SendBaseFeeService } from './send-base-fee.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const PA_TAX_ID = '01234567890';
const NOTICE = '302000100000019421';

describe('SendBaseFeeService', () => {
  let service: SendBaseFeeService;
  const mockSettings = { get: jest.fn(async () => 100) };

  beforeEach(async () => {
    mockFetch.mockReset();
    const module = await Test.createTestingModule({
      providers: [SendBaseFeeService, { provide: AppSettingsService, useValue: mockSettings }],
    }).compile();
    service = module.get(SendBaseFeeService);
  });

  it('usa sendFee reale da PN se paTaxId e noticeCode sono disponibili e la chiamata riesce', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ sendFee: 150 }) });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', PA_TAX_ID, NOTICE);

    expect(mockFetch).toHaveBeenCalledWith(
      `https://send.test/delivery/v2.3/price/${PA_TAX_ID}/${NOTICE}`,
      expect.objectContaining({ headers: { 'x-api-key': 'apikey', Authorization: 'Bearer voucher' } }),
    );
    expect(result).toEqual({ cents: 150, source: 'pn' });
  });

  it('usa il fallback configurato se noticeCode è null', async () => {
    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', null, null);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ cents: 100, source: 'config' });
  });

  it('usa il fallback configurato se la chiamata price fallisce', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', PA_TAX_ID, NOTICE);

    expect(result).toEqual({ cents: 100, source: 'config' });
  });

  it('usa il fallback se PN non restituisce sendFee numerico', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ partialPrice: 100 }) });

    expect(await service.resolve('test', 'https://send.test', 'apikey', 'voucher', PA_TAX_ID, NOTICE)).toEqual({ cents: 100, source: 'config' });
  });

  it('paTaxId/noticeCode fuori formato PN (11 e 18 cifre): fallback senza chiamare PN', async () => {
    for (const [taxId, notice] of [
      ['0123456789', NOTICE],
      [PA_TAX_ID, '30200010000001942'],
      ['../../x', NOTICE],
      [PA_TAX_ID, `${NOTICE}?a=b`],
    ]) {
      expect(await service.resolve('test', 'https://send.test', 'apikey', 'voucher', taxId, notice)).toEqual({ cents: 100, source: 'config' });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
