import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTemplates1783109448492 implements MigrationInterface {
    name = 'AddTemplates1783109448492'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "templates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(10) NOT NULL, "name" character varying(128) NOT NULL, "subject" character varying(255) NOT NULL DEFAULT '', "body_html" text NOT NULL DEFAULT '', "body_markdown" text NOT NULL DEFAULT '', "paired_template_id" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_515948649ce0bbbe391de702ae5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "templates" ADD CONSTRAINT "FK_e88f5437ccfd503900c467d2a2f" FOREIGN KEY ("paired_template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "templates" DROP CONSTRAINT "FK_e88f5437ccfd503900c467d2a2f"`);
        await queryRunner.query(`DROP TABLE "templates"`);
    }

}
