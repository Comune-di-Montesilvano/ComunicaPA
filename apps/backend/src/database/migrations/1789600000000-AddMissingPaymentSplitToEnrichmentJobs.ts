import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissingPaymentSplitToEnrichmentJobs1789600000000 implements MigrationInterface {
    name = 'AddMissingPaymentSplitToEnrichmentJobs1789600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "secondary_campaign_id" uuid`);
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "missing_payment_count" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "missing_payment_count"`);
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "secondary_campaign_id"`);
    }
}
