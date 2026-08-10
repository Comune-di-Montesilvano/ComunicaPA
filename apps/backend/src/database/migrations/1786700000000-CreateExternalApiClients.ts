import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateExternalApiClients1786700000000 implements MigrationInterface {
    name = 'CreateExternalApiClients1786700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "external_api_clients" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "api_key_hash" character varying(64) NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_external_api_clients_id" PRIMARY KEY ("id"), CONSTRAINT "UQ_external_api_clients_api_key_hash" UNIQUE ("api_key_hash"))`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "external_client_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "external_client_id"`);
        await queryRunner.query(`DROP TABLE "external_api_clients"`);
    }

}
