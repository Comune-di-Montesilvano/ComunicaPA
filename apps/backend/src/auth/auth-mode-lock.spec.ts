import { AUTH_REAL_SEEN_KEY, AuthModeLockError, enforceAuthModeLock } from './auth-mode-lock.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { isSettingKey } from '../settings/settings.registry.js';

function makeRepo(initial: Record<string, unknown> = {}) {
  const rows = new Map<string, { key: string; value: unknown }>(
    Object.entries(initial).map(([key, value]) => [key, { key, value }]),
  );
  const inserted: Array<Record<string, unknown>> = [];
  const qb = {
    insert: () => qb,
    into: () => qb,
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return qb;
    },
    orIgnore: () => qb,
    execute: async () => {
      const v = inserted[inserted.length - 1]!;
      const key = String(v['key']);
      if (!rows.has(key)) rows.set(key, { key, value: v['value'] });
      return {};
    },
  };
  const repo = {
    findOneBy: jest.fn(async ({ key }: { key: string }) => rows.get(key) ?? null),
    createQueryBuilder: jest.fn(() => qb),
  };
  return { repo, rows, inserted };
}

describe('enforceAuthModeLock', () => {
  const now = new Date('2026-11-14T08:00:00.000Z');

  it('mock senza marker: avvio consentito, nessuna scrittura', async () => {
    const { repo, rows } = makeRepo();
    await expect(enforceAuthModeLock('mock', repo as never, now)).resolves.toBe('mock');
    expect(rows.has(AUTH_REAL_SEEN_KEY)).toBe(false);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('mock con marker presente: avvio rifiutato con istruzioni', async () => {
    const { repo } = makeRepo({ [AUTH_REAL_SEEN_KEY]: '2026-01-01T00:00:00.000Z' });
    const err = await enforceAuthModeLock('mock', repo as never, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthModeLockError);
    const msg = (err as Error).message;
    expect(msg).toContain('LDAP_HOST=mock');
    expect(msg).toContain(AUTH_REAL_SEEN_KEY);
    expect(msg).toContain('app_settings');
  });

  it('mock con errore DB in lettura: avvio rifiutato (fail closed)', async () => {
    const { repo } = makeRepo();
    repo.findOneBy.mockRejectedValueOnce(new Error('connection refused'));
    await expect(enforceAuthModeLock('mock', repo as never, now)).rejects.toBeInstanceOf(AuthModeLockError);
  });

  it('LDAP reale senza marker: scrive il marker con il timestamp ISO', async () => {
    const { repo, rows, inserted } = makeRepo();
    await expect(enforceAuthModeLock('ldap://ad.ente.it:389', repo as never, now)).resolves.toBe('real');
    expect(rows.get(AUTH_REAL_SEEN_KEY)?.value).toBe('2026-11-14T08:00:00.000Z');
    expect(inserted[0]).toMatchObject({ key: AUTH_REAL_SEEN_KEY, encrypted: false });
  });

  it('LDAP reale con marker già presente: non sovrascrive', async () => {
    const { repo, rows } = makeRepo({ [AUTH_REAL_SEEN_KEY]: '2026-01-01T00:00:00.000Z' });
    await enforceAuthModeLock('ldap://ad.ente.it:389', repo as never, now);
    expect(rows.get(AUTH_REAL_SEEN_KEY)?.value).toBe('2026-01-01T00:00:00.000Z');
  });

  it('LDAP_HOST vuoto conta come avvio reale (non è la modalità mock)', async () => {
    const { repo, rows } = makeRepo();
    await expect(enforceAuthModeLock('', repo as never, now)).resolves.toBe('real');
    expect(rows.has(AUTH_REAL_SEEN_KEY)).toBe(true);
  });
});

describe('marker non esposto dalle Impostazioni', () => {
  it('non è una chiave del registry', () => {
    expect(isSettingKey(AUTH_REAL_SEEN_KEY)).toBe(false);
  });

  it('GET (getAllMasked) non lo restituisce e PUT (setMany) lo rifiuta', async () => {
    const repo = {
      findOneBy: jest.fn(async ({ key }: { key: string }) =>
        key === AUTH_REAL_SEEN_KEY ? { key, value: '2026-01-01T00:00:00.000Z', encrypted: false } : null,
      ),
      save: jest.fn(),
    };
    const service = new AppSettingsService(repo as never, { get: () => 'test-jwt-secret' } as never);
    const all = await service.getAllMasked();
    expect(Object.keys(all)).not.toContain(AUTH_REAL_SEEN_KEY);
    await expect(service.setMany({ [AUTH_REAL_SEEN_KEY]: 'x' }, 'admin')).rejects.toThrow(/Chiave sconosciuta/);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
