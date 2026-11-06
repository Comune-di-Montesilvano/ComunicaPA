import { describe, expect, it } from 'vitest';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { canReadCampaignAttachments, canViewCampaign } from './campaign-access.util.js';

describe('campaign-access', () => {
  it.each([
    { nome: 'admin qualunque', role: 'admin', username: 'boss', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, isTest: false, read: true, view: true },
    { nome: 'creatore', role: 'user', username: 'rossi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, isTest: false, read: true, view: true },
    { nome: 'firmatario', role: 'user', username: 'verdi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT, isTest: false, read: true, view: true },
    { nome: 'altro user, bozza', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT, isTest: false, read: false, view: false },
    { nome: 'altro user, bozza senza firmatario', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.DRAFT, isTest: false, read: false, view: false },
    { nome: 'altro user, campagna in corso', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.RUNNING, isTest: false, read: false, view: true },
    // Invii di prova: stessa regola delle bozze qualunque sia lo stato (ruling controller).
    { nome: 'altro user, invio di prova QUEUED', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.QUEUED, isTest: true, read: false, view: false },
    { nome: 'altro user, invio di prova COMPLETED', role: 'user', username: 'bianchi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.COMPLETED, isTest: true, read: false, view: false },
    { nome: 'creatore, invio di prova', role: 'user', username: 'rossi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.COMPLETED, isTest: true, read: true, view: true },
    { nome: 'firmatario, invio di prova', role: 'user', username: 'verdi', createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.QUEUED, isTest: true, read: true, view: true },
    { nome: 'admin, invio di prova', role: 'admin', username: 'boss', createdBy: 'rossi', signerUsername: null, status: CampaignStatus.COMPLETED, isTest: true, read: true, view: true },
  ] as const)('$nome', ({ role, username, createdBy, signerUsername, status, isTest, read, view }) => {
    const campaign = { createdBy, signerUsername, status, isTest };
    const requester = { username, role };
    expect(canReadCampaignAttachments(campaign, requester)).toBe(read);
    expect(canViewCampaign(campaign, requester)).toBe(view);
  });
});
