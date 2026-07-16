import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAppIoVerificationJobs1784700000000 implements MigrationInterface {
    name = 'CreateAppIoVerificationJobs1784700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."app_io_verification_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`
            CREATE TABLE "app_io_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."app_io_verification_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "total_rows" integer NOT NULL DEFAULT 0,
                "processed_rows" integer NOT NULL DEFAULT 0,
                "present_count" integer NOT NULL DEFAULT 0,
                "absent_count" integer NOT NULL DEFAULT 0,
                "source_csv" text NOT NULL,
                "csv_headers" jsonb NOT NULL,
                "cf_column" character varying(256) NOT NULL,
                "has_headers" boolean NOT NULL DEFAULT true,
                "io_service_id" uuid NOT NULL,
                "result_present_csv" text,
                "result_absent_csv" text,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_app_io_verification_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "app_io_verification_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."app_io_verification_jobs_status_enum"`);
    }
}
