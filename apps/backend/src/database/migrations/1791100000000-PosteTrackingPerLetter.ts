import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Verifica Poste: una riga per raccomandata, non più per attempt. Una notifica
 * SEND può avere più raccomandate (secondo tentativo di recapito, codice nuovo):
 * prima la seconda sovrascriveva la prima, perdendone esito e movimenti.
 */
export class PosteTrackingPerLetter1791100000000 implements MigrationInterface {
    name = 'PosteTrackingPerLetter1791100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" DROP CONSTRAINT IF EXISTS "UQ_postal_poste_tracking_attempt_id"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_postal_poste_tracking_attempt_code" ON "postal_poste_tracking" ("attempt_id", "tracking_code")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Torna a una riga per attempt: tiene solo la raccomandata più recente.
        await queryRunner.query(`DELETE FROM "postal_poste_tracking" t USING "postal_poste_tracking" n WHERE n.attempt_id = t.attempt_id AND n.created_at > t.created_at`);
        await queryRunner.query(`DROP INDEX "public"."UQ_postal_poste_tracking_attempt_code"`);
        await queryRunner.query(`ALTER TABLE "postal_poste_tracking" ADD CONSTRAINT "UQ_postal_poste_tracking_attempt_id" UNIQUE ("attempt_id")`);
    }
}
