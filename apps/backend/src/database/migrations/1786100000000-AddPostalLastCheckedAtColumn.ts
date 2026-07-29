import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalLastCheckedAtColumn1786100000000 implements MigrationInterface {
    name = 'AddPostalLastCheckedAtColumn1786100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_last_checked_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_last_checked_at"`);
    }
}
