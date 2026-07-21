import { Test } from '@nestjs/testing';
import { SendBaseFeeService } from './send-base-fee.service';
import { AppSettingsService } from '../../settings/app-settings.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SendBaseFeeService', () => {
  let service: SendBaseFeeService;
  const mockSettings = { get: jest.fn(async () => 100) };

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({
      providers: [SendBaseFeeService, { provide: AppSettingsService, useValue: mockSettings }],
    }).compile();
    service = module.get(SendBaseFeeService);
  });

  it('usa sendFee reale da PN se paTaxId e noticeCode sono disponibili e la chiamata riesce', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ sendFee: 150 })),
      json: () => Promise.resolve({ sendFee: 150 }),
    });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', '01234567890', 'NOTICE123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.3/price/01234567890/NOTICE123',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey', Authorization: 'Bearer voucher' } }),
    );
    expect(result).toBe(150);
  });

  it('usa il fallback configurato se noticeCode è null', async () => {
    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', null, null);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBe(100);
  });

  it('usa il fallback configurato se la chiamata price fallisce', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', '01234567890', 'NOTICE123');

    expect(result).toBe(100);
  });
});
