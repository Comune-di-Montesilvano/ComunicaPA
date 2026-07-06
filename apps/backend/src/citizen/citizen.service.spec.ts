import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CitizenService } from './citizen.service';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService } from '../attachments/attachment.service';

describe('CitizenService.markAsDownloaded', () => {
  const mockRecipient = { id: 'r-1', codiceFiscale: 'RSSMRA80A01H501X', extraData: {} };
  const mockRecipientRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
  };
  const mockDownloadEventRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const mockAttachmentService = { generatePdfBuffer: jest.fn() };

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
});
