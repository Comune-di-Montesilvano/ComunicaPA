import { MigrationInterface, QueryRunner } from "typeorm";

// Correzioni indirizzo orfane a vita: nessuna cascade esisteva, deleteJob()/
// retention/createCampaignFromJob() eliminano il job e i suoi file ma mai le
// righe in enrichment_address_overrides — vedi review finale whole-branch.
export class AddEnrichmentAddressOverridesJobFk1785900000000 implements MigrationInterface {
    name = 'AddEnrichmentAddressOverridesJobFk1785900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "enrichment_address_overrides"
            ADD CONSTRAINT "FK_enrichment_address_overrides_job_id"
            FOREIGN KEY ("job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP CONSTRAINT "FK_enrichment_address_overrides_job_id"`);
    }
}
