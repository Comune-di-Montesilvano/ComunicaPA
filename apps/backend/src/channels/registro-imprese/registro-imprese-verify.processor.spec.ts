import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor.js';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error.js';
import { VERIFY_PIVA_JOB_NAME, VERIFY_PIVA_CAMPAIGN_JOB_NAME } from './registro-imprese-job.types.js';

const mockRegistroImprese = { dettaglioImpresa: jest.fn() };
const mockJobRepo = { query: jest.fn() };
const mockRecipientRepo = { update: jest.fn() };
const mockDomicileEvents = { notifyJobProgress: jest.fn() };

describe('RegistroImpreseVerifyProcessor.process', () => {
  let processor: RegistroImpreseVerifyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any, mockRecipientRepo as any, mockDomicileEvents as any);
  });

  it('scrive found:true e la PEC su esito positivo', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE domicile_verification_jobs'),
      [JSON.stringify({ '12345678901': 'acme@pec.it' }), 1, 'job-1'],
    );
    // Trigger immediato per DomicileVerificationSyncService — senza questo,
    // se INAD/App IO erano già pronti, il job padre resta PROCESSING fino
    // al prossimo tick cron.
    expect(mockDomicileEvents.notifyJobProgress).toHaveBeenCalledWith('job-1');
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
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any, mockRecipientRepo as any, mockDomicileEvents as any);
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

  it('scrive pec:null e incrementa registro_imprese_done quando i tentativi sono esauriti (esito finale)', async () => {
    const job = {
      name: VERIFY_PIVA_JOB_NAME,
      data: { jobId: 'job-1', partitaIva: '12345678901' },
      attemptsMade: 8,
      opts: { attempts: 8 },
    } as any;

    await processor.onFailed(job);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('registro_imprese_done = registro_imprese_done + 1'),
      [JSON.stringify({ '12345678901': null }), 'job-1'],
    );
    // Non deve toccare registro_imprese_found_count: un esaurimento retry non è mai "trovato".
    const [sql] = mockJobRepo.query.mock.calls[0];
    expect(sql).not.toContain('registro_imprese_found_count');
  });

  it('ignora job undefined o di un tipo diverso', async () => {
    await processor.onFailed(undefined);
    await processor.onFailed({ name: 'other-job', attemptsMade: 8, opts: { attempts: 8 } } as any);

    expect(mockJobRepo.query).not.toHaveBeenCalled();
  });
});

describe('RegistroImpreseVerifyProcessor.process — VERIFY_PIVA_CAMPAIGN_JOB_NAME', () => {
  let processor: RegistroImpreseVerifyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any, mockRecipientRepo as any, mockDomicileEvents as any);
  });

  const jobData = { campaignId: 'camp-1', recipientId: 'rec-1', partitaIva: '12345678901', originalChannel: 'EMAIL', originalAddress: 'destinatario@esempio.it', recipientPec: null };

  it('scrive inadCheck.diverted:true e sovrascrive pec quando trova una PEC diversa da quella già su recipient.pec', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'nuova@pec.it' });

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobData } as any);

    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      { id: 'rec-1' },
      expect.objectContaining({
        inadCheck: expect.objectContaining({ found: true, diverted: true, originalChannel: 'EMAIL', originalAddress: 'destinatario@esempio.it' }),
        pec: 'nuova@pec.it',
      }),
    );
    // Branch campagna: mai un DomicileVerificationJob coinvolto, nessun trigger.
    expect(mockDomicileEvents.notifyJobProgress).not.toHaveBeenCalled();
  });

  it('impresa trovata ma SENZA PEC censita → diverted:false, mai forzato a PEC (bug reale: found=true non implica PEC presente)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: undefined });

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobData } as any);

    const [, update] = mockRecipientRepo.update.mock.calls[0];
    expect(update.inadCheck).toEqual(expect.objectContaining({ found: true, diverted: false }));
    expect(update).not.toHaveProperty('pec');
  });

  it('campagna PEC (originalChannel="PEC") con PEC diversa: PENDING_REVIEW, mai sovrascrive recipient.pec', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'tributi@bancaesempio.it' });
    const jobDataPec = { ...jobData, originalChannel: 'PEC', recipientPec: 'originale@pec.it' };

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobDataPec } as any);

    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      { id: 'rec-1' },
      expect.objectContaining({
        status: 'pending_review',
        inadCheck: expect.objectContaining({ found: true, diverted: true, foundAddress: 'tributi@bancaesempio.it' }),
      }),
    );
    const [, patch] = mockRecipientRepo.update.mock.calls[0];
    expect(patch.pec).toBeUndefined();
  });

  it('non scrive pec (diverted:false) se la PEC trovata coincide con recipient.pec (confronto SEMPRE su recipient.pec, mai su originalAddress)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'vecchia@pec.it' });
    const jobDataWithPec = { ...jobData, recipientPec: 'vecchia@pec.it' };

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobDataWithPec } as any);

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobData } as any);

    const [, patch] = mockRecipientRepo.update.mock.calls[0];
    expect(patch.pec).toBeUndefined();
    expect(patch.inadCheck.diverted).toBe(false);
  });

  it('non scrive nulla (nessun override) su un errore generico — il job resta comunque completato', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new Error('boom'));

    await processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobData } as any);

    expect(mockRecipientRepo.update).not.toHaveBeenCalled();
  });

  it('rilancia RegistroImpreseRateLimitError (BullMQ deve ritentare)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new RegistroImpreseRateLimitError(30));

    await expect(processor.process({ name: VERIFY_PIVA_CAMPAIGN_JOB_NAME, data: jobData } as any)).rejects.toThrow(RegistroImpreseRateLimitError);
    expect(mockRecipientRepo.update).not.toHaveBeenCalled();
  });
});
