import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignsService } from './campaigns.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { ConfigService } from '@nestjs/config';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { InadService } from '../channels/inad/inad.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { RegistroImpreseService } from '../channels/registro-imprese/registro-imprese.service.js';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';

function makeQb(result: { many?: any[]; count?: number; raw?: any[] } = {}) {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'leftJoin', 'innerJoin', 'groupBy', 'orderBy', 'addOrderBy', 'skip', 'take']) qb[m] = vi.fn().mockReturnValue(qb);
  qb.getManyAndCount = vi.fn().mockResolvedValue([result.many ?? [], result.count ?? 0]);
  qb.getRawMany = vi.fn().mockResolvedValue(result.raw ?? []);
  qb.getCount = vi.fn().mockResolvedValue(result.count ?? 0);
  return qb;
}

describe('CampaignsService - stato Letto (canali digitali)', () => {
  let service: CampaignsService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let downloadEventRepo: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: vi.fn().mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true } }) };
    recipientRepo = { find: vi.fn(), createQueryBuilder: vi.fn() };
    attemptRepo = { find: vi.fn() };
    posteRepo = { find: vi.fn().mockResolvedValue([]), query: vi.fn().mockResolvedValue([]) };
    downloadEventRepo = { find: vi.fn().mockResolvedValue([]) };
    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: PostalAuthorizedUsersService, useValue: {} },
        { provide: SignatureVerificationBulkService, useValue: {} },
        { provide: SignatureVerificationService, useValue: {} },
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadEventRepo },
        { provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: vi.fn() } },
        { provide: ConfigService, useValue: {} },
        { provide: InadService, useValue: {} },
        { provide: PostalStatusSyncService, useValue: {} },
        { provide: RegistroImpreseService, useValue: {} },
        { provide: RegistroImpreseVerifyQueueService, useValue: {} },
      ],
    }).compile();
    service = module.get(CampaignsService);
  });


  function digital(channelType = 'EMAIL') {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType, channelConfig: {} });
  }

  it('filtro status=read: inviato E almeno un download', async () => {
    digital();
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, 'read');
    expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: 'sent' });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain('r.download_count > 0 OR EXISTS (SELECT 1 FROM download_events');
    expect(sql).not.toContain('NOT (r.download_count');
  });

  it('filtro status=sent su canale digitale: solo inviati NON ancora letti', async () => {
    digital('PEC');
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, 'sent');
    expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: 'sent' });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain('NOT (r.download_count > 0');
  });

  it('filtro status=sent su POSTAL: invariato (nessun concetto di letto)', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, 'sent');
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).not.toContain('download_count');
  });

  it('opzioni filtro stato su canale digitale: "read" separato da "sent" nella stessa query', async () => {
    digital('APP_IO');
    const qbs: any[] = [];
    recipientRepo.createQueryBuilder.mockImplementation(() => { const q = makeQb(); qbs.push(q); return q; });
    await service.getRecipientFilterOptions('c1');
    const statusQb = qbs[0];
    const selectExpr = String(statusQb.select.mock.calls[0][0]);
    expect(selectExpr).toContain("THEN 'read'");
    expect(String(statusQb.groupBy.mock.calls[0][0])).toBe(selectExpr);
  });

  it('opzioni filtro stato su POSTAL: r.status semplice', async () => {
    const qbs: any[] = [];
    recipientRepo.createQueryBuilder.mockImplementation(() => { const q = makeQb(); qbs.push(q); return q; });
    await service.getRecipientFilterOptions('c1');
    expect(qbs[0].select.mock.calls[0][0]).toBe('r.status');
  });
});
