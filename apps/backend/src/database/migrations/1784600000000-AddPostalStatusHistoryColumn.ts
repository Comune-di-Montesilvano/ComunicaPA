import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalStatusHistoryColumn1784600000000 implements MigrationInterface {
    name = 'AddPostalStatusHistoryColumn1784600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status_history" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status_history"`);
    }
}
