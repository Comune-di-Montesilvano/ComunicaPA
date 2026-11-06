import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationsSearchService } from './notifications-search.service.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { SendLegalFactsService } from '../channels/send/send-legal-facts.service.js';
import { AttachmentService } from '../attachments/attachment.service.js';
import { fromUtcWallClock } from '../legal-attention/legal-attention.util.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { visibleCampaignSql } from '../campaigns/campaign-access.util.js';

const ADMIN = { username: 'admin', role: 'admin' as const };

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
        { provide: SendLegalFactsService, useValue: { listDocuments: jest.fn(), downloadLegalFact: jest.fn() } },
        { provide: AttachmentService, useValue: { generatePdfBuffer: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('applica la condizione di ricerca campo libero su codiceFiscale quando presente', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ codiceFiscale: 'rssmra80a01h501x', page: 1, pageSize: 20 }, ADMIN);

    expect(qbMock.andWhere).toHaveBeenCalledWith(
      '(LOWER(recipient.codiceFiscale) LIKE LOWER(:q) OR LOWER(recipient.fullName) LIKE LOWER(:q) OR LOWER(recipient.email) LIKE LOWER(:q) OR LOWER(recipient.pec) LIKE LOWER(:q) OR EXISTS (SELECT 1 FROM notification_attempts a WHERE a.recipient_id = recipient.id AND LOWER(a.iun) LIKE LOWER(:q)))',
      { q: '%rssmra80a01h501x%' },
    );
  });

  it('applica la condizione di ricerca campo libero su query quando presente', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ query: 'mario', page: 1, pageSize: 20 }, ADMIN);

    expect(qbMock.andWhere).toHaveBeenCalledWith(
      '(LOWER(recipient.codiceFiscale) LIKE LOWER(:q) OR LOWER(recipient.fullName) LIKE LOWER(:q) OR LOWER(recipient.email) LIKE LOWER(:q) OR LOWER(recipient.pec) LIKE LOWER(:q) OR EXISTS (SELECT 1 FROM notification_attempts a WHERE a.recipient_id = recipient.id AND LOWER(a.iun) LIKE LOWER(:q)))',
      { q: '%mario%' },
    );
  });

  it('filtro autore: confronta campaign.createdBy col valore trimmato', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ createdBy: ' mrossi ', page: 1, pageSize: 20 }, ADMIN);

    expect(qbMock.andWhere).toHaveBeenCalledWith('campaign.createdBy = :createdBy', { createdBy: 'mrossi' });
  });

  it('filtro autore: solo spazi o assente non aggiunge condizioni', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ createdBy: '   ', page: 1, pageSize: 20 }, ADMIN);
    await service.search({ page: 1, pageSize: 20 }, ADMIN);

    const sql = qbMock.andWhere.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(sql).not.toContain('createdBy');
  });

  it('filtro campagna: cerca per id (anche parziale) o nome campagna, case-insensitive', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ campaignId: '  Avviso TARI ', page: 1, pageSize: 20 }, ADMIN);

    expect(qbMock.andWhere).toHaveBeenCalledWith(
      '(CAST(campaign.id AS text) ILIKE :campaignQ OR campaign.name ILIKE :campaignQ)',
      { campaignQ: '%Avviso TARI%' },
    );
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

    const result = await service.search({ page: 1, pageSize: 20 }, ADMIN);

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
        posteVerificationStatus: null,
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
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn(), renderAppIoCoDeliveryPreview: jest.fn() };

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
        { provide: SendLegalFactsService, useValue: { listDocuments: jest.fn(), downloadLegalFact: jest.fn() } },
        { provide: AttachmentService, useValue: { generatePdfBuffer: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('lancia NotFoundException se il destinatario non esiste', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(null);

    await expect(service.getDetail('no-exist', ADMIN)).rejects.toThrow(NotFoundException);
  });

  it('ritorna destinatario, campagna, tentativi ed esito App IO separato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL', postalServiceType: null, postalReturnReceipt: false },
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
        postalTrackingId: null,
        postalStatus: null,
        postalStatusUpdatedAt: null,
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    campaignsServiceMock.renderAppIoCoDeliveryPreview.mockResolvedValueOnce({ subject: 'Ciao Mario IO', bodyMarkdown: 'Corpo IO' });
    downloadEventRepoMock.find.mockResolvedValueOnce([
      { channel: 'EMAIL', attachmentIndex: 0, downloadedAt: new Date('2026-07-02T08:00:00Z') },
    ]);

    const result = await service.getDetail('r1', ADMIN);

    expect(result).toEqual({
      legalOutcome: null,
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        email: 'mario@test.it',
        pec: null,
        status: 'sent',
        physicalAddress: null,
      },
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL', postalServiceType: null, postalReturnReceipt: false },
      attempts: [{
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: '2026-07-01T10:00:00.000Z',
        // created_at senza fuso: fromUtcWallClock, dipende dal TZ del processo (CI UTC, container Europe/Rome).
        createdAt: fromUtcWallClock(new Date('2026-07-01T09:59:00Z')).toISOString(),
        appIo: { attempted: true, success: true, error: null, messageId: null },
        appIoMessageId: null,
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        sendStatusHistory: null,
        sendTimeline: null,
        sendPerfection: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
        postalTrackingId: null,
        postalStatus: null,
        postalStatusUpdatedAt: null,
        postalDeliveryStatus: null,
        postalDeliveryCode: null,
        postalDeliveryDate: null,
        postalAcceptanceId: null,
        postalStatusHistory: null,
        costCents: null,
        costCalculatedAt: null,
        costBreakdown: null,
      }],
      downloads: [{ channel: 'EMAIL', attachmentIndex: 0, downloadedAt: '2026-07-02T08:00:00.000Z' }],
      preview: { subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' },
      appIoPreview: { subject: 'Ciao Mario IO', bodyMarkdown: 'Corpo IO' },
      totalCostCents: 0,
      attachments: [],
      payment: null,
      canReadAttachments: true,
    });
  });

  it('bug reale: il Message-ID SMTP di un attempt PEC non viene mai mostrato come ID messaggio App IO', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: null,
      pec: 'mario@pec.it',
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI PEC', channelType: 'PEC', postalServiceType: null, postalReturnReceipt: false },
    });
    attemptRepoMock.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'PEC',
        errorMessage: null,
        sentAt: new Date('2026-09-17T09:24:22Z'),
        createdAt: new Date('2026-09-17T09:24:20Z'),
        // pec.strategy.ts salva qui il Message-ID SMTP della PEC stessa —
        // chiave generica "messageId", MAI un ID App IO.
        responsePayload: { messageId: '01M2Q-pec-smtp-message-id@pec.it' },
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
        postalTrackingId: null,
        postalStatus: null,
        postalStatusUpdatedAt: null,
      },
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'APP_IO',
        errorMessage: null,
        sentAt: new Date('2026-09-17T09:24:22Z'),
        createdAt: new Date('2026-09-17T09:24:20Z'),
        responsePayload: { messageId: '01M2Q-appio-real-message-id' },
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
        postalTrackingId: null,
        postalStatus: null,
        postalStatusUpdatedAt: null,
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    downloadEventRepoMock.find.mockResolvedValueOnce([]);

    const result = await service.getDetail('r1', ADMIN);

    const [pecAttempt, appIoAttempt] = result.attempts;
    expect(pecAttempt.channelType).toBe('PEC');
    expect(pecAttempt.appIoMessageId).toBeNull();
    expect(pecAttempt.appIo).toEqual({ attempted: false });
    expect(appIoAttempt.channelType).toBe('APP_IO');
    expect(appIoAttempt.appIoMessageId).toBe('01M2Q-appio-real-message-id');
  });

  it('espone i dati di pagamento risolti (IUV/importo/scadenza) se la campagna ha paymentConfig abilitato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      extraData: { numero_avviso: '123456789012', importo: '150,50', scadenza: '2026-12-31' },
      campaign: {
        id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL', postalServiceType: null, postalReturnReceipt: false,
        channelConfig: {
          paymentConfig: { enabled: true, amountColumn: 'importo', noticeNumberColumn: 'numero_avviso', dueDateColumn: 'scadenza' },
        },
      },
    });
    attemptRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });
    downloadEventRepoMock.find.mockResolvedValueOnce([]);

    const result = await service.getDetail('r1', ADMIN);

    expect(result.payment).toEqual({
      noticeCode: '123456789012',
      amountCents: 15050,
      creditorTaxId: '',
      dueDateIso: '2026-12-31T23:59:59.000Z',
    });
  });

  it('espone gli allegati configurati per una campagna POSTAL (nessun link nel body, serve per il bottone download admin)', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r-postal',
      codiceFiscale: 'VRDLGU85B02H501X',
      fullName: 'Luigi Verdi',
      email: null,
      pec: null,
      status: 'sent',
      extraData: {},
      campaign: {
        id: 'c-postal',
        name: 'Raccomandata AR',
        channelType: 'POSTAL',
        postalServiceType: 'RaccomandataMarket4',
        postalReturnReceipt: true,
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso' }] },
      },
    });
    attemptRepoMock.find.mockResolvedValueOnce([]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });

    const result = await service.getDetail('r-postal', ADMIN);

    expect(result.attachments).toEqual([{ index: 0, label: 'Avviso' }]);
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

    const result = await service.getDetail('rec-1', ADMIN);

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
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL', postalServiceType: null, postalReturnReceipt: false },
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

    const result = await service.getDetail('rec-1', ADMIN);

    expect(result.attempts[0]).toMatchObject({
      iun: null,
      sendStatus: null,
      sendStatusUpdatedAt: null,
      protocolNumber: null,
      protocolYear: null,
      protocolledAt: null,
    });
  });

  it('SEND: espone sendPerfection con tappa finale destinatario', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: null, pec: null, status: 'sent', extraData: {},
      campaign: { id: 'c1', name: 'Avviso', channelType: 'SEND', channelConfig: {} },
    });
    attemptRepoMock.find.mockResolvedValueOnce([{
      id: 'a1', attemptNumber: 1, status: 'success', channelType: 'SEND', errorMessage: null,
      sentAt: new Date('2026-07-10T10:00:00Z'), createdAt: new Date('2026-07-10T09:00:00Z'), responsePayload: null,
      iun: 'ABCD-EFGH-ILMN-202607-X-1', sendStatus: 'UNREACHABLE', sendStatusUpdatedAt: new Date('2026-07-12T08:00:00Z'),
      sendStatusHistory: [
        { status: 'ACCEPTED', activeFrom: '2026-07-10T10:00:00Z' },
        { status: 'UNREACHABLE', activeFrom: '2026-07-12T08:00:00Z' },
      ],
      sendTimeline: [],
    }]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });
    const result = await service.getDetail('r1', ADMIN);
    expect(result.attempts[0]!.sendPerfection!.steps.at(-1)!.key).toBe('recipient');
  });

  it('non SEND: sendPerfection null', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: 'mario@test.it', pec: null, status: 'sent', extraData: {},
      campaign: { id: 'c1', name: 'Avviso', channelType: 'EMAIL', channelConfig: {} },
    });
    attemptRepoMock.find.mockResolvedValueOnce([{
      id: 'a1', attemptNumber: 1, status: 'success', channelType: 'EMAIL', errorMessage: null,
      sentAt: new Date('2026-07-10T10:00:00Z'), createdAt: new Date('2026-07-10T09:00:00Z'), responsePayload: null,
    }]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });
    const result = await service.getDetail('r1', ADMIN);
    expect(result.attempts[0]!.sendPerfection).toBeNull();
  });

  it.each([
    ['senza IUN', { iun: null }],
    ['tentativo fallito', { status: 'failed' }],
    ['sendStatus REFUSED', { sendStatus: 'REFUSED', sendStatusHistory: [{ status: 'REFUSED', activeFrom: '2026-07-10T11:00:00Z' }] }],
    ['REFUSED solo nello storico', { sendStatus: null, sendStatusHistory: [{ status: 'REFUSED', activeFrom: '2026-07-10T11:00:00Z' }] }],
    ['sendStatus CANCELLED', { sendStatus: 'CANCELLED' }],
  ])('SEND %s: sendPerfection null', async (_label, override) => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: null, pec: null, status: 'sent', extraData: {},
      campaign: { id: 'c1', name: 'Avviso', channelType: 'SEND', channelConfig: {} },
    });
    attemptRepoMock.find.mockResolvedValueOnce([{
      id: 'a1', attemptNumber: 1, status: 'success', channelType: 'SEND', errorMessage: null,
      sentAt: new Date('2026-07-10T10:00:00Z'), createdAt: new Date('2026-07-10T09:00:00Z'), responsePayload: null,
      iun: 'ABCD-EFGH-ILMN-202607-X-1', sendStatus: 'ACCEPTED', sendStatusUpdatedAt: new Date('2026-07-10T10:00:00Z'),
      sendStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-07-10T10:00:00Z' }],
      sendTimeline: [],
      ...override,
    }]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });
    const result = await service.getDetail('r1', ADMIN);
    expect(result.attempts[0]!.sendPerfection).toBeNull();
  });

  it('POSTAL: esito legale nel dettaglio (compiuta giacenza = consegnato, data GlobalCom)', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r-postal', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: null, pec: null, status: 'sent', extraData: {}, inadCheck: null,
      campaign: { id: 'c-postal', name: 'Raccomandata AR', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true } },
    });
    attemptRepoMock.find.mockResolvedValueOnce([{
      id: 'a1', attemptNumber: 1, status: 'success', channelType: 'POSTAL', errorMessage: null,
      sentAt: new Date('2026-07-30T08:00:00Z'), createdAt: new Date('2026-07-30T08:00:00Z'), responsePayload: null,
      postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Compiuta Giacenza', postalDeliveryDate: new Date('2026-09-08T00:00:00Z'),
    }]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });
    const result = await service.getDetail('r-postal', ADMIN);
    expect(result.legalOutcome).toEqual({ outcome: 'delivered', reason: 'Compiuta Giacenza', at: '2026-09-08T00:00:00.000Z' });
  });

  it('non POSTAL: legalOutcome null', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: 'mario@test.it', pec: null, status: 'sent', extraData: {},
      campaign: { id: 'c1', name: 'Avviso', channelType: 'EMAIL', channelConfig: {} },
    });
    attemptRepoMock.find.mockResolvedValueOnce([]);
    downloadEventRepoMock.find.mockResolvedValueOnce([]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Avviso', bodyHtml: '' });
    const result = await service.getDetail('r1', ADMIN);
    expect(result.legalOutcome).toBeNull();
  });
});

