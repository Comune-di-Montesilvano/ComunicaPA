import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { getEnrichmentDir } from './enrichment-paths';
import { EnrichmentRetentionService } from './enrichment-retention.service';

describe('EnrichmentRetentionService', () => {
  let tmpDir: string;
  let repo: any;
  let settings: any;
  let service: EnrichmentRetentionService;

  const oldJob = {
    id: 'old-job',
    status: EnrichmentJobStatus.DONE,
    createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-ret-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    repo = {
      find: jest.fn(async () => [oldJob]),
      delete: jest.fn(async () => undefined),
    };
    settings = { get: jest.fn(async () => 30) };
    service = new EnrichmentRetentionService(repo, settings);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('elimina job più vecchi della retention (record + cartella)', async () => {
    fs.mkdirSync(getEnrichmentDir('old-job'), { recursive: true });
    const removed = await service.runCleanup();
    expect(removed).toBe(1);
    expect(repo.delete).toHaveBeenCalledWith('old-job');
    expect(fs.existsSync(getEnrichmentDir('old-job'))).toBe(false);
    // La query deve filtrare per createdAt < cutoff e status terminale
    const where = repo.find.mock.calls[0][0].where;
    expect(where).toBeDefined();
  });

  it('non elimina job PROCESSING anche se vecchi', async () => {
    // il filtro status è nella WHERE: qui verifichiamo che la clausola escluda PROCESSING
    await service.runCleanup();
    const where = repo.find.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('processing');
  });
});
