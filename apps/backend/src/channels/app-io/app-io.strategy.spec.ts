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

    // Per default, simula profilo abilitato e invio corretto
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/profiles/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sender_allowed: true }),
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'io-msg-001' }),
      };
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

  it('send() chiama App IO API con fiscal_code e content previa verifica profilo', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { name: 'TARI', channelConfig: { subject: 'Avviso {{fullName}}', body: 'Importo dovuto.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.io.pagopa.it/api/v1/profiles/RSSMRA85M01H501Z',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'test-key' }),
      }),
    );

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.io.pagopa.it/api/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': 'test-key',
        }),
        body: JSON.stringify({
          fiscal_code: 'RSSMRA85M01H501Z',
          content: { subject: 'Avviso Mario', markdown: 'Importo dovuto.' },
        }),
      }),
    );
    expect(result.messageId).toBe('io-msg-001');
  });

  it('lancia errore se il cittadino non è iscritto ad App IO (404)', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/profiles/')) {
        return { ok: false, status: 404 };
      }
      return { ok: true, json: async () => ({ id: 'ok' }) };
    });

    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('Cittadino non iscritto ad App IO');
  });

  it('lancia errore se il cittadino ha disabilitato il servizio', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/profiles/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sender_allowed: false }),
        };
      }
      return { ok: true, json: async () => ({ id: 'ok' }) };
    });

    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('Messaggi da questo servizio disabilitati dal cittadino su App IO');
  });

  it('send() lancia Error se invio messaggio fallisce', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/profiles/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sender_allowed: true }),
        };
      }
      return { ok: false, status: 429 };
    });

    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('App IO API error: HTTP 429');
  });
});
