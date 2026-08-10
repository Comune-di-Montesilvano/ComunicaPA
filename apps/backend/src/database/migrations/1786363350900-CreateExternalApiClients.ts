import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateExternalApiClients1786363350900 implements MigrationInterface {
    name = 'CreateExternalApiClients1786363350900'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "external_api_clients" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "api_key_hash" character varying(64) NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_external_api_clients_id" PRIMARY KEY ("id"), CONSTRAINT "UQ_external_api_clients_api_key_hash" UNIQUE ("api_key_hash"))`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP CONSTRAINT "FK_campaigns_parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_recipient_attempt"`);
        await queryRunner.query(`ALTER TABLE "download_events" DROP CONSTRAINT "FK_download_events_recipient"`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP CONSTRAINT "FK_enrichment_address_overrides_job_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_attempts_recipient_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_attempts_recipient_attempt"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_attempts_send_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_attempts_postal_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_attempts_postal_delivery_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_recipients_campaign_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_recipients_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_enrichment_address_overrides_job_pdf"`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "external_client_id" uuid`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_079a6e545481a4788e3ffe25f2" ON "enrichment_address_overrides" ("job_id", "pdf_filename") `);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_f73d33318403eed8edb732ec318" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "download_events" ADD CONSTRAINT "FK_9c7b2e7059fc08596b872789814" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ADD CONSTRAINT "FK_a809dc6c634776f632f5d1e0968" FOREIGN KEY ("job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "external_client_id"`);
        await queryRunner.query(`DROP TABLE "external_api_clients"`);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP CONSTRAINT "FK_a809dc6c634776f632f5d1e0968"`);
        await queryRunner.query(`ALTER TABLE "download_events" DROP CONSTRAINT "FK_9c7b2e7059fc08596b872789814"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_f73d33318403eed8edb732ec318"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_079a6e545481a4788e3ffe25f2"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_enrichment_address_overrides_job_pdf" ON "enrichment_address_overrides" ("job_id", "pdf_filename") `);
        await queryRunner.query(`CREATE INDEX "idx_recipients_status" ON "recipients" ("status") `);
        await queryRunner.query(`CREATE INDEX "idx_recipients_campaign_id" ON "recipients" ("campaign_id") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_attempts_postal_delivery_status" ON "notification_attempts" ("postal_delivery_status") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_attempts_postal_status" ON "notification_attempts" ("postal_status") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_attempts_send_status" ON "notification_attempts" ("send_status") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_attempts_recipient_attempt" ON "notification_attempts" ("attempt_number", "recipient_id") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_attempts_recipient_id" ON "notification_attempts" ("recipient_id") `);
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" ADD CONSTRAINT "FK_enrichment_address_overrides_job_id" FOREIGN KEY ("job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "download_events" ADD CONSTRAINT "FK_download_events_recipient" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_recipient_attempt" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD CONSTRAINT "FK_campaigns_parent_campaign_id" FOREIGN KEY ("parent_campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
