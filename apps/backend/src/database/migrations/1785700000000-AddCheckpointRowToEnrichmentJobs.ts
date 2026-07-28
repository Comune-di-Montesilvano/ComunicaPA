import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCheckpointRowToEnrichmentJobs1785700000000 implements MigrationInterface {
    name = 'AddCheckpointRowToEnrichmentJobs1785700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "checkpoint_row" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "checkpoint_row"`);
    }
}
