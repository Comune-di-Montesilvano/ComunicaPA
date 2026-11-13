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
 * sparisce anche: va tolta da qui. Ridurre lo scarto (`@Index` nelle entity,
 * nomi dei vincoli allineati) è un lavoro separato: qui si misura e basta.
 */
const KNOWN_DRIFT: string[] = [
  // FK create dalle migration con nome esplicito; l'entity non dà nome alla
  // relazione e TypeORM vuole il nome hash generato → DROP + ADD della stessa FK.
  'ALTER TABLE "download_events" DROP CONSTRAINT "FK_download_events_recipient"',
  'ALTER TABLE "download_events" ADD CONSTRAINT "FK_9c7b2e7059fc08596b872789814" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
  'ALTER TABLE "enrichment_address_overrides" DROP CONSTRAINT "FK_enrichment_address_overrides_job_id"',
  'ALTER TABLE "enrichment_address_overrides" ADD CONSTRAINT "FK_a809dc6c634776f632f5d1e0968" FOREIGN KEY ("job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
  'ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_recipient_attempt"',
  'ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_f73d33318403eed8edb732ec318" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
  'ALTER TABLE "postal_poste_tracking" DROP CONSTRAINT "FK_postal_poste_tracking_attempt"',
  'ALTER TABLE "postal_poste_tracking" ADD CONSTRAINT "FK_0575112744a11795753bc5d94c5" FOREIGN KEY ("attempt_id") REFERENCES "notification_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
  // FK self-reference di AddTestCampaignColumns: nell'entity parent_campaign_id
  // è una @Column semplice, senza @ManyToOne → TypeORM la toglierebbe.
  'ALTER TABLE "campaigns" DROP CONSTRAINT "FK_campaigns_parent_campaign_id"',
  // Unique (job_id, pdf_filename): la migration la chiama
  // IDX_enrichment_address_overrides_job_pdf, l'@Index dell'entity è senza
  // nome (enrichment-address-override.entity.ts:12) → DROP + CREATE.
  'DROP INDEX "public"."IDX_enrichment_address_overrides_job_pdf"',
  'CREATE UNIQUE INDEX "IDX_079a6e545481a4788e3ffe25f2" ON "enrichment_address_overrides" ("job_id", "pdf_filename")',
  // Indici dichiarati solo in migration, senza @Index nell'entity: TypeORM li
  // considera estranei e li droppa (in dev con synchronize non esistono).
  'DROP INDEX "public"."IDX_campaigns_group_id"', // AddCampaignGroupId
  'DROP INDEX "public"."IDX_domicile_verification_jobs_created_by"', // AddDomicileVerificationJobOwner
  'DROP INDEX "public"."IDX_signature_verification_jobs_campaign_id"', // CreateSignatureVerificationJobs
  'DROP INDEX "public"."idx_download_events_recipient_id"', // AddDownloadEventsRecipientIdIndex
  // AddRecipientAndAttemptIndexes
  'DROP INDEX "public"."idx_notification_attempts_postal_delivery_status"',
  'DROP INDEX "public"."idx_notification_attempts_postal_status"',
  'DROP INDEX "public"."idx_notification_attempts_recipient_attempt"',
  'DROP INDEX "public"."idx_notification_attempts_recipient_id"',
  'DROP INDEX "public"."idx_notification_attempts_send_status"',
  'DROP INDEX "public"."idx_recipients_campaign_id"',
  'DROP INDEX "public"."idx_recipients_status"',
];

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
