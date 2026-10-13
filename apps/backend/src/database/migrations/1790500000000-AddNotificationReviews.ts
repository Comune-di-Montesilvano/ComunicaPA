import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationReviews1790500000000 implements MigrationInterface {
    name = 'AddNotificationReviews1790500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "notification_reviews" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "recipient_id" uuid NOT NULL,
                "campaign_id" uuid NOT NULL,
                "kind" character varying(10) NOT NULL,
                "action" character varying(10) NOT NULL,
                "snoozed_until" TIMESTAMP WITH TIME ZONE,
                "reason" text NOT NULL,
                "note" text,
                "created_by" character varying(255) NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_bffafe01f60c5d1157e14faab9e" PRIMARY KEY ("id"),
                CONSTRAINT "FK_f9dbd6065651493cdf853d95455" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_notification_reviews_recipient_kind" ON "notification_reviews" ("recipient_id", "kind", "created_at")`);
        await queryRunner.query(`CREATE INDEX "IDX_notification_reviews_campaign" ON "notification_reviews" ("campaign_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "notification_reviews"`);
    }
}
