import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { PdndAuthService } from './pdnd-auth.service';
import { AppSettingsService } from '../settings/app-settings.service';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'pdnd.test.tokenUrl': 'https://auth.uat.interop.pagopa.it/token.oauth2',
  'pdnd.test.audience': 'auth.uat.interop.pagopa.it/client-assertion',
  'pdnd.test.clientId': 'client-123',
  'pdnd.test.kid': 'kid-abc',
  'pdnd.test.privateKey': privateKey,
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

    const voucher = await service.getVoucher('test', 'purpose-456');
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
    await service.getVoucher('test', 'purpose-456');
    await service.getVoucher('test', 'purpose-456');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('non riusa la cache se cambia il purposeId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'voucher-1', expires_in: 600 })),
    });
    await service.getVoucher('test', 'purpose-456');
    await service.getVoucher('test', 'purpose-other');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('lancia errore leggibile se la configurazione è incompleta', async () => {
    // Ambiente "prod" non ha valori in settingsValues: get() risolve tutto a undefined.
    await expect(service.getVoucher('prod', 'purpose-456')).rejects.toThrow(/Configurazione PDND \(prod\) incompleta/);
  });

  it('lancia errore con dettaglio se PDND risponde con errore HTTP', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_client"}'),
    });
    await expect(service.getVoucher('test', 'purpose-456', true)).rejects.toThrow(/Richiesta voucher PDND fallita: HTTP 400/);
  });

  it('getVoucherWithDigest include il claim digest nella client assertion e nessuna cache', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'voucher-with-digest', expires_in: 600 })),
    });

    const voucher = await service.getVoucherWithDigest('test', 'purpose-456', 'deadbeef');
    expect(voucher).toBe('voucher-with-digest');

    const [, init] = mockFetch.mock.calls[0];
    const params = new URLSearchParams(init.body as string);
    const assertion = params.get('client_assertion')!;
    const decoded = jwt.verify(assertion, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload & {
      digest: { alg: string; value: string };
    };
    expect(decoded.purposeId).toBe('purpose-456');
    expect(decoded.digest).toEqual({ alg: 'SHA256', value: 'deadbeef' });

    // Nessuna cache: due chiamate consecutive rifanno sempre la richiesta.
    await service.getVoucherWithDigest('test', 'purpose-456', 'deadbeef');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('getVoucherWithDigest lancia errore leggibile se la configurazione è incompleta', async () => {
    await expect(service.getVoucherWithDigest('prod', 'purpose-456', 'deadbeef')).rejects.toThrow(
      /Configurazione PDND \(prod\) incompleta/,
    );
  });

  it('signAgidJwt firma un JWS RS256 con iss/sub/aud/jti/kid ed extraClaims', async () => {
    settingsValues['pdnd.test.clientId'] = 'client-123';

    const token = await service.signAgidJwt('test', 'https://api.esempio.it/rest/qualcosa', {
      signed_headers: [{ digest: 'SHA-256=abc' }],
    });

    const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload & {
      signed_headers: Array<{ digest: string }>;
    };
    expect(decoded.iss).toBe('client-123');
    expect(decoded.sub).toBe('client-123');
    expect(decoded.aud).toBe('https://api.esempio.it/rest/qualcosa');
    expect(decoded.jti).toBeDefined();
    expect(decoded.signed_headers).toEqual([{ digest: 'SHA-256=abc' }]);
    expect(jwt.decode(token, { complete: true })?.header.kid).toBe('kid-abc');
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('RS256');
  });

  it('signAgidJwt lancia errore leggibile se la configurazione PDND è incompleta', async () => {
    await expect(service.signAgidJwt('prod', 'https://api.esempio.it/x', {})).rejects.toThrow(
      /Configurazione PDND \(prod\) incompleta/,
    );
  });
});
