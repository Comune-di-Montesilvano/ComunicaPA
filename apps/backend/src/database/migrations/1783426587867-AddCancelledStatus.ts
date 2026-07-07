import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCancelledStatus1783426587867 implements MigrationInterface {
    name = 'AddCancelledStatus1783426587867'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."campaigns_status_enum" ADD VALUE 'cancelled'`);
        await queryRunner.query(`ALTER TYPE "public"."recipients_status_enum" ADD VALUE 'cancelled'`);
        await queryRunner.query(`ALTER TYPE "public"."notification_attempts_status_enum" ADD VALUE 'cancelled'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
    }

}
