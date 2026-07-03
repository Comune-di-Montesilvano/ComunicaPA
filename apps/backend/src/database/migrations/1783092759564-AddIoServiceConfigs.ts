import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIoServiceConfigs1783092759564 implements MigrationInterface {
    name = 'AddIoServiceConfigs1783092759564'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "io_service_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "nome" character varying(128) NOT NULL, "id_service" character varying(64) NOT NULL, "descrizione" text NOT NULL DEFAULT '', "api_key_primaria_enc" text NOT NULL DEFAULT '', "api_key_secondaria_enc" text NOT NULL DEFAULT '', "codice_catalogo" character varying(32) NOT NULL DEFAULT '', "is_default" boolean NOT NULL DEFAULT false, "tested_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cc64ba1754defb3666392d6c5d7" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "io_service_configs"`);
    }

}
