import { Test } from '@nestjs/testing';
import { SendStrategy } from './send.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notificationRequestId: 'send-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        SendStrategy,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('send() chiama SEND API con recipientTaxId', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/notifications/sent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer voucher-abc' }),
        body: JSON.stringify({
          recipientTaxId: 'RSSMRA85M01H501Z',
          subject: 'Avviso',
          notificationBody: 'Testo notifica.',
        }),
      }),
    );
    expect(result.messageId).toBe('send-001');
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('test', 'purpose-test');
  });

  it('send() lancia Error se SEND API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('SEND API error: 503');
  });
});
