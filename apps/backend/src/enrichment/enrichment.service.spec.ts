import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';

const RUBRICA_ROW =
  'id;pec@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto;;;PROVV_1.pdf';

function makeZipFile(dir: string, withRubrica = true): string {
  const zip = new AdmZip();
  if (withRubrica) zip.addFile('rubrica.csv', Buffer.from(RUBRICA_ROW, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-fake'));
  const p = join(dir, 'input.zip');
  zip.writeZip(p);
  return p;
}

describe('EnrichmentService', () => {
  let tmpDir: string;
  let repo: any;
  let queue: any;
  let service: EnrichmentService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-test-'));
    process.env['ATTACHMENTS_PATH'] = join(tmpDir, 'attachments');
    repo = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ ...v, id: 'job-uuid-1' })),
      find: jest.fn(async () => []),
      findOneBy: jest.fn(async () => null),
      delete: jest.fn(async () => undefined),
    };
    queue = { add: jest.fn(async () => undefined) };
    service = new EnrichmentService(repo, queue);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('createJob: salva record, copia source.zip, accoda con jobId = id record', async () => {
    const zipPath = makeZipFile(tmpDir);
    const result = await service.createJob({
      zipPath,
      sourceFilename: 'Postalizzazione_114012.zip',
      traceFormat: TraceFormat.MAGGIOLI,
      createdBy: 'debug',
    });

    expect(result.jobId).toBe('job-uuid-1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ totalRecords: 1, status: EnrichmentJobStatus.QUEUED }),
    );
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'job-uuid-1' }, { jobId: 'job-uuid-1' });
    const sourceZip = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1', 'source.zip');
    expect(fs.existsSync(sourceZip)).toBe(true);
  });

  it('createJob: ZIP senza rubrica → blocked, nessun record', async () => {
    const zipPath = makeZipFile(tmpDir, false);
    const result = await service.createJob({
      zipPath, sourceFilename: 'x.zip', traceFormat: TraceFormat.MAGGIOLI, createdBy: 'debug',
    });
    expect(result.blocked).toBe(true);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('createJob: ZIP con zero record → blocked', async () => {
    const zip = new AdmZip();
    zip.addFile('rubrica.csv', Buffer.from('', 'utf-8'));
    const p = join(tmpDir, 'empty.zip');
    zip.writeZip(p);
    const result = await service.createJob({
      zipPath: p, sourceFilename: 'x.zip', traceFormat: TraceFormat.MAGGIOLI, createdBy: 'debug',
    });
    expect(result.blocked).toBe(true);
  });

  it('deleteJob: PROCESSING → blocked', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING });
    const result = await service.deleteJob('j1');
    expect(result.blocked).toBe(true);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deleteJob: DONE → elimina record e cartella', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    const result = await service.deleteJob('job-uuid-1');
    expect(result.blocked).toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith('job-uuid-1');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('buildResultZip: contiene result.csv e i PDF del source.zip', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(makeZipFile(tmpDir), join(dir, 'source.zip'));
    fs.writeFileSync(join(dir, 'result.csv'), '"a"');

    const buf = await service.buildResultZip('job-uuid-1');
    const out = new AdmZip(buf);
    expect(out.getEntry('arricchito.csv')).toBeTruthy();
    expect(out.getEntry('PROVV_1.pdf')).toBeTruthy();
  });
});
