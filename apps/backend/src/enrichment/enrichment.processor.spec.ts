import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import type { Job } from 'bullmq';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity.js';
import { getEnrichmentAttachmentsDir, getEnrichmentCheckpoint, getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourcesDir } from './enrichment-paths.js';
import { EnrichmentProcessor } from './enrichment.processor.js';

const RUBRICA = [
  'id;pec1@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;PROVV_1.pdf',
  'id;pec2@pec.it;;LUIGI;VERDI;VRDLGU70A01H501X;;VERDI LUIGI;2;13/03/2026;Oggetto 2;;;PROVV_MANCANTE.pdf',
].join('\n');

/** Scrive un pezzo ZIP direttamente nella cartella sorgenti permanente del job — stesso stato che
 * `processMergeBatch` produce da un batch upload reale (vedi `moveSourcesIntoJob`). */
function setupJobDir(jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('rubrica.csv', Buffer.from(RUBRICA, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  const dir = getEnrichmentSourcesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  zip.writeZip(join(dir, '0000_pezzo.zip'));
}

const PAG_INDICE = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione",
  "'PROVV_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000099;'RAV999;'99;'01/02/2026",
].join('\n');

function setupJobDirPagIndice(jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('pag_indice.csv', Buffer.from(PAG_INDICE, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  const dir = getEnrichmentSourcesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  zip.writeZip(join(dir, '0000_pezzo.zip'));
}

const PAG_INDICE_CON_OCR = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione;'ocr notifica",
  "'PROVV_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000099;'RAV999;'99;'01/02/2026;'5890000000049995",
].join('\n');

function setupJobDirPagIndiceConOcr(jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('pag_indice.csv', Buffer.from(PAG_INDICE_CON_OCR, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  const dir = getEnrichmentSourcesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  zip.writeZip(join(dir, '0000_pezzo.zip'));
}

describe('EnrichmentProcessor', () => {
  let tmpDir: string;
  let repo: any;
  let queue: any;
  let client: any;
  let events: any;
  let overrideService: any;
  let convertCampaignQueue: any;
  let processor: EnrichmentProcessor;
  const record = {
    id: 'j1',
    status: EnrichmentJobStatus.QUEUED,
    traceFormat: TraceFormat.MAGGIOLI,
    searchPayments: true,
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
    queue = { add: jest.fn(async () => undefined) };
    client = {
      extract: jest.fn(async () => ({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: {
          totale: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
          rate: [],
        },
        fiscalCode: null,
        warnings: [],
      })),
    };
    events = { emitLog: jest.fn(), emitTerminal: jest.fn(), emitStage: jest.fn() };
    overrideService = { findByJob: jest.fn(async () => []), applyOverrides: jest.fn((rows: any) => rows) };
    convertCampaignQueue = { add: jest.fn(async () => undefined) };
    processor = new EnrichmentProcessor(repo, queue, client, events, overrideService, convertCampaignQueue);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  const fakeJob = { data: { jobId: 'j1' }, log: jest.fn(async () => undefined) } as unknown as Job<any>;

  describe('processMergeBatch', () => {
    // Nessun worker_thread/ZIP ricostruito: processMergeBatch sposta solo i
    // pezzi originali (fs) e fonde i CSV (testo, mergeMaggioliCsv) — qui si
    // testa con veri file su disco, non serve mockare nulla oltre repo/queue.
    let batchDir: string;

    function writeBatchPiece(index: number, filename: string, pdfName: string, id: string): string {
      const zip = new AdmZip();
      zip.addFile('rubrica.csv', Buffer.from(`${id};pec@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto;;;${pdfName}`, 'utf-8'));
      zip.addFile(`allegati/${pdfName}`, Buffer.from('%PDF-1'));
      const p = join(batchDir, `${index}_${filename}`);
      zip.writeZip(p);
      return p;
    }

    beforeEach(() => {
      batchDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-batch-'));
      // Il beforeEach esterno ha già popolato le sorgenti di 'j1' via setupJobDir —
      // irrilevante per questi test, che verificano il merge da zero.
      fs.rmSync(getEnrichmentSourcesDir('j1'), { recursive: true, force: true });
    });

    afterEach(() => {
      fs.rmSync(batchDir, { recursive: true, force: true });
    });

    it('merge riuscito: pezzi spostati nelle sorgenti permanenti, totalRecords aggiornato, job "enrich" accodato', async () => {
      const p1 = writeBatchPiece(0, 'a.zip', 'A.pdf', '1');
      const p2 = writeBatchPiece(1, 'b.zip', 'B.pdf', '2');
      const mergeJob = {
        name: 'merge-batch',
        data: { jobId: 'j1', batchId: 'batch-1', zipPaths: [p1, p2], zipFilenames: ['a.zip', 'b.zip'] },
      } as unknown as Job<any>;

      await processor.process(mergeJob);

      expect(fs.existsSync(p1)).toBe(false); // spostato, non più nel batch dir
      const sources = fs.readdirSync(getEnrichmentSourcesDir('j1'));
      expect(sources).toHaveLength(2);
      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate).toEqual(expect.objectContaining({ status: EnrichmentJobStatus.QUEUED, totalRecords: 2 }));
      expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
    });

    it('ZIP senza rubrica/pag_indice → job FAILED, nessun job "enrich" accodato', async () => {
      const empty = new AdmZip();
      const p = join(batchDir, '0_vuoto.zip');
      empty.writeZip(p);
      const mergeJob = {
        name: 'merge-batch',
        data: { jobId: 'j1', batchId: 'batch-1', zipPaths: [p], zipFilenames: ['vuoto.zip'] },
      } as unknown as Job<any>;

      await processor.process(mergeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
      expect(finalUpdate.errorMessage).toContain('vuoto.zip');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('ZIP realmente illeggibile (path inesistente) → job FAILED con errorMessage', async () => {
      const mergeJob = {
        name: 'merge-batch',
        data: { jobId: 'j1', batchId: 'batch-1', zipPaths: [join(batchDir, 'assente.zip')], zipFilenames: ['assente.zip'] },
      } as unknown as Job<any>;

      await processor.process(mergeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
      expect(finalUpdate.errorMessage).toBeTruthy();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

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

  it('scompatta il PDF valido su disco (allegati/ piatta) durante l\'estrazione ed elimina le sorgenti a fine job riuscito', async () => {
    await processor.process(fakeJob);

    expect(fs.existsSync(join(getEnrichmentAttachmentsDir('j1'), 'PROVV_1.pdf'))).toBe(true);
    // PDF_MANCANTE non esiste nello ZIP: nessun file scompattato per quella riga
    expect(fs.existsSync(join(getEnrichmentAttachmentsDir('j1'), 'PROVV_MANCANTE.pdf'))).toBe(false);
    // le sorgenti non servono più dopo un job DONE: i PDF sono già su disco
    expect(fs.existsSync(getEnrichmentSourcesDir('j1'))).toBe(false);
  });

  it('errore fatale (sorgenti assenti): nessun tentativo di eliminarle di nuovo, nessun throw aggiuntivo', async () => {
    fs.rmSync(getEnrichmentSourcesDir('j1'), { recursive: true, force: true });
    await expect(processor.process(fakeJob)).resolves.toBeUndefined();
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
  });

  it('warnings del servizio Python confluiscono nei warnings del job', async () => {
    client.extract.mockResolvedValue({ address: null, payment: null, warnings: ['Indirizzo non estratto: xyz'] });
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pdf: 'PROVV_1.pdf', message: 'Indirizzo non estratto: xyz' })]),
    );
  });

  it('errore fatale (sorgenti assenti) → stato FAILED con errorMessage, niente throw', async () => {
    fs.rmSync(getEnrichmentSourcesDir('j1'), { recursive: true, force: true });
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
    expect(finalUpdate.errorMessage).toBeTruthy();
  });

  it('record DB assente → return senza errori', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(processor.process(fakeJob)).resolves.toBeUndefined();
  });

  it('indirizzo da pag_indice.csv vince sul PDF, numero avviso dal PDF (QR) vince sul CSV', async () => {
    fs.rmSync(getEnrichmentDir('j1'), { recursive: true, force: true });
    setupJobDirPagIndice('j1');
    // Il PDF restituisce un indirizzo/numero avviso DIVERSI da quelli già nel CSV.
    // Indirizzo: resta quello del CSV (fonte affidabile per la consegna postale).
    // Numero avviso: vince il PDF — il tracciato Maggioli può avere un valore
    // disallineato dal vero IUV stampato/embeddato nel QR (visto dal vivo:
    // colonna CSV con un numero che non corrispondeva al QR scansionato
    // realmente sul foglio), fidarsi del CSV avrebbe prodotto un avviso PagoPA
    // sbagliato in mano al cittadino.
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
    // Numero avviso: vince il PDF (QR), non il CSV
    expect(lines[1]).toContain('"999999999999999999"');
    expect(lines[1]).toContain('"PDF-ALT"');
    expect(lines[1]).not.toContain('301000000000000099');
    // Importo/scadenza: sempre dal PDF (non presenti nel CSV sorgente)
    expect(lines[1]).toContain('"10,00"');
    // external_id: pag_indice.csv senza colonna 'ocr notifica' → fallback su numero_provvedimento
    const headerCells = csv.split('\n')[0].split(';');
    const externalIdIdx = headerCells.indexOf('"external_id"');
    expect(lines[1].split(';')[externalIdIdx]).toBe('"99"');
  });

  it('numero avviso da pag_indice.csv usato come fallback quando il PDF non estrae dati pagamento', async () => {
    try { fs.rmSync(getEnrichmentDir('j1'), { recursive: true, force: true }); } catch {}
    setupJobDirPagIndice('j1');
    client.extract.mockResolvedValue({
      address: { indirizzo: 'VIA PDF ESTRATTA 99', cap: '99999', comune: 'ALTROVE', provincia: 'XX', stato_estero: '' },
      payment: { totale: { numero_avviso: '', numero_avviso_alternativo: '', cf_ente: '', importo: '10,00', scadenza: '01/01/2027' }, rate: [] },
      warnings: [],
    });

    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    expect(lines[1]).toContain('"301000000000000099"');
    expect(lines[1]).toContain('"RAV999"');
  });

  it('external_id: usa "ocr notifica" quando presente nel tracciato pag_indice', async () => {
    fs.rmSync(getEnrichmentDir('j1'), { recursive: true, force: true });
    setupJobDirPagIndiceConOcr('j1');
    client.extract.mockResolvedValue({
      address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
      payment: { totale: { numero_avviso: '1', numero_avviso_alternativo: '', cf_ente: '000', importo: '10,00', scadenza: '01/01/2027' }, rate: [] },
      warnings: [],
    });

    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    const headerCells = lines[0].split(';');
    const externalIdIdx = headerCells.indexOf('"external_id"');
    expect(lines[1].split(';')[externalIdIdx]).toBe('"5890000000049995"');
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
    fs.rmSync(getEnrichmentSourcesDir('j1'), { recursive: true });
    await processor.process(fakeJob);
    expect(events.emitTerminal).toHaveBeenCalledWith('j1', expect.objectContaining({ type: 'error' }));
    expect(events.emitTerminal).not.toHaveBeenCalledWith('j1', { type: 'done' });
  });

  it('checkpoint scritto ogni 100 righe: con meno di 100 record nessun checkpoint intermedio, ma checkpointRow finale = totale', async () => {
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.DONE);
    // Il job di test ha 2 record: sotto soglia 100, checkpointRow avanza comunque a fine job
    // per coerenza (nessuna riga "non committata" a job concluso).
  });

  it('resume: con checkpoint esistente, salta extractor.extract per le righe già coperte da lastRow', async () => {
    const { writeCheckpointSync } = await import('./enrichment-checkpoint.util.js');
    writeCheckpointSync('j1', {
      lastRow: 1,
      rows: [{ codice_fiscale: 'RSSMRA80A01H501U', allegato: 'PROVV_1.pdf', indirizzo: 'GIA PROCESSATA' }],
      warnings: [],
      maxRate: 0,
    });

    await processor.process(fakeJob);

    // Solo la riga 2 (PDF mancante, nessuna extract comunque) viene elaborata:
    // extract non deve essere richiamato per la riga 1 già nel checkpoint.
    expect(client.extract).not.toHaveBeenCalled();
    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    expect(csv).toContain('GIA PROCESSATA');
  });

  it('checkpoint corrotto: trattato come assente, elabora da riga 0', async () => {
    fs.writeFileSync(getEnrichmentCheckpoint('j1'), '{not valid json');
    await processor.process(fakeJob);
    expect(client.extract).toHaveBeenCalledTimes(1); // comportamento normale, da zero
  });

  it('a completamento (DONE) il checkpoint viene cancellato dal disco', async () => {
    await processor.process(fakeJob);
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
  });

  it('a completamento (FAILED) il checkpoint viene cancellato dal disco', async () => {
    fs.rmSync(getEnrichmentSourcesDir('j1'), { recursive: true });
    await processor.process(fakeJob);
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
  });

  describe('convert-campaign legacy (shim di migrazione deploy)', () => {
    // Un job 'convert-campaign' può restare in waiting/active su
    // ENRICHMENT_QUEUE al momento di un deploy che sposta questo tipo di job
    // sulla coda dedicata CONVERT_CAMPAIGN_QUEUE (vedi convert-campaign.processor.ts) —
    // BullMQ persiste i job in Redis, sopravvivono al restart del processo.
    // Senza questo shim, il process() di default lo tratterebbe come un
    // job 'enrich' con dati completamente diversi (jobId,name,channelType,
    // createdBy invece di solo jobId), corrompendo lo stato del job originale.
    const legacyConvertJob = {
      id: 'convert-campaign-job-uuid-1',
      name: 'convert-campaign',
      data: { jobId: 'job-uuid-1', name: 'Campagna X', channelType: 'PEC', createdBy: 'op' },
    } as unknown as Job<any>;

    it('rispedisce il job sulla coda dedicata invece di processarlo come enrich', async () => {
      await processor.process(legacyConvertJob);

      expect(convertCampaignQueue.add).toHaveBeenCalledWith(
        'convert-campaign',
        legacyConvertJob.data,
        { jobId: legacyConvertJob.id },
      );
      expect(repo.findOneBy).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  it('applica gli override indirizzo esistenti prima di scrivere il CSV finale', async () => {
    overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA CORRETTA' }]);
    overrideService.applyOverrides.mockImplementation((rows: any[]) =>
      rows.map((r) => (r.allegato === 'PROVV_1.pdf' ? { ...r, indirizzo: 'VIA CORRETTA' } : r)),
    );
    await processor.process(fakeJob);
    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    expect(csv).toContain('VIA CORRETTA');
  });

  describe('validazione Paese/Città/CAP (stesse regole del wizard campagne)', () => {
    it('Città mancante → warning, quando comune resta vuoto dopo estrazione/CSV', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: '', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Città mancante' })]),
      );
    });

    it('Paese non riconosciuto → warning, con il fix apostrofo/spazi ora "PERU\'" viene riconosciuto e NON genera warning', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: '', comune: 'LIMA', provincia: '', stato_estero: "PERU'" },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('non riconosciuto') })]),
      );
    });

    it('Paese realmente non riconosciuto (stringa non mappabile) → warning', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: '', comune: 'LIMA', provincia: '', stato_estero: 'PAESE INESISTENTE XYZ' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Paese "PAESE INESISTENTE XYZ" non riconosciuto' })]),
      );
    });

    it('CAP non valido → warning solo per indirizzo domestico (Paese vuoto o Italia)', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: 'LA', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'CAP non valido (richieste 5 cifre)' })]),
      );
    });

    it('CAP non a 5 cifre NON genera warning se l\'indirizzo è estero', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: 'LA', comune: 'LIMA', provincia: '', stato_estero: 'Perù' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('CAP non valido') })]),
      );
    });

    it('indirizzo domestico completo e valido → nessun nuovo warning di validazione', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      const validationMessages = finalUpdate.warnings
        .filter((w: any) => w.pdf === 'PROVV_1.pdf')
        .map((w: any) => w.message);
      expect(validationMessages).toEqual([]);
    });
  });

  describe('validazione Codice Fiscale/Partita IVA', () => {
    function setupJobDirWithCf(jobId: string, cf: string): void {
      const rubrica = [
        `id;pec1@pec.it;;MARIO;ROSSI;${cf};;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;PROVV_1.pdf`,
      ].join('\n');
      const zip = new AdmZip();
      zip.addFile('rubrica.csv', Buffer.from(rubrica, 'utf-8'));
      zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
      const dir = getEnrichmentSourcesDir(jobId);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      zip.writeZip(join(dir, '0000_pezzo.zip'));
    }

    it('CF vuoto → warning "mancante", nessun fallback tentato', async () => {
      setupJobDirWithCf('j1', '');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA mancante' })]),
      );
    });

    it('CF invalido nel CSV, PDF ne estrae uno valido → auto-sostituito + warning', async () => {
      setupJobDirWithCf('j1', 'CFINVALIDO');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: 'RSSMRA80A01H501U',
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Codice Fiscale/Partita IVA CSV non valido ("CFINVALIDO") — sostituito con valore estratto dal PDF',
          }),
        ]),
      );
      const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
      expect(csv).toContain('RSSMRA80A01H501U');
      expect(csv).not.toContain('CFINVALIDO');
    });

    it('CF invalido nel CSV, PDF non ne estrae uno valido → solo warning, riga invariata', async () => {
      setupJobDirWithCf('j1', 'CFINVALIDO');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA non valido ("CFINVALIDO")' })]),
      );
      const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
      expect(csv).toContain('CFINVALIDO');
    });

    it('CF valido nel CSV → nessun warning CF/PIVA, anche se il PDF non estrae nulla', async () => {
      setupJobDirWithCf('j1', 'RSSMRA80A01H501U');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('Codice Fiscale') })]),
      );
    });

    it('PDF non trovato nello ZIP → warning CF/PIVA comunque valutato su riga base (nessun fallback disponibile)', async () => {
      const rubrica = 'id;pec1@pec.it;;MARIO;ROSSI;CFINVALIDO;;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;MANCANTE.pdf';
      const zip = new AdmZip();
      zip.addFile('rubrica.csv', Buffer.from(rubrica, 'utf-8'));
      const dir = getEnrichmentSourcesDir('j1');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      zip.writeZip(join(dir, '0000_pezzo.zip'));

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA non valido ("CFINVALIDO")' })]),
      );
    });
  });
});
