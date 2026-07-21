import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateInadVerificationJobs1785200000000 implements MigrationInterface {
    name = 'CreateInadVerificationJobs1785200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."inad_verification_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`
            CREATE TABLE "inad_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."inad_verification_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "total_rows" integer NOT NULL DEFAULT 0,
                "batches" jsonb NOT NULL,
                "found_count" integer NOT NULL DEFAULT 0,
                "not_found_count" integer NOT NULL DEFAULT 0,
                "source_csv" text NOT NULL,
                "csv_headers" jsonb NOT NULL,
                "cf_column" character varying(256) NOT NULL,
                "has_headers" boolean NOT NULL DEFAULT true,
                "result_found_csv" text,
                "result_not_found_csv" text,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_inad_verification_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "inad_verification_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."inad_verification_jobs_status_enum"`);
    }
}
