import { vi } from 'vitest';
import { createHash } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { OidcCitizenStrategy } from './oidc-citizen.strategy.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'jwt.secret': 'jwt-test-secret',
    };
    return cfg[key];
  },
};

// vitest 5: una const top-level referenziata dentro una factory vi.mock()
// va dichiarata con vi.hoisted(), altrimenti la factory (hoistata sopra gli
// import) la vede ancora in TDZ — vedi migration guide vitest 5.
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
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

const reqWith = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;

describe('OidcCitizenStrategy', () => {
  let strategy: OidcCitizenStrategy;
  let settingsValues: Record<string, unknown>;

  const buildStrategy = async () => {
    const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
    const module = await Test.createTestingModule({
      providers: [
        OidcCitizenStrategy,
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();

    return module.get(OidcCitizenStrategy);
  };

  it('validate() lancia UnauthorizedException se issuer non corrisponde', async () => {
    settingsValues = { 'oidc.issuer': 'https://issuer.test', 'oidc.audience': '' };
    strategy = await buildStrategy();

    await expect(
      strategy.validate(reqWith('tok'), { iss: 'https://altro-issuer.test', sub: 'user-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('validate() accetta issuer configurato con trailing slash (bug reale: confronto stringa esatta lo rifiutava sempre)', async () => {
    settingsValues = { 'oidc.issuer': 'https://issuer.test/', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), { iss: 'https://issuer.test', sub: 'user-1' });

    expect(claims.sub).toBe('user-1');
  });

  it('validate() con oidc.audience vuoto non verifica aud e accetta token senza claim aud (regressione mock SPID)', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-mock-spid',
      fiscal_number: 'RSSMRA85M01H501Z',
    });

    expect(claims.sub).toBe('user-mock-spid');
    expect(claims.codiceFiscale).toBe('RSSMRA85M01H501Z');
  });

  it('validate() con oidc.audience vuoto accetta anche un claim aud che non corrisponderebbe a nulla', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-mock-spid-2',
      aud: 'qualcosa-che-non-combacia',
      fiscal_number: 'RSSMRA85M01H501Z',
    });

    expect(claims.sub).toBe('user-mock-spid-2');
  });

  it('validate() lancia UnauthorizedException se oidc.audience è impostato e non corrisponde', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': 'comunicapa' };
    strategy = await buildStrategy();

    await expect(
      strategy.validate(reqWith('tok'), { sub: 'user-1', aud: 'altra-app' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('validate() accetta audience array contenente il valore atteso', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': 'comunicapa' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-1',
      aud: ['altra-app', 'comunicapa'],
      fiscal_number: 'rssmra85m01h501z',
    });

    expect(claims.sub).toBe('user-1');
    expect(claims.codiceFiscale).toBe('RSSMRA85M01H501Z');
  });

  it('validate() strippa il prefisso TINIT- e compone il nome da given/family (pa-sso-proxy)', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-3',
      fiscal_number: 'TINIT-RSSMRA85M01H501Z',
      given_name: 'Mario',
      family_name: 'Rossi',
      email: 'mario@example.com',
    });

    expect(claims.codiceFiscale).toBe('RSSMRA85M01H501Z');
    expect(claims.name).toBe('Mario Rossi');
  });

  it('validate() legge il claim URI eIDAS quando fiscal_number manca', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-4',
      'https://attributes.eid.gov.it/fiscal_number': 'TINIT-VRDLGI70A01H501Q',
    });

    expect(claims.codiceFiscale).toBe('VRDLGI70A01H501Q');
  });

  it('validate() legge il claim URI SPID quando fiscal_number manca', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-5',
      'https://attributes.spid.gov.it/fiscalNumber': 'TINIT-RSSMRA85M01H501Z',
    });

    expect(claims.codiceFiscale).toBe('RSSMRA85M01H501Z');
  });

  it('validate() con issuer e audience non impostati mappa i claim normalmente', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-2',
      email: 'user@example.com',
      name: 'Mario Rossi',
      codice_fiscale: 'rssmra85m01h501z',
    });

    expect(claims).toEqual({
      sub: 'user-2',
      codiceFiscale: 'RSSMRA85M01H501Z',
      email: 'user@example.com',
      name: 'Mario Rossi',
      accessType: 'PF',
    });
  });

  it('validate() legge i claims da Redis se presenti', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    redisMock.get.mockResolvedValueOnce(
      JSON.stringify({
        codiceFiscale: 'MOCKEDCF12345678',
        name: 'John Doe cached',
        provider: 'eIDAS',
      }),
    );

    const claims = await strategy.validate(reqWith('tok'), {
      sub: 'user-cached',
    });

    expect(redisMock.get).toHaveBeenCalledWith('oidc:claims:user-cached');
    expect(claims.codiceFiscale).toBe('MOCKEDCF12345678');
    expect(claims.name).toBe('John Doe cached');
  });

  // ─── Contesto di sessione legato al token (accesso cittadino / impresa) ───

  describe('con JWKS configurato (token reali del proxy)', () => {
    const token = 'header.payload.firma';
    const sessionKey = `oidc:session:${createHash('sha256').update(token).digest('hex')}`;

    beforeEach(async () => {
      redisMock.get.mockReset();
      settingsValues = { 'oidc.issuer': '', 'oidc.audience': '', 'oidc.jwksUri': 'https://sso.ente.it/OIDC/jwks' };
      strategy = await buildStrategy();
    });

    it('sessione impresa: P.IVA e ragione sociale dal contesto Redis del token, mai dai claim del token', async () => {
      redisMock.get.mockImplementation(async (k: string) => (k === sessionKey
        ? JSON.stringify({ accessType: 'PG', codiceFiscale: 'RSSMRA85M01H501Z', name: 'Mario Rossi', provider: 'SPID', ivaCode: '01234567890', companyName: 'ACME SRL', registeredOffice: 'Via Roma 1' })
        : null));

      const claims = await strategy.validate(reqWith(token), { sub: 'persona-1', iva_code: '99999999999', company_name: 'ALTRA SRL' });

      expect(claims).toMatchObject({ sub: 'persona-1', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PG', ivaCode: '01234567890', companyName: 'ACME SRL' });
    });

    it('sessione cittadino: nessun dato aziendale anche se il token ne contiene', async () => {
      redisMock.get.mockImplementation(async (k: string) => (k === sessionKey
        ? JSON.stringify({ accessType: 'PF', codiceFiscale: 'RSSMRA85M01H501Z', name: 'Mario Rossi', provider: 'SPID' })
        : null));

      const claims = await strategy.validate(reqWith(token), { sub: 'persona-1', iva_code: '01234567890' });

      expect(claims.accessType).toBe('PF');
      expect(claims.ivaCode).toBeUndefined();
    });

    it('stessa persona, due token (cittadino e impresa): contesti separati, nessuna sovrapposizione', async () => {
      const tokenPg = 'altro.token.pg';
      const keyPg = `oidc:session:${createHash('sha256').update(tokenPg).digest('hex')}`;
      redisMock.get.mockImplementation(async (k: string) => {
        if (k === sessionKey) return JSON.stringify({ accessType: 'PF', codiceFiscale: 'RSSMRA85M01H501Z', name: 'M', provider: 'SPID' });
        if (k === keyPg) return JSON.stringify({ accessType: 'PG', codiceFiscale: 'RSSMRA85M01H501Z', name: 'M', provider: 'SPID', ivaCode: '01234567890', companyName: 'ACME SRL', registeredOffice: 'Via Roma 1' });
        return null;
      });

      expect((await strategy.validate(reqWith(token), { sub: 'persona-1' })).accessType).toBe('PF');
      expect((await strategy.validate(reqWith(tokenPg), { sub: 'persona-1' })).accessType).toBe('PG');
    });

    it('contesto perso (Redis svuotato): token rifiutato, nuovo login obbligatorio', async () => {
      redisMock.get.mockResolvedValue(null);

      await expect(strategy.validate(reqWith(token), { sub: 'persona-1', fiscal_number: 'TINIT-RSSMRA85M01H501Z' }))
        .rejects.toThrow(UnauthorizedException);
    });

    it('token emesso prima di questa versione (solo cache legacy oidc:claims:<sub>): accettato come cittadino', async () => {
      redisMock.get.mockImplementation(async (k: string) => (k === 'oidc:claims:persona-1'
        ? JSON.stringify({ codiceFiscale: 'RSSMRA85M01H501Z', name: 'Mario Rossi', provider: 'SPID' })
        : null));

      const claims = await strategy.validate(reqWith(token), { sub: 'persona-1' });

      expect(claims).toMatchObject({ codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PF' });
      expect(claims.ivaCode).toBeUndefined();
    });
  });

  it('senza JWKS (simulatore dev, token firmato dal backend): i dati impresa arrivano dal token stesso', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate(reqWith('dev.token'), {
      sub: 'RSSMRA85M01H501Z', codiceFiscale: 'RSSMRA85M01H501Z',
      accessType: 'PG', ivaCode: '01234567890', companyName: 'ACME SRL', registeredOffice: 'Via Roma 1',
    });

    expect(claims).toMatchObject({ accessType: 'PG', ivaCode: '01234567890', companyName: 'ACME SRL' });
  });
});
