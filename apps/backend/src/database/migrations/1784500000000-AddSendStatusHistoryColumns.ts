import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSendStatusHistoryColumns1784500000000 implements MigrationInterface {
    name = 'AddSendStatusHistoryColumns1784500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_status_history" jsonb`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_digital_domicile" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_digital_domicile"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_status_history"`);
    }
}
