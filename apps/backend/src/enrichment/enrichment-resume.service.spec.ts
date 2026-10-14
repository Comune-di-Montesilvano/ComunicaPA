import { vi } from 'vitest';
import { EnrichmentJobStatus } from '../entities/enrichment-job.entity.js';
import { EnrichmentResumeService } from './enrichment-resume.service.js';

vi.mock('./enrichment-checkpoint.util', () => ({
  readCheckpointSync: jest.fn(),
}));
import { readCheckpointSync } from './enrichment-checkpoint.util.js';
vi.mock('./enrichment-sources.util', () => ({
  listEnrichmentSources: jest.fn(() => []),
}));
import { listEnrichmentSources } from './enrichment-sources.util.js';

describe('EnrichmentResumeService', () => {
  let jobRepo: any;
  let queue: any;
  let service: EnrichmentResumeService;

  beforeEach(() => {
    jobRepo = {
      find: jest.fn(async () => []),
      update: jest.fn(async () => undefined),
    };
    queue = { add: jest.fn(async () => undefined), getJob: jest.fn(async () => null) };
    service = new EnrichmentResumeService(jobRepo, queue);
    (readCheckpointSync as jest.Mock).mockReset();
    (listEnrichmentSources as jest.Mock).mockReset().mockReturnValue([]);
  });

  it('nessun job PROCESSING → nessuna azione', async () => {
    await service.resumeStuckJobs();
    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING con checkpoint leggibile, nessun job BullMQ residuo → re-enqueue diretto', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j1', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue({ lastRow: 100, rows: [], warnings: [], maxRate: 0 });
    queue.getJob.mockResolvedValue(null);

    await service.resumeStuckJobs();

    expect(jobRepo.find).toHaveBeenCalledWith({ where: { status: EnrichmentJobStatus.PROCESSING } });
    expect(queue.getJob).toHaveBeenCalledWith('j1');
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING con vecchio job BullMQ terminale (completed) → lo rimuove e riaggiunge con lo stesso jobId', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j1', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue({ lastRow: 75, rows: [], warnings: [], maxRate: 0 });
    const remove = jest.fn(async () => undefined);
    queue.getJob.mockResolvedValue({ getState: jest.fn(async () => 'completed'), remove });

    await service.resumeStuckJobs();

    // Un job BullMQ già in stato terminale (completato/fallito) va rimosso
    // esplicitamente prima del re-add — riaggiungerlo con lo stesso jobId
    // senza prima rimuoverlo sarebbe un no-op silenzioso di BullMQ (dedup su
    // jobId esistente, qualunque sia lo stato — bug reale, verificato dal
    // vivo: log "riprendo da riga N" scritto, job mai davvero rieseguito).
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
  });

  it('job PROCESSING con vecchio job BullMQ ancora active → nessun re-enqueue, lo riprende BullMQ stesso', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j1', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue({ lastRow: 75, rows: [], warnings: [], maxRate: 0 });
    const remove = jest.fn(async () => undefined);
    queue.getJob.mockResolvedValue({ getState: jest.fn(async () => 'active'), remove });

    await service.resumeStuckJobs();

    // Un job BullMQ ancora active (crash vero, lock del worker morto non
    // rilasciato) NON va toccato: aggiungerne un secondo qui produrrebbe due
    // EnrichmentProcessor.process() concorrenti sullo stesso jobId (stesso
    // checkpoint letto/scritto due volte, stessa result.csv sovrascritta due
    // volte non atomicamente) — il meccanismo di stalled-job recovery di
    // BullMQ (opzioni default) lo riprende da solo, nessun intervento nostro.
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING senza checkpoint (o corrotto) → marcato FAILED, nessun re-enqueue', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j2', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue(null);

    await service.resumeStuckJobs();

    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).toHaveBeenCalledWith('j2', expect.objectContaining({
      status: EnrichmentJobStatus.FAILED,
      errorMessage: expect.stringContaining('riavvio'),
    }));
  });

  // Il primo checkpoint si scrive solo a riga CHECKPOINT_EVERY (100): il cron
  // ogni 5 minuti trovava il job ancora nelle prime righe, senza checkpoint,
  // e lo marcava FAILED mentre il worker lo stava elaborando (bug reale).
  it.each(['active', 'waiting', 'delayed'])(
    'senza checkpoint ma job "enrich" BullMQ %s → nessuna azione (non è bloccato)',
    async (state) => {
      jobRepo.find.mockResolvedValue([{ id: 'j3', status: EnrichmentJobStatus.PROCESSING, totalRecords: 832 }]);
      (readCheckpointSync as jest.Mock).mockReturnValue(null);
      queue.getJob.mockImplementation(async (id: string) => (id === 'j3' ? { getState: jest.fn(async () => state), remove: jest.fn() } : null));

      await service.resumeStuckJobs();

      expect(queue.add).not.toHaveBeenCalled();
      expect(jobRepo.update).not.toHaveBeenCalled();
    },
  );

  it('senza checkpoint ma merge-batch BullMQ ancora active → nessuna azione', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j4', status: EnrichmentJobStatus.PROCESSING, totalRecords: 0 }]);
    (readCheckpointSync as jest.Mock).mockReturnValue(null);
    queue.getJob.mockImplementation(async (id: string) => (id === 'merge-j4' ? { getState: jest.fn(async () => 'active') } : null));

    await service.resumeStuckJobs();

    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('senza checkpoint, merge già completato (totalRecords>0, sorgenti su disco), job BullMQ terminale → riparte da zero', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j5', status: EnrichmentJobStatus.PROCESSING, totalRecords: 832 }]);
    (readCheckpointSync as jest.Mock).mockReturnValue(null);
    (listEnrichmentSources as jest.Mock).mockReturnValue([{ path: '/x/1_a.zip', filename: 'a.zip' }]);
    const remove = jest.fn(async () => undefined);
    queue.getJob.mockImplementation(async (id: string) => (id === 'j5' ? { getState: jest.fn(async () => 'failed'), remove } : null));

    await service.resumeStuckJobs();

    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j5' }, { jobId: 'j5' });
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('senza checkpoint e merge mai completato (totalRecords=0) → FAILED anche con sorgenti su disco', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j6', status: EnrichmentJobStatus.PROCESSING, totalRecords: 0 }]);
    (readCheckpointSync as jest.Mock).mockReturnValue(null);
    (listEnrichmentSources as jest.Mock).mockReturnValue([{ path: '/x/1_a.zip', filename: 'a.zip' }]);

    await service.resumeStuckJobs();

    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).toHaveBeenCalledWith('j6', expect.objectContaining({ status: EnrichmentJobStatus.FAILED }));
  });

  it('più job bloccati: ciascuno gestito indipendentemente', async () => {
    jobRepo.find.mockResolvedValue([
      { id: 'j1', status: EnrichmentJobStatus.PROCESSING },
      { id: 'j2', status: EnrichmentJobStatus.PROCESSING },
    ]);
    (readCheckpointSync as jest.Mock)
      .mockReturnValueOnce({ lastRow: 50, rows: [], warnings: [], maxRate: 0 })
      .mockReturnValueOnce(null);
    queue.getJob.mockResolvedValue(null);

    await service.resumeStuckJobs();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
    expect(jobRepo.update).toHaveBeenCalledTimes(1);
    expect(jobRepo.update).toHaveBeenCalledWith('j2', expect.objectContaining({ status: EnrichmentJobStatus.FAILED }));
  });
});
