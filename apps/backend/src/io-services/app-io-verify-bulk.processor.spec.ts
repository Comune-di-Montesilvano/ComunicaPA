import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppIoVerifyBulkProcessor, isPresentResult } from './app-io-verify-bulk.processor.js';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { DomicileVerificationEventsService } from '../channels/domicile-verification/domicile-verification-events.service.js';

describe('isPresentResult', () => {
  it('presente solo se success && active && messaggio non contiene "disabilitati"', () => {
    expect(isPresentResult({ success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' })).toBe(true);
    expect(isPresentResult({ success: true, active: true, message: 'Iscritto ma messaggi disabilitati dall\'utente' })).toBe(false);
    expect(isPresentResult({ success: true, active: false, message: 'Cittadino non iscritto' })).toBe(false);
    expect(isPresentResult({ success: false, active: false, message: 'Errore di connessione' })).toBe(false);
  });
});

describe('AppIoVerifyBulkProcessor', () => {
  let processor: AppIoVerifyBulkProcessor;
  const jobRepoMock = { findOneBy: jest.fn(), update: jest.fn() };
  const ioServiceRepoMock = { findOneBy: jest.fn() };
  const ioServicesMock = { verifyProfile: jest.fn() };
  const domicileEventsMock = { notifyJobProgress: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppIoVerifyBulkProcessor,
        { provide: getRepositoryToken(DomicileVerificationJob), useValue: jobRepoMock },
        { provide: getRepositoryToken(IoServiceConfig), useValue: ioServiceRepoMock },
        { provide: IoServicesService, useValue: ioServicesMock },
        { provide: DomicileVerificationEventsService, useValue: domicileEventsMock },
      ],
    }).compile();
    processor = moduleRef.get(AppIoVerifyBulkProcessor);
  });

  it('classifica presenti/assenti sui soli CF plausibili (16 char), scrive appIoResults e marca appIoDone', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-1',
      sourceCsv: 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nAAAAAA,CF Corto\nVRDLGI80A01H501W,Luigi Verdi',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1', apiKeyPrimariaEnc: 'enc:v1:xxx' });
    ioServicesMock.verifyProfile.mockImplementation(async (cf: string) => {
      if (cf === 'RSSMRA85M01H501Z') return { success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' };
      return { success: true, active: false, message: 'Cittadino non iscritto ad App IO' };
    });

    await processor.process({ data: { jobId: 'job-1' } } as any);

    expect(ioServicesMock.verifyProfile).toHaveBeenCalledTimes(2); // AAAAAA è CF non plausibile, nessuna chiamata
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('RSSMRA85M01H501Z', 'svc-1');
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('VRDLGI80A01H501W', 'svc-1');

    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.appIoDone === true);
    expect(doneCall).toBeDefined();
    const [, patch] = doneCall;
    expect(patch.appIoProcessedRows).toBe(2); // solo le righe con CF plausibile, AAAAAA scartata a monte
    expect(patch.appIoPresentCount).toBe(1);
    expect(patch.appIoAbsentCount).toBe(1);
    expect(patch.appIoResults).toEqual({ RSSMRA85M01H501Z: true, VRDLGI80A01H501W: false });
    // Trigger immediato per DomicileVerificationSyncService — senza questo,
    // se INAD/Registro Imprese erano già pronti, il job padre resta
    // PROCESSING fino al prossimo tick cron.
    expect(domicileEventsMock.notifyJobProgress).toHaveBeenCalledWith('job-1');
  });

  it('marca l\'intero DomicileVerificationJob FAILED se il servizio App IO scelto non esiste più o non ha una chiave configurata', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-2',
      sourceCsv: 'cf\nRSSMRA85M01H501Z',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-deleted',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue(null);

    await processor.process({ data: { jobId: 'job-2' } } as any);

    expect(ioServicesMock.verifyProfile).not.toHaveBeenCalled();
    const failedCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toContain('svc-deleted');
    // Nessun trigger su un fallimento hard: il job intero va FAILED, non
    // ha senso far ricontrollare al sync service un job già chiuso.
    expect(domicileEventsMock.notifyJobProgress).not.toHaveBeenCalled();
  });
});
