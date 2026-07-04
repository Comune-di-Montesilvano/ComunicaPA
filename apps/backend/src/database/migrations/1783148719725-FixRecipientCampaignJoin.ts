import { MigrationInterface, QueryRunner } from "typeorm";

export class FixRecipientCampaignJoin1783148719725 implements MigrationInterface {
    name = 'FixRecipientCampaignJoin1783148719725'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // "campaignId" (uuid) è la colonna auto-generata da TypeORM per la relazione
        // priva di @JoinColumn: non è mai stata scritta da nessun codice applicativo
        // ed è sempre NULL. La FK reale va spostata sulla colonna "campaign_id"
        // (varchar) effettivamente popolata, che qui viene castata a uuid.
        await queryRunner.query(`ALTER TABLE "recipients" DROP CONSTRAINT "FK_5bbab1e50e1783c9768c0d1f8e4"`);
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "campaignId"`);
        await queryRunner.query(`ALTER TABLE "recipients" ALTER COLUMN "campaign_id" TYPE uuid USING "campaign_id"::uuid`);
        await queryRunner.query(`ALTER TABLE "recipients" ADD CONSTRAINT "FK_0776cae7bc374f5b2369f7ac50c" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP CONSTRAINT "FK_0776cae7bc374f5b2369f7ac50c"`);
        await queryRunner.query(`ALTER TABLE "recipients" ALTER COLUMN "campaign_id" TYPE character varying USING "campaign_id"::character varying`);
        await queryRunner.query(`ALTER TABLE "recipients" ADD "campaignId" uuid`);
        await queryRunner.query(`ALTER TABLE "recipients" ADD CONSTRAINT "FK_5bbab1e50e1783c9768c0d1f8e4" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
