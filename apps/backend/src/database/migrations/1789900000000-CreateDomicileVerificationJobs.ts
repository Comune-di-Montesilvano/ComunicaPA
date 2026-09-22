import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDomicileVerificationJobs1789900000000 implements MigrationInterface {
    name = 'CreateDomicileVerificationJobs1789900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "app_io_verification_jobs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."app_io_verification_jobs_status_enum"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "inad_verification_jobs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."inad_verification_jobs_status_enum"`);

        await queryRunner.query(`CREATE TYPE "public"."domicile_verification_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`
            CREATE TABLE "domicile_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."domicile_verification_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "total_rows" integer NOT NULL DEFAULT 0,
                "source_csv" text NOT NULL,
                "csv_headers" jsonb NOT NULL,
                "cf_column" character varying(256) NOT NULL,
                "has_headers" boolean NOT NULL DEFAULT true,
                "io_service_id" uuid NOT NULL,
                "cf_fisico_total" integer NOT NULL DEFAULT 0,
                "piva_total" integer NOT NULL DEFAULT 0,
                "inad_batches" jsonb NOT NULL DEFAULT '[]',
                "inad_fetched" boolean NOT NULL DEFAULT false,
                "inad_found_map" jsonb NOT NULL DEFAULT '{}',
                "app_io_done" boolean NOT NULL DEFAULT false,
                "app_io_processed_rows" integer NOT NULL DEFAULT 0,
                "app_io_present_count" integer NOT NULL DEFAULT 0,
                "app_io_absent_count" integer NOT NULL DEFAULT 0,
                "app_io_results" jsonb NOT NULL DEFAULT '{}',
                "registro_imprese_total" integer NOT NULL DEFAULT 0,
                "registro_imprese_done" integer NOT NULL DEFAULT 0,
                "registro_imprese_found_count" integer NOT NULL DEFAULT 0,
                "registro_imprese_results" jsonb NOT NULL DEFAULT '{}',
                "residual_enqueued" boolean NOT NULL DEFAULT false,
                "result_assenti_csv" text,
                "result_app_io_csv" text,
                "result_inad_csv" text,
                "result_registro_imprese_csv" text,
                "result_aggregato_csv" text,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_domicile_verification_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "domicile_verification_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."domicile_verification_jobs_status_enum"`);
        // Nessun ripristino delle 2 tabelle vecchie nel down() — stesso
        // principio già in uso altrove (ALTER TYPE ADD VALUE): un rollback
        // di questa migration non è pensato per riportare indietro dati.
    }
}
