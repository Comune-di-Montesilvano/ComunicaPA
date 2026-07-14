import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUploadedDocumentsColumn1784100000000 implements MigrationInterface {
    name = 'AddUploadedDocumentsColumn1784100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "uploaded_documents" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "uploaded_documents"`);
    }

}
