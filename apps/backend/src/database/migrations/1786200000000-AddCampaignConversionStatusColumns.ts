import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignConversionStatusColumns1786200000000 implements MigrationInterface {
    name = 'AddCampaignConversionStatusColumns1786200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."enrichment_jobs_campaign_conversion_status_enum" AS ENUM('pending', 'processing', 'done', 'failed')`);
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "campaign_conversion_status" "public"."enrichment_jobs_campaign_conversion_status_enum"`);
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "campaign_conversion_error" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "campaign_conversion_error"`);
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "campaign_conversion_status"`);
        await queryRunner.query(`DROP TYPE "public"."enrichment_jobs_campaign_conversion_status_enum"`);
    }
}
