import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLastContentResendSignatureToRecipients1785700000000 implements MigrationInterface {
    name = 'AddLastContentResendSignatureToRecipients1785700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" ADD "last_content_resend_signature" character varying(512)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "last_content_resend_signature"`);
    }
}
