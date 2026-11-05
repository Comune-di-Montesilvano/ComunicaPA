import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Not } from 'typeorm';
import { CitizenService } from './citizen.service.js';
import { Recipient } from '../entities/recipient.entity.js';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { AttachmentService } from '../attachments/attachment.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';

describe('CitizenService.markAsDownloaded', () => {
  const mockRecipient = { id: 'r-1', codiceFiscale: 'RSSMRA80A01H501X', extraData: {} };
  const mockRecipientRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
  };
  const mockDownloadEventRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const mockAttachmentService = { generatePdfBuffer: jest.fn() };
  const mockCampaignsService = { renderMessageForRecipient: jest.fn().mockResolvedValue({ subject: 'Oggetto', bodyHtml: '<p>Corpo</p>' }) };

  let service: CitizenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRecipientRepo.findOne.mockResolvedValue({ ...mockRecipient, extraData: {} });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CitizenService,
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: CampaignsService, useValue: mockCampaignsService },
      ],
    }).compile();
    service = moduleRef.get(CitizenService);
  });

  it('incrementa extraData.download_count come prima E registra un DownloadEvent CITIZEN_PORTAL', async () => {
    await service.markAsDownloaded('r-1', 'RSSMRA80A01H501X');

    expect(mockRecipientRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ extraData: expect.objectContaining({ download_count: 1 }) }),
    );
    expect(mockDownloadEventRepo.insert).toHaveBeenCalledWith({
      recipientId: 'r-1',
      channel: 'CITIZEN_PORTAL',
      attachmentIndex: 0,
    });
  });

  it('risolve comunque con il recipient se la registrazione del DownloadEvent fallisce', async () => {
    mockDownloadEventRepo.insert.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    await expect(service.markAsDownloaded('r-1', 'RSSMRA80A01H501X')).resolves.toEqual(
      expect.objectContaining({ id: 'r-1' }),
    );
    expect(mockRecipientRepo.save).toHaveBeenCalled();
  });
});

describe('CitizenService — esclude campagne in bozza', () => {
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
  };
  const mockDownloadEventRepo = { insert: jest.fn() };
  const mockAttachmentService = { generatePdfBuffer: jest.fn() };
  const mockCampaignsService = { renderMessageForRecipient: jest.fn() };

  let service: CitizenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRecipientRepo.find.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CitizenService,
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: CampaignsService, useValue: mockCampaignsService },
      ],
    }).compile();
    service = moduleRef.get(CitizenService);
  });

  it('findAllForCitizen filtra campaign.status != DRAFT', async () => {
    await service.findAllForCitizen('RSSMRA80A01H501X');

    expect(mockRecipientRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ campaign: { status: Not(CampaignStatus.DRAFT) } }),
      }),
    );
  });

  it('findOneForCitizen (via download) filtra campaign.status != DRAFT — bozza non trovata', async () => {
    mockRecipientRepo.findOne.mockResolvedValue(null);

    await expect(service.markAsDownloaded('r-bozza', 'RSSMRA80A01H501X')).rejects.toThrow('non trovata');

    expect(mockRecipientRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ campaign: { status: Not(CampaignStatus.DRAFT) } }),
      }),
    );
  });
});

describe('CitizenService — notifica SEND senza documenti nel portale', () => {
  const sendRecipient = {
    id: 'r-send', codiceFiscale: 'RSSMRA80A01H501X', extraData: {}, attempts: [],
    campaign: { channelType: 'SEND', channelConfig: { attachments: [{ key: 'allegato', label: 'Avviso' }] } },
  };
  const mockRecipientRepo = { find: jest.fn(), findOne: jest.fn() };
  const mockAttachmentService = { generatePdfBuffer: jest.fn() };
  const mockCampaignsService = { renderMessageForRecipient: jest.fn().mockResolvedValue({ subject: 'Oggetto' }) };
  let service: CitizenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRecipientRepo.findOne.mockResolvedValue(sendRecipient);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CitizenService,
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: { insert: jest.fn() } },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: CampaignsService, useValue: mockCampaignsService },
      ],
    }).compile();
    service = moduleRef.get(CitizenService);
  });

  it('il dettaglio non elenca allegati', async () => {
    const dto = await service.findOneForCitizen('r-send', 'RSSMRA80A01H501X');
    expect(dto.attachments).toEqual([]);
  });

  it('il download di un allegato è rifiutato', async () => {
    await expect(service.generateAttachmentPdf('r-send', 'RSSMRA80A01H501X', 0)).rejects.toThrow('notifichedigitali.it');
    expect(mockAttachmentService.generatePdfBuffer).not.toHaveBeenCalled();
  });

  const withLegalDate = (daysAgo: number) => ({
    ...sendRecipient,
    attempts: [{
      channelType: 'SEND', status: 'success', iun: 'AAAA-BBBB-CCCC-202601-A-1',
      sendStatusHistory: [{ status: 'VIEWED', activeFrom: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }],
    }],
  });

  it('entro i 120 giorni dalla data legale: nessun allegato, scadenza esposta', async () => {
    mockRecipientRepo.findOne.mockResolvedValue(withLegalDate(30));
    const dto = await service.findOneForCitizen('r-send', 'RSSMRA80A01H501X');
    expect(dto.attachments).toEqual([]);
    expect(dto.sendCopyAvailable).toBe(false);
    expect(new Date(dto.sendDocumentsAvailableUntil!).getTime()).toBeGreaterThan(Date.now());
    await expect(service.generateAttachmentPdf('r-send', 'RSSMRA80A01H501X', 0)).rejects.toThrow('120 giorni');
  });

  it('oltre i 120 giorni: copia locale elencata e scaricabile', async () => {
    mockRecipientRepo.findOne.mockResolvedValue(withLegalDate(121));
    mockAttachmentService.generatePdfBuffer.mockResolvedValue(Buffer.from('%PDF'));
    const dto = await service.findOneForCitizen('r-send', 'RSSMRA80A01H501X');
    expect(dto.attachments).toEqual([{ index: 0, label: 'Avviso' }]);
    expect(dto.sendCopyAvailable).toBe(true);
    await expect(service.generateAttachmentPdf('r-send', 'RSSMRA80A01H501X', 0)).resolves.toEqual(Buffer.from('%PDF'));
  });

  it('notifica senza valore legale: nessuna scadenza, nessuna copia', async () => {
    const dto = await service.findOneForCitizen('r-send', 'RSSMRA80A01H501X');
    expect(dto.sendDocumentsAvailableUntil).toBeNull();
    expect(dto.sendCopyAvailable).toBe(false);
  });
});