describe('NotificationsSearchService.getSendLegalFacts / downloadSendLegalFact', () => {
  const recipientRepoMock = { createQueryBuilder: jest.fn(), findOne: jest.fn() };
  const attemptRepoMock = { find: jest.fn(), findOne: jest.fn() };
  const downloadEventRepoMock = { find: jest.fn() };
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn() };
  const sendLegalFactsMock = { listDocuments: jest.fn(), downloadLegalFact: jest.fn() };

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
        { provide: SendLegalFactsService, useValue: sendLegalFactsMock },
        { provide: AttachmentService, useValue: { generatePdfBuffer: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
    recipientRepoMock.findOne.mockResolvedValue({ id: 'rec-1', campaign: launched });
  });

  const OTHER = { username: 'luigi', role: 'user' as const };
  const launched = { id: 'c1', name: 'Avviso', status: 'completed', isTest: false, createdBy: 'mario', signerUsername: null };
  const testSend = { ...launched, isTest: true };

  it('getSendLegalFacts: destinatario inesistente → NotFoundException', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(null);
    await expect(service.getSendLegalFacts('rec-1', ADMIN)).rejects.toThrow(NotFoundException);
    expect(sendLegalFactsMock.listDocuments).not.toHaveBeenCalled();
  });

  it('getSendLegalFacts: invio di prova altrui → NotFoundException, PN mai interrogato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({ id: 'rec-1', campaign: testSend });
    await expect(service.getSendLegalFacts('rec-1', OTHER)).rejects.toThrow(NotFoundException);
    expect(recipientRepoMock.findOne).toHaveBeenCalledWith({ where: { id: 'rec-1' }, relations: { campaign: true } });
    expect(attemptRepoMock.findOne).not.toHaveBeenCalled();
    expect(sendLegalFactsMock.listDocuments).not.toHaveBeenCalled();
  });

  it('getSendLegalFacts: campagna lanciata visibile a ogni user (atti opponibili restano aperti)', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce({ iun: 'IUN-1' });
    sendLegalFactsMock.listDocuments.mockResolvedValueOnce([]);
    await expect(service.getSendLegalFacts('rec-1', OTHER)).resolves.toEqual({ items: [] });
  });

  it('downloadSendLegalFact: invio di prova altrui → NotFoundException, PN mai interrogato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({ id: 'rec-1', campaign: testSend });
    await expect(service.downloadSendLegalFact('rec-1', 'key1', OTHER)).rejects.toThrow(NotFoundException);
    expect(attemptRepoMock.findOne).not.toHaveBeenCalled();
    expect(sendLegalFactsMock.downloadLegalFact).not.toHaveBeenCalled();
  });

  it('getSendLegalFacts: ritorna lista vuota se il destinatario non ha un attempt SEND con iun', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce(null);

    const result = await service.getSendLegalFacts('rec-1', ADMIN);

    expect(result).toEqual({ items: [] });
    expect(sendLegalFactsMock.listDocuments).not.toHaveBeenCalled();
  });

  it('getSendLegalFacts: chiama SendLegalFactsService.listDocuments con lo iun più recente', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce({ iun: 'IUN-1' });
    sendLegalFactsMock.listDocuments.mockResolvedValueOnce([{ legalFactId: 'key1', category: 'SENDER_ACK' }]);

    const result = await service.getSendLegalFacts('rec-1', ADMIN);

    expect(attemptRepoMock.findOne).toHaveBeenCalledWith({
      where: { recipientId: 'rec-1', channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    expect(sendLegalFactsMock.listDocuments).toHaveBeenCalledWith('IUN-1');
    expect(result).toEqual({ items: [{ legalFactId: 'key1', category: 'SENDER_ACK' }] });
  });

  it('downloadSendLegalFact: ritorna errore se il destinatario non ha un attempt SEND con iun', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce(null);

    const result = await service.downloadSendLegalFact('rec-1', 'key1', ADMIN);

    expect(result).toEqual({ ready: false, error: 'Nessun IUN disponibile per questo destinatario' });
    expect(sendLegalFactsMock.downloadLegalFact).not.toHaveBeenCalled();
  });

  it('downloadSendLegalFact: delega a SendLegalFactsService.downloadLegalFact', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce({ iun: 'IUN-1' });
    sendLegalFactsMock.downloadLegalFact.mockResolvedValueOnce({ ready: true, filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });

    const result = await service.downloadSendLegalFact('rec-1', 'key1', ADMIN);

    expect(sendLegalFactsMock.downloadLegalFact).toHaveBeenCalledWith('IUN-1', 'key1');
    expect(result).toEqual({ ready: true, filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });
  });
});

