import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignIsLegalValueColumn1785500000000 implements MigrationInterface {
    name = 'AddCampaignIsLegalValueColumn1785500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "is_legal_value" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "is_legal_value"`);
    }
}
