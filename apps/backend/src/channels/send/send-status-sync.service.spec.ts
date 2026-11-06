import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendStatusSyncService, LEGACY_TIMELINE_SQL } from './send-status-sync.service.js';
import { SendBaseFeeService } from './send-base-fee.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';
import { NotificationAttempt } from '../../entities/notification-attempt.entity.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.apiKey': 'apikey-abc',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockSendBaseFee = { resolve: jest.fn(async () => 100) };

function makeQueryBuilder(results: any[]) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => results),
  };
  return qb;
}

describe('SendStatusSyncService', () => {
  let service: SendStatusSyncService;
  let mockRepo: any;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockRepo = { createQueryBuilder: jest.fn(), save: jest.fn(async (a: any) => a) };

    const module = await Test.createTestingModule({
      providers: [
        SendStatusSyncService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockRepo },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: SendBaseFeeService, useValue: mockSendBaseFee },
      ],
    }).compile();

    service = module.get(SendStatusSyncService);
  });

  it('resolveMissingIun: risolve IUN se PN risponde ACCEPTED', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'ACCEPTED', iun: 'IUN-123' })),
    });

    await service.resolveMissingIun();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.6/requests?notificationRequestId=req-1',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.iun).toBe('IUN-123');
    expect(attempt.sendStatus).toBe('ACCEPTED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('resolveMissingIun: esclude gli attempt già REFUSED dalla query (non li ripolla per sempre)', async () => {
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.resolveMissingIun();

    const excludesRefused = qb.andWhere.mock.calls.some(([sql, params]: [string, unknown]) => {
      const sqlHasRefused = /send_status/i.test(sql) && /refused/i.test(sql);
      const paramsHaveRefused = params && JSON.stringify(params).toUpperCase().includes('REFUSED');
      return sqlHasRefused || (/send_status/i.test(sql) && paramsHaveRefused);
    });
    expect(excludesRefused).toBe(true);
    expect(qb.orderBy).toHaveBeenCalledWith('attempt.created_at', 'ASC');
  });

  it('resolveMissingIun: non fa nulla se PN risponde WAITING', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'WAITING' })),
    });

    await service.resolveMissingIun();

    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('resolveMissingIun: salva sendStatus REFUSED se PN rifiuta', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'REFUSED', errors: [{ code: 'X' }] })),
    });

    await service.resolveMissingIun();

    expect(attempt.sendStatus).toBe('REFUSED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: aggiorna sendStatus, storico e domicilio digitale da GET notifications/sent/{iun}', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED', costCents: 100 };
    const qb = makeQueryBuilder([attempt]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        notificationStatus: 'DELIVERED',
        notificationStatusHistory: [
          { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
          { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
        ],
        timeline: [
          { category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' }, digitalAddressSource: 'PLATFORM' } },
        ],
      })),
    });

    await service.updateStatuses();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.9/notifications/sent/IUN-123',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.sendStatus).toBe('DELIVERED');
    expect(attempt.sendStatusHistory).toEqual([
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ]);
    expect(attempt.sendDigitalDomicile).toEqual({ type: 'PEC', address: 'x@pec.it', source: 'PLATFORM' });
    expect(qb.orderBy).toHaveBeenCalledWith(`CASE WHEN ${LEGACY_TIMELINE_SQL} THEN 1 ELSE 0 END`, 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('attempt.created_at', 'ASC');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: calcola e salva cost_cents (base fee + analogico) da timeline PN', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED', costCents: null };
    const qb = makeQueryBuilder([attempt]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        notificationStatus: 'DELIVERED',
        notificationStatusHistory: [{ status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' }],
        timeline: [
          { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } },
        ],
      })),
    });

    await service.updateStatuses();

    expect(attempt.costCents).toBe(1070); // 100 (fallback base fee mockato) + 970
    expect(attempt.costBreakdown).toEqual({
      baseFeeCents: 100,
      analogEvents: [{ productType: 'AR', analogCostCents: 970, envelopeWeight: 20, numberOfPages: 2 }],
    });
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: include nella query gli attempt terminali senza costo ancora calcolato', async () => {
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.updateStatuses();

    const includesCostNull = qb.andWhere.mock.calls.some(([sql]: [string]) => /cost_cents/i.test(sql));
    expect(includesCostNull).toBe(true);
  });

  it('updateStatuses: non ricalcola il costo se già presente e lo stato non cambia', async () => {
    const attempt: any = {
      id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED', costCents: 1070,
      costBreakdown: { baseFeeCents: 100, analogEvents: [{ productType: 'AR', analogCostCents: 970, envelopeWeight: 20, numberOfPages: 2 }] },
      costCalculatedAt: new Date('2026-01-12T10:00:00Z'),
      sendStatusUpdatedAt: new Date('2026-01-12T09:00:00Z'),
    };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({
      notificationStatus: 'DELIVERED',
      timeline: [{ category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } }],
    })) });

    await service.updateStatuses();

    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('bug reale: ricalcola il costo quando l\'invio cartaceo compare DOPO il primo calcolo (tutte le SEND ferme a 1€)', async () => {
    mockSendBaseFee.resolve.mockClear();
    const attempt: any = {
      id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERING', costCents: 100,
      costBreakdown: { baseFeeCents: 100, analogEvents: [] },
      costCalculatedAt: new Date('2026-01-10T10:00:00Z'),
      sendStatusUpdatedAt: new Date('2026-01-10T10:00:00Z'),
    };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        notificationStatus: 'DELIVERED',
        timeline: [
          { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } },
        ],
      })),
    });

    await service.updateStatuses();

    expect(attempt.costCents).toBe(1070);
    expect(attempt.costBreakdown.analogEvents).toHaveLength(1);
    // Base fee già nota nel breakdown: nessuna nuova chiamata a PN per risolverla.
    expect(mockSendBaseFee.resolve).not.toHaveBeenCalled();
    expect(attempt.costCalculatedAt.getTime()).toBeGreaterThan(new Date('2026-01-10T10:00:00Z').getTime());
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('ripesca gli attempt terminali col costo calcolato prima dell\'ultimo cambio stato (recupero SEND già chiuse a 1€)', async () => {
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.updateStatuses();

    const includesStaleCost = qb.andWhere.mock.calls.some(([sql]: [string]) =>
      /cost_calculated_at\s*<\s*attempt\.send_status_updated_at/i.test(sql));
    expect(includesStaleCost).toBe(true);
  });

  it('attempt ripescato come "costo stantio" ma senza variazioni: aggiorna solo cost_calculated_at, così esce dal batch', async () => {
    const attempt: any = {
      id: 'a1', iun: 'IUN-123', sendStatus: 'VIEWED', costCents: 100,
      costBreakdown: { baseFeeCents: 100, analogEvents: [] },
      costCalculatedAt: new Date('2026-01-10T10:00:00Z'),
      sendStatusUpdatedAt: new Date('2026-01-12T10:00:00Z'),
    };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'VIEWED', timeline: [] })) });

    await service.updateStatuses();

    expect(attempt.costCents).toBe(100);
    expect(attempt.costCalculatedAt.getTime()).toBeGreaterThanOrEqual(attempt.sendStatusUpdatedAt.getTime());
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('salva timeline e storico anche senza cambio stato (es. ritiro presso punto RADD mentre resta DELIVERED)', async () => {
    const attempt: any = {
      id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED', costCents: 100,
      costBreakdown: { baseFeeCents: 100, analogEvents: [] },
      costCalculatedAt: new Date('2026-01-12T10:00:00Z'),
      sendStatusUpdatedAt: new Date('2026-01-12T09:00:00Z'),
      sendStatusHistory: [{ status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' }],
      sendTimeline: [],
    };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({
      notificationStatus: 'DELIVERED',
      notificationStatusHistory: [{ status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' }],
      timeline: [{ category: 'NOTIFICATION_RADD_RETRIEVED', timestamp: '2026-01-15T10:00:00Z', details: { raddType: 'ALT' } }],
    })) });

    await service.updateStatuses();

    expect(attempt.sendTimeline).toEqual([{ category: 'NOTIFICATION_RADD_RETRIEVED', at: '2026-01-15T10:00:00Z', raddType: 'ALT', details: { raddType: 'ALT' } }]);
    expect(attempt.sendStatusUpdatedAt).toEqual(new Date('2026-01-12T09:00:00Z'));
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('LEGACY_TIMELINE_SQL: predicato esatto e incluso nella OR della condizione terminale', async () => {
    expect(LEGACY_TIMELINE_SQL).toBe("((jsonb_array_length(COALESCE(attempt.send_timeline, '[]'::jsonb)) > 0 AND NOT (attempt.send_timeline -> 0 ? 'details')) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(attempt.send_timeline, '[]'::jsonb)) e WHERE e->>'category' IN ('SEND_ANALOG_DOMICILE','SEND_SIMPLE_REGISTERED_LETTER','PREPARE_ANALOG_DOMICILE') AND e->'details' IS NOT NULL AND NOT (e->'details' ? 'physicalAddress')))");
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.updateStatuses();

    const hit = qb.andWhere.mock.calls.some(([sql]: [string]) => /NOT IN/.test(sql) && sql.includes(` OR ${LEGACY_TIMELINE_SQL}`));
    expect(hit).toBe(true);
  });

  it('updateStatuses: righe del backfill legacy in coda, il sync live non resta affamato', async () => {
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.updateStatuses();

    expect(qb.orderBy).toHaveBeenCalledTimes(1);
    expect(qb.orderBy).toHaveBeenCalledWith(`CASE WHEN ${LEGACY_TIMELINE_SQL} THEN 1 ELSE 0 END`, 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('attempt.created_at', 'ASC');
    expect(qb.orderBy.mock.invocationCallOrder[0]).toBeLessThan(qb.addOrderBy.mock.invocationCallOrder[0]);
    expect(qb.take).toHaveBeenCalledWith(200);
  });

  it('rewrites timeline when only details changed (backfill terminale senza details)', async () => {
    const attempt: any = {
      id: 'a1', iun: 'IUN-123', sendStatus: 'UNREACHABLE', costCents: 100,
      costBreakdown: { baseFeeCents: 100, analogEvents: [] },
      costCalculatedAt: new Date('2026-01-12T10:00:00Z'),
      sendStatusUpdatedAt: new Date('2026-01-12T09:00:00Z'),
      sendStatusHistory: [{ status: 'UNREACHABLE', activeFrom: '2026-01-12T09:00:00Z' }],
      sendTimeline: [{ category: 'REQUEST_ACCEPTED', at: '2026-01-10T10:00:00Z' }],
    };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({
      notificationStatus: 'UNREACHABLE',
      notificationStatusHistory: [{ status: 'UNREACHABLE', activeFrom: '2026-01-12T09:00:00Z' }],
      timeline: [{ category: 'REQUEST_ACCEPTED', timestamp: '2026-01-10T10:00:00Z', details: { foo: 'bar' } }],
    })) });

    await service.updateStatuses();

    expect(mockRepo.save).toHaveBeenCalledTimes(1);
    const saved = mockRepo.save.mock.calls[0][0];
    expect(saved.sendTimeline[0].details).toBeDefined();
    expect(saved.sendStatus).toBe('UNREACHABLE');
  });

  it('handleCron chiama sia resolveMissingIun che updateStatuses', async () => {
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));
    const spyResolve = jest.spyOn(service, 'resolveMissingIun');
    const spyUpdate = jest.spyOn(service, 'updateStatuses');
    await service.handleCron();
    expect(spyResolve).toHaveBeenCalled();
    expect(spyUpdate).toHaveBeenCalled();
  });
});
