import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Le righe chiuse come "consegnate" prima del flusso verifica+cookie sono
 * state valutate su dati ridotti di Poste (senza fase 6 / flagRitorno):
 * rimesse in coda una volta per la riverifica, senza toccarne lo stato
 * (se Poste non dà un esito nuovo, esito e prova già salvati restano).
 */
export class ReverifyPosteDelivered1790400000000 implements MigrationInterface {
    name = 'ReverifyPosteDelivered1790400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "postal_poste_tracking" SET "next_check_at" = now() WHERE "status" = 'delivered'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "postal_poste_tracking" SET "next_check_at" = NULL WHERE "status" = 'delivered'`);
    }
}
