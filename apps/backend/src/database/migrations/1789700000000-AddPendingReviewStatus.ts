import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPendingReviewStatus1789700000000 implements MigrationInterface {
    name = 'AddPendingReviewStatus1789700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."recipients_status_enum" ADD VALUE 'pending_review'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
    }
}
