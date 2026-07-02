import * as fs from 'fs/promises';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RetentionCleanupService } from './retention-cleanup.service';
import { Recipient } from '../entities/recipient.entity';

jest.mock('fs/promises', () => ({ unlink: jest.fn().mockResolvedValue(undefined) }));

describe('RetentionCleanupService', () => {
  let service: RetentionCleanupService;

  const expiredRecipient = {
    id: 'r-expired',
    campaignId: 'c-1',
    extraData: { allegato: 'DOC_1_1.pdf' },
    campaign: { channelConfig: { allegatoKey: 'allegato' } },
  };

  const mockQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([expiredRecipient]),
  };
  const mockRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    update: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQb.getMany.mockResolvedValue([expiredRecipient]);
    const module = await Test.createTestingModule({
      providers: [RetentionCleanupService, { provide: getRepositoryToken(Recipient), useValue: mockRepo }],
    }).compile();
    service = module.get(RetentionCleanupService);
  });

  it('elimina il file allegato scaduto e marca attachmentDeletedAt', async () => {
    await service.runCleanup();

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('DOC_1_1.pdf'));
    expect(mockRepo.update).toHaveBeenCalledWith('r-expired', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });

  it('marca comunque attachmentDeletedAt se il file non esiste più su disco (idempotenza)', async () => {
    (fs.unlink as jest.Mock).mockRejectedValueOnce(new Error('ENOENT'));
    await service.runCleanup();
    expect(mockRepo.update).toHaveBeenCalledWith('r-expired', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });
});
