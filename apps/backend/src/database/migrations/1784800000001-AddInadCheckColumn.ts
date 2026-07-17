import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInadCheckColumn1784800000001 implements MigrationInterface {
    name = 'AddInadCheckColumn1784800000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" ADD "inad_check" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "inad_check"`);
    }
}
