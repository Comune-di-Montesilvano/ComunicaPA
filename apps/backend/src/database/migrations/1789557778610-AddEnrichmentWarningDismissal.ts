import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEnrichmentWarningDismissal1789557778610 implements MigrationInterface {
    name = 'AddEnrichmentWarningDismissal1789557778610'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ADD "dismissed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ADD "dismissed_by" character varying(256)`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ADD "dismissed_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ALTER COLUMN "corrected_by" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ALTER COLUMN "corrected_by" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP COLUMN "dismissed_at"`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP COLUMN "dismissed_by"`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP COLUMN "dismissed"`);
    }
}
