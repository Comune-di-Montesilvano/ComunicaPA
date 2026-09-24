import { vi } from 'vitest';
import { createHash } from 'crypto';
import { BadGatewayException, BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OidcFlowService } from './oidc-flow.service.js';

// vitest 5: una const top-level referenziata dentro una factory vi.mock()
// va dichiarata con vi.hoisted(), altrimenti la factory (hoistata sopra gli
// import) la vede ancora in TDZ — vedi migration guide vitest 5.
const redisMock = vi.hoisted(() => ({
  set: vi.fn(),
  getdel: vi.fn(),
  quit: vi.fn(async () => 'OK'),
}));

vi.mock('ioredis', () => {
  // vitest 5: il mock ora fa Reflect.construct() sull'implementation quando
  // chiamato con `new` (per incatenare il prototype) — richiede una funzione
  // costruibile, mai una arrow function (non ha [[Construct]]).
  const RedisMock = vi.fn().mockImplementation(function RedisCtor() {
    return redisMock;
  });
  return {
    __esModule: true,
    default: RedisMock,
    Redis: RedisMock,
  };
});

describe('OidcFlowService', () => {
  const values = new Map<string, unknown>([
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
    values.delete('oidc.legalEntityEnabled');
    values.delete('oidc.legalEntityScope');
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
    const { url: urlStr, state: returnedState } = await service.buildAuthorizationUrl();
    const url = new URL(urlStr);

    expect(url.origin + url.pathname).toBe('https://sso.ente.it/oidc/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://comunicapa.ente.it/oidc/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    const state = url.searchParams.get('state');
    expect(state).toBe(returnedState);
    expect(redisMock.set).toHaveBeenCalledWith(
      `oidc:state:${state}`,
      expect.any(String),
      'EX',
      300,
    );
  });

  it('buildAuthorizationUrl: discovery assente → fallback /authorize', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as never);
    const { url: urlStr } = await service.buildAuthorizationUrl();
    const url = new URL(urlStr);
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

  it('exchangeCode: consuma lo state e restituisce id_token se il cookie state corrisponde', async () => {
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id_token: 'jwt.id.token', access_token: 'jwt.access' }),
    } as never);

    const result = await service.exchangeCode('code-1', 'state-1', 'state-1');
    expect(result).toEqual({
      access_token: 'jwt.id.token',
      claims: {
        cf: '',
        name: '',
        provider: 'Identità Digitale',
        accessType: 'PF',
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

  it('exchangeCode: 401 per CSRF se il cookie state è mancante o non corrisponde', async () => {
    await expect(service.exchangeCode('code-1', 'state-1', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.exchangeCode('code-1', 'state-1', 'different-state')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('exchangeCode: client_secret_basic quando il secret è configurato', async () => {
    values.set('oidc.clientSecret', 's3gr3t0');
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id_token: 'jwt.id.token' }),
    } as never);

    await service.exchangeCode('code-1', 'state-1', 'state-1');
    const [, options] = fetchMock.mock.calls[1];
    const body = options.body as URLSearchParams;
    // Secret nell'header Basic (unico metodo che tutti i provider devono supportare), mai nel body
    expect(body.get('client_secret')).toBeNull();
    const expected = Buffer.from('client-abc:s3gr3t0').toString('base64');
    expect(options.headers['Authorization']).toBe(`Basic ${expected}`);
  });

  it('exchangeCode: 401 con state sconosciuto/scaduto', async () => {
    redisMock.getdel.mockResolvedValueOnce(null);
    await expect(service.exchangeCode('code-1', 'state-x', 'state-x')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('exchangeCode: 502 quando il token endpoint fallisce', async () => {
    redisMock.getdel.mockResolvedValueOnce('verifier-123');
    mockDiscoveryOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as never);

    await expect(service.exchangeCode('code-1', 'state-1', 'state-1')).rejects.toThrow(
      BadGatewayException,
    );
  });

  // ─── Accesso per conto di impresa (SPID persona giuridica, scope legal_entity) ───

  function fakeIdToken(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256' })}.${b64(payload)}.firma`;
  }

  function mockTokenAndUserinfo(idTokenPayload: Record<string, unknown>, userinfo: Record<string, unknown>): string {
    const idToken = fakeIdToken(idTokenPayload);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id_token: idToken, access_token: 'opaque-access' }) } as never);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => userinfo } as never);
    return idToken;
  }

  const sessionKeyOf = (token: string) => `oidc:session:${createHash('sha256').update(token).digest('hex')}`;

  it('buildAuthorizationUrl PF: scope invariato e tipo di accesso salvato con lo state', async () => {
    mockDiscoveryOk();
    const { url } = await service.buildAuthorizationUrl('PF');

    expect(new URL(url).searchParams.get('scope')).toBe('openid profile email');
    const stored = JSON.parse(redisMock.set.mock.calls[0][1]);
    expect(stored.accessType).toBe('PF');
    expect(stored.verifier).toEqual(expect.any(String));
  });

  it('buildAuthorizationUrl PG: aggiunge lo scope legal_entity solo nel flusso impresa', async () => {
    values.set('oidc.legalEntityEnabled', true as never);
    values.set('oidc.legalEntityScope', 'legal_entity');
    mockDiscoveryOk();
    const { url } = await service.buildAuthorizationUrl('PG');

    expect(new URL(url).searchParams.get('scope')).toBe('openid profile email legal_entity');
    expect(JSON.parse(redisMock.set.mock.calls[0][1]).accessType).toBe('PG');
  });

  it('buildAuthorizationUrl PG: rifiutato se la funzione è disattivata nelle impostazioni', async () => {
    values.set('oidc.legalEntityEnabled', false as never);
    await expect(service.buildAuthorizationUrl('PG')).rejects.toThrow(BadRequestException);
  });

  it('exchangeCode PG con claim aziendali: sessione impresa con P.IVA e CF normalizzati, legata al token', async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ verifier: 'v-1', accessType: 'PG' }));
    mockDiscoveryOk();
    const token = mockTokenAndUserinfo(
      { sub: 'persona-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      {
        fiscal_number: 'TINIT-RSSMRA85M01H501Z', given_name: 'Mario', family_name: 'Rossi',
        company_name: 'ACME SRL', iva_code: 'VATIT-01234567890', registered_office: 'Via Roma 1, 65015 Montesilvano',
      },
    );

    const result = await service.exchangeCode('code-1', 'state-1', 'state-1');

    expect(result).toEqual({
      access_token: token,
      claims: {
        cf: 'RSSMRA85M01H501Z', name: 'Mario Rossi', provider: 'Identità Digitale',
        accessType: 'PG', ivaCode: '01234567890', companyName: 'ACME SRL', registeredOffice: 'Via Roma 1, 65015 Montesilvano',
      },
    });
    const sessionCall = redisMock.set.mock.calls.find((c: unknown[]) => c[0] === sessionKeyOf(token));
    expect(sessionCall).toBeDefined();
    expect(JSON.parse(sessionCall![1])).toMatchObject({ accessType: 'PG', codiceFiscale: 'RSSMRA85M01H501Z', ivaCode: '01234567890' });
    // Mai più il contesto indicizzato per persona: si mescolerebbe con una sessione PF della stessa persona.
    expect(redisMock.set.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('oidc:claims:'))).toBe(false);
  });

  it('exchangeCode PG senza claim aziendali (es. passato da CIE): nessuna sessione impresa, esito legal_entity_required', async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ verifier: 'v-1', accessType: 'PG' }));
    mockDiscoveryOk();
    mockTokenAndUserinfo({ sub: 'persona-1' }, { fiscal_number: 'TINIT-RSSMRA85M01H501Z' });

    const result = await service.exchangeCode('code-1', 'state-1', 'state-1');

    expect(result).toEqual({ error: 'legal_entity_required', message: expect.stringContaining('SPID') });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('exchangeCode PF: eventuali claim aziendali ricevuti vengono ignorati', async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ verifier: 'v-1', accessType: 'PF' }));
    mockDiscoveryOk();
    const token = mockTokenAndUserinfo(
      { sub: 'persona-1' },
      { fiscal_number: 'TINIT-RSSMRA85M01H501Z', company_name: 'ACME SRL', iva_code: 'VATIT-01234567890' },
    );

    const result = await service.exchangeCode('code-1', 'state-1', 'state-1');

    expect(result).toEqual({ access_token: token, claims: { cf: 'RSSMRA85M01H501Z', name: '', provider: 'Identità Digitale', accessType: 'PF' } });
    const sessionCall = redisMock.set.mock.calls.find((c: unknown[]) => c[0] === sessionKeyOf(token));
    expect(JSON.parse(sessionCall![1])).toEqual({ accessType: 'PF', codiceFiscale: 'RSSMRA85M01H501Z', name: '', provider: 'Identità Digitale' });
  });

  it('exchangeCode: il tipo di accesso viene dallo state salvato (state legacy senza tipo = PF), mai dalla richiesta', async () => {
    redisMock.getdel.mockResolvedValueOnce('verifier-legacy');
    mockDiscoveryOk();
    mockTokenAndUserinfo({ sub: 'persona-1' }, { fiscal_number: 'RSSMRA85M01H501Z', company_name: 'ACME SRL', iva_code: '01234567890' });

    const result = await service.exchangeCode('code-1', 'state-1', 'state-1');

    expect('claims' in result && result.claims?.accessType).toBe('PF');
    expect(fetchMock.mock.calls[1][1].body.get('code_verifier')).toBe('verifier-legacy');
  });

  it('resolveProviderError: errore del proxy su un flusso impresa → legal_entity_required, cittadino → provider_error', async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ verifier: 'v', accessType: 'PG' }));
    await expect(service.resolveProviderError('state-1', 'state-1', 'access_denied')).resolves.toEqual({
      error: 'legal_entity_required', message: expect.stringContaining('SPID'),
    });

    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ verifier: 'v', accessType: 'PF' }));
    await expect(service.resolveProviderError('state-2', 'state-2', 'access_denied')).resolves.toEqual({
      error: 'provider_error', message: expect.stringContaining('access_denied'),
    });

    await expect(service.resolveProviderError('state-3', 'altro', 'access_denied')).rejects.toThrow(UnauthorizedException);
  });
});
