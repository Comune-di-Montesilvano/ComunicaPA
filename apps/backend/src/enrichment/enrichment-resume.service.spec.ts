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
    queue = { add: jest.fn(async () => undefined) };
    service = new EnrichmentResumeService(jobRepo, queue);
    (readCheckpointSync as jest.Mock).mockReset();
  });

  it('nessun job PROCESSING → nessuna azione', async () => {
    await service.resumeStuckJobs();
    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING con checkpoint leggibile → re-enqueue in BullMQ', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j1', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue({ lastRow: 100, rows: [], warnings: [], maxRate: 0 });

    await service.resumeStuckJobs();

    expect(jobRepo.find).toHaveBeenCalledWith({ where: { status: EnrichmentJobStatus.PROCESSING } });
    // Nessun opts.jobId = job.id: BullMQ dedupe-a su jobId esistente, un job
    // arrivato qui in PROCESSING ha già un job BullMQ con quell'id (terminale
    // o attivo) — riusarlo come opts.jobId renderebbe la add() un no-op
    // silenzioso (bug reale trovato in verifica end-to-end live, mai
    // rieseguito nonostante il log "riprendo da riga N").
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' });
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

    await service.resumeStuckJobs();

    expect(queue.add).toHaveBeenCalledTimes(1);
    // Nessun opts.jobId = job.id: BullMQ dedupe-a su jobId esistente, un job
    // arrivato qui in PROCESSING ha già un job BullMQ con quell'id (terminale
    // o attivo) — riusarlo come opts.jobId renderebbe la add() un no-op
    // silenzioso (bug reale trovato in verifica end-to-end live, mai
    // rieseguito nonostante il log "riprendo da riga N").
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' });
    expect(jobRepo.update).toHaveBeenCalledTimes(1);
    expect(jobRepo.update).toHaveBeenCalledWith('j2', expect.objectContaining({ status: EnrichmentJobStatus.FAILED }));
  });
});
