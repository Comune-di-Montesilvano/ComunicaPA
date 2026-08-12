import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';

const mockJobRepo = {
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => ({ id: 'job-1', ...v })),
  update: jest.fn(),
  findOneBy: jest.fn(),
};
const mockInad = { startBulkExtraction: jest.fn(), getBulkState: jest.fn(), getBulkResult: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };

describe('InadVerifyBulkService.createJob', () => {
  let service: InadVerifyBulkService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InadVerifyBulkService(mockJobRepo as any, mockInad as any, mockRegistroImpreseQueue as any);
  });

  it('smista CF (16 char) su INAD e Partite IVA (11 cifre) su Registro Imprese', async () => {
    const csv = 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n';
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).toHaveBeenCalledWith(['RRANGL74M28R701V'], 'comunicapa-verifica-job-1');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '98765432109');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(2);
    expect(mockJobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ pivaTotal: 2 }));
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [{ id: 'batch-1', size: 1, done: false }], pivaTotal: 2 });
  });

  it('accetta un CSV con sole Partite IVA (nessun CF a 16 char)', async () => {
    const csv = 'cf\n12345678901\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [], pivaTotal: 1 });
  });

  it('un enqueueVerify fallito su una PIVA non blocca il job: le altre PIVA restano accodate, pivaTotal riconciliato ed errorMessage impostato', async () => {
    const csv = 'cf\n12345678901\n98765432109\n11111111111\n';
    mockRegistroImpreseQueue.enqueueVerify.mockImplementation(async (_jobId: string, piva: string) => {
      if (piva === '98765432109') throw new Error('coda temporaneamente giù');
    });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(3);
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '11111111111');
    // pivaTotal riconciliato: 2 accodate con successo su 3, mai il pivaValues.length ottimistico (3) —
    // altrimenti pivaDone (che si ferma a 2) non raggiungerebbe mai pivaTotal.
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', {
      status: InadVerificationJobStatus.PROCESSING,
      batches: [],
      pivaTotal: 2,
      errorMessage: expect.stringContaining('1 Partite IVA non accodate'),
    });
  });

  it('un chunk startBulkExtraction fallito non blocca il job: gli altri chunk restano avviati, errorMessage riporta il fallimento parziale', async () => {
    const cfs = Array.from({ length: 1500 }, (_, i) => `V${String(i).padStart(15, '0')}`);
    const csv = 'cf\n' + cfs.join('\n') + '\n';
    let call = 0;
    mockInad.startBulkExtraction.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('INAD non disponibile');
      return { id: 'batch-2' };
    });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).toHaveBeenCalledTimes(2);
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', {
      status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-2', size: 500, done: false }],
      pivaTotal: 0,
      errorMessage: expect.stringContaining('Batch INAD 1 fallito'),
    });
  });

  it('nessun fallimento parziale: pivaTotal riconciliato coincide col totale pianificato, nessun errorMessage', async () => {
    const csv = 'cf\nRRANGL74M28R701V\n12345678901\n';
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === InadVerificationJobStatus.PROCESSING);
    expect(call![1]).toEqual({
      status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-1', size: 1, done: false }],
      pivaTotal: 1,
    });
    expect(call![1].errorMessage).toBeUndefined();
  });

  it('blocca se non ci sono né CF validi né Partite IVA valide', async () => {
    const csv = 'cf\nnonvalido\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });
});
