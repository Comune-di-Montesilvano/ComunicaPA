import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { APP_IO_VERIFY_BULK_QUEUE } from './app-io-verify-bulk-job.types';

describe('AppIoVerifyBulkService', () => {
  let service: AppIoVerifyBulkService;
  const jobRepoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'job-1', ...x })),
    findOneBy: jest.fn(),
  };
  const ioServiceRepoMock = { findOneBy: jest.fn() };
  const queueMock = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppIoVerifyBulkService,
        { provide: getRepositoryToken(AppIoVerificationJob), useValue: jobRepoMock },
        { provide: getRepositoryToken(IoServiceConfig), useValue: ioServiceRepoMock },
        { provide: getQueueToken(APP_IO_VERIFY_BULK_QUEUE), useValue: queueMock },
      ],
    }).compile();
    service = moduleRef.get(AppIoVerifyBulkService);
  });

  describe('createJob', () => {
    it('blocked se il servizio App IO non esiste', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue(null);
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'nope' });
      expect(result).toEqual({ blocked: true, message: 'Servizio App IO selezionato non trovato' });
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('blocked se il CSV non ha righe di dati', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('non contiene righe');
    });

    it('blocked se la colonna CF scelta non esiste tra le intestazioni', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z', hasHeaders: true, cfColumn: 'colonna_sbagliata', ioServiceId: 'svc-1' });
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('colonna_sbagliata');
    });

    it('crea il job e lo accoda con jobId=id del job creato', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z\nVRDLGI80A01H501W', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });
      expect(result).toEqual({ jobId: 'job-1' });
      expect(jobRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
        status: AppIoVerificationJobStatus.QUEUED,
        totalRows: 2,
        ioServiceId: 'svc-1',
        cfColumn: 'cf',
      }));
      expect(queueMock.add).toHaveBeenCalledWith('verify', { jobId: 'job-1' }, { jobId: 'job-1' });
    });
  });

  describe('getStatus', () => {
    it('lancia NotFoundException se il job non esiste', async () => {
      jobRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(NotFoundException);
    });

    it('ritorna i campi di stato del job', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({
        status: AppIoVerificationJobStatus.PROCESSING, totalRows: 10, processedRows: 5, presentCount: 0, absentCount: 0, errorMessage: null,
      });
      const result = await service.getStatus('job-1');
      expect(result).toEqual({ status: AppIoVerificationJobStatus.PROCESSING, totalRows: 10, processedRows: 5, presentCount: 0, absentCount: 0, errorMessage: null });
    });
  });

  describe('getResultCsv', () => {
    it('lancia se il job non è DONE', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({ status: AppIoVerificationJobStatus.PROCESSING });
      await expect(service.getResultCsv('job-1', 'present')).rejects.toThrow('non è ancora completato');
    });

    it('ritorna il CSV richiesto quando DONE', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({
        status: AppIoVerificationJobStatus.DONE, resultPresentCsv: 'PRESENTI', resultAbsentCsv: 'ASSENTI',
      });
      expect(await service.getResultCsv('job-1', 'present')).toBe('PRESENTI');
      expect(await service.getResultCsv('job-1', 'absent')).toBe('ASSENTI');
    });
  });
});
