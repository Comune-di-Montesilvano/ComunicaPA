import { InadVerifyBulkSyncService } from './inad-verify-bulk-sync.service';
import { InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';

const mockJobRepo = { find: jest.fn(), update: jest.fn() };
const mockInad = { getBulkState: jest.fn(), getBulkResult: jest.fn() };

describe('InadVerifyBulkSyncService.handleCron', () => {
  let service: InadVerifyBulkSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InadVerifyBulkSyncService(mockJobRepo as any, mockInad as any);
  });

  it('non finalizza se i batch INAD sono pronti ma la quota PIVA non è completa', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-1', size: 1, done: false }],
      pivaTotal: 3, pivaDone: 1, pivaResults: {},
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('DISPONIBILE');

    await service.handleCron();

    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { batches: [{ id: 'batch-1', size: 1, done: true }] });
    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: InadVerificationJobStatus.DONE }));
  });

  it('finalizza e fonde i risultati PIVA nel CSV quando entrambe le fonti sono complete', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-1', size: 1, done: true }],
      pivaTotal: 2, pivaDone: 2, pivaResults: { '12345678901': 'acme@pec.it', '98765432109': null },
      sourceCsv: 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkResult.mockResolvedValue([{ codiceFiscale: 'RRANGL74M28R701V', since: '2020', digitalAddress: [{ digitalAddress: 'persona@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01' } }] }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === InadVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    const patch = call![1];
    expect(patch.foundCount).toBe(2); // CF persona + PIVA con PEC trovata
    expect(patch.notFoundCount).toBe(1); // PIVA senza PEC
    expect(patch.resultFoundCsv).toContain('persona@pec.it');
    expect(patch.resultFoundCsv).toContain('acme@pec.it');
    expect(patch.resultNotFoundCsv).toContain('98765432109');
  });

  it('finalizza un job con sole Partite IVA (nessun batch INAD)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [],
      pivaTotal: 1, pivaDone: 1, pivaResults: { '12345678901': 'acme@pec.it' },
      sourceCsv: 'cf\n12345678901\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === InadVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    expect(call![1].foundCount).toBe(1);
  });
});
