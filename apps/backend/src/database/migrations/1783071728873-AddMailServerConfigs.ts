import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMailServerConfigs1783071728873 implements MigrationInterface {
    name = 'AddMailServerConfigs1783071728873'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_server_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(8) NOT NULL, "name" character varying(128) NOT NULL, "host" character varying(255) NOT NULL, "port" integer NOT NULL DEFAULT '587', "secure" boolean NOT NULL DEFAULT false, "auth_enabled" boolean NOT NULL DEFAULT true, "username" character varying(255) NOT NULL DEFAULT '', "password_enc" text NOT NULL DEFAULT '', "from_address" character varying(255) NOT NULL, "batch_size" integer NOT NULL DEFAULT '100', "batch_interval_seconds" integer NOT NULL DEFAULT '60', "tested_at" TIMESTAMP WITH TIME ZONE, "active" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b384013f5e4e8e7969f055371d9" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "mail_server_configs"`);
    }

}
