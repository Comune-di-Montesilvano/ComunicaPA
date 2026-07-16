import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Due template "standard" precompilati (MAIL + APP_IO, accoppiati) cosi'
 * l'operatore ha un default pronto all'uso nel selettore "Carica da
 * template" della co-consegna App IO, invece di un elenco vuoto alla prima
 * installazione. UUID fissi per idempotenza/leggibilita' della migration.
 */
export class SeedStandardTemplates1784400000000 implements MigrationInterface {
    name = 'SeedStandardTemplates1784400000000'

    private readonly mailId = '00000000-0000-4000-8000-000000000001';
    private readonly appIoId = '00000000-0000-4000-8000-000000000002';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Inserisce prima senza pairing (FK su paired_template_id: la riga
        // gemella non esiste ancora), poi accoppia con due UPDATE.
        await queryRunner.query(`
            INSERT INTO "templates" ("id", "type", "name", "subject", "body_html", "body_markdown")
            VALUES ($1, 'MAIL', 'Standard', 'Comunicazione importante', $2, '')
        `, [
            this.mailId,
            `<p>Gentile %%nominativo%%,</p>\n<p>Le inviamo una comunicazione importante da parte dell'Ente.</p>\n<p>%%elenco_allegati%%</p>\n<p>Cordiali saluti.</p>`,
        ]);

        await queryRunner.query(`
            INSERT INTO "templates" ("id", "type", "name", "subject", "body_html", "body_markdown")
            VALUES ($1, 'APP_IO', 'Standard', 'Comunicazione importante', '', $2)
        `, [
            this.appIoId,
            `Gentile %%nominativo%%,\n\nle e' stata inviata una comunicazione importante da parte dell'Ente. Consulta il messaggio per i dettagli.\n\n%%elenco_allegati%%`,
        ]);

        await queryRunner.query(`UPDATE "templates" SET "paired_template_id" = $1 WHERE "id" = $2`, [this.appIoId, this.mailId]);
        await queryRunner.query(`UPDATE "templates" SET "paired_template_id" = $1 WHERE "id" = $2`, [this.mailId, this.appIoId]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "templates" WHERE "id" IN ($1, $2)`, [this.mailId, this.appIoId]);
    }
}
