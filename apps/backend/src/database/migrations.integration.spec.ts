import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { createTempDatabase } from '../../vitest.global-setup.js';
import { ENTITIES, MIGRATIONS } from './schema.list.js';

/**
 * Scarto congelato tra lo schema prodotto dalle migration e quello che
 * TypeORM ricaverebbe dalle entity (`createSchemaBuilder().log().upQueries`),
 * misurato su un DB nuovo migrato da zero. Una differenza nuova (entity
 * cambiata senza migration o viceversa) rende rosso il test; una voce che
 * sparisce anche: va tolta da qui. Gli indici creati solo dalle migration
 * (AddCampaignGroupId, AddRecipientAndAttemptIndexes, ...) hanno ora l'@Index
 * con lo stesso nome nell'entity (quello DESC con `synchronize: false`) e non
 * compaiono più. Le voci rimaste sono "richiede migration: non allineato":
 * allinearle cambierebbe nomi di vincoli/indici o aggiungerebbe relazioni.
 */
// Schema delle migration ed entity allineati: nessuno scarto ammesso. FK e indici
// creati dalle migration con nome esplicito vanno dichiarati con lo stesso nome
// nell'entity (`@JoinColumn({ foreignKeyConstraintName })`, `@Index('<nome>')`).
const KNOWN_DRIFT: string[] = [];

const normalize = (queries: string[]): string[] =>
  queries.map((q) => q.trim().replace(/\s+/g, ' ')).sort();

const lastMigration = MIGRATIONS.at(-1) as unknown as { name: string; irreversible?: boolean };
const lastIrreversible = lastMigration.irreversible === true;

/**
 * DB temporaneo `migr_<random>` creato e droppato dal test: mai il DB di
 * DATABASE_URL (in dev è quello di synchronize, in CI quello già migrato
 * dal globalSetup). I test girano in ordine e condividono lo stesso DB.
 */
describe.skipIf(!process.env.DATABASE_URL)('migration su Postgres da zero', () => {
  let db: Awaited<ReturnType<typeof createTempDatabase>> | undefined;
  let ds: DataSource | undefined;

  const drift = async (): Promise<string[]> =>
    normalize((await ds!.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query));

  beforeAll(async () => {
    db = await createTempDatabase(process.env.DATABASE_URL!, 'migr');
    ds = await new DataSource({
      type: 'postgres',
      url: db.url,
      entities: ENTITIES,
      migrations: MIGRATIONS,
      migrationsRun: false,
      synchronize: false,
    }).initialize();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
    await db?.drop();
  }, 60000);

  it('tutte le migration girano da zero', async () => {
    expect(await ds!.runMigrations()).toHaveLength(MIGRATIONS.length);
  }, 120000);

  it('lo scarto schema/entity coincide con KNOWN_DRIFT', async () => {
    expect(await drift()).toEqual(normalize(KNOWN_DRIFT));
  }, 60000);

  // Le migration con down() no-op o che non ripristina lo schema
  // (ALTER TYPE … ADD VALUE, tabelle droppate) sono marcate
  // `static readonly irreversible = true`: se è l'ultima, niente rollback.
  it.skipIf(lastIrreversible)(
    lastIrreversible
      ? `l'ultima migration è reversibile (saltato: ${lastMigration.name} è irreversible)`
      : "l'ultima migration è reversibile",
    async () => {
      await ds!.undoLastMigration();
      expect(await ds!.runMigrations()).toHaveLength(1);
      expect(await drift()).toEqual(normalize(KNOWN_DRIFT));
    },
    60000,
  );
});
