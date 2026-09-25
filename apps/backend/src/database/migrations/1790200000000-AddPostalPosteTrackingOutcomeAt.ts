import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalPosteTrackingOutcomeAt1790200000000 implements MigrationInterface {
    name = 'AddPostalPosteTrackingOutcomeAt1790200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" ADD "outcome_at" TIMESTAMP WITH TIME ZONE`);
        // Righe già chiuse prima di questa colonna: consegnate = delivered_at,
        // restituite = data dell'ultimo movimento salvato (stesso criterio di
        // mapPosteOutcome, che usa l'ultimo movimento come data esito).
        await queryRunner.query(`UPDATE "postal_poste_tracking" SET "outcome_at" = "delivered_at" WHERE "status" = 'delivered' AND "delivered_at" IS NOT NULL`);
        await queryRunner.query(`
            UPDATE "postal_poste_tracking" t SET "outcome_at" = sub.max_at
            FROM (
                SELECT id, MAX((m->>'at')::timestamptz) AS max_at
                FROM "postal_poste_tracking", jsonb_array_elements(COALESCE(movements, '[]'::jsonb)) m
                WHERE m->>'at' <> ''
                GROUP BY id
            ) sub
            WHERE t.id = sub.id AND t."status" = 'returned' AND t."outcome_at" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" DROP COLUMN "outcome_at"`);
    }
}
