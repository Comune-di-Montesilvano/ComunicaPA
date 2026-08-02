import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

describe('CampaignsController', () => {
  let controller: CampaignsController;
  const mockService = {
    getRecipientStats: jest.fn().mockResolvedValue({ campaignId: 'uuid-1', page: 1, pageSize: 50, total: 0, items: [] }),
    getRecipientFilterOptions: jest.fn().mockResolvedValue({ statuses: [], deliveryStatuses: [] }),
    assertDraftForAttachments: jest.fn(),
    finalizeAttachments: jest.fn().mockResolvedValue({ uploaded: 2, discarded: 0 }),
    remove: jest.fn().mockResolvedValue({ deleted: true }),
    getNeverDownloadedRecipients: jest.fn(),
    getFailuresByReason: jest.fn(),
    getDownloadReportRows: jest.fn(),
    getSendStatusBreakdown: jest.fn(),
    getSendReportRows: jest.fn(),
    getPostalStatusBreakdown: jest.fn(),
    getPostalReportRows: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'uuid-1', name: 'Test Campaign' }),
    finalizeInadCheck: jest.fn().mockResolvedValue(undefined),
    skipInadCheck: jest.fn().mockResolvedValue({ launched: 3, campaignId: 'uuid-1' }),
    getRecipientIdsByChannelOutcome: jest.fn(),
    updateCampaignContent: jest.fn(),
  };

  const mockAuditLogsService = {
    log: jest.fn().mockResolvedValue({}),
  };

  const mockOperatorDirectory = {
    resolveMany: jest.fn().mockResolvedValue({}),
  };

  const mockContentCorrectionService = {
    resendSafeBulk: jest.fn(),
  };

  const mockBulkRetryService = {
    createJob: jest.fn(),
    getStatus: jest.fn(),
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
      mockOperatorDirectory as any,
      mockContentCorrectionService as any,
      mockBulkRetryService as any,
    );
  });

  describe('getRecipientStats', () => {
    it('usa i valori di default quando page/pageSize non sono forniti', async () => {
      await controller.getRecipientStats('uuid-1', undefined, undefined, undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
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
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 2, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    });

    it('inoltra il parametro search al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '1', '50', 'rossi');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, 'rossi', undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    });

    it('inoltra i parametri status e deliveryStatus al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '1', '50', undefined, 'failed', 'ACCEPTED');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined, 'failed', 'ACCEPTED', undefined, undefined, undefined, undefined, undefined);
    });

    it('splitta il parametro tags (comma-separated) in un array al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '1', '50', undefined, undefined, undefined, 'diverted,appio', 'yes');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined, undefined, undefined, ['diverted', 'appio'], 'yes', undefined, undefined, undefined);
    });

    it('inoltra il parametro postalDeliveryStatus al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '1', '50', undefined, undefined, undefined, undefined, undefined, 'CONSEGNATO');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'CONSEGNATO', undefined, undefined);
    });
  });

  describe('getRecipientFilterOptions', () => {
    it('delega al service', async () => {
      mockService.getRecipientFilterOptions = jest.fn().mockResolvedValue({ statuses: ['sent'], deliveryStatuses: ['ACCEPTED'] });
      const result = await controller.getRecipientFilterOptions('uuid-1');
      expect(mockService.getRecipientFilterOptions).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ statuses: ['sent'], deliveryStatuses: ['ACCEPTED'] });
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

  describe('updateCampaignContent', () => {
    it('PATCH content: delega al service e loggua audit', async () => {
      mockService.updateCampaignContent = jest.fn(async () => ({ id: 'camp-1', name: 'TARI' } as any));

      const result = await controller.updateCampaignContent('camp-1', { body: 'nuovo' }, mockReq);

      expect(mockService.updateCampaignContent).toHaveBeenCalledWith('camp-1', { body: 'nuovo' }, 'test-operator');
      expect(mockAuditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CONTENT_CORRECTION' }));
      expect(result).toEqual({ id: 'camp-1', name: 'TARI' });
    });
  });

  describe('resendContent', () => {
    it('resend-content: recipientIds vuoto/assente → BadRequestException', () => {
      expect(() => controller.resendContent('camp-1', [], mockReq)).toThrow(BadRequestException);
      expect(() => controller.resendContent('camp-1', undefined as any, mockReq)).toThrow(BadRequestException);
    });

    it('resend-content: delega al service e loggua audit con il conteggio', async () => {
      mockContentCorrectionService.resendSafeBulk = jest.fn(async () => [
        { recipientId: 'r1', result: 'resent' },
        { recipientId: 'r2', result: 'skipped' },
      ]);
      mockService.findOne = jest.fn(async () => ({ id: 'camp-1', name: 'TARI' } as any));

      const result = await controller.resendContent('camp-1', ['r1', 'r2'], mockReq);

      expect(mockContentCorrectionService.resendSafeBulk).toHaveBeenCalledWith('camp-1', ['r1', 'r2']);
      expect(mockAuditLogsService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESEND_CONTENT', details: { count: 2 } }),
      );
      expect(result).toEqual([{ recipientId: 'r1', result: 'resent' }, { recipientId: 'r2', result: 'skipped' }]);
    });
  });

  describe('remove', () => {
    it('delega a campaignsService.remove', async () => {
      const result = await controller.remove('uuid-1', mockReq);
      expect(mockService.remove).toHaveBeenCalledWith('uuid-1', { username: 'test-operator', role: 'admin' });
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
    it('rifiuta un body senza errorMessage', async () => {
      await expect(controller.retryRecipientsBulk('uuid-1', undefined as any, mockReq)).rejects.toThrow(BadRequestException);
    });

    it('rifiuta una stringa vuota', async () => {
      await expect(controller.retryRecipientsBulk('uuid-1', '', mockReq)).rejects.toThrow(BadRequestException);
    });

    it('crea un job async tramite bulkRetryService (solo errorMessage, mai un array di id) e ritorna jobId/totalCount', async () => {
      mockBulkRetryService.createJob.mockResolvedValue({ jobId: 'job-1', totalCount: 3205 });
      const result = await controller.retryRecipientsBulk('uuid-1', 'timeout', mockReq);
      expect(mockBulkRetryService.createJob).toHaveBeenCalledWith('uuid-1', 'timeout', 'test-operator');
      expect(result).toEqual({ jobId: 'job-1', totalCount: 3205 });
    });
  });

  describe('getRetryBulkStatus', () => {
    it('chiama il service con lo jobId', async () => {
      mockBulkRetryService.getStatus.mockResolvedValue({ status: 'done' });
      const result = await controller.getRetryBulkStatus('job-1');
      expect(mockBulkRetryService.getStatus).toHaveBeenCalledWith('job-1');
      expect(result).toEqual({ status: 'done' });
    });
  });

  describe('exportDownloadReportCsv', () => {
    it('imposta gli header CSV e invia il body generato dal service', async () => {
      mockService.getDownloadReportRows = jest.fn().mockResolvedValue({
        hasExternalId: false,
        rows: [
          { codiceFiscale: 'AAA1', fullName: null, email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null, externalId: null },
        ],
      });
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

  describe('postal status endpoints', () => {
    it('getPostalStatusBreakdown delega al service', async () => {
      mockService.getPostalStatusBreakdown = jest.fn().mockResolvedValue([{ status: 'Consegnato', count: 3 }]);
      const result = await controller.getPostalStatusBreakdown('c1');
      expect(mockService.getPostalStatusBreakdown).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ status: 'Consegnato', count: 3 }]);
    });

    it('exportPostalReportAttuale scrive CSV con header e content-disposition corretti', async () => {
      mockService.getPostalReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportPostalReportAttuale('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_postal_attuale_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Codice Fiscale'));
    });

    it('exportPostalReportStorico scrive CSV con header e content-disposition corretti', async () => {
      mockService.getPostalReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportPostalReportStorico('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_postal_storico_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Data Accettato'));
    });
  });

  describe('inad-check retry/skip', () => {
    it('retryInadCheck chiama finalizeInadCheck e logga audit', async () => {
      await controller.retryInadCheck('uuid-1', mockReq);
      expect(mockService.finalizeInadCheck).toHaveBeenCalledWith('uuid-1');
      expect(mockAuditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INAD_CHECK_RETRY', campaignId: 'uuid-1' }));
    });

    it('skipInadCheck chiama il servizio e logga audit', async () => {
      const result = await controller.skipInadCheck('uuid-1', mockReq);
      expect(result.launched).toBe(3);
      expect(mockService.skipInadCheck).toHaveBeenCalledWith('uuid-1');
      expect(mockAuditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INAD_CHECK_SKIP', campaignId: 'uuid-1' }));
    });
  });

  describe('getRecipientIdsByChannelOutcome', () => {
    it('recipients-by-channel-outcome: outcome non valido → BadRequestException', () => {
      expect(() => controller.getRecipientIdsByChannelOutcome('camp-1', 'invalid' as any)).toThrow(BadRequestException);
    });

    it('recipients-by-channel-outcome: delega al service con outcome valido', async () => {
      mockService.getRecipientIdsByChannelOutcome = jest.fn(async () => ['r1', 'r2']);
      const result = await controller.getRecipientIdsByChannelOutcome('camp-1', 'both');
      expect(mockService.getRecipientIdsByChannelOutcome).toHaveBeenCalledWith('camp-1', 'both');
      expect(result).toEqual({ recipientIds: ['r1', 'r2'] });
    });
  });
});
