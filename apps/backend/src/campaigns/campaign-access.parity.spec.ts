import { describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { canViewCampaign, visibleCampaignSql } from './campaign-access.util.js';

/**
 * Parità canViewCampaign (TS) / visibleCampaignSql (SQL) su Postgres vero:
 * fixture dentro BEGIN … ROLLBACK, niente resta nel DB. La CI non ha
 * Postgres e la salta; in dev: vitest run campaign-access.parity.
 */
const FIXTURES = [
  { key: 'bozza-rossi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT },
  { key: 'bozza-rossi-firma-verdi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT },
  { key: 'bozza-bianchi', createdBy: 'bianchi', signerUsername: null, status: CampaignStatus.DRAFT },
  { key: 'running-rossi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.RUNNING },
  { key: 'completed-rossi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.COMPLETED },
] as const;

const REQUESTERS = [
  { username: 'bianchi', role: 'user' },
  { username: 'verdi', role: 'user' },
  { username: 'rossi', role: 'user' },
  { username: 'boss', role: 'admin' },
] as const;

describe.skipIf(!process.env.DATABASE_URL)('campaign-access — parità TS/SQL su Postgres', () => {
  it('visibleCampaignSql seleziona esattamente le campagne di canViewCampaign', async () => {
    const ds = await new DataSource({ type: 'postgres', url: process.env.DATABASE_URL }).initialize();
    const client = ds.createQueryRunner();
    try {
      await client.startTransaction();
      const ids = new Map<string, string>();
      for (const f of FIXTURES) {
        const rows: Array<{ id: string }> = await client.query(
          `INSERT INTO campaigns (name, status, channel_type, channel_config, created_by, signer_username, is_test)
           VALUES ($1, $2, 'EMAIL', '{}', $3, $4, true) RETURNING id`,
          [`parity-${f.key}`, f.status, f.createdBy, f.signerUsername],
        );
        ids.set(rows[0]!.id, f.key);
      }
      for (const requester of REQUESTERS) {
        const visible = visibleCampaignSql('c', requester);
        const qb = ds
          .createQueryBuilder()
          .select('c.id', 'id')
          .from('campaigns', 'c')
          .where('c.id IN (:...ids)', { ids: [...ids.keys()] });
        if (visible) qb.andWhere(visible.sql, visible.params);
        const [sql, params] = qb.getQueryAndParameters();
        const rows: Array<{ id: string }> = await client.query(sql, params);
        const fromSql = rows.map((r) => ids.get(r.id)).sort();
        const fromTs = FIXTURES.filter((f) => canViewCampaign(f, requester)).map((f) => f.key).sort();
        expect(fromSql, `${requester.username}/${requester.role}`).toEqual(fromTs);
      }
    } finally {
      await client.rollbackTransaction();
      await client.release();
      await ds.destroy();
    }
  });
});
