import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { DomicileVerificationRetentionService } from './domicile-verification-retention.service.js';

describe('DomicileVerificationRetentionService', () => {
  let repo: any;
  let settings: any;
  let service: DomicileVerificationRetentionService;

  const oldJob = { id: 'old-job', status: DomicileVerificationJobStatus.DONE, createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) };

  beforeEach(() => {
    repo = { find: jest.fn(async () => [oldJob]), delete: jest.fn(async () => undefined) };
    settings = { get: jest.fn(async () => 7) };
    service = new DomicileVerificationRetentionService(repo, settings);
  });

  it('elimina job più vecchi della retention configurata', async () => {
    const removed = await service.runCleanup();

    expect(removed).toBe(1);
    expect(repo.delete).toHaveBeenCalledWith('old-job');
    expect(settings.get).toHaveBeenCalledWith('domicileVerification.retentionDays');
  });

  it('la query filtra su createdAt < cutoff e status terminale (QUEUED/DONE/FAILED, mai PROCESSING)', async () => {
    await service.runCleanup();

    const where = repo.find.mock.calls[0][0].where;
    expect(where.status._value).toEqual(expect.arrayContaining([
      DomicileVerificationJobStatus.QUEUED,
      DomicileVerificationJobStatus.DONE,
      DomicileVerificationJobStatus.FAILED,
    ]));
    expect(where.status._value).not.toContain(DomicileVerificationJobStatus.PROCESSING);
  });

  it('nessun job da eliminare: ritorna 0, nessuna delete chiamata', async () => {
    repo.find.mockResolvedValue([]);

    const removed = await service.runCleanup();

    expect(removed).toBe(0);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
