import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignSigner1791000000000 implements MigrationInterface {
    name = 'AddCampaignSigner1791000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Nullable: le campagne esistenti non hanno un firmatario indicato.
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "signer_username" character varying(255)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "signer_username"`);
    }
}
