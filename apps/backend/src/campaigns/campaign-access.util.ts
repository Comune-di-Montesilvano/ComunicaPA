import { CampaignStatus, type Campaign } from '../entities/campaign.entity.js';
import type { CampaignRequester } from './campaigns.service.js';

export type CampaignAccessSubject = Pick<Campaign, 'createdBy' | 'signerUsername' | 'status'>;

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

/** Le bozze sono visibili solo a chi può leggerne gli allegati; le altre a tutti. */
export function canViewCampaign(
  campaign: CampaignAccessSubject,
  requester: Pick<CampaignRequester, 'username' | 'role'>,
): boolean {
  return campaign.status !== CampaignStatus.DRAFT || canReadCampaignAttachments(campaign, requester);
}
