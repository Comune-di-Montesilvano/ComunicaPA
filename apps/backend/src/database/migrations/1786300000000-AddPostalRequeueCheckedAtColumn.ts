import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalRequeueCheckedAtColumn1786300000000 implements MigrationInterface {
    name = 'AddPostalRequeueCheckedAtColumn1786300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_requeue_checked_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_requeue_checked_at"`);
    }
}
