import { MigrationInterface, QueryRunner } from "typeorm";

// Correzione da PDF illeggibile (es. "ADM-ZIP: Unknown descriptor format"):
// l'estrazione non ha prodotto nessun dato, non solo l'indirizzo — serve poter
// sovrascrivere qualunque colonna del CSV (importo/scadenza/rate...), non solo
// le 5 tipizzate indirizzo/cap/comune/provincia/statoEstero. jsonb libero per
// non dover aggiungere una colonna a ogni nuova intestazione rataN_*.
export class AddExtraFieldsToEnrichmentAddressOverrides1786000000000 implements MigrationInterface {
    name = 'AddExtraFieldsToEnrichmentAddressOverrides1786000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "enrichment_address_overrides"
            ADD "extra_fields" jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_address_overrides" DROP COLUMN "extra_fields"`);
    }
}
