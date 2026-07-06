import { MigrationInterface, QueryRunner } from "typeorm";

export class FixRecipientAttemptJoin1783358259000 implements MigrationInterface {
    name = 'FixRecipientAttemptJoin1783358259000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Rimuove la FK e la colonna temporanea recipientId (sempre NULL) autogenerata da TypeORM.
        // Converte recipient_id a uuid in modo che corrisponda alla colonna id di recipients.
        // Aggiunge la FK corretta su recipient_id.
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT IF EXISTS "FK_6685e428f32605e205015eacaf0"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN IF EXISTS "recipientId"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ALTER COLUMN "recipient_id" TYPE uuid USING "recipient_id"::uuid`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_recipient_attempt" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_recipient_attempt"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ALTER COLUMN "recipient_id" TYPE character varying USING "recipient_id"::character varying`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "recipientId" uuid`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_6685e428f32605e205015eacaf0" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
}
