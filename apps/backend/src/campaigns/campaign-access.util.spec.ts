import { describe, expect, it } from 'vitest';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { canReadCampaignAttachments, canViewCampaign } from './campaign-access.util.js';

describe('campaign-access', () => {
  it.each([
    { nome: 'admin qualunque', role: 'admin', username: 'boss', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, read: true, view: true },
    { nome: 'creatore', role: 'user', username: 'rossi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, read: true, view: true },
    { nome: 'firmatario', role: 'user', username: 'verdi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT, read: true, view: true },
    { nome: 'altro user, bozza', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT, read: false, view: false },
    { nome: 'altro user, bozza senza firmatario', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, read: false, view: false },
    { nome: 'altro user, campagna in corso', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.RUNNING, read: false, view: true },
  ] as const)('$nome', ({ role, username, createdBy, signerUsername, status, read, view }) => {
    const campaign = { createdBy, signerUsername, status };
    const requester = { username, role };
    expect(canReadCampaignAttachments(campaign, requester)).toBe(read);
    expect(canViewCampaign(campaign, requester)).toBe(view);
  });
});
