import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { NotificationsSearchService } from './notifications-search.service';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignsService } from '../campaigns/campaigns.service';

describe('NotificationsSearchService.search', () => {
  const qbMock = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const recipientRepoMock = { createQueryBuilder: jest.fn(() => qbMock) };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    qbMock.leftJoinAndSelect.mockReturnThis();
    qbMock.andWhere.mockReturnThis();
    qbMock.orderBy.mockReturnThis();
    qbMock.skip.mockReturnThis();
    qbMock.take.mockReturnThis();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(DownloadEvent), useValue: { find: jest.fn() } },
        { provide: CampaignsService, useValue: { renderMessageForRecipient: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('applica il filtro codiceFiscale quando presente', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ codiceFiscale: 'rssmra80a01h501x', page: 1, pageSize: 20 });

    expect(qbMock.andWhere).toHaveBeenCalledWith('recipient.codiceFiscale = :cf', { cf: 'RSSMRA80A01H501X' });
  });

  it('mappa i risultati nel formato atteso', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[
      {
        id: 'r1',
        campaignId: 'c1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        status: 'sent',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        campaign: { name: 'Avviso TARI', channelType: 'EMAIL' },
      },
    ], 1]);

    const result = await service.search({ page: 1, pageSize: 20 });

    expect(result).toEqual({
      rows: [{
        recipientId: 'r1',
        campaignId: 'c1',
        campaignName: 'Avviso TARI',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      total: 1,
    });
  });
});

describe('NotificationsSearchService.getDetail', () => {
  const recipientRepoMock = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };
  const attemptRepoMock = { find: jest.fn() };
  const downloadEventRepoMock = { find: jest.fn() };
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn() };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadEventRepoMock },
        { provide: CampaignsService, useValue: campaignsServiceMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('lancia NotFoundException se il destinatario non esiste', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(null);

    await expect(service.getDetail('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('ritorna destinatario, campagna, tentativi ed esito App IO separato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL' },
    });
    attemptRepoMock.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: new Date('2026-07-01T10:00:00Z'),
        createdAt: new Date('2026-07-01T09:59:00Z'),
        responsePayload: { appIo: { success: true } },
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    downloadEventRepoMock.find.mockResolvedValueOnce([
      { channel: 'EMAIL', attachmentIndex: 0, downloadedAt: new Date('2026-07-02T08:00:00Z') },
    ]);

    const result = await service.getDetail('r1');

    expect(result).toEqual({
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        email: 'mario@test.it',
        pec: null,
        status: 'sent',
      },
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL' },
      attempts: [{
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: '2026-07-01T10:00:00.000Z',
        createdAt: '2026-07-01T09:59:00.000Z',
        appIo: { attempted: true, success: true, error: null },
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
      }],
      downloads: [{ channel: 'EMAIL', attachmentIndex: 0, downloadedAt: '2026-07-02T08:00:00.000Z' }],
      preview: { subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' },
    });
  });

  it('espone iun/protocollo/stato SEND quando presenti sull\'attempt', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'SEND' },
    });
    attemptRepoMock.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'SEND',
        errorMessage: null,
        sentAt: new Date('2026-07-10T10:00:00Z'),
        createdAt: new Date('2026-07-10T09:00:00Z'),
        responsePayload: null,
        iun: 'ABCD-EFGH-ILMN-202607-X-1',
        sendStatus: 'ACCEPTED',
        sendStatusUpdatedAt: new Date('2026-07-11T08:00:00Z'),
        protocolNumber: 123,
        protocolYear: 2026,
        protocolledAt: new Date('2026-07-10T08:30:00Z'),
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    downloadEventRepoMock.find.mockResolvedValueOnce([]);

    const result = await service.getDetail('rec-1');

    expect(result.attempts[0]).toMatchObject({
      iun: 'ABCD-EFGH-ILMN-202607-X-1',
      sendStatus: 'ACCEPTED',
      sendStatusUpdatedAt: '2026-07-11T08:00:00.000Z',
      protocolNumber: 123,
      protocolYear: 2026,
      protocolledAt: '2026-07-10T08:30:00.000Z',
    });
  });

  it('espone i campi SEND come null per un attempt di un altro canale', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL' },
    });
    attemptRepoMock.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: new Date('2026-07-10T10:00:00Z'),
        createdAt: new Date('2026-07-10T09:00:00Z'),
        responsePayload: null,
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    downloadEventRepoMock.find.mockResolvedValueOnce([]);

    const result = await service.getDetail('rec-1');

    expect(result.attempts[0]).toMatchObject({
      iun: null,
      sendStatus: null,
      sendStatusUpdatedAt: null,
      protocolNumber: null,
      protocolYear: null,
      protocolledAt: null,
    });
  });
});
