import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDomicileVerificationCancelled1791300000000 implements MigrationInterface {
    // ALTER TYPE ADD VALUE: Postgres non rimuove valori enum, down() no-op.
    static readonly irreversible = true;
    name = 'AddDomicileVerificationCancelled1791300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."domicile_verification_jobs_status_enum" ADD VALUE IF NOT EXISTS 'cancelled'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
    }
}
