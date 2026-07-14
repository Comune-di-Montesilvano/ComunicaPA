import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProtocolColumns1783800000000 implements MigrationInterface {
    name = 'AddProtocolColumns1783800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocol_number" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocol_year" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocolled_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocolled_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocol_year"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocol_number"`);
    }

}
