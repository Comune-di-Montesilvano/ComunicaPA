import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCheckingInadStatus1784800000000 implements MigrationInterface {
    name = 'AddCheckingInadStatus1784800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."campaigns_status_enum" ADD VALUE 'checking_inad'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
    }
}
