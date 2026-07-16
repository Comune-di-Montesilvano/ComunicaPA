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
    getFailuresByReason: jest.fn(),
    retryRecipientsBulk: jest.fn(),
    getDownloadReportRows: jest.fn(),
    getSendStatusBreakdown: jest.fn(),
    getSendReportRows: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'uuid-1', name: 'Test Campaign' }),
  };

  const mockAuditLogsService = {
    log: jest.fn().mockResolvedValue({}),
  };

  const mockReq = {
    user: {
      username: 'test-operator',
      role: 'admin',
      type: 'operator',
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CampaignsController(
      mockService as unknown as CampaignsService,
      mockAuditLogsService as any,
    );
  });

  describe('getRecipientStats', () => {
    it('usa i valori di default quando page/pageSize non sono forniti', async () => {
      await controller.getRecipientStats('uuid-1', undefined, undefined, undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined);
    });

    it('rifiuta un page non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', 'abc', undefined, undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, 'xyz', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un page negativo con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', '-1', undefined, undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize pari a zero con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, '0', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('accetta valori validi e li inoltra al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '2', '25', undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 2, 25, undefined);
    });

    it('inoltra il parametro search al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '1', '50', 'rossi');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, 'rossi');
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

      await expect(controller.uploadAttachments('uuid-1', files, mockReq)).rejects.toThrow(BadRequestException);

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

      await expect(controller.uploadAttachments('uuid-1', files, mockReq)).rejects.toThrow(BadRequestException);
      expect(unlinkSpy).toHaveBeenCalledTimes(2);
      unlinkSpy.mockRestore();
    });

    it('accetta gli allegati e NON elimina i file quando la campagna è in DRAFT', async () => {
      const unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
      mockService.assertDraftForAttachments.mockResolvedValueOnce(undefined);

      const res = await controller.uploadAttachments('uuid-1', files, mockReq);

      expect(res).toEqual({ uploaded: 2, discarded: 0, campaignId: 'uuid-1' });
      expect(unlinkSpy).not.toHaveBeenCalled();
      unlinkSpy.mockRestore();
    });
  });

  describe('remove', () => {
    it('delega a campaignsService.remove', async () => {
      const result = await controller.remove('uuid-1', mockReq);
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

  describe('getFailuresByReason', () => {
    it('chiama il service con l\'id campagna', async () => {
      mockService.getFailuresByReason = jest.fn().mockResolvedValue([]);
      await controller.getFailuresByReason('uuid-1');
      expect(mockService.getFailuresByReason).toHaveBeenCalledWith('uuid-1');
    });
  });

  describe('retryRecipientsBulk', () => {
    it('rifiuta un body senza recipientIds', () => {
      expect(() => controller.retryRecipientsBulk('uuid-1', undefined as any, mockReq)).toThrow(BadRequestException);
    });

    it('rifiuta un array vuoto', () => {
      expect(() => controller.retryRecipientsBulk('uuid-1', [], mockReq)).toThrow(BadRequestException);
    });

    it('chiama il service con id campagna e recipientIds', async () => {
      mockService.retryRecipientsBulk = jest.fn().mockResolvedValue({ requeued: 1, failed: [] });
      await controller.retryRecipientsBulk('uuid-1', ['r1'], mockReq);
      expect(mockService.retryRecipientsBulk).toHaveBeenCalledWith('uuid-1', ['r1']);
    });
  });

  describe('exportDownloadReportCsv', () => {
    it('imposta gli header CSV e invia il body generato dal service', async () => {
      mockService.getDownloadReportRows = jest.fn().mockResolvedValue([
        { codiceFiscale: 'AAA1', fullName: null, email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null },
      ]);
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportDownloadReportCsv('uuid-1', res);

      expect(mockService.getDownloadReportRows).toHaveBeenCalledWith('uuid-1');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('AAA1'));
    });
  });

  describe('send status endpoints', () => {
    it('getSendStatusBreakdown delega al service', async () => {
      mockService.getSendStatusBreakdown = jest.fn().mockResolvedValue([{ status: 'DELIVERED', count: 3 }]);
      const result = await controller.getSendStatusBreakdown('c1');
      expect(mockService.getSendStatusBreakdown).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ status: 'DELIVERED', count: 3 }]);
    });

    it('exportSendReportAttuale scrive CSV con header e content-disposition corretti', async () => {
      mockService.getSendReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportSendReportAttuale('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_send_attuale_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Codice Fiscale'));
    });

    it('exportSendReportStorico scrive CSV con header e content-disposition corretti', async () => {
      mockService.getSendReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportSendReportStorico('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_send_storico_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Data Accettazione'));
    });
  });
});
