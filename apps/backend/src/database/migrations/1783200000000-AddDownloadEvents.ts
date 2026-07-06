import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDownloadEvents1783200000000 implements MigrationInterface {
    name = 'AddDownloadEvents1783200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "download_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "recipient_id" uuid NOT NULL, "channel" character varying(20) NOT NULL, "attachment_index" integer NOT NULL DEFAULT 0, "downloaded_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_download_events_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "download_events" ADD CONSTRAINT "FK_download_events_recipient" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "download_events" DROP CONSTRAINT "FK_download_events_recipient"`);
        await queryRunner.query(`DROP TABLE "download_events"`);
    }

}
