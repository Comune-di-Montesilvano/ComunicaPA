import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSearchPaymentsToEnrichmentJobs1785600000000 implements MigrationInterface {
    name = 'AddSearchPaymentsToEnrichmentJobs1785600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "search_payments" boolean NOT NULL DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "search_payments"`);
    }
}
