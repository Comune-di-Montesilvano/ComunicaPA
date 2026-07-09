import { Test } from '@nestjs/testing';
import { GoneException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PublicDownloadController } from './public-download.controller';
import { AttachmentService } from '../attachments/attachment.service';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { signDownloadLink } from '../channels/download-link.util';

describe('PublicDownloadController', () => {
  let controller: PublicDownloadController;
  const secret = 'test-secret';
  const recipientId = 'r-1';
  const futureExp = Math.floor(Date.now() / 1000) + 3600;

  const mockRecipient = {
    id: recipientId,
    attachmentDeletedAt: null,
    downloadCount: 0,
    firstDownloadedAt: null,
    lastDownloadedAt: null,
    campaign: { channelConfig: {} },
    extraData: {},
  };

  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockAttachmentService = {
    generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
  };
  const mockDownloadEventRepo = {
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const mockConfig = { get: () => secret };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(mockRecipient);
    const module = await Test.createTestingModule({
      controllers: [PublicDownloadController],
      providers: [
        { provide: getRepositoryToken(Recipient), useValue: mockRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    controller = module.get(PublicDownloadController);
  });

  it('rifiuta con 403 se la firma non è valida', async () => {
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), 'firma-non-valida', undefined, undefined, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se l\'indice non corrisponde alla firma (firma dell\'indice 0 usata per l\'indice 1)', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '1', String(futureExp), sig, undefined, undefined, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se il canale non corrisponde alla firma', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret, 'EMAIL');
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), sig, 'APP_IO', undefined, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se preview=1 viene aggiunto a un link firmato senza preview', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), sig, undefined, '1', res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 410 se il link è scaduto', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const sig = signDownloadLink(recipientId, 0, pastExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(pastExp), sig, undefined, undefined, res)).rejects.toThrow(GoneException);
  });

  it('rifiuta con 410 se l\'allegato è già stato eliminato per retention', async () => {
    mockRepo.findOne.mockResolvedValueOnce({ ...mockRecipient, attachmentDeletedAt: new Date() });
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(futureExp), sig, undefined, undefined, res)).rejects.toThrow(GoneException);
  });

  it('serve il PDF, incrementa downloadCount e registra un DownloadEvent col canale corretto', async () => {
    const sig = signDownloadLink(recipientId, 1, futureExp, secret, 'EMAIL');
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await controller.download(recipientId, '1', String(futureExp), sig, 'EMAIL', undefined, res);
    expect(mockAttachmentService.generatePdfBuffer).toHaveBeenCalledWith(mockRecipient, 1);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
    expect(mockRepo.update).toHaveBeenCalledWith(
      recipientId,
      expect.objectContaining({ downloadCount: 1 }),
    );
    expect(mockDownloadEventRepo.insert).toHaveBeenCalledWith({
      recipientId,
      channel: 'EMAIL',
      attachmentIndex: 1,
    });
  });

  it('serve comunque il PDF se la registrazione del DownloadEvent fallisce', async () => {
    mockDownloadEventRepo.insert.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    const sig = signDownloadLink(recipientId, 1, futureExp, secret, 'EMAIL');
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '1', String(futureExp), sig, 'EMAIL', undefined, res),
    ).resolves.toBeUndefined();
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
  });

  it('con preview=1 (link firmato come preview) serve il PDF ma NON incrementa downloadCount né registra DownloadEvent', async () => {
    const sig = signDownloadLink(recipientId, 1, futureExp, secret, 'EMAIL', true);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await controller.download(recipientId, '1', String(futureExp), sig, 'EMAIL', '1', res);
    expect(mockAttachmentService.generatePdfBuffer).toHaveBeenCalledWith(mockRecipient, 1);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(mockDownloadEventRepo.insert).not.toHaveBeenCalled();
  });
});
