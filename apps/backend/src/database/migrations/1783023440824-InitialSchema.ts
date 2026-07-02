import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1783023440824 implements MigrationInterface {
    name = 'InitialSchema1783023440824'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Richiesta da uuid_generate_v4(): in dev la crea synchronize, qui va esplicitata
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "app_settings" ("key" character varying(128) NOT NULL, "value" jsonb NOT NULL, "encrypted" boolean NOT NULL DEFAULT false, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_by" character varying(128), CONSTRAINT "PK_975c2db59c65c05fd9c6b63a2ab" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TYPE "public"."campaigns_status_enum" AS ENUM('draft', 'queued', 'running', 'completed', 'failed')`);
        await queryRunner.query(`CREATE TABLE "campaigns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "description" text, "status" "public"."campaigns_status_enum" NOT NULL DEFAULT 'draft', "channel_type" character varying(20) NOT NULL, "channel_config" jsonb NOT NULL DEFAULT '{}', "retention_days" integer, "created_by" character varying(255) NOT NULL, "total_recipients" integer NOT NULL DEFAULT '0', "sent_count" integer NOT NULL DEFAULT '0', "failed_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_831e3fcd4fc45b4e4c3f57a9ee4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."notification_attempts_status_enum" AS ENUM('queued', 'processing', 'success', 'failed')`);
        await queryRunner.query(`CREATE TABLE "notification_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "recipient_id" character varying NOT NULL, "channel_type" character varying(20) NOT NULL, "status" "public"."notification_attempts_status_enum" NOT NULL DEFAULT 'queued', "attempt_number" integer NOT NULL DEFAULT '1', "sent_at" TIMESTAMP WITH TIME ZONE, "response_payload" jsonb, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "recipientId" uuid, CONSTRAINT "PK_f6abd34f351bbbf11c7ae8e7565" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."recipients_status_enum" AS ENUM('pending', 'queued', 'sent', 'failed', 'skipped')`);
        await queryRunner.query(`CREATE TABLE "recipients" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "campaign_id" character varying NOT NULL, "codice_fiscale" character varying(16) NOT NULL, "email" character varying(255), "pec" character varying(255), "full_name" character varying(255), "extra_data" jsonb NOT NULL DEFAULT '{}', "status" "public"."recipients_status_enum" NOT NULL DEFAULT 'pending', "download_count" integer NOT NULL DEFAULT '0', "first_downloaded_at" TIMESTAMP WITH TIME ZONE, "last_downloaded_at" TIMESTAMP WITH TIME ZONE, "attachment_expires_at" TIMESTAMP WITH TIME ZONE, "attachment_deleted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "campaignId" uuid, CONSTRAINT "PK_de8fc5a9c364568f294798fe1e9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_6685e428f32605e205015eacaf0" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "recipients" ADD CONSTRAINT "FK_5bbab1e50e1783c9768c0d1f8e4" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP CONSTRAINT "FK_5bbab1e50e1783c9768c0d1f8e4"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_6685e428f32605e205015eacaf0"`);
        await queryRunner.query(`DROP TABLE "recipients"`);
        await queryRunner.query(`DROP TYPE "public"."recipients_status_enum"`);
        await queryRunner.query(`DROP TABLE "notification_attempts"`);
        await queryRunner.query(`DROP TYPE "public"."notification_attempts_status_enum"`);
        await queryRunner.query(`DROP TABLE "campaigns"`);
        await queryRunner.query(`DROP TYPE "public"."campaigns_status_enum"`);
        await queryRunner.query(`DROP TABLE "app_settings"`);
    }

}
