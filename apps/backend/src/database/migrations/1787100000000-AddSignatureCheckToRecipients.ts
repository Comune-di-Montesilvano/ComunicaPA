import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSignatureCheckToRecipients1787100000000 implements MigrationInterface {
    name = 'AddSignatureCheckToRecipients1787100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" ADD "signature_check" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "signature_check"`);
    }
}
