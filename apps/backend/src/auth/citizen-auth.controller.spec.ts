import { CitizenAuthController } from './citizen-auth.controller.js';

describe('CitizenAuthController — accesso cittadino / per conto di impresa', () => {
  const oidcFlow = {
    buildAuthorizationUrl: jest.fn(async () => ({ url: 'https://sso.ente.it/OIDC/authorization?x=1', state: 'st' })),
    exchangeCode: jest.fn(async () => ({ access_token: 't', claims: { cf: 'X', name: '', provider: 'SPID', accessType: 'PF' } })),
    resolveProviderError: jest.fn(async () => ({ error: 'legal_entity_required', message: 'msg' })),
  };
  const settings = { get: jest.fn(async (k: string) => (k === 'oidc.legalEntityEnabled' ? true : '')) };
  const config = { get: jest.fn(() => 'ldap.ente.it') };
  const controller = new CitizenAuthController({} as never, oidcFlow as never, settings as never, config as never);
  const res = () => ({ cookie: jest.fn(), redirect: jest.fn(), clearCookie: jest.fn() }) as never;
  const reqWithStateCookie = { headers: { cookie: 'oidc_state=st' } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('oidc/start: type=pg avvia il flusso impresa, qualunque altro valore il flusso cittadino', async () => {
    await controller.oidcStart('pg', res());
    expect(oidcFlow.buildAuthorizationUrl).toHaveBeenLastCalledWith('PG');
    await controller.oidcStart(undefined, res());
    expect(oidcFlow.buildAuthorizationUrl).toHaveBeenLastCalledWith('PF');
    await controller.oidcStart('PG-forzato', res());
    expect(oidcFlow.buildAuthorizationUrl).toHaveBeenLastCalledWith('PF');
  });

  it('config espone il flag che mostra il pulsante impresa', async () => {
    await expect(controller.citizenConfig()).resolves.toMatchObject({ legalEntityEnabled: true });
  });

  it('callback con errore del proxy: risolto dallo state salvato, nessuno scambio del code', async () => {
    const result = await controller.oidcCallback(reqWithStateCookie, res(), { state: 'st', error: 'access_denied' });
    expect(oidcFlow.resolveProviderError).toHaveBeenCalledWith('st', 'st', 'access_denied');
    expect(oidcFlow.exchangeCode).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'legal_entity_required', message: 'msg' });
  });

  it('callback normale: scambio del code col cookie state, nessun tipo di accesso passato dal client', async () => {
    await controller.oidcCallback(reqWithStateCookie, res(), { state: 'st', code: 'c1' });
    expect(oidcFlow.exchangeCode).toHaveBeenCalledWith('c1', 'st', 'st');
  });
});
