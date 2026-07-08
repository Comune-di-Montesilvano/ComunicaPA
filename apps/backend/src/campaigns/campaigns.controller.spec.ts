import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

describe('CampaignsController', () => {
  let controller: CampaignsController;
  const mockService = {
    getRecipientStats: jest.fn().mockResolvedValue({ campaignId: 'uuid-1', page: 1, pageSize: 50, total: 0, items: [] }),
    assertDraftForAttachments: jest.fn(),
    finalizeAttachments: jest.fn().mockResolvedValue({ uploaded: 2, discarded: 0 }),
    remove: jest.fn().mockResolvedValue({ deleted: true }),
    getNeverDownloadedRecipients: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CampaignsController(mockService as unknown as CampaignsService);
  });

  describe('getRecipientStats', () => {
    it('usa i valori di default quando page/pageSize non sono forniti', async () => {
      await controller.getRecipientStats('uuid-1', undefined, undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50);
    });

    it('rifiuta un page non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', 'abc', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, 'xyz')).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un page negativo con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', '-1', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize pari a zero con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, '0')).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('accetta valori validi e li inoltra al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '2', '25');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 2, 25);
    });
  });

  describe('uploadAttachments', () => {
    const files = [
      { path: '/tmp/uploads/a.pdf' },
      { path: '/tmp/uploads/b.pdf' },
    ] as unknown as Express.Multer.File[];

    it('I1: elimina i file appena caricati se la campagna non è in DRAFT, poi rilancia', async () => {
      const unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
      mockService.assertDraftForAttachments.mockRejectedValueOnce(
        new BadRequestException('La campagna non è in stato DRAFT'),
      );

      await expect(controller.uploadAttachments('uuid-1', files)).rejects.toThrow(BadRequestException);

      expect(unlinkSpy).toHaveBeenCalledTimes(2);
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/uploads/a.pdf');
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/uploads/b.pdf');
      unlinkSpy.mockRestore();
    });

    it('I1: un file già assente non maschera il 400 originale', async () => {
      const unlinkSpy = jest
        .spyOn(fs.promises, 'unlink')
        .mockRejectedValue(new Error('ENOENT'));
      mockService.assertDraftForAttachments.mockRejectedValueOnce(
        new BadRequestException('La campagna non è in stato DRAFT'),
      );

      await expect(controller.uploadAttachments('uuid-1', files)).rejects.toThrow(BadRequestException);
      expect(unlinkSpy).toHaveBeenCalledTimes(2);
      unlinkSpy.mockRestore();
    });

    it('accetta gli allegati e NON elimina i file quando la campagna è in DRAFT', async () => {
      const unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
      mockService.assertDraftForAttachments.mockResolvedValueOnce(undefined);

      const res = await controller.uploadAttachments('uuid-1', files);

      expect(res).toEqual({ uploaded: 2, discarded: 0, campaignId: 'uuid-1' });
      expect(unlinkSpy).not.toHaveBeenCalled();
      unlinkSpy.mockRestore();
    });
  });

  describe('remove', () => {
    it('delega a campaignsService.remove', async () => {
      const result = await controller.remove('uuid-1');
      expect(mockService.remove).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ deleted: true });
    });
  });

  describe('exportNeverDownloadedCsv', () => {
    it('imposta gli header CSV e invia il body generato dal service', async () => {
      const rows = [
        { codiceFiscale: 'AAA1', fullName: null, campaignName: 'Tari', channelType: 'EMAIL', status: 'sent', createdAt: '2026-06-01T10:00:00.000Z' },
      ];
      mockService.getNeverDownloadedRecipients = jest.fn().mockResolvedValue(rows);
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportNeverDownloadedCsv(undefined, undefined, res);

      expect(mockService.getNeverDownloadedRecipients).toHaveBeenCalledWith(undefined, undefined);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="mai_scaricato.csv"');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('AAA1'));
    });
  });
});
