import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { join, basename } from 'path';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  CampaignConversionStatus,
  TraceFormat,
  type EnrichmentWarning,
} from '../entities/enrichment-job.entity.js';
import { PdfExtractorClient } from './pdf-extractor.client.js';
import {
  ENRICHMENT_QUEUE,
  EnrichmentQueueJobData,
  CONVERT_CAMPAIGN_QUEUE,
  CONVERT_CAMPAIGN_JOB_NAME,
  ConvertCampaignQueueJobData,
  MERGE_BATCH_JOB_NAME,
  MergeBatchQueueJobData,
} from './enrichment-job.types.js';
import { getEnrichmentAttachmentsDir, getEnrichmentDir, getEnrichmentResultCsv } from './enrichment-paths.js';
import { EnrichmentAddressOverrideService, type AddressOverrideInput } from './enrichment-address-override.service.js';
import { readCheckpointSync, writeCheckpointSync } from './enrichment-checkpoint.util.js';
import { validateRowContentWarnings } from './enrichment-row-validation.util.js';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, parseEnrichedCsv, type EnrichedRow } from './enriched-csv.util.js';
import type { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity.js';

export interface EnqueueBatchMergeParams {
  batchId: string;
  /** Uno o più pezzi ZIP "attigui" dello stesso tracciato (vedi CLAUDE.md — tracciati spezzati per problemi di download). */
  zipPaths: string[];
  /** Nomi originali dei file in zipPaths, stesso ordine — usati nei messaggi di errore/validazione. */
  zipFilenames: string[];
  sourceFilename: string;
  traceFormat: TraceFormat;
  searchPayments?: boolean;
  createdBy: string;
}

@Injectable()
export class EnrichmentService {
  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData | MergeBatchQueueJobData>,
    @InjectQueue(CONVERT_CAMPAIGN_QUEUE)
    private readonly convertCampaignQueue: Queue<ConvertCampaignQueueJobData>,
    private readonly overrideService: EnrichmentAddressOverrideService,
    private readonly extractor: PdfExtractorClient,
  ) {}

  /**
   * Il merge multi-ZIP va SEMPRE su job BullMQ (vedi `enrichment.processor.ts`
   * `processMergeBatch`), mai dentro questa richiesta HTTP — due bug reali
   * corretti in sequenza: prima un RangeError su `fs.writeFileSync` oltre
   * 2GiB (ricostruendo un ZIP merged sincrono), poi — anche dopo l'offload
   * su worker_thread — un OOM/freeze dell'intero host, perché adm-zip tiene
   * in RAM OGNI PDF decompresso più il nuovo ZIP compresso simultaneamente.
   * Fix definitivo: nessun ZIP merged fisico, `processMergeBatch` sposta solo
   * i pezzi originali su disco (`getEnrichmentSourcesDir`) e fonde i CSV
   * (testo, mai un PDF toccato) — `processEnrich` decomprime un PDF alla
   * volta, come già faceva per il caso a singolo file. Qui si crea solo il
   * record QUEUED e si accoda — niente più lavoro pesante in questa richiesta.
   */
  async enqueueBatchMerge(params: EnqueueBatchMergeParams): Promise<{ jobId: string }> {
    const saved = await this.jobRepo.save(
      this.jobRepo.create({
        status: EnrichmentJobStatus.QUEUED,
        traceFormat: params.traceFormat,
        searchPayments: params.searchPayments ?? true,
        sourceFilename: params.sourceFilename,
        totalRecords: 0,
        processedRecords: 0,
        warningCount: 0,
        warnings: [],
        errorMessage: null,
        campaignId: null,
        createdBy: params.createdBy,
        completedAt: null,
      }),
    );

    // opts.jobId volutamente DIVERSO da saved.id (jobId nel payload, usato per
    // i lookup EnrichmentJob) — bug reale trovato/corretto: BullMQ deduplica
    // per jobId nell'intera coda, indipendente dal job NAME. Riusare saved.id
    // anche qui avrebbe reso il successivo `queue.add('enrich', ..., { jobId:
    // saved.id })` (sotto, in processMergeBatch) un no-op silenzioso — nessun
    // errore, il job 'enrich' semplicemente non parte mai (stesso gotcha già
    // documentato in CLAUDE.md, qui capitato dal vivo).
    await this.queue.add(
      MERGE_BATCH_JOB_NAME,
      { jobId: saved.id, batchId: params.batchId, zipPaths: params.zipPaths, zipFilenames: params.zipFilenames },
      { jobId: `merge-${saved.id}` },
    );
    return { jobId: saved.id };
  }

  listJobs(): Promise<EnrichmentJob[]> {
    return this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  async getJob(id: string): Promise<EnrichmentJob> {
    const job = await this.jobRepo.findOneBy({ id });
    if (!job) throw new NotFoundException(`Job di arricchimento ${id} non trovato`);
    return job;
  }

  /**
   * Nessun blocco su PROCESSING: un job rimasto bloccato in quello stato
   * (es. backend riavviato a metà elaborazione) non ha altrimenti alcuna
   * via d'uscita da UI — né retention (lo esclude sempre) né riconversione.
   * Endpoint già admin-only, eliminazione forzata è la valvola di sfogo.
   */
  async deleteJob(id: string): Promise<{ blocked?: boolean; message?: string }> {
    await this.getJob(id);
    fs.rmSync(getEnrichmentDir(id), { recursive: true, force: true });
    await this.jobRepo.delete(id);
    return {};
  }

  /**
   * ZIP risultato costruito on-the-fly: arricchito.csv + PDF già scompattati
   * su disco da processEnrich (allegati/ piatta, niente più re-parsing di
   * source.zip — cancellato a fine arricchimento riuscita). Ritorna null
   * (mai un'eccezione non-2xx) se il job non è ancora pronto o il file è già
   * stato rimosso (race con retention) — il chiamante HTTP deve rispondere
   * 200+blocked, mai un errore che il proxy esterno sostituirebbe con la sua
   * pagina HTML.
   */
  async buildResultZip(id: string): Promise<Buffer | null> {
    const job = await this.getJob(id);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return null;
    }
    const csvPath = getEnrichmentResultCsv(id);
    if (!fs.existsSync(csvPath)) {
      return null;
    }
    const out = new AdmZip();
    out.addFile('arricchito.csv', fs.readFileSync(csvPath));
    const attachmentsDir = getEnrichmentAttachmentsDir(id);
    if (fs.existsSync(attachmentsDir)) {
      for (const filename of fs.readdirSync(attachmentsDir)) {
        out.addFile(filename, fs.readFileSync(join(attachmentsDir, filename)));
      }
    }
    return out.toBuffer();
  }

  /**
   * Vincolo repo: la creazione/import destinatari passa SOLO dal wizard.
   * Qui NON importiamo destinatari: creiamo una bozza col meccanismo
   * wizCsvFilename + draft_recipients.csv, così "Riprendi wizard" ricarica il
   * CSV arricchito attraverso parseCsvFile con tutte le validazioni wizard.
   *
   * Solo validazioni rapide qui — il lavoro pesante (unzip del source.zip,
   * fino a centinaia di MB, e scrittura di migliaia di PDF) gira in
   * background su ENRICHMENT_QUEUE (EnrichmentProcessor), mai dentro la
   * richiesta HTTP: farlo qui bloccherebbe l'event loop Node abbastanza a
   * lungo da far scattare il timeout del reverse proxy esterno (bug reale:
   * "Unexpected token '<'" sul frontend, corpo 500 sostituito dalla pagina
   * HTML del proxy) e, nel frattempo, affamerebbe qualunque altra richiesta
   * concorrente (single-thread Node — osservato in produzione: 403 su
   * /admin/settings scollegato, in corso nello stesso momento).
   */
  async requestCampaignConversion(
    jobId: string,
    params: { name: string; channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'; splitMissingPayment?: boolean },
    createdBy: string,
  ): Promise<{ accepted?: boolean; blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessun risultato da convertire' };
    }
    if (job.campaignId) {
      return { blocked: true, message: 'Job già convertito in campagna' };
    }
    if (job.campaignConversionStatus === CampaignConversionStatus.PENDING || job.campaignConversionStatus === CampaignConversionStatus.PROCESSING) {
      return { blocked: true, message: 'Conversione in campagna già in corso' };
    }
    if (!fs.existsSync(getEnrichmentResultCsv(jobId))) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }

    await this.jobRepo.update(jobId, {
      campaignConversionStatus: CampaignConversionStatus.PENDING,
      campaignConversionError: null,
    });
    const data: ConvertCampaignQueueJobData = {
      jobId,
      name: params.name,
      channelType: params.channelType,
      createdBy,
      splitMissingPayment: params.splitMissingPayment,
    };
    await this.convertCampaignQueue.add(CONVERT_CAMPAIGN_JOB_NAME, data, { jobId: `${CONVERT_CAMPAIGN_JOB_NAME}-${jobId}` });
    return { accepted: true };
  }

  /**
   * Legge lo stato corrente di una riga per pdfFilename. Job DONE → dal CSV
   * risultato già scritto; job ancora PROCESSING → dal checkpoint se
   * esiste (righe non ancora committate non sono raggiungibili: nessun
   * checkpoint le contiene, coerente col gate lato UI su checkpointRow).
   *
   * `headers`/`row` espongono TUTTE le colonne del job (incluse le rataN_*
   * dinamiche) — necessario per il caso PDF illeggibile (es. "ADM-ZIP:
   * Unknown descriptor format"): l'estrazione non ha prodotto alcun dato,
   * l'operatore deve poter compilare a mano qualunque campo, non solo
   * l'indirizzo. Il form lato frontend è quindi dinamico sugli `headers`,
   * non una lista fissa di 5 campi.
   */
  /**
   * Elenco pdf con correzione salvata per un job — usato dal frontend per
   * mostrare il badge "Corretto" anche dopo un refresh/riapertura del
   * dettaglio (lo stato locale ottimistico da solo si perde a ogni remount).
   */
  async getCorrectedPdfs(jobId: string): Promise<Array<{ pdfFilename: string; dismissed: boolean }>> {
    const overrides = await this.overrideService.findByJob(jobId);
    return overrides.map((o) => ({ pdfFilename: o.pdfFilename, dismissed: o.dismissed }));
  }

  /**
   * "Ignora" un avviso senza modificare alcun dato (falso positivo, es. un
   * "PagoPA mancante" che in realtà è corretto così). Stessa chiave
   * (jobId+pdfFilename) di saveRowOverride — vedi EnrichmentAddressOverrideService.dismiss.
   */
  async dismissWarning(jobId: string, pdfFilename: string, dismissedBy: string): Promise<void> {
    await this.overrideService.dismiss(jobId, pdfFilename, dismissedBy);
  }

  async getRow(jobId: string, pdfFilename: string): Promise<{
    pdfFilename: string;
    codiceFiscale: string;
    headers: string[];
    row: EnrichedRow;
    override: EnrichmentAddressOverride | null;
  }> {
    const job = await this.getJob(jobId);
    const { headers, rows } = this.loadCurrentRows(job);
    const row = rows.find((r) => r['allegato'] === pdfFilename);
    if (!row) {
      throw new BadRequestException(`Nessuna riga con allegato "${pdfFilename}" in questo job`);
    }
    const overrides = await this.overrideService.findByJob(jobId);
    const override = overrides.find((o) => o.pdfFilename === pdfFilename) ?? null;
    return {
      pdfFilename,
      codiceFiscale: row['codice_fiscale'] ?? '',
      headers,
      row,
      override,
    };
  }

  /**
   * fields copre qualunque colonna del CSV (indirizzo/cap/comune/provincia/
   * statoEstero vanno nelle colonne tipizzate dell'override per compatibilità
   * con l'uso esistente — es. futuri filtri/query — il resto in extraFields).
   */
  async saveRowOverride(
    jobId: string,
    pdfFilename: string,
    fields: Record<string, string>,
    correctedBy: string,
  ): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    const { rows } = this.loadCurrentRows(job);
    if (!rows.some((r) => r['allegato'] === pdfFilename)) {
      return { blocked: true, message: `Nessuna riga con allegato "${pdfFilename}" in questo job` };
    }
    // `fields` è chiavato sui nomi colonna CSV reali (snake_case, es. "stato_estero",
    // "numero_avviso", "rata1_importo") — coerente con come li restituisce getRow e
    // come applyOverrides li riscrive nella riga. Solo "stato_estero" va nella colonna
    // tipizzata camelCase "statoEstero" dell'override, il resto passa in extraFields
    // con la stessa chiave del CSV, senza traduzione.
    const address: AddressOverrideInput = {
      indirizzo: fields.indirizzo,
      cap: fields.cap,
      comune: fields.comune,
      provincia: fields.provincia,
      statoEstero: fields.stato_estero,
    };
    const extraFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'indirizzo' || key === 'cap' || key === 'comune' || key === 'provincia' || key === 'stato_estero') continue;
      if (key === 'allegato') continue; // chiave di identità della riga, mai sovrascrivibile
      extraFields[key] = value;
    }
    await this.overrideService.upsert(jobId, pdfFilename, address, extraFields, correctedBy);
    return {};
  }

  /**
   * Solo per job DONE: rilegge il CSV già scritto, ripatcha le righe con
   * override e riscrive il file — azione esplicita, mai automatica (stesso
   * principio della correzione indirizzo POSTAL).
   */
  async regenerateCsv(jobId: string): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessun CSV da rigenerare' };
    }
    const csvPath = getEnrichmentResultCsv(jobId);
    if (!fs.existsSync(csvPath)) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }
    const { headers, rows } = parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8'));
    const overrides = await this.overrideService.findByJob(jobId);
    const patched = this.overrideService.applyOverrides(rows, overrides);
    // Scrittura mai diretta sul file finale (stesso principio di
    // writeCheckpointSync, Global Constraint del piano) — un crash a metà
    // qui colpirebbe un job già DONE col checkpoint già cancellato: nessuna
    // via di recupero, e il click "Rigenera CSV" successivo dell'operatore
    // rileggerebbe il file troncato che ha appena prodotto, peggiorando le
    // cose invece di correggerle.
    const tmpPath = `${csvPath}.tmp`;
    fs.writeFileSync(tmpPath, buildEnrichedCsv(headers, patched), 'utf-8');
    fs.renameSync(tmpPath, csvPath);

    // Ricalcolo qui, non solo a fine processEnrich: un job DONE prima
    // dell'introduzione di missingPaymentCount resta a 0 (default migration)
    // per sempre altrimenti — "Rigenera CSV" è l'unica azione che un job
    // già DONE può ripetere, quindi è anche l'occasione per recuperare il
    // dato senza dover rilanciare l'intera estrazione. Dati obbligatori:
    // numero_avviso e importo (scadenza non vincolante) — uno dei due vuoto
    // basta, mai un AND su tutte e tre (numero_avviso può restare un
    // fallback CSV anche senza PagoPa reale, vedi stessa nota in
    // enrichment.processor.ts).
    const missingPaymentCount = job.searchPayments
      ? patched.filter((r) => !r.numero_avviso || !r.importo).length
      : 0;
    await this.jobRepo.update(jobId, { missingPaymentCount });
    return {};
  }

  /**
   * Ri-richiama pdf-extractor per le righe con warning "Estrazione fallita:
   * ..." (fallimento TRANSITORIO della chiamata, es. pdf-extractor
   * irraggiungibile perché il backend/servizio è stato riavviato a metà
   * job) — MAI per "PDF non trovato nel ZIP" (file genuinamente assente, un
   * retry non risolverebbe nulla). Il PDF è già su disco in allegati/ anche
   * per le righe fallite (scritto PRIMA della chiamata all'estrattore, vedi
   * enrichment.processor.ts) — nessun bisogno di riaprire i pezzi ZIP
   * originali.
   *
   * Funziona sia a job DONE (ripatcha il CSV finale) sia a job PROCESSING
   * (ripatcha il checkpoint e riaccoda subito, senza aspettare la fine —
   * vedi retryFailedPdfsWhileProcessing).
   *
   * Ogni riga riprovata ricalcola TUTTI i warning di contenuto
   * (validateRowContentWarnings), non solo quello di estrazione — bug reale
   * corretto prima del deploy: la prima versione scartava senza
   * ricontrollare un warning indipendente sulla stessa riga (es. "Città
   * mancante"), che spariva silenziosamente anche se il dato restava
   * davvero mancante.
   *
   * Limite noto (solo path DONE): se la riga aveva più rate di quelle già
   * presenti nell'header CSV (calcolato una volta sola a fine job sul
   * massimo trovato), le rate oltre l'header esistente vengono scartate
   * silenziosamente da buildEnrichedCsv (colonna non presente) — caso raro,
   * non gestito qui. Il path PROCESSING non ha questo limite (aggiorna
   * anche `maxRate` sul checkpoint).
   */
  async retryFailedPdfs(jobId: string): Promise<{ blocked?: boolean; message?: string; retried?: number; succeeded?: number; stillFailing?: number }> {
    const job = await this.getJob(jobId);
    if (job.status === EnrichmentJobStatus.PROCESSING) {
      return this.retryFailedPdfsWhileProcessing(job);
    }
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessuna riga da riprovare' };
    }
    const csvPath = getEnrichmentResultCsv(jobId);
    if (!fs.existsSync(csvPath)) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }

    const failedRowNumbers = new Set(
      job.warnings.filter((w) => w.message.startsWith('Estrazione fallita:')).map((w) => w.row),
    );
    if (failedRowNumbers.size === 0) {
      return { retried: 0, succeeded: 0, stillFailing: 0 };
    }

    const { headers, rows } = parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8'));
    const attachmentsDir = getEnrichmentAttachmentsDir(jobId);
    // Warning non toccati da questo retry (righe diverse, o classi di errore
    // diverse tipo "PDF non trovato") restano invariati; quelli delle righe
    // riprovate vengono ricostruiti da zero sotto.
    const untouchedWarnings = job.warnings.filter((w) => !failedRowNumbers.has(w.row));
    const newWarnings: EnrichmentWarning[] = [];
    let succeeded = 0;

    for (const rowNum of failedRowNumbers) {
      const row = rows[rowNum - 1];
      const pdfFilename = row?.allegato ?? '';
      const pdfPath = pdfFilename ? join(attachmentsDir, basename(pdfFilename)) : '';
      if (!row || !pdfFilename || !fs.existsSync(pdfPath)) {
        newWarnings.push({ row: rowNum, pdf: pdfFilename, message: 'Estrazione fallita: PDF non più disponibile su disco per il retry' });
        if (row) newWarnings.push(...validateRowContentWarnings(row, rowNum, pdfFilename, null));
        continue;
      }
      let extractedFiscalCode: string | null = null;
      try {
        const pdfBuffer = fs.readFileSync(pdfPath);
        const result = await this.extractor.extract(pdfBuffer, pdfFilename, { searchPayments: job.searchPayments });
        extractedFiscalCode = result.fiscalCode;
        for (const w of result.warnings) {
          newWarnings.push({ row: rowNum, pdf: pdfFilename, message: w });
        }
        if (!row.indirizzo && result.address) {
          row.indirizzo = result.address.indirizzo;
          row.cap = result.address.cap;
          row.comune = result.address.comune;
          row.provincia = result.address.provincia;
          row.stato_estero = result.address.stato_estero;
        }
        if (result.payment?.totale) {
          row.numero_avviso = result.payment.totale.numero_avviso || row.numero_avviso;
          row.numero_avviso_alternativo = result.payment.totale.numero_avviso_alternativo || row.numero_avviso_alternativo;
          row.importo = result.payment.totale.importo;
          row.scadenza = result.payment.totale.scadenza;
        }
        result.payment?.rate?.forEach((rata, idx) => {
          const n = idx + 1;
          if (!headers.includes(`rata${n}_numero_avviso`)) return; // vedi limite noto in cima al metodo
          row[`rata${n}_numero_avviso`] = rata.numero_avviso;
          row[`rata${n}_importo`] = rata.importo;
          row[`rata${n}_scadenza`] = rata.scadenza;
        });
        succeeded++;
      } catch (err: any) {
        newWarnings.push({ row: rowNum, pdf: pdfFilename, message: `Estrazione fallita: ${err.message}` });
      }
      newWarnings.push(...validateRowContentWarnings(row, rowNum, pdfFilename, extractedFiscalCode));
    }

    const overrides = await this.overrideService.findByJob(jobId);
    const patched = this.overrideService.applyOverrides(rows, overrides);
    const tmpPath = `${csvPath}.tmp`;
    fs.writeFileSync(tmpPath, buildEnrichedCsv(headers, patched), 'utf-8');
    fs.renameSync(tmpPath, csvPath);

    const warnings = [...untouchedWarnings, ...newWarnings];
    const missingPaymentCount = job.searchPayments
      ? patched.filter((r) => !r.numero_avviso || !r.importo).length
      : 0;
    await this.jobRepo.update(jobId, { warnings, warningCount: warnings.length, missingPaymentCount });

    return { retried: failedRowNumbers.size, succeeded, stillFailing: failedRowNumbers.size - succeeded };
  }

  /**
   * "Ferma e correggi ora": job ancora PROCESSING, l'operatore non vuole
   * aspettare la fine per riprovare le righe già marcate "Estrazione
   * fallita" nel checkpoint — richiesta esplicita, accettando di perdere il
   * progresso non ancora salvato a checkpoint (scritto ogni 100 righe) se il
   * job era ancora realmente attivo. Rimuove SEMPRE il job BullMQ esistente
   * prima di ripatchare (stesso principio di EnrichmentResumeService: un
   * loop ancora vivo che scrivesse un altro checkpoint dopo il nostro lo
   * sovrascriverebbe silenziosamente — rimuovere il job non può fermare un
   * `for` già in esecuzione, ma è la stessa richiesta esplicita
   * dell'operatore, non un'azione silenziosa) e riaccoda con lo stesso jobId
   * per riprendere da `checkpoint.lastRow` una volta ripatchato.
   */
  private async retryFailedPdfsWhileProcessing(
    job: EnrichmentJob,
  ): Promise<{ blocked?: boolean; message?: string; retried?: number; succeeded?: number; stillFailing?: number }> {
    const checkpoint = readCheckpointSync(job.id);
    if (!checkpoint) {
      return { blocked: true, message: 'Nessun checkpoint disponibile: il job non ha ancora processato righe' };
    }
    const failedRowNumbers = new Set(
      checkpoint.warnings.filter((w) => w.message.startsWith('Estrazione fallita:')).map((w) => w.row),
    );
    if (failedRowNumbers.size === 0) {
      return { retried: 0, succeeded: 0, stillFailing: 0 };
    }

    const existing = await this.queue.getJob(job.id);
    if (existing) {
      try {
        await existing.remove();
      } catch {
        // BullMQ Job.remove() lancia se il job è ancora `active` (lockato da
        // un worker realmente in esecuzione — nessuna opzione `force` in
        // questa versione) — bug reale: 500 non gestito al primo utilizzo
        // reale in prod. L'operatore ha esplicitamente accettato questo caso
        // (job ancora attivo): si prosegue comunque a ripatchare il
        // checkpoint, il successivo queue.add() con lo stesso jobId resta un
        // no-op sicuro se il job è davvero ancora vivo (dedup BullMQ).
      }
    }

    const attachmentsDir = getEnrichmentAttachmentsDir(job.id);
    const untouchedWarnings = checkpoint.warnings.filter((w) => !failedRowNumbers.has(w.row));
    const newWarnings: EnrichmentWarning[] = [];
    let maxRate = checkpoint.maxRate;
    let succeeded = 0;

    for (const rowNum of failedRowNumbers) {
      const row = checkpoint.rows[rowNum - 1];
      const pdfFilename = row?.allegato ?? '';
      const pdfPath = pdfFilename ? join(attachmentsDir, basename(pdfFilename)) : '';
      if (!row || !pdfFilename || !fs.existsSync(pdfPath)) {
        newWarnings.push({ row: rowNum, pdf: pdfFilename, message: 'Estrazione fallita: PDF non più disponibile su disco per il retry' });
        if (row) newWarnings.push(...validateRowContentWarnings(row, rowNum, pdfFilename, null));
        continue;
      }
      let extractedFiscalCode: string | null = null;
      try {
        const pdfBuffer = fs.readFileSync(pdfPath);
        const result = await this.extractor.extract(pdfBuffer, pdfFilename, { searchPayments: job.searchPayments });
        extractedFiscalCode = result.fiscalCode;
        for (const w of result.warnings) {
          newWarnings.push({ row: rowNum, pdf: pdfFilename, message: w });
        }
        if (!row.indirizzo && result.address) {
          row.indirizzo = result.address.indirizzo;
          row.cap = result.address.cap;
          row.comune = result.address.comune;
          row.provincia = result.address.provincia;
          row.stato_estero = result.address.stato_estero;
        }
        if (result.payment?.totale) {
          row.numero_avviso = result.payment.totale.numero_avviso || row.numero_avviso;
          row.numero_avviso_alternativo = result.payment.totale.numero_avviso_alternativo || row.numero_avviso_alternativo;
          row.importo = result.payment.totale.importo;
          row.scadenza = result.payment.totale.scadenza;
        }
        if (result.payment?.rate?.length) {
          maxRate = Math.max(maxRate, result.payment.rate.length);
          result.payment.rate.forEach((rata, idx) => {
            const n = idx + 1;
            row[`rata${n}_numero_avviso`] = rata.numero_avviso;
            row[`rata${n}_importo`] = rata.importo;
            row[`rata${n}_scadenza`] = rata.scadenza;
          });
        }
        succeeded++;
      } catch (err: any) {
        newWarnings.push({ row: rowNum, pdf: pdfFilename, message: `Estrazione fallita: ${err.message}` });
      }
      newWarnings.push(...validateRowContentWarnings(row, rowNum, pdfFilename, extractedFiscalCode));
    }

    const warnings = [...untouchedWarnings, ...newWarnings];
    writeCheckpointSync(job.id, { ...checkpoint, warnings, maxRate });
    await this.jobRepo.update(job.id, { warnings, warningCount: warnings.length });
    await this.queue.add('enrich', { jobId: job.id }, { jobId: job.id });

    return { retried: failedRowNumbers.size, succeeded, stillFailing: failedRowNumbers.size - succeeded };
  }

  private loadCurrentRows(job: EnrichmentJob): { headers: string[]; rows: EnrichedRow[] } {
    if (job.status === EnrichmentJobStatus.DONE) {
      const csvPath = getEnrichmentResultCsv(job.id);
      if (!fs.existsSync(csvPath)) return { headers: [], rows: [] };
      return parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8'));
    }
    const checkpoint = readCheckpointSync(job.id);
    return { headers: buildEnrichedCsvHeaders(checkpoint?.maxRate ?? 0), rows: checkpoint?.rows ?? [] };
  }
}