describe('NotificationsSearchService.downloadAttachment', () => {
  const recipientRepoMock = { findOne: jest.fn() };
  const attachmentServiceMock = { generatePdfBuffer: jest.fn() };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(DownloadEvent), useValue: { find: jest.fn() } },
        { provide: CampaignsService, useValue: { renderMessageForRecipient: jest.fn() } },
        { provide: SendLegalFactsService, useValue: { listDocuments: jest.fn(), downloadLegalFact: jest.fn() } },
        { provide: AttachmentService, useValue: attachmentServiceMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('lancia NotFoundException se il destinatario non esiste', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(null);

    await expect(service.downloadAttachment('no-exist', 0, ADMIN)).rejects.toThrow(NotFoundException);
    expect(attachmentServiceMock.generatePdfBuffer).not.toHaveBeenCalled();
  });

  it('genera il PDF via AttachmentService, nessun incremento downloadCount (consultazione da backoffice)', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r-postal', codiceFiscale: 'VRDLGU85B02H501X', extraData: { file: 'raccomandata.pdf' },
      campaign: { channelConfig: { attachments: [{ key: 'file', label: 'Avviso' }] } },
    });
    attachmentServiceMock.generatePdfBuffer.mockResolvedValueOnce(Buffer.from('%PDF-fake'));

    const result = await service.downloadAttachment('r-postal', 0, ADMIN);

    expect(attachmentServiceMock.generatePdfBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r-postal' }),
      0,
    );
    expect(result.buffer.toString()).toBe('%PDF-fake');
    expect(result.filename).toBe('raccomandata.pdf');
  });
});

