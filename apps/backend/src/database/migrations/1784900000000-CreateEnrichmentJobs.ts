import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEnrichmentJobs1784900000000 implements MigrationInterface {
    name = 'CreateEnrichmentJobs1784900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."enrichment_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`CREATE TYPE "public"."enrichment_jobs_trace_format_enum" AS ENUM('MAGGIOLI')`);
        await queryRunner.query(`
            CREATE TABLE "enrichment_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."enrichment_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "trace_format" "public"."enrichment_jobs_trace_format_enum" NOT NULL,
                "source_filename" character varying(512) NOT NULL,
                "total_records" integer NOT NULL DEFAULT 0,
                "processed_records" integer NOT NULL DEFAULT 0,
                "warning_count" integer NOT NULL DEFAULT 0,
                "warnings" jsonb NOT NULL DEFAULT '[]',
                "error_message" text,
                "campaign_id" uuid,
                "created_by" character varying(256) NOT NULL,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_enrichment_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enrichment_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."enrichment_jobs_trace_format_enum"`);
        await queryRunner.query(`DROP TYPE "public"."enrichment_jobs_status_enum"`);
    }
}
