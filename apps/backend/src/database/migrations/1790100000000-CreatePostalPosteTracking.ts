import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePostalPosteTracking1790100000000 implements MigrationInterface {
    name = 'CreatePostalPosteTracking1790100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "postal_poste_tracking" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "attempt_id" uuid NOT NULL,
                "tracking_code" character varying(50) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'pending',
                "check_count" integer NOT NULL DEFAULT 0,
                "next_check_at" TIMESTAMP WITH TIME ZONE,
                "last_checked_at" TIMESTAMP WITH TIME ZONE,
                "last_error" character varying(500),
                "poste_stato" character varying(10),
                "poste_esito_ricerca" character varying(10),
                "poste_product" character varying(100),
                "delivered_at" TIMESTAMP WITH TIME ZONE,
                "movements" jsonb,
                "last_response" jsonb,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_postal_poste_tracking_attempt_id" UNIQUE ("attempt_id"),
                CONSTRAINT "PK_postal_poste_tracking" PRIMARY KEY ("id"),
                CONSTRAINT "FK_postal_poste_tracking_attempt" FOREIGN KEY ("attempt_id") REFERENCES "notification_attempts"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_postal_poste_tracking_status_next" ON "postal_poste_tracking" ("status", "next_check_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_postal_poste_tracking_status_next"`);
        await queryRunner.query(`DROP TABLE "postal_poste_tracking"`);
    }
}
