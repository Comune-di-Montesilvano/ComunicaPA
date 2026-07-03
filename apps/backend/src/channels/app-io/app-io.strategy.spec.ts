import { Test } from '@nestjs/testing';
import { AppIoStrategy } from './app-io.strategy';
import { IoServicesService } from '../../io-services/io-services.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockIoServices = {
  resolveApiKey: jest.fn(async () => ({ apiKey: 'test-key', idService: 'SVC1' })),
};

describe('AppIoStrategy', () => {
  let strategy: AppIoStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockIoServices.resolveApiKey.mockClear();
    mockIoServices.resolveApiKey.mockResolvedValue({ apiKey: 'test-key', idService: 'SVC1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'io-msg-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        AppIoStrategy,
        { provide: IoServicesService, useValue: mockIoServices },
      ],
    }).compile();

    strategy = module.get(AppIoStrategy);
  });

  it('is defined with channel APP_IO', () => {
    expect(strategy.channel).toBe('APP_IO');
  });

  it('send() chiama App IO API con fiscal_code e content', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { name: 'TARI', channelConfig: { subject: 'Avviso {{fullName}}', body: 'Importo dovuto.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.io.pagopa.it/api/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'test-key' }),
        body: JSON.stringify({
          fiscal_code: 'RSSMRA85M01H501Z',
          content: { subject: 'Avviso Mario', markdown: 'Importo dovuto.' },
        }),
      }),
    );
    expect(result.messageId).toBe('io-msg-001');
  });

  it('chiama sempre https://api.io.pagopa.it, mai un URL configurabile', async () => {
    const recipient = { fullName: 'Mario Rossi', codiceFiscale: 'RSSMRA80A01H501X', email: null, pec: null };
    const campaign = { name: 'Test', channelConfig: { subject: 'Oggetto', body: 'Corpo' } };

    await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.io.pagopa.it/api/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('send() lancia Error se API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('App IO API error: 429');
  });
});
