import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ENTITIES, MIGRATIONS } from './src/database/schema.list.js';

/**
 * Esegue tutte le migration (stessa lista dell'app) sul DB indicato e
 * ritorna quante ne ha applicate (0 se lo schema era gia' aggiornato).
 */
export async function migrateTestDatabase(url: string): Promise<number> {
  const ds = await new DataSource({
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsRun: false,
    synchronize: false,
  }).initialize();
  try {
    return (await ds.runMigrations()).length;
  } finally {
    await ds.destroy();
  }
}

/**
 * globalSetup Vitest: porta lo schema del DB di test a quello di produzione
 * prima della suite (job CI integration-tests, Postgres vuoto).
 * Solo con TEST_DB_MIGRATE=1: nel container backend dev DATABASE_URL punta
 * al DB creato da synchronize, e le migration lo romperebbero.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (process.env.TEST_DB_MIGRATE !== '1' || !url) return;
  const applied = await migrateTestDatabase(url);
  console.log(`[global-setup] migration applicate: ${applied}`);
}
