import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRemoteSignJobs1790600000000 implements MigrationInterface {
    name = 'CreateRemoteSignJobs1790600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "remote_sign_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaign_id" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'queued',
                "total_files" integer NOT NULL DEFAULT 0,
                "signed_count" integer NOT NULL DEFAULT 0,
                "failed_count" integer NOT NULL DEFAULT 0,
                "error_message" text,
                "error_kind" character varying(20),
                "operator" character varying(255) NOT NULL,
                "signer_cn" character varying(255),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_remote_sign_jobs" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_remote_sign_jobs_campaign" ON "remote_sign_jobs" ("campaign_id", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "remote_sign_jobs"`);
    }
}
