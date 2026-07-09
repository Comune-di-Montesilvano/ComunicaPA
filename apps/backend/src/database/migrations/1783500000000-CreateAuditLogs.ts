import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuditLogs1783500000000 implements MigrationInterface {
    name = 'CreateAuditLogs1783500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "audit_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaign_id" uuid,
                "campaign_name" character varying(255),
                "operator" character varying(255) NOT NULL,
                "action" character varying(50) NOT NULL,
                "details" jsonb,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "audit_logs"`);
    }
}
