import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDomicileVerificationAnpr1791200000000 implements MigrationInterface {
    name = 'AddDomicileVerificationAnpr1791200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "registro_imprese_found_map" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "anpr_id_requested" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "anpr_vita_requested" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "anpr_requests" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "anpr_results" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "anpr_vita_results" jsonb NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "anpr_vita_results"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "anpr_results"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "anpr_requests"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "anpr_vita_requested"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "anpr_id_requested"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "registro_imprese_found_map"`);
    }
}
