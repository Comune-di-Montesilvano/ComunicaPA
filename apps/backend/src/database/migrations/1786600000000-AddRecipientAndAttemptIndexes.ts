import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRecipientAndAttemptIndexes1786600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_recipients_campaign_id" ON "recipients" ("campaign_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_recipients_status" ON "recipients" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_attempts_recipient_id" ON "notification_attempts" ("recipient_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_attempts_recipient_attempt" ON "notification_attempts" ("recipient_id", "attempt_number" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_attempts_send_status" ON "notification_attempts" ("send_status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_attempts_postal_status" ON "notification_attempts" ("postal_status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_attempts_postal_delivery_status" ON "notification_attempts" ("postal_delivery_status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_attempts_postal_delivery_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_attempts_postal_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_attempts_send_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_attempts_recipient_attempt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_attempts_recipient_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_recipients_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_recipients_campaign_id"`);
  }
}
