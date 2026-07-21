import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCostColumns1785100000000 implements MigrationInterface {
    name = 'AddCostColumns1785100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_cents" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_calculated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_breakdown" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_breakdown"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_calculated_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_cents"`);
    }
}
