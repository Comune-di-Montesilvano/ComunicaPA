import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SendStrategy } from './send.strategy';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockConfig = {
  get: (key: string) => ({ 'send.apiKey': 'send-key', 'send.baseUrl': 'https://send.test' }[key]),
};

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notificationRequestId: 'send-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [SendStrategy, { provide: ConfigService, useValue: mockConfig }],
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
        headers: expect.objectContaining({ 'x-api-key': 'send-key' }),
        body: JSON.stringify({
          recipientTaxId: 'RSSMRA85M01H501Z',
          subject: 'Avviso',
          notificationBody: 'Testo notifica.',
        }),
      }),
    );
    expect(result.messageId).toBe('send-001');
  });

  it('send() lancia Error se SEND API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('SEND API error: 503');
  });
});
