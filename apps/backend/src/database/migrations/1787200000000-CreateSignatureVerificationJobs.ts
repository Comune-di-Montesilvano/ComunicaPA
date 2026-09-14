import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSignatureVerificationJobs1787200000000 implements MigrationInterface {
    name = 'CreateSignatureVerificationJobs1787200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "signature_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaign_id" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'queued',
                "total_rows" int NOT NULL DEFAULT 0,
                "valid_count" int NOT NULL DEFAULT 0,
                "invalid_count" int NOT NULL DEFAULT 0,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_signature_verification_jobs" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_signature_verification_jobs_campaign_id" ON "signature_verification_jobs" ("campaign_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "signature_verification_jobs"`);
    }
}
