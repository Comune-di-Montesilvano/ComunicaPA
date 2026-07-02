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
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([expiredRecipient]),
  };
  const mockRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    update: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // getMany() è chiamato in loop finché non restituisce un array vuoto (paginazione a lotti):
    // di default simuliamo un solo lotto con un destinatario, seguito da lotti vuoti che terminano il loop.
    mockQb.getMany.mockReset();
    mockQb.getMany.mockResolvedValueOnce([expiredRecipient]).mockResolvedValue([]);
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

  it('interroga la query builder con .take(200) per limitare la dimensione del lotto', async () => {
    await service.runCleanup();
    expect(mockQb.take).toHaveBeenCalledWith(200);
  });

  it('itera su più lotti finché la query non restituisce risultati vuoti (nessun caricamento non limitato in memoria)', async () => {
    // Simuliamo 3 destinatari scaduti che rientrano ciascuno in un lotto separato (batch size mockato a 1 per riga):
    // la coda della WHERE esclude automaticamente le righe già marcate come eliminate,
    // quindi ogni chiamata a getMany() restituisce un destinatario diverso finché non se ne trovano più.
    const r1 = { id: 'r-1', campaignId: 'c-1', extraData: { allegato: 'A.pdf' }, campaign: { channelConfig: { allegatoKey: 'allegato' } } };
    const r2 = { id: 'r-2', campaignId: 'c-1', extraData: { allegato: 'B.pdf' }, campaign: { channelConfig: { allegatoKey: 'allegato' } } };
    const r3 = { id: 'r-3', campaignId: 'c-1', extraData: { allegato: 'C.pdf' }, campaign: { channelConfig: { allegatoKey: 'allegato' } } };

    // Sovrascriviamo la sequenza di default impostata in beforeEach con questo scenario specifico.
    mockQb.getMany.mockReset();
    mockQb.getMany
      .mockResolvedValueOnce([r1])
      .mockResolvedValueOnce([r2])
      .mockResolvedValueOnce([r3])
      .mockResolvedValueOnce([]);

    await service.runCleanup();

    // 4 chiamate: 3 lotti con dati + 1 lotto vuoto che termina il loop
    expect(mockQb.getMany).toHaveBeenCalledTimes(4);
    expect(mockRepo.update).toHaveBeenCalledTimes(3);
    expect(mockRepo.update).toHaveBeenNthCalledWith(1, 'r-1', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
    expect(mockRepo.update).toHaveBeenNthCalledWith(2, 'r-2', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
    expect(mockRepo.update).toHaveBeenNthCalledWith(3, 'r-3', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });

  it('usa il fallback di scansione .pdf quando allegatoKey è assente in channelConfig', async () => {
    const recipientWithoutAllegatoKey = {
      id: 'r-fallback',
      campaignId: 'c-2',
      extraData: { qualcheAltroCampo: 'valore', documentoAllegato: 'PREAVVISO.PDF' },
      campaign: { channelConfig: {} },
    };
    // Sovrascriviamo la sequenza di default impostata in beforeEach con questo scenario specifico.
    mockQb.getMany.mockReset();
    mockQb.getMany.mockResolvedValueOnce([recipientWithoutAllegatoKey]).mockResolvedValueOnce([]);

    await service.runCleanup();

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('PREAVVISO.PDF'));
    expect(mockRepo.update).toHaveBeenCalledWith('r-fallback', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });
});
