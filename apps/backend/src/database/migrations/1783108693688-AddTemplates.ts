import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTemplates1783108693688 implements MigrationInterface {
    name = 'AddTemplates1783108693688'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "templates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(10) NOT NULL, "name" character varying(128) NOT NULL, "subject" character varying(255) NOT NULL DEFAULT '', "body_html" text NOT NULL DEFAULT '', "body_markdown" text NOT NULL DEFAULT '', "paired_template_id" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "pairedTemplateId" uuid, CONSTRAINT "PK_515948649ce0bbbe391de702ae5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "templates" ADD CONSTRAINT "FK_ceb614d1357f8284688953769f9" FOREIGN KEY ("pairedTemplateId") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "templates" DROP CONSTRAINT "FK_ceb614d1357f8284688953769f9"`);
        await queryRunner.query(`DROP TABLE "templates"`);
    }

}
