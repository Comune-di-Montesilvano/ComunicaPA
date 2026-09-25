import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsSearchService } from './notifications-search.service.js';
import { NotificationsSearchController } from './notifications-search.controller.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { SendLegalFactsService } from '../channels/send/send-legal-facts.service.js';
import { AttachmentService } from '../attachments/attachment.service.js';

function recipientRow(id: string) {
  return { id, campaignId: 'c1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', status: 'sent', createdAt: new Date('2026-07-01T00:00:00Z'), campaign: { name: 'Avviso', channelType: 'POSTAL' } };
}

describe('NotificationsSearchService - verifica Poste', () => {
  let qb: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let downloadRepo: any;
  let campaignsService: any;
  let service: NotificationsSearchService;

  beforeEach(async () => {
    qb = {};
    for (const m of ['leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take']) qb[m] = vi.fn().mockReturnValue(qb);
    qb.getManyAndCount = vi.fn().mockResolvedValue([[], 0]);
    recipientRepo = { createQueryBuilder: vi.fn(() => qb), findOne: vi.fn() };
    attemptRepo = { find: vi.fn() };
    posteRepo = { find: vi.fn().mockResolvedValue([]), query: vi.fn().mockResolvedValue([]) };
    downloadRepo = { find: vi.fn().mockResolvedValue([]) };
    campaignsService = { renderMessageForRecipient: vi.fn().mockResolvedValue({ subject: 's', bodyHtml: '' }), renderAppIoCoDeliveryPreview: vi.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadRepo },
        { provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo },
        { provide: CampaignsService, useValue: campaignsService },
        { provide: SendLegalFactsService, useValue: {} },
        { provide: AttachmentService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('filtro posteVerification=delivered usa il predicato di discrepanza sull\'ultimo attempt', async () => {
    await service.search({ posteVerification: 'delivered', page: 1, pageSize: 50 });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain("ppt.status = 'delivered'");
    expect(sql).toContain("COALESCE(na.postal_status, '') <> 'Consegnato'");
    expect(sql).toContain('SELECT MAX(na2.attempt_number)');
  });

  it('filtro posteVerification=pending filtra per stato riga', async () => {
    await service.search({ posteVerification: 'pending', page: 1, pageSize: 50 });
    const call = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('postal_poste_tracking ppt2'));
    expect(String(call[0])).toContain('ppt2.status = :pv');
    expect(call[1]).toEqual({ pv: 'pending' });
  });

  it('filtro posteVerification=any: qualunque riga, senza vincolo di stato', async () => {
    await service.search({ posteVerification: 'any', page: 1, pageSize: 50 });
    const call = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('postal_poste_tracking ppt2'));
    expect(String(call[0])).not.toContain('ppt2.status');
  });

  it('righe risultato: stato verifica dall\'ultimo attempt, delivered senza NonConsegnato scartato', async () => {
    qb.getManyAndCount.mockResolvedValue([[recipientRow('r1'), recipientRow('r2'), recipientRow('r3'), recipientRow('r4')], 4]);
    posteRepo.query.mockResolvedValue([
      { recipientId: 'r1', status: 'delivered', postalStatus: 'NonConsegnato' },
      { recipientId: 'r2', status: 'delivered', postalStatus: 'Consegnato' },
      { recipientId: 'r4', status: 'delivered', postalStatus: 'Confermato' },
      { recipientId: 'r3', status: 'pending', postalStatus: 'NonConsegnato' },
    ]);
    const { rows } = await service.search({ page: 1, pageSize: 50 });
    expect(rows.map((r) => r.posteVerificationStatus)).toEqual(['delivered', null, 'pending', 'delivered']);
    expect(posteRepo.query.mock.calls[0][1]).toEqual([['r1', 'r2', 'r3', 'r4']]);
  });

  it('dettaglio: posteVerification sugli attempt POSTAL con riga, null sugli altri', async () => {
    recipientRepo.findOne.mockResolvedValue({ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: null, pec: null, status: 'sent', extraData: {}, campaign: { id: 'c1', name: 'Avviso', channelType: 'POSTAL', channelConfig: {} } });
    attemptRepo.find.mockResolvedValue([
      { id: 'a1', attemptNumber: 1, status: 'success', channelType: 'POSTAL', errorMessage: null, sentAt: null, createdAt: new Date('2026-07-01T00:00:00Z'), responsePayload: {}, postalStatus: 'NonConsegnato' },
      { id: 'a2', attemptNumber: 2, status: 'success', channelType: 'POSTAL', errorMessage: null, sentAt: null, createdAt: new Date('2026-07-02T00:00:00Z'), responsePayload: {}, postalStatus: 'Accettato' },
    ]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'pending', trackingCode: 'RN000000000IT', checkCount: 2, nextCheckAt: null, lastCheckedAt: null, lastError: null, deliveredAt: null, movements: [] }]);
    const detail = await service.getDetail('r1');
    expect(detail.attempts[0]).toMatchObject({ posteVerification: { status: 'pending', checkCount: 2, trackingUntil: null } });
    expect(detail.attempts[1]).toMatchObject({ posteVerification: null });
  });
});

