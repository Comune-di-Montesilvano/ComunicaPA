import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMailServerConfigDefault1785300000000 implements MigrationInterface {
    name = 'AddMailServerConfigDefault1785300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_server_configs" ADD "is_default" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_server_configs" DROP COLUMN "is_default"`);
    }
}
