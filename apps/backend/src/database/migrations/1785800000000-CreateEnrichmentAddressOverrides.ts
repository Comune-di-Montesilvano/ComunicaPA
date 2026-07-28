import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEnrichmentAddressOverrides1785800000000 implements MigrationInterface {
    name = 'CreateEnrichmentAddressOverrides1785800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "enrichment_address_overrides" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "job_id" uuid NOT NULL,
                "pdf_filename" character varying(512) NOT NULL,
                "indirizzo" character varying(512),
                "cap" character varying(16),
                "comune" character varying(256),
                "provincia" character varying(8),
                "stato_estero" character varying(256),
                "corrected_by" character varying(256) NOT NULL,
                "corrected_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_enrichment_address_overrides" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_enrichment_address_overrides_job_pdf"
            ON "enrichment_address_overrides" ("job_id", "pdf_filename")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enrichment_address_overrides"`);
    }
}
