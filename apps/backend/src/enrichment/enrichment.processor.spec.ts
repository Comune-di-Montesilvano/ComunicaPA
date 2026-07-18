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

const PAG_INDICE = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione",
  "'PROVV_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000099;'RAV999;'99;'01/02/2026",
].join('\n');

function setupJobDirPagIndice(jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('pag_indice.csv', Buffer.from(PAG_INDICE, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  fs.mkdirSync(getEnrichmentDir(jobId), { recursive: true });
  zip.writeZip(getEnrichmentSourceZip(jobId));
}

describe('EnrichmentProcessor', () => {
  let tmpDir: string;
  let repo: any;
  let client: any;
  let events: any;
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
        payment: {
          totale: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
          rate: [],
        },
        warnings: [],
      })),
    };
    events = { emitLog: jest.fn(), emitTerminal: jest.fn() };
    processor = new EnrichmentProcessor(repo, client, events);
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

  it('indirizzo e numero avviso da pag_indice.csv vincono sui dati estratti dal PDF', async () => {
    fs.rmSync(getEnrichmentDir('j1'), { recursive: true, force: true });
    setupJobDirPagIndice('j1');
    // Il PDF restituisce un indirizzo/numero avviso DIVERSI da quelli già nel CSV:
    // la riga finale deve mantenere i valori del CSV, non quelli del PDF.
    client.extract.mockResolvedValue({
      address: { indirizzo: 'VIA PDF ESTRATTA 99', cap: '99999', comune: 'ALTROVE', provincia: 'XX', stato_estero: '' },
      payment: {
        totale: { numero_avviso: '999999999999999999', numero_avviso_alternativo: 'PDF-ALT', cf_ente: '000', importo: '10,00', scadenza: '01/01/2027' },
        rate: [],
      },
      warnings: [],
    });

    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2); // header + 1 riga
    // Indirizzo: vince pag_indice.csv, non il PDF
    expect(lines[1]).toContain('"VIA MILANO 5"');
    expect(lines[1]).toContain('"00067"');
    expect(lines[1]).toContain('"MORLUPO"');
    expect(lines[1]).not.toContain('VIA PDF ESTRATTA 99');
    // Numero avviso: vince pag_indice.csv (Ocr int/rid), non il PDF
    expect(lines[1]).toContain('"301000000000000099"');
    expect(lines[1]).toContain('"RAV999"');
    expect(lines[1]).not.toContain('999999999999999999');
    // Importo/scadenza: sempre dal PDF (non presenti nel CSV sorgente)
    expect(lines[1]).toContain('"10,00"');
  });

  it('rate multiple: header CSV con colonne rataN_*, riga con meno rate lascia colonne vuote', async () => {
    client.extract.mockResolvedValueOnce({
      address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
      payment: {
        totale: { numero_avviso: '301000000000000000', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
        rate: [
          { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '380,50', scadenza: '31/01/2027' },
          { numero_avviso: '301000000000000002', numero_avviso_alternativo: '', cf_ente: '000', importo: '190,25', scadenza: '28/02/2027' },
        ],
      },
      warnings: [],
    });
    // Riga 2 (PDF mancante nello ZIP): nessuna rata, colonne rataN_* vuote

    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    const headerCells = lines[0].split(';');
    const rata1NumeroIdx = headerCells.indexOf('"rata1_numero_avviso"');
    const rata1ImportoIdx = headerCells.indexOf('"rata1_importo"');
    const rata1ScadenzaIdx = headerCells.indexOf('"rata1_scadenza"');
    const rata2NumeroIdx = headerCells.indexOf('"rata2_numero_avviso"');
    const rata2ImportoIdx = headerCells.indexOf('"rata2_importo"');
    const rata2ScadenzaIdx = headerCells.indexOf('"rata2_scadenza"');

    const row1Cells = lines[1].split(';');
    // rata1 e rata2 hanno valori DISTINTI: verifica che ciascuna colonna
    // contenga esattamente la propria rata, non uno scambio o un duplicato.
    expect(row1Cells[rata1NumeroIdx]).toBe('"301000000000000001"');
    expect(row1Cells[rata1ImportoIdx]).toBe('"380,50"');
    expect(row1Cells[rata1ScadenzaIdx]).toBe('"31/01/2027"');
    expect(row1Cells[rata2NumeroIdx]).toBe('"301000000000000002"');
    expect(row1Cells[rata2ImportoIdx]).toBe('"190,25"');
    expect(row1Cells[rata2ScadenzaIdx]).toBe('"28/02/2027"');

    const row2Cells = lines[2].split(';');
    expect(row2Cells[rata1ImportoIdx]).toBe('""'); // riga 2 senza PDF: nessuna rata
    expect(row2Cells[rata2ImportoIdx]).toBe('""');
  });

  it('emette evento log full per la riga 1, summary per le successive, terminale done a fine job', async () => {
    await processor.process(fakeJob);

    expect(events.emitLog).toHaveBeenCalledWith('j1', expect.objectContaining({ row: 1, detail: 'full' }));
    expect(events.emitLog).toHaveBeenCalledWith('j1', expect.objectContaining({ row: 2, detail: 'summary' }));
    expect(events.emitTerminal).toHaveBeenCalledWith('j1', { type: 'done' });
  });

  it('errore fatale: emette evento terminale error invece di done', async () => {
    fs.rmSync(getEnrichmentSourceZip('j1'));
    await processor.process(fakeJob);
    expect(events.emitTerminal).toHaveBeenCalledWith('j1', expect.objectContaining({ type: 'error' }));
    expect(events.emitTerminal).not.toHaveBeenCalledWith('j1', { type: 'done' });
  });
});
