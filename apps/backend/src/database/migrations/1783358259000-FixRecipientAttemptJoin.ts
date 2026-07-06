import { MigrationInterface, QueryRunner } from "typeorm";

export class FixRecipientAttemptJoin1783358259000 implements MigrationInterface {
    name = 'FixRecipientAttemptJoin1783358259000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Rimuove la FK e la colonna temporanea recipientId (sempre NULL) autogenerata da TypeORM.
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT IF EXISTS "FK_6685e428f32605e205015eacaf0"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN IF EXISTS "recipientId"`);

        // 2. Elimina i record orfani (tentativi i cui destinatari sono stati rimossi in passato)
        // per evitare violazioni del vincolo di integrità referenziale.
        await queryRunner.query(`DELETE FROM "notification_attempts" WHERE "recipient_id" NOT IN (SELECT "id"::text FROM "recipients")`);

        // 3. Converte recipient_id a uuid in modo che corrisponda alla colonna id di recipients.
        await queryRunner.query(`ALTER TABLE "notification_attempts" ALTER COLUMN "recipient_id" TYPE uuid USING "recipient_id"::uuid`);

        // 4. Aggiunge la FK corretta su recipient_id con onDelete CASCADE.
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_recipient_attempt" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP CONSTRAINT "FK_recipient_attempt"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ALTER COLUMN "recipient_id" TYPE character varying USING "recipient_id"::character varying`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "recipientId" uuid`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD CONSTRAINT "FK_6685e428f32605e205015eacaf0" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
}
