import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppIoVerifyBulkProcessor, isPresentResult } from './app-io-verify-bulk.processor.js';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { DomicileVerificationEventsService } from '../channels/domicile-verification/domicile-verification-events.service.js';


/** n codici fiscali distinti con carattere di controllo corretto (codice comune variabile). */
function distinctCfs(n: number): string[] {
  const odd = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
  const val = (c: string) => (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 65);
  return Array.from({ length: n }, (_, i) => {
    const body = `RSSMRA85M01H${String(100 + i).padStart(3, '0')}`;
    let sum = 0;
    for (let k = 0; k < 15; k++) sum += k % 2 === 0 ? odd[val(body[k])] : val(body[k]);
    return body + String.fromCharCode(65 + (sum % 26));
  });
}

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
      sourceCsv: 'cf,nome\nRSSMRA85M01H501Q,Mario Rossi\nAAAAAA,CF Corto\nVRDLGI80A01H501E,Luigi Verdi',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1', apiKeyPrimariaEnc: 'enc:v1:xxx' });
    ioServicesMock.verifyProfile.mockImplementation(async (cf: string) => {
      if (cf === 'RSSMRA85M01H501Q') return { success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' };
      return { success: true, active: false, message: 'Cittadino non iscritto ad App IO' };
    });

    await processor.process({ data: { jobId: 'job-1' } } as any);

    expect(ioServicesMock.verifyProfile).toHaveBeenCalledTimes(2); // AAAAAA è CF non plausibile, nessuna chiamata
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('RSSMRA85M01H501Q', 'svc-1');
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('VRDLGI80A01H501E', 'svc-1');

    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.appIoDone === true);
    expect(doneCall).toBeDefined();
    const [, patch] = doneCall;
    expect(patch.appIoProcessedRows).toBe(2); // solo le righe con CF plausibile, AAAAAA scartata a monte
    expect(patch.appIoPresentCount).toBe(1);
    expect(patch.appIoAbsentCount).toBe(1);
    expect(patch.appIoResults).toEqual({ RSSMRA85M01H501Q: true, VRDLGI80A01H501E: false });
    // Trigger immediato per DomicileVerificationSyncService — senza questo,
    // se INAD/Registro Imprese erano già pronti, il job padre resta
    // PROCESSING fino al prossimo tick cron.
    expect(domicileEventsMock.notifyJobProgress).toHaveBeenCalledWith('job-1');
  });

  it('CF ripetuto su più righe: una sola chiamata, progresso = CF distinti (mai 204/202)', async () => {
    jobRepoMock.findOneBy.mockReset();
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-4',
      status: 'processing',
      sourceCsv: 'cf\nRSSMRA85M01H501Q\nrssmra85m01h501q \nVRDLGI80A01H501E',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1', apiKeyPrimariaEnc: 'enc:v1:xxx' });
    ioServicesMock.verifyProfile.mockReset();
    ioServicesMock.verifyProfile.mockResolvedValue({ success: true, active: true, message: 'ok' });

    await processor.process({ data: { jobId: 'job-4' } } as any);

    expect(ioServicesMock.verifyProfile).toHaveBeenCalledTimes(2);
    const [, patch] = jobRepoMock.update.mock.calls.find(([, p]: any) => p.appIoDone === true);
    expect(patch.appIoProcessedRows).toBe(2);
    expect(patch.appIoPresentCount).toBe(2);
  });

  it('si ferma se la verifica viene annullata durante l\'elaborazione (nessun appIoDone)', async () => {
    const record = {
      id: 'job-3',
      status: 'processing',
      sourceCsv: 'cf\n' + distinctCfs(300).join('\n'),
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    };
    jobRepoMock.findOneBy.mockReset();
    jobRepoMock.findOneBy.mockResolvedValueOnce(record).mockResolvedValue({ ...record, status: 'cancelled' });
    ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1', apiKeyPrimariaEnc: 'enc:v1:xxx' });
    ioServicesMock.verifyProfile.mockReset();
    ioServicesMock.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'x' });

    await processor.process({ data: { jobId: 'job-3' } } as any);

    expect(ioServicesMock.verifyProfile.mock.calls.length).toBeLessThan(300);
    expect(jobRepoMock.update.mock.calls.some(([, patch]: any) => patch.appIoDone === true)).toBe(false);
  });

  it('marca l\'intero DomicileVerificationJob FAILED se il servizio App IO scelto non esiste più o non ha una chiave configurata', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-2',
      sourceCsv: 'cf\nRSSMRA85M01H501Q',
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
