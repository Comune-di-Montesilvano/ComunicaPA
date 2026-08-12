import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';
import { VERIFY_PIVA_JOB_NAME } from './registro-imprese-job.types';

const mockRegistroImprese = { dettaglioImpresa: jest.fn() };
const mockJobRepo = { query: jest.fn() };

describe('RegistroImpreseVerifyProcessor.process', () => {
  let processor: RegistroImpreseVerifyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any);
  });

  it('scrive found:true e la PEC su esito positivo', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE inad_verification_jobs'),
      [JSON.stringify({ '12345678901': 'acme@pec.it' }), 1, 'job-1'],
    );
  });

  it('scrive found:false (pec null) quando l\'impresa non è trovata', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: false, raw: '' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.any(String),
      [JSON.stringify({ '12345678901': null }), 0, 'job-1'],
    );
  });

  it('marca not-found (non blocca il job) su un errore generico', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new Error('boom'));

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.any(String),
      [JSON.stringify({ '12345678901': null }), 0, 'job-1'],
    );
  });

  it('rilancia RegistroImpreseRateLimitError (BullMQ deve ritentare con backoff)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new RegistroImpreseRateLimitError(30));

    await expect(
      processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any),
    ).rejects.toThrow(RegistroImpreseRateLimitError);
    expect(mockJobRepo.query).not.toHaveBeenCalled();
  });
});

describe('RegistroImpreseVerifyProcessor.onFailed', () => {
  let processor: RegistroImpreseVerifyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any);
  });

  it('non scrive nulla se il job ritenterà ancora (attemptsMade < attempts)', async () => {
    const job = {
      name: VERIFY_PIVA_JOB_NAME,
      data: { jobId: 'job-1', partitaIva: '12345678901' },
      attemptsMade: 3,
      opts: { attempts: 8 },
    } as any;

    await processor.onFailed(job);

    expect(mockJobRepo.query).not.toHaveBeenCalled();
  });

  it('scrive pec:null e incrementa piva_done quando i tentativi sono esauriti (esito finale)', async () => {
    const job = {
      name: VERIFY_PIVA_JOB_NAME,
      data: { jobId: 'job-1', partitaIva: '12345678901' },
      attemptsMade: 8,
      opts: { attempts: 8 },
    } as any;

    await processor.onFailed(job);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('piva_done = piva_done + 1'),
      [JSON.stringify({ '12345678901': null }), 'job-1'],
    );
    // Non deve toccare piva_found_count: un esaurimento retry non è mai "trovato".
    const [sql] = mockJobRepo.query.mock.calls[0];
    expect(sql).not.toContain('piva_found_count');
  });

  it('ignora job undefined o di un tipo diverso', async () => {
    await processor.onFailed(undefined);
    await processor.onFailed({ name: 'other-job', attemptsMade: 8, opts: { attempts: 8 } } as any);

    expect(mockJobRepo.query).not.toHaveBeenCalled();
  });
});
