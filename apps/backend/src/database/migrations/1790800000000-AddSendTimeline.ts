import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSendTimeline1790800000000 implements MigrationInterface {
    name = 'AddSendTimeline1790800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Nullable: le SEND esistenti si popolano al prossimo poll di SendStatusSyncService.
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_timeline" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_timeline"`);
    }
}
