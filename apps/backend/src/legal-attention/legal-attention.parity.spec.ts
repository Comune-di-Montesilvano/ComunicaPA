import { describe, it, expect } from 'vitest';
import { DataSource } from 'typeorm';
import { legalAttentionClassifiedSql, legalAttentionOf, isLegalAttentionCampaign, fromUtcWallClock } from './legal-attention.util.js';
import { postalLegalOutcome } from '../campaigns/postal-legal-outcome.util.js';

/**
 * Parità regola TS (legalAttentionOf) / gemella SQL su Postgres vero: fixture
 * dentro BEGIN … ROLLBACK, niente resta nel DB. Gira solo dove c'è un DB
 * (container dev: `docker compose exec backend node_modules/.bin/vitest run
 * legal-attention.parity`); la CI non ha Postgres e la salta.
 */
type Fixture = {
  key: string;
  campaign: 'send' | 'postalBool' | 'postalNumber' | 'postalFalse';
  recipientStatus?: string;
  attempts: Array<{
    daysAgo: number;
    status?: string;
    sendStatus?: string | null;
    history?: Array<{ status: string; activeFrom: string }>;
    postalStatus?: string | null;
    postalDeliveryStatus?: string | null;
  }>;
  expected: 'blocking' | 'stale' | null | 'excluded';
};

const FIXTURES: Fixture[] = [
  { key: 's-refused', campaign: 'send', attempts: [{ daysAgo: 1, sendStatus: 'REFUSED' }], expected: 'blocking' },
  { key: 's-failed', campaign: 'send', attempts: [{ daysAgo: 1, status: 'failed', sendStatus: null }], expected: 'blocking' },
  { key: 's-stale', campaign: 'send', attempts: [{ daysAgo: 60, sendStatus: 'DELIVERING' }], expected: 'stale' },
  { key: 's-young', campaign: 'send', attempts: [{ daysAgo: 44, sendStatus: 'DELIVERING' }], expected: null },
  { key: 's-legal', campaign: 'send', attempts: [{ daysAgo: 90, sendStatus: 'EFFECTIVE_DATE', history: [{ status: 'UNREACHABLE', activeFrom: '2026-07-01T10:00:00Z' }, { status: 'EFFECTIVE_DATE', activeFrom: '2026-07-11T10:00:00Z' }] }], expected: null },
  { key: 's-viewed-empty', campaign: 'send', attempts: [{ daysAgo: 50, sendStatus: 'VIEWED', history: [{ status: 'VIEWED', activeFrom: '' }] }], expected: 'stale' },
  { key: 's-cancelled-attempt', campaign: 'send', attempts: [{ daysAgo: 90, status: 'cancelled' }], expected: null },
  { key: 's-cancelled-recipient', campaign: 'send', recipientStatus: 'cancelled', attempts: [{ daysAgo: 90, sendStatus: 'REFUSED' }], expected: 'excluded' },
  { key: 's-retry', campaign: 'send', attempts: [{ daysAgo: 60, status: 'failed' }, { daysAgo: 1, sendStatus: 'DELIVERING' }], expected: 'stale' },
  { key: 's-no-attempts', campaign: 'send', attempts: [], expected: null },
  { key: 'p-deceased', campaign: 'postalBool', attempts: [{ daysAgo: 3, postalStatus: 'Restituito', postalDeliveryStatus: 'Destinatario deceduto' }], expected: 'blocking' },
  { key: 'p-stale', campaign: 'postalBool', attempts: [{ daysAgo: 50, postalStatus: 'InLavorazione' }], expected: 'stale' },
  { key: 'p-delivered', campaign: 'postalBool', attempts: [{ daysAgo: 50, postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato' }], expected: null },
  { key: 'p-receipt-number', campaign: 'postalNumber', attempts: [{ daysAgo: 50, postalStatus: 'InLavorazione' }], expected: 'stale' },
  { key: 'p-no-receipt', campaign: 'postalFalse', attempts: [{ daysAgo: 50, postalStatus: 'InLavorazione' }], expected: 'excluded' },
];

interface AttemptRow {
  status: string;
  error_message: string | null;
  send_status: string | null;
  send_status_history: Array<{ status: string; activeFrom: string }> | null;
  postal_status: string | null;
  postal_delivery_status: string | null;
  postal_delivery_date: Date | null;
  sent_at: Date | null;
  postal_status_history: Array<{ codiceErrore?: string; descrizione?: string }> | null;
  created_at: Date;
}

const CAMPAIGNS = {
  send: { channelType: 'SEND', channelConfig: {} },
  postalBool: { channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true } },
  postalNumber: { channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: 1 } },
  postalFalse: { channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: false } },
} as const;

