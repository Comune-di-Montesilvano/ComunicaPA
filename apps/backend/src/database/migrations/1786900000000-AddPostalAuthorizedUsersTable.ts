import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalAuthorizedUsersTable1786900000000 implements MigrationInterface {
    name = 'AddPostalAuthorizedUsersTable1786900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "postal_authorized_users" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "username" character varying(255) NOT NULL,
                "added_by" character varying(255) NOT NULL,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_postal_authorized_users_username" UNIQUE ("username"),
                CONSTRAINT "PK_postal_authorized_users" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "postal_authorized_users"`);
    }
}
