import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendStatusSyncService } from './send-status-sync.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

function makeQueryBuilder(results: any[]) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
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
      'https://send.test/delivery/v2.6/requests?requestId=req-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.iun).toBe('IUN-123');
    expect(attempt.sendStatus).toBe('ACCEPTED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
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

  it('updateStatuses: aggiorna sendStatus da GET notifications/sent/{iun}', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED' };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })),
    });

    await service.updateStatuses();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.9/notifications/sent/IUN-123',
      expect.objectContaining({ headers: { Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.sendStatus).toBe('DELIVERED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: non salva se lo stato non è cambiato', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED' };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })),
    });

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
