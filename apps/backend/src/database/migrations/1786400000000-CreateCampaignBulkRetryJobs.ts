import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCampaignBulkRetryJobs1786400000000 implements MigrationInterface {
    name = 'CreateCampaignBulkRetryJobs1786400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."campaign_bulk_retry_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`CREATE TABLE "campaign_bulk_retry_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "campaign_id" uuid NOT NULL, "status" "public"."campaign_bulk_retry_jobs_status_enum" NOT NULL DEFAULT 'queued', "recipient_ids" jsonb NOT NULL, "total_count" integer NOT NULL DEFAULT '0', "processed_count" integer NOT NULL DEFAULT '0', "requeued_count" integer NOT NULL DEFAULT '0', "failed" jsonb NOT NULL DEFAULT '[]', "error_message" text, "created_by" character varying(256) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_campaign_bulk_retry_jobs" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "campaign_bulk_retry_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."campaign_bulk_retry_jobs_status_enum"`);
    }

}
