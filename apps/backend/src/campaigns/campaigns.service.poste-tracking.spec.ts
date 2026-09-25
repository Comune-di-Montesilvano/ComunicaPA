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

describe('CampaignsService - verifica Poste', () => {
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

  it('breakdown: NonConsegnato + Poste delivered → bucket ConsegnatoVerificaPoste', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: null }, { id: 'r2', inadCheck: null }]);
    attemptRepo.find.mockResolvedValue([
      { id: 'a1', recipientId: 'r1', attemptNumber: 1, status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' },
      { id: 'a2', recipientId: 'r2', attemptNumber: 1, status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' },
    ]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered' }]);
    const result = await service.getPostalDeliveryStatusBreakdown('c1');
    expect(result).toEqual(expect.arrayContaining([
      { status: 'ConsegnatoVerificaPoste', count: 1 },
      { status: 'Indirizzo errato o inesatto', count: 1 },
    ]));
    expect(result).toHaveLength(2);
  });

  it('breakdown: conta solo l\'ultimo attempt del destinatario', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: null }]);
    attemptRepo.find.mockResolvedValue([
      { id: 'a1', recipientId: 'r1', attemptNumber: 1, status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' },
      { id: 'a2', recipientId: 'r1', attemptNumber: 2, status: 'success', postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato' },
    ]);
    posteRepo.find.mockImplementation(async ({ where }: any) => [{ attemptId: 'a1', status: 'delivered' }].filter((p) => JSON.stringify(where).includes(p.attemptId)));
    expect(await service.getPostalDeliveryStatusBreakdown('c1')).toEqual([{ status: 'Consegnato', count: 1 }]);
  });

  it('breakdown: GlobalCom uscito da NonConsegnato → nessun override', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: null }]);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, status: 'success', postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato' }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered' }]);
    expect(await service.getPostalDeliveryStatusBreakdown('c1')).toEqual([{ status: 'Consegnato', count: 1 }]);
  });

  it('filtro lista: ramo dedicato per il bucket, generico esclude gli override', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'ConsegnatoVerificaPoste');
    const dedicated = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(dedicated).toContain("ppt.status = 'delivered'");
    expect(dedicated).not.toContain(':postalDeliveryStatus');

    const qb2 = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb2);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'Indirizzo errato o inesatto');
    const generic = qb2.andWhere.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => s.includes(':postalDeliveryStatus'));
    expect(generic).toContain("AND NOT (na.postal_status = 'NonConsegnato'");
  });

  it('lista: espone stato verifica Poste sull\'ultimo attempt POSTAL', async () => {
    const qb = makeQb({ many: [{ id: 'r1', downloadCount: 0 }], count: 1 });
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', postalStatus: 'NonConsegnato' }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered', deliveredAt: new Date('2026-09-04T08:06:00Z') }]);
    const page = await service.getRecipientStats('c1', 1, 50);
    expect(page.items[0]).toMatchObject({ posteVerificationStatus: 'delivered', posteDeliveredAt: new Date('2026-09-04T08:06:00Z') });
  });

  it('report postale: verifica e discrepanza sull\'ultimo attempt', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', extraData: {} }]);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto', postalStatusHistory: [] }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered', checkCount: 3, deliveredAt: new Date('2026-09-04T08:06:00Z'), outcomeAt: new Date('2026-09-04T08:06:00Z'), movements: [{ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false }] }]);
    const report = await service.getPostalReportRows('c1');
    expect(report.rows[0]).toMatchObject({
      posteDiscrepancy: true,
      posteVerification: { status: 'delivered', checkCount: 3, deliveredAt: '2026-09-04T08:06:00.000Z', outcomeAt: '2026-09-04T08:06:00.000Z' },
    });
    expect(report.rows[0]!.posteVerification!.lastMovement).toContain('SVIZZERA');
  });

  it('tag posteChecked: solo destinatari con almeno una risposta valida di Poste sull\'ultimo attempt', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, ['posteChecked']);
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => s.includes('postal_poste_tracking'));
    expect(sql).toContain('ppt.poste_esito_ricerca IS NOT NULL');
    expect(sql).toContain('SELECT MAX(na2.attempt_number)');
  });

  it('opzioni filtro: conteggio controllati su Poste', async () => {
    recipientRepo.createQueryBuilder.mockImplementation(() => makeQb());
    posteRepo.query = vi.fn().mockResolvedValue([{ n: 7 }]);
    const opts = await service.getRecipientFilterOptions('c1');
    expect(opts.posteCheckedCount).toBe(7);
    expect(posteRepo.query.mock.calls[0][0]).toContain('ppt.poste_esito_ricerca IS NOT NULL');
    expect(posteRepo.query.mock.calls[0][1]).toEqual(['c1']);
  });

  it('opzioni filtro: valore = CASE sul bucket, sottoquery espone id e postal_status', async () => {
    const qbs: any[] = [];
    recipientRepo.createQueryBuilder.mockImplementation(() => { const q = makeQb(); qbs.push(q); return q; });
    await service.getRecipientFilterOptions('c1');
    const postalQb = qbs.find((q) => q.select.mock.calls.some((c: any[]) => String(c[0]).includes("'ConsegnatoVerificaPoste'")));
    expect(postalQb).toBeDefined();
    expect(String(postalQb.leftJoin.mock.calls[0][0])).toMatch(/id, recipient_id, postal_status, postal_delivery_status/);
  });
});
