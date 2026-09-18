import { MigrationInterface, QueryRunner } from 'typeorm';

// download_events non aveva alcun indice su recipient_id — ogni query che
// lo joina/filtra per destinatario (combinazione canali download, filtro
// "Canale download" in Destinatari Caricati) degenerava in uno scan
// completo della tabella per riga, molto lento su campagne grandi
// (18832 destinatari, query percepita come "applicata solo al poll
// successivo" — in realtà solo lenta oltre il timeout della UI).
export class AddDownloadEventsRecipientIdIndex1789800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_download_events_recipient_id" ON "download_events" ("recipient_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_download_events_recipient_id"`);
  }
}