describe('NotificationsSearchService - stato Letto (canali digitali)', () => {
  let qb: any;
  let service: NotificationsSearchService;
  let downloadRepo: any;

  function recipient(id: string, channelType: string, status = 'sent', downloadCount = 0) {
    return { id, campaignId: 'c1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', status, downloadCount, createdAt: new Date('2026-07-01T00:00:00Z'), campaign: { name: 'Avviso', channelType } };
  }

  beforeEach(async () => {
    qb = {};
    for (const m of ['leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take']) qb[m] = vi.fn().mockReturnValue(qb);
    qb.getManyAndCount = vi.fn().mockResolvedValue([[], 0]);
    downloadRepo = { find: vi.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: { createQueryBuilder: vi.fn(() => qb) } },
        { provide: getRepositoryToken(NotificationAttempt), useValue: { find: vi.fn() } },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadRepo },
        { provide: CampaignsService, useValue: {} },
        { provide: SendLegalFactsService, useValue: {} },
        { provide: AttachmentService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('riga: sent + download su canale digitale → read; POSTAL resta sent', async () => {
    qb.getManyAndCount.mockResolvedValue([[recipient('r1', 'EMAIL', 'sent', 1), recipient('r2', 'PEC'), recipient('r3', 'APP_IO'), recipient('r4', 'POSTAL', 'sent', 3)], 4]);
    downloadRepo.find.mockResolvedValue([{ recipientId: 'r3' }]);
    const { rows } = await service.search({ page: 1, pageSize: 50 });
    expect(rows.map((r) => r.status)).toEqual(['read', 'sent', 'read', 'sent']);
  });

  it('filtro status=read: inviato, canale digitale, con download', async () => {
    await service.search({ status: 'read', page: 1, pageSize: 50 });
    expect(qb.andWhere).toHaveBeenCalledWith('recipient.status = :status', { status: 'sent' });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain("campaign.channelType IN ('EMAIL', 'PEC', 'APP_IO')");
    expect(sql).toContain('recipient.download_count > 0 OR EXISTS');
  });

  it('filtro status=sent: esclude i letti dei canali digitali', async () => {
    await service.search({ status: 'sent', page: 1, pageSize: 50 });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain("NOT (campaign.channelType IN ('EMAIL', 'PEC', 'APP_IO') AND");
  });
});

describe('NotificationsSearchController - posteVerification', () => {
  it('passa posteVerification solo se valore ammesso', () => {
    const svc = { search: vi.fn() };
    const ctrl = new NotificationsSearchController(svc as any);
    ctrl.search(undefined, undefined, undefined, undefined, undefined, undefined, undefined, '1', '50', 'delivered');
    expect(svc.search).toHaveBeenLastCalledWith(expect.objectContaining({ posteVerification: 'delivered' }));
    ctrl.search(undefined, undefined, undefined, undefined, undefined, undefined, undefined, '1', '50', 'DROP');
    expect(svc.search).toHaveBeenLastCalledWith(expect.objectContaining({ posteVerification: undefined }));
  });
});
