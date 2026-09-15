import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignGroupId1787300000000 implements MigrationInterface {
    name = 'AddCampaignGroupId1787300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "group_id" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_campaigns_group_id" ON "campaigns" ("group_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_campaigns_group_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "group_id"`);
    }
}
