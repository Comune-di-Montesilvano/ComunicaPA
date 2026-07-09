import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { PdndAuthService } from './pdnd-auth.service';
import { AppSettingsService } from '../../settings/app-settings.service';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.test.pdndTokenUrl': 'https://auth.uat.interop.pagopa.it/token.oauth2',
  'send.test.pdndAudience': 'auth.uat.interop.pagopa.it/client-assertion',
  'send.test.pdndClientId': 'client-123',
  'send.test.pdndKid': 'kid-abc',
  'send.test.pdndPurposeId': 'purpose-456',
  'send.test.pdndPrivateKey': privateKey,
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

describe('PdndAuthService', () => {
  let service: PdndAuthService;

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        PdndAuthService,
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(PdndAuthService);
  });

  it('costruisce un client_assertion RS256 valido e scambia il voucher', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'voucher-xyz', expires_in: 600 })),
    });

    const voucher = await service.getVoucher('test');
    expect(voucher).toBe('voucher-xyz');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://auth.uat.interop.pagopa.it/token.oauth2');
    expect(init.method).toBe('POST');

    const params = new URLSearchParams(init.body as string);
    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

    const assertion = params.get('client_assertion')!;
    const decoded = jwt.verify(assertion, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(decoded.iss).toBe('client-123');
    expect(decoded.sub).toBe('client-123');
    expect(decoded.aud).toBe('auth.uat.interop.pagopa.it/client-assertion');
    expect(decoded.purposeId).toBe('purpose-456');
    expect(jwt.decode(assertion, { complete: true })?.header.kid).toBe('kid-abc');
  });

  it('riusa il voucher in cache finché non scade', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'voucher-1', expires_in: 600 })),
    });
    await service.getVoucher('test');
    await service.getVoucher('test');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('lancia errore leggibile se la configurazione è incompleta', async () => {
    // Ambiente "prod" non ha valori in settingsValues: get() risolve tutto a undefined.
    await expect(service.getVoucher('prod')).rejects.toThrow(/Configurazione SEND \(prod\) incompleta/);
  });

  it('lancia errore con dettaglio se PDND risponde con errore HTTP', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_client"}'),
    });
    await expect(service.getVoucher('test', true)).rejects.toThrow(/Richiesta voucher PDND fallita: HTTP 400/);
  });
});
