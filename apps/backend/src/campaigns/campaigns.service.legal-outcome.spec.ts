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

describe('CampaignsService - esito legale POSTAL', () => {
  let service: CampaignsService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let downloadEventRepo: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: vi.fn().mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true } }) };
    recipientRepo = { find: vi.fn(), createQueryBuilder: vi.fn(), query: vi.fn().mockResolvedValue([]) };
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


  const AR = { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true };
  const whereSql = (qb: any) => qb.andWhere.mock.calls.map((c: any[]) => String(c[0]));

  it('filtro Stato documento con codice esito: espressione esito, mai postal_status grezzo', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, 'delivered');
    const where = whereSql(qb);
    expect(where.some((w: string) => w.includes('LEFT JOIN LATERAL') && w.includes('= :legalOutcome'))).toBe(true);
    expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('= :legalOutcome'), { legalOutcome: 'delivered' });
    expect(where.some((w: string) => w.includes(':deliveryStatus'))).toBe(false);
  });

  it('filtro esito legale e filtro Recapito Poste si sommano', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, 'delivered', undefined, undefined, 'Compiuta Giacenza');
    const where = whereSql(qb);
    expect(where.some((w: string) => w.includes('= :legalOutcome'))).toBe(true);
    expect(where.some((w: string) => w.includes('na.postal_delivery_status = :postalDeliveryStatus'))).toBe(true);
  });

  it('status=failed include gli Errore GlobalCom, status=sent li esclude', async () => {
    let qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, 'failed');
    expect(whereSql(qb).some((w: string) => w.includes("r.status = 'failed' OR") && w.includes("na_err.postal_status = 'Errore'"))).toBe(true);
    qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, 'sent');
    expect(whereSql(qb).some((w: string) => w.startsWith('NOT EXISTS') && w.includes("na_err.postal_status = 'Errore'"))).toBe(true);
  });

  it('ordinamento Stato Documento su POSTAL: per esito legale', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, undefined, undefined, undefined, 'postalStatus', 'ASC');
    expect(String(qb.orderBy.mock.calls[0][0])).toContain('LEFT JOIN LATERAL');
  });

  it('riga: esito, motivo e data legale; Errore GlobalCom mostrato Fallito', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: AR });
    const qb = makeQb({ many: [
      { id: 'r1', status: 'sent', inadCheck: null, downloadCount: 0 },
      { id: 'r2', status: 'sent', inadCheck: null, downloadCount: 0 },
      { id: 'r3', status: 'sent', inadCheck: { found: true, diverted: true }, downloadCount: 0 },
      { id: 'r4', status: 'queued', inadCheck: null, downloadCount: 0 },
    ], count: 4 });
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    attemptRepo.find.mockResolvedValue([
      { id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Compiuta Giacenza', postalDeliveryDate: new Date('2026-09-08T00:00:00Z'), sentAt: new Date('2026-07-30T00:00:00Z'), errorMessage: null },
      { id: 'a2', recipientId: 'r2', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'Errore', postalDeliveryStatus: null, postalDeliveryDate: null, postalStatusHistory: [{ stato: 'Errore', rilevatoIl: '2026-07-31', codiceErrore: '1327', descrizione: 'Nazione non ammessa' }], sentAt: new Date('2026-07-30T00:00:00Z'), errorMessage: null },
      { id: 'a3', recipientId: 'r3', attemptNumber: 1, channelType: 'PEC', status: 'success', postalStatus: null, postalDeliveryStatus: null, postalDeliveryDate: null, sentAt: new Date('2026-08-01T10:00:00Z'), errorMessage: null },
    ]);
    const page = await service.getRecipientStats('c1', 1, 50);
    expect(page.items[0]).toMatchObject({ status: 'sent', legalOutcome: 'delivered', legalOutcomeReason: 'Compiuta Giacenza', legalOutcomeAt: new Date('2026-09-08T00:00:00Z') });
    expect(page.items[1]).toMatchObject({ status: 'failed', legalOutcome: 'not_delivered', legalOutcomeReason: '1327: Nazione non ammessa', lastError: '1327: Nazione non ammessa' });
    expect(page.items[2]).toMatchObject({ legalOutcome: 'delivered', legalOutcomeReason: 'Via PEC', legalOutcomeAt: new Date('2026-08-01T10:00:00Z') });
    expect(page.items[3]).toMatchObject({ status: 'queued', legalOutcome: 'in_progress' });
  });

  it('riga non POSTAL: nessun esito legale', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL', channelConfig: {} });
    const qb = makeQb({ many: [{ id: 'r1', status: 'sent', downloadCount: 0 }], count: 1 });
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'EMAIL', status: 'success', sentAt: new Date(), errorMessage: null }]);
    const page = await service.getRecipientStats('c1', 1, 50);
    expect(page.items[0]).not.toHaveProperty('legalOutcome');
  });

  it('opzioni filtro: deliveryStatuses POSTAL = conteggi per esito legale (query raw)', async () => {
    recipientRepo.createQueryBuilder.mockImplementation(() => makeQb({ raw: [{ value: 'Confermato', count: '9' }] }));
    recipientRepo.query.mockResolvedValue([{ value: 'delivered', count: 3 }, { value: 'in_progress', count: 2 }]);
    const res = await service.getRecipientFilterOptions('c1');
    expect(res.deliveryStatuses).toEqual([{ value: 'delivered', count: 3 }, { value: 'in_progress', count: 2 }]);
    const sql = String(recipientRepo.query.mock.calls[0][0]);
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('GROUP BY 1');
    expect(recipientRepo.query.mock.calls[0][1]).toEqual(['c1']);
  });

  it('opzioni filtro: statuses POSTAL contano Fallito gli Errore GlobalCom', async () => {
    const qbs: any[] = [];
    recipientRepo.createQueryBuilder.mockImplementation(() => { const q = makeQb(); qbs.push(q); return q; });
    await service.getRecipientFilterOptions('c1');
    const selectExpr = String(qbs[0].select.mock.calls[0][0]);
    expect(selectExpr).toContain("THEN 'failed'");
    expect(selectExpr).toContain("na_err.postal_status = 'Errore'");
    expect(String(qbs[0].groupBy.mock.calls[0][0])).toBe(selectExpr);
  });

  it('opzioni filtro: canali non POSTAL non usano la query esito', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: {} });
    recipientRepo.createQueryBuilder.mockImplementation(() => makeQb({ raw: [{ value: 'DELIVERED', count: '4' }] }));
    const res = await service.getRecipientFilterOptions('c1');
    expect(recipientRepo.query).not.toHaveBeenCalled();
    expect(res.deliveryStatuses).toContainEqual({ value: 'DELIVERED', count: 4 });
  });

  it('report: dirottato INAD con data legale = invio PEC', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: AR });
    recipientRepo.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', extraData: {}, inadCheck: { found: true, diverted: true } }]);
    attemptRepo.find.mockImplementation(async (opts: any) => (opts.where.channelType === 'PEC'
      ? [{ id: 'p1', recipientId: 'r1', attemptNumber: 1, channelType: 'PEC', status: 'success', sentAt: new Date('2026-08-01T10:00:00Z') }]
      : []));
    const report = await service.getPostalReportRows('c1');
    expect(report.rows[0]).toMatchObject({ legalOutcome: 'delivered', legalOutcomeReason: 'Via PEC', legalOutcomeAt: '2026-08-01T10:00:00.000Z' });
  });
});
