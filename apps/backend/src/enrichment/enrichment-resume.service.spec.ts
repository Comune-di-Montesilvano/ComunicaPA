import { EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { EnrichmentResumeService } from './enrichment-resume.service';

jest.mock('./enrichment-checkpoint.util', () => ({
  readCheckpointSync: jest.fn(),
}));
import { readCheckpointSync } from './enrichment-checkpoint.util';

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
