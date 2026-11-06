import { CampaignStatus, type Campaign } from '../entities/campaign.entity.js';
import type { CampaignRequester } from './campaigns.service.js';

export type CampaignAccessSubject = Pick<Campaign, 'createdBy' | 'signerUsername' | 'status' | 'isTest'>;

export const ATTACHMENT_DENIED_MESSAGE =
  'Allegato visibile solo a chi ha creato la campagna, agli amministratori e al firmatario indicato';

/** Allegati leggibili da: admin, creatore, firmatario indicato. */
export function canReadCampaignAttachments(
  campaign: CampaignAccessSubject,
  requester: Pick<CampaignRequester, 'username' | 'role'>,
): boolean {
  if (requester.role === 'admin') return true;
  if (campaign.createdBy === requester.username) return true;
  return campaign.signerUsername != null && campaign.signerUsername === requester.username;
}

/**
 * Bozze e invii di prova (isTest, qualunque stato: sono verifiche interne di
 * una bozza) visibili solo a chi può leggerne gli allegati; le altre a tutti.
 */
export function canViewCampaign(
  campaign: CampaignAccessSubject,
  requester: Pick<CampaignRequester, 'username' | 'role'>,
): boolean {
  return (campaign.status !== CampaignStatus.DRAFT && !campaign.isTest) || canReadCampaignAttachments(campaign, requester);
}

/**
 * Gemella SQL di canViewCampaign per filtrare elenchi (findAll,
 * getRecentActivity, ricerca notifiche). `alias` = alias della tabella
 * campaigns nella query; usa i nomi colonna, quindi vale sia in un
 * QueryBuilder TypeORM sia in SQL grezzo con parametri nominati.
 * Admin → null: nessun filtro da applicare.
 */
export function visibleCampaignSql(
  alias: string,
  requester: Pick<CampaignRequester, 'username' | 'role'>,
): { sql: string; params: { visibleCampaignUser: string } } | null {
  if (requester.role === 'admin') return null;
  return {
    sql: `((${alias}.status <> 'draft' AND ${alias}.is_test = false) OR ${alias}.created_by = :visibleCampaignUser OR ${alias}.signer_username = :visibleCampaignUser)`,
    params: { visibleCampaignUser: requester.username },
  };
}
