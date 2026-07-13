import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSendStatusColumns1783700000000 implements MigrationInterface {
    name = 'AddSendStatusColumns1783700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "iun" character varying(26)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_status" character varying(30)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_status_updated_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_status_updated_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_status"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "iun"`);
    }

}
