import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPivaColumnsToInadVerificationJobs1786800000000 implements MigrationInterface {
    name = 'AddPivaColumnsToInadVerificationJobs1786800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_total" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_done" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_found_count" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_results" jsonb NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_results"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_found_count"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_done"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_total"`);
    }
}
