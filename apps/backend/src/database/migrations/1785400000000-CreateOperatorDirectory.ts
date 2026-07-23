import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOperatorDirectory1785400000000 implements MigrationInterface {
    name = 'CreateOperatorDirectory1785400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "operator_directory" (
                "username" character varying(255) NOT NULL,
                "display_name" character varying(255) NOT NULL,
                "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_operator_directory" PRIMARY KEY ("username")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "operator_directory"`);
    }
}
