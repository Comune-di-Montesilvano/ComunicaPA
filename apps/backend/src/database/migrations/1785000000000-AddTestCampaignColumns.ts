import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTestCampaignColumns1785000000000 implements MigrationInterface {
    name = 'AddTestCampaignColumns1785000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "is_test" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "parent_campaign_id" uuid`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD CONSTRAINT "FK_campaigns_parent_campaign_id" FOREIGN KEY ("parent_campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP CONSTRAINT "FK_campaigns_parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "is_test"`);
    }
}
