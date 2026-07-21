import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendStatusSyncService } from './send-status-sync.service';
import { SendBaseFeeService } from './send-base-fee.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';

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
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
    expect(qb.orderBy).toHaveBeenCalledWith('attempt.created_at', 'ASC');
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
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED', costCents: 1070 };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })) });

    await service.updateStatuses();

    expect(mockRepo.save).not.toHaveBeenCalled();
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