describe('NotificationsSearchService — riservatezza bozze e allegati', () => {
  const OTHER = { username: 'luigi', role: 'user' as const };
  const CREATOR = { username: 'mario', role: 'user' as const };
  const qbMock = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const recipientRepoMock = { createQueryBuilder: jest.fn(() => qbMock), findOne: jest.fn() };
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn(), renderAppIoCoDeliveryPreview: jest.fn() };
  const attachmentServiceMock = { generatePdfBuffer: jest.fn() };
  const auditLogsMock = { log: jest.fn() };
  let service: NotificationsSearchService;

  const recipientOf = (status: string, isTest = false) => ({
    id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', email: null, pec: null, status: 'sent', extraData: {},
    campaign: { id: 'c1', name: 'Avviso', channelType: 'EMAIL', channelConfig: {}, status, createdBy: 'mario', signerUsername: null, isTest },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    qbMock.leftJoinAndSelect.mockReturnThis();
    qbMock.andWhere.mockReturnThis();
    qbMock.orderBy.mockReturnThis();
    qbMock.skip.mockReturnThis();
    qbMock.take.mockReturnThis();
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(DownloadEvent), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: CampaignsService, useValue: campaignsServiceMock },
        { provide: SendLegalFactsService, useValue: {} },
        { provide: AttachmentService, useValue: attachmentServiceMock },
        { provide: AuditLogsService, useValue: auditLogsMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('search: altro user → filtro visibleCampaignSql su campaign; admin → nessun filtro', async () => {
    await service.search({ page: 1, pageSize: 20 }, OTHER);
    const expected = visibleCampaignSql('campaign', OTHER)!;
    expect(qbMock.andWhere).toHaveBeenCalledWith(expected.sql, expected.params);

    qbMock.andWhere.mockClear();
    await service.search({ page: 1, pageSize: 20 }, ADMIN);
    const sql = qbMock.andWhere.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(sql).not.toContain('visibleCampaignUser');
  });

  it('getDetail: destinatario di bozza altrui → NotFoundException, niente rendering', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('draft'));
    await expect(service.getDetail('r1', OTHER)).rejects.toThrow(NotFoundException);
    expect(campaignsServiceMock.renderMessageForRecipient).not.toHaveBeenCalled();
  });

  it('getDetail: invio di prova (isTest) lanciato, altro user → NotFoundException', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('queued', true));
    await expect(service.getDetail('r1', OTHER)).rejects.toThrow(NotFoundException);
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed', true));
    await expect(service.getDetail('r1', OTHER)).rejects.toThrow(NotFoundException);
    expect(campaignsServiceMock.renderMessageForRecipient).not.toHaveBeenCalled();
  });

  it('getDetail: campagna lanciata, altro user → canReadAttachments false e link oscurati', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed'));
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'S', bodyHtml: '' });
    const detail = await service.getDetail('r1', OTHER);
    expect(detail.canReadAttachments).toBe(false);
    expect(campaignsServiceMock.renderMessageForRecipient).toHaveBeenCalledWith('r1', undefined, true, true);
  });

  it('getDetail: creatore → canReadAttachments true e link reali', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed'));
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'S', bodyHtml: '' });
    const detail = await service.getDetail('r1', CREATOR);
    expect(detail.canReadAttachments).toBe(true);
    expect(campaignsServiceMock.renderMessageForRecipient).toHaveBeenCalledWith('r1', undefined, true, false);
  });

  it('getDetail: co-consegna App IO oscurata per altro user', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed'));
    const attemptRepo = (service as unknown as { attemptRepo: { find: jest.Mock } }).attemptRepo;
    attemptRepo.find.mockResolvedValueOnce([{ id: 'a1', attemptNumber: 1, status: 'success', channelType: 'EMAIL', createdAt: new Date('2026-07-01T00:00:00Z'), responsePayload: { appIo: { success: true } } }]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'S', bodyHtml: '' });
    campaignsServiceMock.renderAppIoCoDeliveryPreview.mockResolvedValueOnce({ subject: 'S', bodyMarkdown: '' });
    await service.getDetail('r1', OTHER);
    expect(campaignsServiceMock.renderAppIoCoDeliveryPreview).toHaveBeenCalledWith('r1', true);
  });

  it('downloadAttachment: altro user → ForbiddenException + audit ATTACHMENT_ACCESS_DENIED', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed'));
    await expect(service.downloadAttachment('r1', 0, OTHER)).rejects.toThrow(ForbiddenException);
    expect(attachmentServiceMock.generatePdfBuffer).not.toHaveBeenCalled();
    expect(auditLogsMock.log).toHaveBeenCalledWith({
      action: 'ATTACHMENT_ACCESS_DENIED',
      operator: 'luigi',
      campaignId: 'c1',
      campaignName: 'Avviso',
      details: { endpoint: 'notifications-search/attachment', recipientId: 'r1', attachmentIndex: 0 },
    });
  });

  it('downloadAttachment: bozza altrui → NotFoundException come il dettaglio', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('draft'));
    await expect(service.downloadAttachment('r1', 0, OTHER)).rejects.toThrow(NotFoundException);
    expect(attachmentServiceMock.generatePdfBuffer).not.toHaveBeenCalled();
  });

  it('downloadAttachment: creatore → PDF generato, nessun audit', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(recipientOf('completed'));
    attachmentServiceMock.generatePdfBuffer.mockResolvedValueOnce(Buffer.from('%PDF'));
    const result = await service.downloadAttachment('r1', 0, CREATOR);
    expect(result.buffer.toString()).toBe('%PDF');
    expect(auditLogsMock.log).not.toHaveBeenCalled();
  });
});