describe.skipIf(!process.env.DATABASE_URL)('legal-attention — parità TS/SQL su Postgres', () => {
  it('ogni caso della tabella di classificazione dà lo stesso risultato in TS e in SQL', async () => {
    const ds = await new DataSource({ type: 'postgres', url: process.env.DATABASE_URL }).initialize();
    const client = ds.createQueryRunner();
    await client.connect();
    try {
      await client.startTransaction();
      const campaignIds: Record<string, string> = {};
      for (const [key, c] of Object.entries(CAMPAIGNS)) {
        const rows: Array<{ id: string }> = await client.query(
          `INSERT INTO campaigns (id, name, status, channel_type, channel_config, created_by, is_test)
           VALUES (gen_random_uuid(), $1, 'completed', $2, $3::jsonb, 'parity-test', false) RETURNING id`,
          [`PARITY ${key}`, c.channelType, JSON.stringify(c.channelConfig)],
        );
        campaignIds[key] = rows[0].id;
      }
      const recipientIds: Record<string, string> = {};
      for (const f of FIXTURES) {
        const rows: Array<{ id: string }> = await client.query(
          `INSERT INTO recipients (id, campaign_id, codice_fiscale, full_name, status)
           VALUES (gen_random_uuid(), $1, 'RSSMRA80A01H501U', $2, $3) RETURNING id`,
          [campaignIds[f.campaign], `ROSSI MARIO ${f.key}`, f.recipientStatus ?? 'sent'],
        );
        recipientIds[f.key] = rows[0].id;
        for (const [i, a] of f.attempts.entries()) {
          // Come il default del DB: ora UTC senza fuso.
          await client.query(
            `INSERT INTO notification_attempts (id, recipient_id, channel_type, status, attempt_number, send_status, send_status_history, postal_status, postal_delivery_status, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, (now() AT TIME ZONE 'UTC') - make_interval(days => $9))`,
            [recipientIds[f.key], CAMPAIGNS[f.campaign].channelType, a.status ?? 'success', i + 1, a.sendStatus ?? null,
              a.history ? JSON.stringify(a.history) : null, a.postalStatus ?? null, a.postalDeliveryStatus ?? null, a.daysAgo],
          );
        }
      }

      const ids = Object.values(campaignIds);
      const sqlRows: Array<{ recipient_id: string; kind: string | null }> = await client.query(
        `SELECT recipient_id, kind FROM (${legalAttentionClassifiedSql('r.campaign_id = ANY($1::uuid[])')}) x`,
        [ids],
      );
      const sqlKind = new Map(sqlRows.map((r) => [r.recipient_id, r.kind ?? null]));

      const now = new Date();
      for (const f of FIXTURES) {
        const id = recipientIds[f.key];
        const attempts: AttemptRow[] = await client.query(
          `SELECT status, error_message, send_status, send_status_history, postal_status, postal_delivery_status, postal_delivery_date, sent_at, postal_status_history, created_at
           FROM notification_attempts WHERE recipient_id = $1 ORDER BY attempt_number`,
          [id],
        );
        const c = CAMPAIGNS[f.campaign];
        const inPerimeter = isLegalAttentionCampaign({ channelType: c.channelType, channelConfig: { ...c.channelConfig }, isTest: false })
          && !['cancelled', 'skipped'].includes(f.recipientStatus ?? 'sent');
        const last = attempts[attempts.length - 1];
        const first = attempts.reduce<Date | null>((min, a) => (!min || a.created_at < min ? a.created_at : min), null);
        const ts = inPerimeter
          ? legalAttentionOf({
              channelType: c.channelType,
              now,
              firstAttemptAt: first ? fromUtcWallClock(first) : null,
              lastAttempt: last ? { status: last.status, errorMessage: last.error_message, sendStatus: last.send_status, sendStatusHistory: last.send_status_history } : null,
              postal: c.channelType === 'POSTAL'
                ? postalLegalOutcome({
                    diverted: false,
                    arTracking: true,
                    attempt: last
                      ? { status: last.status, postalStatus: last.postal_status, postalDeliveryStatus: last.postal_delivery_status, postalDeliveryDate: last.postal_delivery_date, sentAt: last.sent_at, errorMessage: last.error_message, postalStatusHistory: last.postal_status_history }
                      : null,
                    poste: null,
                  })
                : null,
            })
          : null;

        if (f.expected === 'excluded') {
          expect(sqlKind.has(id), `${f.key}: escluso in SQL`).toBe(false);
          expect(inPerimeter, `${f.key}: escluso in TS`).toBe(false);
        } else {
          expect(sqlKind.get(id) ?? null, `${f.key}: SQL`).toBe(f.expected);
          expect(ts?.kind ?? null, `${f.key}: TS`).toBe(f.expected);
        }
      }
    } finally {
      await client.rollbackTransaction();
      await client.release();
      await ds.destroy();
    }
  });
});
