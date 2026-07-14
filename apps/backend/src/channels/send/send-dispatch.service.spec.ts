import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendDispatchService } from './send-dispatch.service';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { Campaign } from '../../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../../entities/recipient.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.apiKey': 'apikey-abc',
  'send.test.purposeId': 'purpose-test',
  'send.senderTaxId': '01234567890',
  'brand.name': 'Comune di Prova',
};

describe('SendDispatchService', () => {
  let service: SendDispatchService;
  const mockQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn(() => mockQb),
    find: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mockRecipientRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const mockCampaignRepo = { increment: jest.fn().mockResolvedValue(undefined) };
  const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
  const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
  const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
  const mockUpload = { preloadAndUpload: jest.fn(async (_b: string, _ak: string, _v: string, _buf: Buffer, _ct: string, idx: string) => ({ key: `key-${idx}`, versionToken: `vt-${idx}`, sha256Base64: 'abc123==' })) };

  function makeAttempt(overrides: Partial<NotificationAttempt> = {}): NotificationAttempt {
    return {
      id: 'att-1',
      protocolNumber: 111,
      protocolYear: 2026,
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        extraData: {},
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: { subject: 'Avviso TARI 2026', taxonomyCode: '010101P', physicalCommunicationType: 'AR_REGISTERED_LETTER' },
        } as unknown as Campaign,
      } as unknown as Recipient,
      ...overrides,
    } as NotificationAttempt;
  }

  function mockBatch(attempts: NotificationAttempt[]): void {
    mockQb.getRawMany.mockResolvedValueOnce(attempts.map((a) => ({ id: a.id })));
    mockAttemptRepo.find.mockResolvedValueOnce(attempts);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockFetch.mockResolvedValue({ ok: true, status: 202, json: () => Promise.resolve({ notificationRequestId: 'req-001' }) });
    settingsValues['retention.maxDays'] = 90;
    const module = await Test.createTestingModule({
      providers: [
        SendDispatchService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: SendAttachmentUploadService, useValue: mockUpload },
      ],
    }).compile();
    service = module.get(SendDispatchService);
  });

  it('interroga attempt SEND protocollati non ancora inviati', async () => {
    mockQb.getRawMany.mockResolvedValueOnce([]);
    await service.handleCron();
    expect(mockQb.where).toHaveBeenCalledWith('attempt.channel_type = :ch', { ch: 'SEND' });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.status = :status', { status: AttemptStatus.QUEUED });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.protocolled_at IS NOT NULL');
    expect(mockQb.andWhere).toHaveBeenCalledWith("attempt.response_payload ->> 'notificationRequestId' IS NULL");
    expect(mockAttemptRepo.find).not.toHaveBeenCalled();
  });

  it('invia a PN, marca SUCCESS e incrementa sentCount', async () => {
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockAttemptRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      relations: { recipient: { campaign: true } },
    }));

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    expect(sendCall).toBeDefined();
    expect(sendCall![1].headers).toEqual(expect.objectContaining({
      'x-api-key': 'apikey-abc',
      Authorization: 'Bearer voucher-abc',
    }));
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.paProtocolNumber).toBe('111/2026');
    expect(payload.idempotenceToken).toBe('att-1');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      { id: 'att-1', status: AttemptStatus.QUEUED },
      expect.objectContaining({
        status: AttemptStatus.SUCCESS,
        responsePayload: expect.objectContaining({ notificationRequestId: 'req-001' }),
      }),
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: RecipientStatus.SENT }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
  });

  it('marca FAILED e incrementa failedCount se PN risponde errore', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('{"errors":["bad"]}') });
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      { id: 'att-1', status: AttemptStatus.QUEUED },
      expect.objectContaining({ status: AttemptStatus.FAILED }),
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: RecipientStatus.FAILED }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
  });

  it('non aggiorna recipient/campaign se l\'attempt non è più QUEUED (cancellato durante l\'invio)', async () => {
    // Ogni update() guardato su status=QUEUED riporta 0 righe toccate: sia la
    // scrittura durevole intermedia (post-upload) sia quella finale (markSuccess)
    // devono rispettare la cancellazione avvenuta nel frattempo.
    mockAttemptRepo.update.mockResolvedValue({ affected: 0 });
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockRecipientRepo.update).not.toHaveBeenCalled();
    expect(mockCampaignRepo.increment).not.toHaveBeenCalled();
  });

  it('scrive uploadedDocuments su DB subito dopo ogni upload riuscito (scrittura durevole)', async () => {
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      { id: 'att-1', status: AttemptStatus.QUEUED },
      { uploadedDocuments: [{ docIdx: 0, key: 'key-doc-0', versionToken: 'vt-doc-0', sha256Base64: 'abc123==' }] },
    );
  });

  it('riusa un documento già caricato (uploadedDocuments ereditato da un retry) invece di ricaricarlo', async () => {
    const attempt = makeAttempt({
      uploadedDocuments: [{ docIdx: 0, key: 'key-old', versionToken: 'vt-old', sha256Base64: 'sha-old==' }],
    });
    mockBatch([attempt]);

    await service.handleCron();

    expect(mockUpload.preloadAndUpload).not.toHaveBeenCalled();
    expect(mockAttachments.generatePdfBuffer).not.toHaveBeenCalled();
    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.documents).toEqual([{
      ref: { key: 'key-old', versionToken: 'vt-old' },
      title: 'Avviso TARI 2026',
      digests: { sha256: 'sha-old==' },
      contentType: 'application/pdf',
      docIdx: '0',
    }]);
  });

  it('include payments nel destinatario se paymentConfig risolve dati validi', async () => {
    const attempt = makeAttempt({
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        extraData: { importo: '50', avviso: '999888777', cf_ente: '00223344556' },
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: {
            subject: 'Avviso',
            taxonomyCode: '010101P',
            paymentConfig: { enabled: true, amountColumn: 'importo', amountType: 'euro', noticeNumberColumn: 'avviso', payeeFiscalCodeType: 'column', payeeFiscalCodeColumn: 'cf_ente' },
          },
        } as unknown as Campaign,
      } as unknown as Recipient,
    });
    mockBatch([attempt]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].payments).toEqual([
      { pagoPa: { noticeCode: '999888777', creditorTaxId: '00223344556', applyCost: true } },
    ]);
  });

  it('include physicalAddress nel destinatario se physicalAddressConfig risolve dati validi', async () => {
    const attempt = makeAttempt({
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        extraData: { indirizzo: 'Via Roma 1', comune: 'Comuneesempio', cap: '00000', prov: 'XX' },
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: {
            subject: 'Avviso',
            taxonomyCode: '010101P',
            physicalAddressConfig: { enabled: true, addressColumn: 'indirizzo', municipalityColumn: 'comune', zipColumn: 'cap', provinceColumn: 'prov' },
          },
        } as unknown as Campaign,
      } as unknown as Recipient,
    });
    mockBatch([attempt]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].physicalAddress).toEqual({
      address: 'Via Roma 1',
      municipality: 'Comuneesempio',
      zip: '00000',
      province: 'XX',
    });
  });
});
