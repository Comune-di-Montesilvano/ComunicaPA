import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Orari Poste salvati 1-2 h avanti: `dataOra` di poste.it è l'ora italiana
 * codificata come UTC (vedi posteDataOraToDate). I valori salvati sono
 * l'ora di Roma scritta come UTC: si rileggono i campi UTC come ora di Roma.
 */
const fix = (expr: string) => `((${expr} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome')`;
const unfix = (expr: string) => `((${expr} AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'UTC')`;

function movementsSql(conv: (e: string) => string): string {
    return `UPDATE postal_poste_tracking SET movements = (
        SELECT jsonb_agg(CASE WHEN coalesce(m->>'at', '') = '' THEN m
            ELSE jsonb_set(m, '{at}', to_jsonb(to_char(${conv("(m->>'at')::timestamptz")} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) END ORDER BY ord)
        FROM jsonb_array_elements(movements) WITH ORDINALITY e(m, ord))
      WHERE jsonb_typeof(movements) = 'array' AND jsonb_array_length(movements) > 0`;
}

export class FixPosteMovementTimezone1790900000000 implements MigrationInterface {
    name = 'FixPosteMovementTimezone1790900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(movementsSql(fix));
        await queryRunner.query(`UPDATE postal_poste_tracking SET delivered_at = ${fix('delivered_at')} WHERE delivered_at IS NOT NULL`);
        await queryRunner.query(`UPDATE postal_poste_tracking SET outcome_at = ${fix('outcome_at')} WHERE outcome_at IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(movementsSql(unfix));
        await queryRunner.query(`UPDATE postal_poste_tracking SET delivered_at = ${unfix('delivered_at')} WHERE delivered_at IS NOT NULL`);
        await queryRunner.query(`UPDATE postal_poste_tracking SET outcome_at = ${unfix('outcome_at')} WHERE outcome_at IS NOT NULL`);
    }
}
