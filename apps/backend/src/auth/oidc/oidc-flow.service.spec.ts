import { BadGatewayException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OidcFlowService } from './oidc-flow.service';

const redisMock = {
  set: jest.fn(),
  getdel: jest.fn(),
  quit: jest.fn(async () => 'OK'),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

describe('OidcFlowService', () => {
  const values = new Map<string, string>([
    ['oidc.issuer', 'https://sso.ente.it'],
    ['oidc.clientId', 'client-abc'],
    ['oidc.clientSecret', ''],
    ['system.citizenPublicUrl', 'https://comunicapa.ente.it'],
  ]);
  const settingsMock = { get: jest.fn(async (k: string) => values.get(k) ?? '') };
  const configMock = { get: jest.fn(() => 'redis://redis:6379') };
  let service: OidcFlowService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    values.set('oidc.issuer', 'https://sso.ente.it');
    values.set('oidc.clientId', 'client-abc');
    values.set('oidc.clientSecret', '');
    values.set('system.citizenPublicUrl', 'https://comunicapa.ente.it');
    service = new OidcFlowService(settingsMock as never, configMock as never);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function mockDiscoveryOk(): void {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: 'https://sso.ente.it/oidc/auth',
        token_endpoint: 'https://sso.ente.it/oidc/token',
      }),
    } as never);
  }

  it('buildAuthorizationUrl: usa la discovery, salva lo state e compone i parametri PKCE', async () => {
    mockDiscoveryOk();
    const url = new URL(await service.buildAuthorizationUrl());

    expect(url.origin + url.pathname).toBe('https://sso.ente.it/oidc/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://comunicapa.ente.it/oidc/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    const state = url.searchParams.get('state');
    expect(redisMock.set).toHaveBeenCalledWith(
      `oidc:state:${state}`,
      expect.any(String),
      'EX',
      300,
    );
  });

  it('buildAuthorizationUrl: discovery assente → fallback /authorize', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as never);
    const url = new URL(await service.buildAuthorizationUrl());
    expect(url.pathname).toBe('/authorize');
  });

  it('buildAuthorizationUrl: 503 senza issuer/clientId', async () => {
    values.set('oidc.issuer', '');
    await expect(service.buildAuthorizationUrl()).rejects.toThrow(ServiceUnavailableException);
  });

  it('buildAuthorizationUrl: 503 senza CITIZEN_ORIGIN', async () => {
    values.set('system.citizenPublicUrl', '');
    await expect(service.buildAuthorizationUrl()).rejects.toThrow(ServiceUnavailableException);
  });

  it('exchangeCode: consuma lo state e restituisce id_token', async () => {
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id_token: 'jwt.id.token', access_token: 'jwt.access' }),
    } as never);

    const result = await service.exchangeCode('code-1', 'state-1');
    expect(result).toEqual({
      access_token: 'jwt.id.token',
      claims: {
        cf: '',
        name: '',
        provider: 'Identità Digitale',
      },
    });
    expect(redisMock.getdel).toHaveBeenCalledWith('oidc:state:state-1');

    const tokenCall = fetchMock.mock.calls[1];
    expect(tokenCall[0]).toBe('https://sso.ente.it/oidc/token');
    const body = tokenCall[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('verifier-123');
    expect(body.get('client_secret')).toBeNull();
  });

  it('exchangeCode: client_secret_basic quando il secret è configurato', async () => {
    values.set('oidc.clientSecret', 's3gr3t0');
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id_token: 'jwt.id.token' }),
    } as never);

    await service.exchangeCode('code-1', 'state-1');
    const [, options] = fetchMock.mock.calls[1];
    const body = options.body as URLSearchParams;
    // Secret nell'header Basic (unico metodo che tutti i provider devono supportare), mai nel body
    expect(body.get('client_secret')).toBeNull();
    const expected = Buffer.from('client-abc:s3gr3t0').toString('base64');
    expect(options.headers['Authorization']).toBe(`Basic ${expected}`);
  });

  it('exchangeCode: 401 con state sconosciuto/scaduto', async () => {
    redisMock.getdel.mockResolvedValueOnce(null);
    await expect(service.exchangeCode('code-1', 'state-x')).rejects.toThrow(UnauthorizedException);
  });

  it('exchangeCode: 502 quando il token endpoint fallisce', async () => {
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as never);

    await expect(service.exchangeCode('code-1', 'state-1')).rejects.toThrow(BadGatewayException);
  });
});
