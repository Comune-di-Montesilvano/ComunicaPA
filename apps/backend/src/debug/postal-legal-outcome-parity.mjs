// Confronta postalLegalOutcomeCaseSql (valutata da Postgres) con
// postalLegalOutcome (TS) su una matrice di casi, senza toccare tabelle.
// Uso: docker compose exec -w /app/apps/backend backend node src/debug/postal-legal-outcome-parity.mjs
import pg from 'pg';
import { postalLegalOutcome, postalLegalOutcomeCaseSql } from '../../dist/campaigns/postal-legal-outcome.util.js';

const statuses = [null, 'Consegnato', 'Consegnato a Domicilio', 'Compiuta Giacenza', 'Invio Rifiutato', 'Indirizzo errato o inesatto', 'Smarrito', 'Inesitato', 'In giacenza', 'Valore mai visto'];
const postalStatuses = [null, 'Confermato', 'NonConsegnato', 'Consegnato', 'Errore', 'Eliminato', 'AppIoSostituito'];
const cases = [];
for (const diverted of [false, true]) for (const hasAttempt of [false, true]) for (const status of ['success', 'failed', 'queued'])
  for (const ps of postalStatuses) for (const ds of statuses) for (const poste of [null, 'delivered', 'returned', 'pending'])
    cases.push({ diverted, hasAttempt, status, ps, ds, poste });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let mismatches = 0;
for (const ar of [true, false]) {
  const values = cases.map((c, i) => `(${i}, '{"diverted": ${c.diverted}}'::jsonb, ${c.hasAttempt ? `'00000000-0000-0000-0000-${String(i).padStart(12, '0')}'::uuid` : 'NULL::uuid'}, ${c.hasAttempt ? `'${c.status}'` : 'NULL'}, ${c.hasAttempt && c.ps ? `'${c.ps}'` : 'NULL'}, ${c.hasAttempt && c.ds ? `'${c.ds}'` : 'NULL'}, ${c.hasAttempt && c.poste ? `'${c.poste}'` : 'NULL'})`).join(',\n');
  const sql = `SELECT v.i, ${postalLegalOutcomeCaseSql(ar, { r: 'v', la: 'v', ppt: 'vp' })} AS outcome
    FROM (VALUES ${values}) AS v(i, inad_check, id, status, postal_status, postal_delivery_status, ppt_status)
    CROSS JOIN LATERAL (SELECT v.ppt_status AS status) vp
    ORDER BY v.i`;
  const { rows } = await client.query(sql);
  for (const row of rows) {
    const c = cases[row.i];
    const ts = postalLegalOutcome({
      diverted: c.diverted,
      arTracking: ar,
      attempt: c.hasAttempt ? { status: c.status, postalStatus: c.ps, postalDeliveryStatus: c.ds, postalDeliveryDate: null, sentAt: null } : null,
      poste: c.hasAttempt && c.poste ? { status: c.poste, outcomeAt: null } : null,
    }).outcome;
    if (ts !== row.outcome) { mismatches++; if (mismatches <= 20) console.log('MISMATCH', { ar, ...c, sql: row.outcome, ts }); }
  }
  console.log(`ar=${ar}: ${rows.length} casi confrontati`);
}
await client.end();
console.log(mismatches === 0 ? 'OK: SQL e TS coincidono' : `KO: ${mismatches} differenze`);
process.exit(mismatches === 0 ? 0 : 1);
