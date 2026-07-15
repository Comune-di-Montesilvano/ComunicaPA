import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePostalProviderConfigs1784300000000 implements MigrationInterface {
    name = 'CreatePostalProviderConfigs1784300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "postal_provider_configs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "type" character varying(20) NOT NULL,
                "name" character varying(128) NOT NULL,
                "base_url" character varying(255) NOT NULL,
                "username" character varying(255) NOT NULL,
                "password_enc" text NOT NULL DEFAULT '',
                "group" character varying(128) NOT NULL DEFAULT '',
                "centro_di_costo" character varying(128) NOT NULL DEFAULT '',
                "mittente_denominazione1" character varying(128) NOT NULL DEFAULT '',
                "mittente_indirizzo1" character varying(128) NOT NULL DEFAULT '',
                "mittente_cap" character varying(10) NOT NULL DEFAULT '',
                "mittente_citta" character varying(128) NOT NULL DEFAULT '',
                "mittente_provincia" character varying(2) NOT NULL DEFAULT '',
                "enabled_service_types" jsonb NOT NULL DEFAULT '[]',
                "contratti" jsonb NOT NULL DEFAULT '[]',
                "tested_at" TIMESTAMP WITH TIME ZONE,
                "active" boolean NOT NULL DEFAULT false,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_postal_provider_configs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "postal_provider_configs"`);
    }
}
