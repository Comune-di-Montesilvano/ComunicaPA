import { DomicileVerificationService } from './domicile-verification.service.js';
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';

const mockJobRepo = {
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => ({ id: 'job-1', ...v })),
  update: jest.fn(),
  findOneBy: jest.fn(),
  find: jest.fn(),
};
const mockIoServiceRepo = { findOneBy: jest.fn() };
const mockInad = { startBulkExtraction: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };
const mockAppIoQueue = { add: jest.fn() };

describe('DomicileVerificationService.createJob', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIoServiceRepo.findOneBy.mockResolvedValue({ id: 'svc-1' });
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('smista CF fisici (16 char) su App IO+INAD+Registro Imprese (in parallelo) e Partite IVA (11 cifre) su Registro Imprese', async () => {
    const csv = 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n';
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    expect(mockAppIoQueue.add).toHaveBeenCalledWith('verify', { jobId: 'job-1' }, { jobId: 'job-1' });
    expect(mockInad.startBulkExtraction).toHaveBeenCalledWith(['RRANGL74M28R701V'], 'comunicapa-domicili-job-1');
    // Registro Imprese: PIVA + il CF fisico, tutti accodati subito (in parallelo a INAD, non un residuo dopo)
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '98765432109');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', 'RRANGL74M28R701V');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(3);
    expect(mockJobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ cfFisicoTotal: 1, pivaTotal: 2, ioServiceId: 'svc-1' }));
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { inadBatches: [{ id: 'batch-1', size: 1, done: false }] });
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: DomicileVerificationJobStatus.PROCESSING, registroImpreseTotal: 3, residualEnqueued: true });
  });

  it('CSV di sole PIVA: nessun job App IO/INAD accodato', async () => {
    const csv = 'cf\n12345678901\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    expect(mockAppIoQueue.add).not.toHaveBeenCalled();
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: DomicileVerificationJobStatus.PROCESSING, registroImpreseTotal: 1, residualEnqueued: true });
  });

  it('blocca se il servizio App IO non esiste', async () => {
    mockIoServiceRepo.findOneBy.mockResolvedValue(null);

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-x' });

    expect(result).toEqual({ blocked: true, message: 'Servizio App IO selezionato non trovato' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('blocca se non ci sono né CF fisici né Partite IVA validi', async () => {
    const result = await service.createJob({ csvContent: 'cf\nnonvalido\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('un fallimento parziale (es. App IO non accodato) non blocca il job: errorMessage riporta il problema', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.PROCESSING);
    expect(call![1].errorMessage).toContain('App IO non accodato');
  });

  it('FAILED immediato se tutti i tentativi di enqueue falliscono', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockRejectedValue(new Error('INAD giù'));
    mockRegistroImpreseQueue.enqueueVerify.mockRejectedValue(new Error('registro giù'));

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
  });
});

describe('DomicileVerificationService.skipInad', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('marca tutti i batch INAD pending come done e inadFetched, senza toccare i risultati già trovati', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({
      id: 'job-1',
      status: DomicileVerificationJobStatus.PROCESSING,
      inadBatches: [{ id: 'b1', size: 2, done: false }, { id: 'b2', size: 1, done: true }],
    });

    await service.skipInad('job-1');

    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', {
      inadBatches: [{ id: 'b1', size: 2, done: true }, { id: 'b2', size: 1, done: true }],
      inadFetched: true,
    });
  });

  it('lancia 404 se il job non esiste', async () => {
    mockJobRepo.findOneBy.mockResolvedValue(null);
    await expect(service.skipInad('job-x')).rejects.toThrow('non trovato');
  });

  it('lancia BadRequest se il job non è PROCESSING (es. già DONE/FAILED)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ id: 'job-1', status: DomicileVerificationJobStatus.DONE, inadBatches: [] });
    await expect(service.skipInad('job-1')).rejects.toThrow('non è in elaborazione');
  });
});

describe('DomicileVerificationService.getResultCsv', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('ritorna il CSV richiesto quando il job è DONE', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, resultAssentiCsv: 'assenti-content' });

    const csv = await service.getResultCsv('job-1', 'assenti');

    expect(csv).toBe('assenti-content');
  });

  it('lancia se il job non è ancora DONE', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.PROCESSING });

    await expect(service.getResultCsv('job-1', 'assenti')).rejects.toThrow('Il job di verifica non è ancora completato');
  });

  it('lancia 404 se il CSV richiesto è null (nessun risultato per quella categoria)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, resultAppIoCsv: null });

    await expect(service.getResultCsv('job-1', 'app-io')).rejects.toThrow('Risultato non disponibile');
  });
});
