import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Not } from 'typeorm';
import { CitizenService } from './citizen.service';
import { Recipient } from '../entities/recipient.entity';
import { CampaignStatus } from '../entities/campaign.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService } from '../attachments/attachment.service';
import { CampaignsService } from '../campaigns/campaigns.service';

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
