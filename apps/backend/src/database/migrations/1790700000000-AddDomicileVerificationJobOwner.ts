import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDomicileVerificationJobOwner1790700000000 implements MigrationInterface {
    name = 'AddDomicileVerificationJobOwner1790700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Nullable: i job esistenti non hanno un proprietario noto e restano visibili solo agli admin.
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" ADD "created_by" character varying(255)`);
        await queryRunner.query(`CREATE INDEX "IDX_domicile_verification_jobs_created_by" ON "domicile_verification_jobs" ("created_by", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_domicile_verification_jobs_created_by"`);
        await queryRunner.query(`ALTER TABLE "domicile_verification_jobs" DROP COLUMN "created_by"`);
    }
}
