import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import type { Job } from 'bullmq';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity';
import { getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { EnrichmentProcessor } from './enrichment.processor';

const RUBRICA = [
  'id;pec1@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;PROVV_1.pdf',
  'id;pec2@pec.it;;LUIGI;VERDI;VRDLGU70A01H501X;;VERDI LUIGI;2;13/03/2026;Oggetto 2;;;PROVV_MANCANTE.pdf',
].join('\n');

function setupJobDir(jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('rubrica.csv', Buffer.from(RUBRICA, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  fs.mkdirSync(getEnrichmentDir(jobId), { recursive: true });
  zip.writeZip(getEnrichmentSourceZip(jobId));
}

describe('EnrichmentProcessor', () => {
  let tmpDir: string;
  let repo: any;
  let client: any;
  let processor: EnrichmentProcessor;
  const record = {
    id: 'j1',
    status: EnrichmentJobStatus.QUEUED,
    traceFormat: TraceFormat.MAGGIOLI,
    totalRecords: 2,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-proc-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    setupJobDir('j1');
    repo = {
      findOneBy: jest.fn(async () => ({ ...record })),
      update: jest.fn(async () => undefined),
    };
    client = {
      extract: jest.fn(async () => ({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
        warnings: [],
      })),
    };
    processor = new EnrichmentProcessor(repo, client);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  const fakeJob = { data: { jobId: 'j1' }, log: jest.fn(async () => undefined) } as unknown as Job<any>;

  it('elabora il ZIP: CSV scritto, riga con PDF mancante = warning, stato DONE', async () => {
    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 righe
    expect(lines[1]).toContain('"RSSMRA80A01H501U"');
    expect(lines[1]).toContain('"VIA ROMA 1"');
    expect(lines[1]).toContain('"761,00"');
    // Riga 2: PDF mancante → campi estratti vuoti ma riga presente
    expect(lines[2]).toContain('"VRDLGU70A01H501X"');

    expect(client.extract).toHaveBeenCalledTimes(1); // solo il PDF esistente

    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.DONE);
    expect(finalUpdate.processedRecords).toBe(2);
    expect(finalUpdate.warningCount).toBeGreaterThanOrEqual(1);
    expect(finalUpdate.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pdf: 'PROVV_MANCANTE.pdf' })]),
    );
  });

  it('warnings del servizio Python confluiscono nei warnings del job', async () => {
    client.extract.mockResolvedValue({ address: null, payment: null, warnings: ['Indirizzo non estratto: xyz'] });
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pdf: 'PROVV_1.pdf', message: 'Indirizzo non estratto: xyz' })]),
    );
  });

  it('errore fatale (source.zip assente) → stato FAILED con errorMessage, niente throw', async () => {
    fs.rmSync(getEnrichmentSourceZip('j1'));
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
    expect(finalUpdate.errorMessage).toBeTruthy();
  });

  it('record DB assente → return senza errori', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(processor.process(fakeJob)).resolves.toBeUndefined();
  });
});
