import { DomicileVerificationService } from './domicile-verification.service.js';
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';

const mockJobRepo = {
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => ({ id: 'job-1', ...v })),
  update: jest.fn(),
  findOneBy: jest.fn(),
  find: jest.fn(),
  delete: jest.fn(),
};
const mockIoServiceRepo = { findOneBy: jest.fn() };
const mockInad = { startBulkExtraction: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };
const mockAppIoQueue = { add: jest.fn() };

const ADMIN = { username: 'admin1', role: 'admin' as const };
const USER = { username: 'operatore1', role: 'user' as const };

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

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

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

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

    expect(result.jobId).toBe('job-1');
    expect(mockAppIoQueue.add).not.toHaveBeenCalled();
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: DomicileVerificationJobStatus.PROCESSING, registroImpreseTotal: 1, residualEnqueued: true });
  });

  it('blocca se il servizio App IO non esiste', async () => {
    mockIoServiceRepo.findOneBy.mockResolvedValue(null);

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-x', createdBy: 'operatore1' });

    expect(result).toEqual({ blocked: true, message: 'Servizio App IO selezionato non trovato' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('blocca se non ci sono né CF fisici né Partite IVA validi', async () => {
    const result = await service.createJob({ csvContent: 'cf\nnonvalido\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('un fallimento parziale (es. App IO non accodato) non blocca il job: errorMessage riporta il problema', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

    expect(result.jobId).toBe('job-1');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.PROCESSING);
    expect(call![1].errorMessage).toContain('App IO non accodato');
  });

  it('FAILED immediato se tutti i tentativi di enqueue falliscono', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockRejectedValue(new Error('INAD giù'));
    mockRegistroImpreseQueue.enqueueVerify.mockRejectedValue(new Error('registro giù'));

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

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

    const csv = await service.getResultCsv('job-1', 'assenti', ADMIN);

    expect(csv).toBe('assenti-content');
  });

  it('lancia se il job non è ancora DONE', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.PROCESSING });

    await expect(service.getResultCsv('job-1', 'assenti', ADMIN)).rejects.toThrow('Il job di verifica non è ancora completato');
  });

  it('lancia 404 se il CSV richiesto è null (nessun risultato per quella categoria)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, resultAppIoCsv: null });

    await expect(service.getResultCsv('job-1', 'app-io', ADMIN)).rejects.toThrow('Risultato non disponibile');
  });
});

describe('DomicileVerificationService — visibilità per operatore', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIoServiceRepo.findOneBy.mockResolvedValue({ id: 'svc-1' });
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('createJob salva lo username di chi carica il tracciato', async () => {
    mockRegistroImpreseQueue.enqueueVerify.mockResolvedValue(undefined);

    await service.createJob({ csvContent: 'cf\n12345678901\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1', createdBy: 'operatore1' });

    expect(mockJobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'operatore1' }));
  });

  it('listJobs: un operatore vede solo i propri job', async () => {
    mockJobRepo.find.mockResolvedValue([]);

    await service.listJobs(USER);

    expect(mockJobRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { createdBy: 'operatore1' } }));
  });

  it('listJobs: un admin vede tutti i job, con il proprietario', async () => {
    mockJobRepo.find.mockResolvedValue([{ id: 'job-1', status: DomicileVerificationJobStatus.DONE, createdBy: 'operatore2' }]);

    const jobs = await service.listJobs(ADMIN);

    expect(mockJobRepo.find.mock.calls[0][0].where).toEqual({});
    expect(jobs[0].createdBy).toBe('operatore2');
  });

  it('getStatus e getResultCsv cercano il job solo tra quelli dell\'operatore (404 sui job altrui)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue(null);

    await expect(service.getStatus('job-1', USER)).rejects.toThrow('non trovato');
    await expect(service.getResultCsv('job-1', 'assenti', USER)).rejects.toThrow('non trovato');
    expect(mockJobRepo.findOneBy).toHaveBeenCalledWith({ id: 'job-1', createdBy: 'operatore1' });
  });

  it('getStatus per un admin cerca il job senza filtro sul proprietario', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, inadBatches: [], inadFoundMap: {} });

    await service.getStatus('job-1', ADMIN);

    expect(mockJobRepo.findOneBy).toHaveBeenCalledWith({ id: 'job-1' });
  });
});

describe('DomicileVerificationService.deleteJob', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('il proprietario elimina un proprio job concluso', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ id: 'job-1', status: DomicileVerificationJobStatus.DONE, createdBy: 'operatore1' });

    await service.deleteJob('job-1', USER);

    expect(mockJobRepo.findOneBy).toHaveBeenCalledWith({ id: 'job-1', createdBy: 'operatore1' });
    expect(mockJobRepo.delete).toHaveBeenCalledWith('job-1');
  });

  it('un operatore non elimina un job altrui (404, nessuna cancellazione)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue(null);

    await expect(service.deleteJob('job-1', USER)).rejects.toThrow('non trovato');
    expect(mockJobRepo.delete).not.toHaveBeenCalled();
  });

  it('un admin elimina anche job altrui o senza proprietario', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ id: 'job-1', status: DomicileVerificationJobStatus.FAILED, createdBy: null });

    await service.deleteJob('job-1', ADMIN);

    expect(mockJobRepo.delete).toHaveBeenCalledWith('job-1');
  });

  it('rifiuta la cancellazione di un job in elaborazione', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdBy: 'operatore1' });

    await expect(service.deleteJob('job-1', USER)).rejects.toThrow('in elaborazione');
    expect(mockJobRepo.delete).not.toHaveBeenCalled();
  });
});
