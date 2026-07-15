import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalStatusColumns1784200000000 implements MigrationInterface {
    name = 'AddPostalStatusColumns1784200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_tracking_id" character varying(50)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status" character varying(30)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status_updated_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status_updated_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_tracking_id"`);
    }
}
