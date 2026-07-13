import { MigrationInterface, QueryRunner } from "typeorm";

export class RenamePdndSettingsKeys1783600000000 implements MigrationInterface {
    name = 'RenamePdndSettingsKeys1783600000000'

    private readonly renames: [string, string][] = [
        ['send.test.pdndTokenUrl', 'pdnd.test.tokenUrl'],
        ['send.test.pdndAudience', 'pdnd.test.audience'],
        ['send.test.pdndClientId', 'pdnd.test.clientId'],
        ['send.test.pdndKid', 'pdnd.test.kid'],
        ['send.test.pdndPrivateKey', 'pdnd.test.privateKey'],
        ['send.test.pdndPurposeId', 'send.test.purposeId'],
        ['send.prod.pdndTokenUrl', 'pdnd.prod.tokenUrl'],
        ['send.prod.pdndAudience', 'pdnd.prod.audience'],
        ['send.prod.pdndClientId', 'pdnd.prod.clientId'],
        ['send.prod.pdndKid', 'pdnd.prod.kid'],
        ['send.prod.pdndPrivateKey', 'pdnd.prod.privateKey'],
        ['send.prod.pdndPurposeId', 'send.prod.purposeId'],
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [oldKey, newKey] of this.renames) {
            await queryRunner.query(
                `UPDATE "app_settings" SET "key" = $1 WHERE "key" = $2`,
                [newKey, oldKey],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [oldKey, newKey] of this.renames) {
            await queryRunner.query(
                `UPDATE "app_settings" SET "key" = $1 WHERE "key" = $2`,
                [oldKey, newKey],
            );
        }
    }
}
