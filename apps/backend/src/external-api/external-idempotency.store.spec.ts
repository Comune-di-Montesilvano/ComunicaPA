import { ExternalIdempotencyStore, hashRequest } from './external-idempotency.store.js';

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    del: jest.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
}

describe('ExternalIdempotencyStore', () => {
  it('prima richiesta → new; replay dopo complete → stessa risposta', async () => {
    const redis = fakeRedis();
    const store = new ExternalIdempotencyStore(redis as any);
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'new' });
    await store.complete('c1', 'k1', 'h1', { success: true, notificationId: 'n1' });
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'replay', response: { success: true, notificationId: 'n1' } });
  });

  it('stessa chiave con hash diverso → conflict; ancora pending → in_progress', async () => {
    const store = new ExternalIdempotencyStore(fakeRedis() as any);
    await store.begin('c1', 'k1', 'h1');
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'in_progress' });
    expect(await store.begin('c1', 'k1', 'h2')).toEqual({ kind: 'conflict' });
  });

  it('release libera la chiave', async () => {
    const store = new ExternalIdempotencyStore(fakeRedis() as any);
    await store.begin('c1', 'k1', 'h1');
    await store.release('c1', 'k1');
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'new' });
  });

  it('chiavi isolate per client e con TTL 24h, chiave Redis hashata', async () => {
    const redis = fakeRedis();
    const store = new ExternalIdempotencyStore(redis as any);
    await store.begin('c1', 'k1', 'h1');
    expect(await store.begin('c2', 'k1', 'h1')).toEqual({ kind: 'new' });
    const [key, , ex, ttl, nx] = redis.set.mock.calls[0];
    expect(key).toMatch(/^ext:idem:c1:[0-9a-f]{64}$/);
    expect([ex, ttl, nx]).toEqual(['EX', 86400, 'NX']);
  });

  it('hashRequest ignora l\'ordine delle chiavi', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});
