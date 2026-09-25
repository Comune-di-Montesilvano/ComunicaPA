import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalPosteTrackingUntil1790300000000 implements MigrationInterface {
    name = 'AddPostalPosteTrackingUntil1790300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" ADD "tracking_until" TIMESTAMP WITH TIME ZONE`);
        // Finestra di verifica = 90 giorni dalla data della notifica (non 90
        // risposte): righe esistenti ricalcolate dall'attempt.
        await queryRunner.query(`
            UPDATE "postal_poste_tracking" t
            SET "tracking_until" = COALESCE(na.sent_at, na.created_at) + interval '90 days'
            FROM "notification_attempts" na
            WHERE na.id = t.attempt_id
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" DROP COLUMN "tracking_until"`);
    }
}
