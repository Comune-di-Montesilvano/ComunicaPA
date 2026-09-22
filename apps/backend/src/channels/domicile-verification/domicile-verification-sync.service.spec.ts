import { DomicileVerificationSyncService } from './domicile-verification-sync.service.js';
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';

const mockJobRepo = { find: jest.fn(), update: jest.fn() };
const mockInad = { getBulkState: jest.fn(), getBulkResult: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };

describe('DomicileVerificationSyncService.handleCron', () => {
  let service: DomicileVerificationSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationSyncService(mockJobRepo as any, mockInad as any, mockRegistroImpreseQueue as any);
  });

  it('non finalizza se i batch INAD non sono ancora tutti pronti', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({
      inadBatches: [{ id: 'batch-1', size: 1, done: false }],
    }));
    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: DomicileVerificationJobStatus.DONE }));
  });

  it('quando INAD è pronto: fetch una volta, accoda il residuo Registro Imprese sui CF fisici non trovati', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 2, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 2, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\nVRDLGI80A01H501W\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('DISPONIBILE');
    mockInad.getBulkResult.mockResolvedValue([
      { codiceFiscale: 'RRANGL74M28R701V', since: '2020', digitalAddress: [{ digitalAddress: 'trovato@pec.it', usageInfo: { motivation: 'x', dateEndValidity: '' } }] },
    ]);

    await service.handleCron();

    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', 'VRDLGI80A01H501W'); // solo il non-trovato
    expect(mockRegistroImpreseQueue.enqueueVerify).not.toHaveBeenCalledWith('job-1', 'RRANGL74M28R701V');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.residualEnqueued === true);
    expect(call).toBeDefined();
    expect(call![1].inadFetched).toBe(true);
    expect(call![1].inadFoundMap).toEqual({ RRANGL74M28R701V: 'trovato@pec.it' });
    expect(call![1].registroImpreseTotal).toBe(1);
  });

  it('non ri-fetcha INAD né riaccoda il residuo se già fatto (inadFetched/residualEnqueued già true)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: true }], inadFetched: true, inadFoundMap: { RRANGL74M28R701V: 'x@pec.it' },
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: true,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      appIoResults: {}, registroImpreseResults: {},
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    expect(mockInad.getBulkResult).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).not.toHaveBeenCalled();
    // tutte le fonti già pronte (residualEnqueued+contatori a target): il job
    // completa comunque in questo stesso tick, solo senza rifare fetch/enqueue
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.DONE);
    expect(call).toBeDefined();
  });

  it('non finalizza se App IO non ha ancora finito (cfFisicoTotal > 0, appIoDone false)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [], inadFetched: true, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: false, residualEnqueued: true,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: DomicileVerificationJobStatus.DONE }));
    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: DomicileVerificationJobStatus.FAILED }));
  });

  it('finalizza (DONE) quando INAD+App IO+Registro Imprese sono tutti completi, costruendo i 5 CSV', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [], inadFetched: true, inadFoundMap: { RRANGL74M28R701V: 'inad@pec.it' },
      cfFisicoTotal: 1, pivaTotal: 1, appIoDone: true, residualEnqueued: true,
      registroImpreseTotal: 1, registroImpreseDone: 1,
      registroImpreseResults: { '12345678901': 'registro@pec.it' },
      appIoResults: {},
      sourceCsv: 'cf\nRRANGL74M28R701V\n12345678901\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    const patch = call![1];
    expect(patch.resultAggregatoCsv).toContain('inad@pec.it');
    expect(patch.resultAggregatoCsv).toContain('registro@pec.it');
    expect(patch.resultInadCsv).toContain('inad@pec.it');
    expect(patch.resultRegistroImpreseCsv).toContain('registro@pec.it');
    expect(patch.completedAt).toBeInstanceOf(Date);
  });

  it('marca FAILED un job bloccato in PROCESSING da più di 24h', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: false, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
    expect(call![1].errorMessage).toContain('24');
  });

  it('un errore imprevisto durante il sync marca il job FAILED (mai un job bloccato senza spiegazione)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockRejectedValue(new Error('INAD giù'));

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
    expect(call![1].errorMessage).toContain('INAD giù');
  });
});
