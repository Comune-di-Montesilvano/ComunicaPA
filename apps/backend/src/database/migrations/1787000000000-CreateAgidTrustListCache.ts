import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAgidTrustListCache1787000000000 implements MigrationInterface {
    name = 'CreateAgidTrustListCache1787000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "agid_trust_list_cache" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "certificates_pem" jsonb NOT NULL,
                "fetched_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_agid_trust_list_cache" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "agid_trust_list_cache"`);
    }
}
