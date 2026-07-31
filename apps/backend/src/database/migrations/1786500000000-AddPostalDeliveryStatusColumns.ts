import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalDeliveryStatusColumns1786500000000 implements MigrationInterface {
    name = 'AddPostalDeliveryStatusColumns1786500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_delivery_status" character varying(80)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_delivery_code" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_delivery_date" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_acceptance_id" character varying(50)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_acceptance_id"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_delivery_date"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_delivery_code"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_delivery_status"`);
    }
}
