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
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [{ id: 'batch-1', size: 1, done: false }] });
  });

  it('accetta un CSV con sole Partite IVA (nessun CF a 16 char)', async () => {
    const csv = 'cf\n12345678901\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [] });
  });

  it('blocca se non ci sono né CF validi né Partite IVA valide', async () => {
    const csv = 'cf\nnonvalido\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });
});
