import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignsService } from './campaigns.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
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

function makeQb(rawMany: any[]) {
  const qb: any = {};
  ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'limit'].forEach((m) => {
    qb[m] = vi.fn().mockReturnValue(qb);
  });
  qb.getRawMany = vi.fn().mockResolvedValue(rawMany);
  return qb;
}

describe('CampaignsService - getRecentActivity', () => {
  let service: CampaignsService;
  let campaignRepo: any;

  beforeEach(async () => {
    campaignRepo = { createQueryBuilder: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: PostalAuthorizedUsersService, useValue: {} },
        { provide: SignatureVerificationBulkService, useValue: {} },
        { provide: SignatureVerificationService, useValue: {} },
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: InadService, useValue: {} },
        { provide: PostalStatusSyncService, useValue: {} },
        { provide: RegistroImpreseService, useValue: {} },
        { provide: RegistroImpreseVerifyQueueService, useValue: {} },
      ],
    }).compile();

    service = module.get(CampaignsService);
  });

  it('mappa le righe raw convertendo i campi numerici', async () => {
    campaignRepo.createQueryBuilder.mockReturnValue(
      makeQb([
        {
          id: 'c1',
          name: 'Tari 2026',
          channelType: 'PEC',
          status: 'running',
          totalRecipients: '100',
          sentCount: '80',
          failedCount: '5',
          lastActivityAt: '2026-09-15T10:00:00.000Z',
        },
      ]),
    );

    const result = await service.getRecentActivity();

    expect(result).toEqual([
      {
        id: 'c1',
        name: 'Tari 2026',
        channelType: 'PEC',
        status: 'running',
        totalRecipients: 100,
        sentCount: 80,
        failedCount: 5,
        lastActivityAt: '2026-09-15T10:00:00.000Z',
      },
    ]);
  });

  it('ritorna array vuoto se nessuna campagna è attiva o aggiornata di recente', async () => {
    campaignRepo.createQueryBuilder.mockReturnValue(makeQb([]));

    const result = await service.getRecentActivity();

    expect(result).toEqual([]);
  });

  it('applica il filtro isTest/bozze, lo stato attivo e il limite 15 alla query', async () => {
    const qb = makeQb([]);
    campaignRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getRecentActivity();

    expect(campaignRepo.createQueryBuilder).toHaveBeenCalledWith('c');
    expect(qb.where).toHaveBeenCalledWith("c.isTest = false AND c.status != 'draft'");
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('c.status IN (:...activeStatuses)'),
      expect.objectContaining({ activeStatuses: ['queued', 'running'] }),
    );
    expect(qb.limit).toHaveBeenCalledWith(15);
  });
});
