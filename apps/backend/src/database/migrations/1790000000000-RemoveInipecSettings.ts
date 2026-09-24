import { MigrationInterface, QueryRunner } from 'typeorm';

// INIPEC abbandonato (domicilio d'impresa via Registro Imprese): le chiavi
// inipec.* non esistono più nel registry. Le righe residue sarebbero comunque
// ignorate in lettura (getAllMasked itera il registry), le togliamo per pulizia.
export class RemoveInipecSettings1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "app_settings" WHERE "key" LIKE 'inipec.%'`);
  }

  public async down(): Promise<void> {
    // Nessun ripristino: erano solo Purpose ID di un'integrazione mai attivata.
  }
}
