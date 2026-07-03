import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { OidcCitizenStrategy } from './oidc-citizen.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'jwt.secret': 'jwt-test-secret',
    };
    return cfg[key];
  },
};

const redisMock = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

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
      strategy.validate({ iss: 'https://altro-issuer.test', sub: 'user-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('validate() accetta audience array contenente il valore atteso', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': 'comunicapa' };
    strategy = await buildStrategy();

    const claims = await strategy.validate({
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

    const claims = await strategy.validate({
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

    const claims = await strategy.validate({
      sub: 'user-4',
      'https://attributes.eid.gov.it/fiscal_number': 'TINIT-VRDLGI70A01H501Q',
    });

    expect(claims.codiceFiscale).toBe('VRDLGI70A01H501Q');
  });

  it('validate() legge il claim URI SPID quando fiscal_number manca', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate({
      sub: 'user-5',
      'https://attributes.spid.gov.it/fiscalNumber': 'TINIT-RSSMRA85M01H501Z',
    });

    expect(claims.codiceFiscale).toBe('RSSMRA85M01H501Z');
  });

  it('validate() con issuer e audience non impostati mappa i claim normalmente', async () => {
    settingsValues = { 'oidc.issuer': '', 'oidc.audience': '' };
    strategy = await buildStrategy();

    const claims = await strategy.validate({
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

    const claims = await strategy.validate({
      sub: 'user-cached',
    });

    expect(redisMock.get).toHaveBeenCalledWith('oidc:claims:user-cached');
    expect(claims.codiceFiscale).toBe('MOCKEDCF12345678');
    expect(claims.name).toBe('John Doe cached');
  });
});
