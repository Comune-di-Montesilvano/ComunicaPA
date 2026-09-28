import { buildRequestContext } from './sentry-request-context.js';

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('buildRequestContext', () => {
  it('riporta metodo e rotta come pattern, mai l’URL reale', () => {
    const ctx = buildRequestContext({
      method: 'GET',
      route: { path: '/admin/campaigns/:id' },
      originalUrl: `/admin/campaigns/${UUID}?q=RSSMRA80A01H501U`,
      params: { id: UUID },
    });
    expect(ctx).toMatchObject({ method: 'GET', route: '/admin/campaigns/:id', params: { id: UUID } });
    expect(JSON.stringify(ctx)).not.toContain('RSSMRA');
  });

  it('tiene solo parametri di path non identificativi (UUID, interi, token brevi)', () => {
    const ctx = buildRequestContext({
      method: 'GET',
      route: { path: '/x/:id/:index/:channel/:pdfFilename/:cf' },
      params: { id: UUID, index: '3', channel: 'SEND', pdfFilename: 'avviso-rossi-mario.pdf', cf: 'RSSMRA80A01H501U' },
    });
    expect(ctx?.params).toEqual({ id: UUID, index: '3', channel: 'SEND', pdfFilename: '[filtrato]', cf: '[filtrato]' });
  });

  it('operatore: username e ruolo', () => {
    const ctx = buildRequestContext({
      method: 'POST',
      route: { path: '/admin/campaigns' },
      user: { type: 'operator', username: 'mrossi', role: 'admin', displayName: 'Mario Rossi' },
    });
    expect(ctx?.actor).toEqual({ type: 'operator', username: 'mrossi', role: 'admin' });
  });

  it('cittadino: solo tipo di accesso, mai CF/email/nome', () => {
    const ctx = buildRequestContext({
      method: 'GET',
      route: { path: '/citizen/notifications' },
      user: { sub: 'abc', codiceFiscale: 'RSSMRA80A01H501U', email: 'm@x.it', name: 'Mario Rossi', accessType: 'PF' },
    });
    expect(ctx?.actor).toEqual({ type: 'citizen', accessType: 'PF' });
    expect(JSON.stringify(ctx)).not.toMatch(/RSSMRA|m@x\.it|Mario/);
  });

  it('client API esterna: id e nome del client', () => {
    const client = { id: UUID, name: 'Gestionale Tributi', apiKeyHash: 'segreto' };
    const ctx = buildRequestContext({
      method: 'POST',
      route: { path: '/external/v1/notifications' },
      apiClient: client,
    });
    expect(ctx?.actor).toEqual({ type: 'api-client', id: UUID, name: 'Gestionale Tributi' });
    expect(JSON.stringify(ctx)).not.toContain('segreto');
  });

  it('richiesta anonima o senza rotta risolta', () => {
    const ctx = buildRequestContext({ method: 'GET' });
    expect(ctx).toEqual({ method: 'GET', route: undefined, params: {}, actor: { type: 'anonymous' } });
  });

  it('request assente (contesto non HTTP) → undefined', () => {
    expect(buildRequestContext(undefined)).toBeUndefined();
  });
});
