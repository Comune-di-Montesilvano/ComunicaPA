import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import setup, { createTempDatabase, migrateTestDatabase } from '../../vitest.global-setup.js';
import { MIGRATIONS } from './schema.list.js';

/**
 * globalSetup Vitest: migra il DB di test solo con TEST_DB_MIGRATE=1 (job CI
 * integration-tests). Il container backend dev ha DATABASE_URL del DB creato
 * da synchronize: eseguirci le migration lo romperebbe.
 */
describe('vitest.global-setup — gate TEST_DB_MIGRATE', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('senza TEST_DB_MIGRATE non tocca il DB', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@db-inesistente:5432/x');
    vi.stubEnv('TEST_DB_MIGRATE', undefined);
    const init = vi.spyOn(DataSource.prototype, 'initialize');
    await setup();
    expect(init).not.toHaveBeenCalled();
  });

  it('con TEST_DB_MIGRATE diverso da "1" non tocca il DB', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@db-inesistente:5432/x');
    vi.stubEnv('TEST_DB_MIGRATE', 'true');
    const init = vi.spyOn(DataSource.prototype, 'initialize');
    await setup();
    expect(init).not.toHaveBeenCalled();
  });

  it('con TEST_DB_MIGRATE=1 ma senza DATABASE_URL non tocca il DB', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('TEST_DB_MIGRATE', '1');
    const init = vi.spyOn(DataSource.prototype, 'initialize');
    await setup();
    expect(init).not.toHaveBeenCalled();
  });

  it('con TEST_DB_MIGRATE=1 e DATABASE_URL migra il DB indicato', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@db-inesistente:5432/x');
    vi.stubEnv('TEST_DB_MIGRATE', '1');
    const init = vi
      .spyOn(DataSource.prototype, 'initialize')
      .mockRejectedValue(new Error('sentinella: connessione non tentata'));
    await expect(setup()).rejects.toThrow('sentinella');
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('migrateTestDatabase su Postgres', () => {
  it('migra un DB vuoto', async () => {
    const db = await createTempDatabase(process.env.DATABASE_URL!, 'gs');
    try {
      expect(await migrateTestDatabase(db.url)).toBe(MIGRATIONS.length);
      expect(await migrateTestDatabase(db.url)).toBe(0);
    } finally {
      await db.drop();
    }
  }, 60000);
});
