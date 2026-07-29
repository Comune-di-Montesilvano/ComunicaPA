import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';
import { getEnrichmentAttachmentsDir, getEnrichmentDir, getEnrichmentResultCsv } from './enrichment-paths';
import { buildEnrichedCsv, buildEnrichedCsvHeaders } from './enriched-csv.util';

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
  let overrideService: any;
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
      update: jest.fn(async () => undefined),
    };
    queue = { add: jest.fn(async () => undefined) };
    overrideService = {
      findByJob: jest.fn(async () => []),
      applyOverrides: jest.fn((rows: any) => rows),
      upsert: jest.fn(async () => ({ id: 'o1' })),
    };
    service = new EnrichmentService(repo, queue, overrideService);
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

  it('deleteJob: PROCESSING → eliminazione forzata comunque permessa (endpoint admin-only, unica via d\'uscita per un job bloccato)', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.PROCESSING });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    const result = await service.deleteJob('job-uuid-1');
    expect(result.blocked).toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith('job-uuid-1');
    expect(fs.existsSync(dir)).toBe(false);
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

  it('buildResultZip: contiene result.csv e i PDF già scompattati su disco da processEnrich', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(getEnrichmentAttachmentsDir('job-uuid-1'), { recursive: true });
    fs.writeFileSync(join(getEnrichmentAttachmentsDir('job-uuid-1'), 'PROVV_1.pdf'), '%PDF-fake');
    fs.writeFileSync(join(dir, 'result.csv'), '"a"');

    const buf = await service.buildResultZip('job-uuid-1');
    expect(buf).not.toBeNull();
    const out = new AdmZip(buf as Buffer);
    expect(out.getEntry('arricchito.csv')).toBeTruthy();
    expect(out.getEntry('PROVV_1.pdf')).toBeTruthy();
  });

  it('buildResultZip: job non DONE → null (mai eccezione, il chiamante HTTP deve rispondere 200+blocked)', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.PROCESSING });
    const buf = await service.buildResultZip('job-uuid-1');
    expect(buf).toBeNull();
  });

  it('buildResultZip: result.csv assente nonostante status DONE (race con retention) → null', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const buf = await service.buildResultZip('job-uuid-1');
    expect(buf).toBeNull();
  });

  it('buildResultZip: job DONE ma senza cartella allegati (job pre-refactor o senza PDF) → solo il CSV', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'result.csv'), '"a"');

    const buf = await service.buildResultZip('job-uuid-1');
    const out = new AdmZip(buf as Buffer);
    expect(out.getEntry('arricchito.csv')).toBeTruthy();
    expect(out.getEntries()).toHaveLength(1);
  });

  describe('requestCampaignConversion', () => {
    // Il lavoro pesante (unzip + scrittura PDF) è stato spostato su
    // ENRICHMENT_QUEUE/EnrichmentProcessor (vedi enrichment.processor.spec.ts)
    // per non bloccare l'event loop Node dentro la richiesta HTTP — qui si
    // testano solo i guard rapidi e l'accodamento.
    function setupDoneJob(): void {
      repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE, campaignId: null, campaignConversionStatus: null });
      const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'result.csv'), '"codice_fiscale"\n"RSSMRA80A01H501U"');
    }

    it('job pronto: marca campaignConversionStatus=pending e accoda il job convert-campaign', async () => {
      setupDoneJob();
      const result = await service.requestCampaignConversion('job-uuid-1', { name: 'Campagna X', channelType: 'PEC' }, 'op');

      expect(result.accepted).toBe(true);
      expect(repo.update).toHaveBeenCalledWith('job-uuid-1', {
        campaignConversionStatus: 'pending',
        campaignConversionError: null,
      });
      expect(queue.add).toHaveBeenCalledWith(
        'convert-campaign',
        { jobId: 'job-uuid-1', name: 'Campagna X', channelType: 'PEC', createdBy: 'op' },
        { jobId: 'convert-campaign-job-uuid-1' },
      );
    });

    it('job non DONE → blocked, nessun accodamento', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING, campaignId: null, campaignConversionStatus: null });
      const result = await service.requestCampaignConversion('j1', { name: 'X', channelType: 'PEC' }, 'op');
      expect(result.blocked).toBe(true);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('job già convertito → blocked', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE, campaignId: 'camp-old', campaignConversionStatus: 'done' });
      const result = await service.requestCampaignConversion('j1', { name: 'X', channelType: 'PEC' }, 'op');
      expect(result.blocked).toBe(true);
    });

    it('conversione già in corso (pending/processing) → blocked, nessun secondo job in coda', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE, campaignId: null, campaignConversionStatus: 'processing' });
      const result = await service.requestCampaignConversion('j1', { name: 'X', channelType: 'PEC' }, 'op');
      expect(result.blocked).toBe(true);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('getRow', () => {
    it('job DONE: legge dal CSV risultato, override presente incluso', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
      fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
      fs.writeFileSync(
        getEnrichmentResultCsv('j1'),
        buildEnrichedCsv(buildEnrichedCsvHeaders(0), [
          { codice_fiscale: 'RSSMRA80A01H501U', allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA', cap: '00000', comune: 'X', provincia: 'XX', stato_estero: '' },
        ]),
      );
      overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA' }]);

      const row = await service.getRow('j1', 'PROVV_1.pdf');

      expect(row.codiceFiscale).toBe('RSSMRA80A01H501U');
      expect(row.row.indirizzo).toBe('VIA VECCHIA'); // dato corrente non patchato di default
      expect(row.headers).toEqual(buildEnrichedCsvHeaders(0));
      expect(row.override).toEqual(expect.objectContaining({ indirizzo: 'VIA NUOVA' }));
    });

    it('pdfFilename inesistente nel job → BadRequestException', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
      fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
      fs.writeFileSync(getEnrichmentResultCsv('j1'), buildEnrichedCsv(buildEnrichedCsvHeaders(0), []));
      await expect(service.getRow('j1', 'INESISTENTE.pdf')).rejects.toThrow(BadRequestException);
    });
  });

  describe('saveRowOverride', () => {
    it('pdfFilename valido → upsert, indirizzo tipizzato ed extraFields separati', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
      fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
      fs.writeFileSync(
        getEnrichmentResultCsv('j1'),
        buildEnrichedCsv(buildEnrichedCsvHeaders(0), [{ allegato: 'PROVV_1.pdf' }]),
      );
      const result = await service.saveRowOverride('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA', importo: '100,00' }, 'op');
      expect(result.blocked).toBeUndefined();
      expect(overrideService.upsert).toHaveBeenCalledWith(
        'j1',
        'PROVV_1.pdf',
        { indirizzo: 'VIA NUOVA', cap: undefined, comune: undefined, provincia: undefined, statoEstero: undefined },
        { importo: '100,00' },
        'op',
      );
    });

    it('pdfFilename inesistente → blocked', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
      fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
      fs.writeFileSync(getEnrichmentResultCsv('j1'), buildEnrichedCsv(buildEnrichedCsvHeaders(0), []));
      const result = await service.saveRowOverride('j1', 'INESISTENTE.pdf', { indirizzo: 'X' }, 'op');
      expect(result.blocked).toBe(true);
      expect(overrideService.upsert).not.toHaveBeenCalled();
    });
  });

  describe('regenerateCsv', () => {
    it('job non DONE → blocked', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING });
      const result = await service.regenerateCsv('j1');
      expect(result.blocked).toBe(true);
    });

    it('job DONE: rilegge il CSV, applica override, riscrive il file', async () => {
      repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
      fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
      fs.writeFileSync(
        getEnrichmentResultCsv('j1'),
        buildEnrichedCsv(buildEnrichedCsvHeaders(0), [{ allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA' }]),
      );
      overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA CORRETTA' }]);
      overrideService.applyOverrides.mockImplementation((rows: any[]) =>
        rows.map((r) => (r.allegato === 'PROVV_1.pdf' ? { ...r, indirizzo: 'VIA CORRETTA' } : r)),
      );

      const result = await service.regenerateCsv('j1');

      expect(result.blocked).toBeUndefined();
      const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
      expect(csv).toContain('VIA CORRETTA');
      expect(csv).not.toContain('VIA VECCHIA');
    });
  });
});
