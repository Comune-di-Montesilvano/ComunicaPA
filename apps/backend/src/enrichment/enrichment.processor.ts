import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import * as fs from 'fs';
import { basename, join } from 'path';
import AdmZip from 'adm-zip';
import { validateRowContentWarnings } from './enrichment-row-validation.util.js';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  EnrichmentWarning,
} from '../entities/enrichment-job.entity.js';
import {
  ENRICHMENT_QUEUE,
  EnrichmentQueueJobData,
  MERGE_BATCH_JOB_NAME,
  MergeBatchQueueJobData,
  CONVERT_CAMPAIGN_QUEUE,
  CONVERT_CAMPAIGN_JOB_NAME,
  ConvertCampaignQueueJobData,
} from './enrichment-job.types.js';
import { getEnrichmentAttachmentsDir, getEnrichmentResultCsv, getEnrichmentSourcesDir } from './enrichment-paths.js';
import { readLargeFileSync } from './large-file-read.util.js';
import { mergeMaggioliCsv } from './enrichment-zip-merge.util.js';
import type { MaggioliRecord } from './maggioli-parser.js';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, type EnrichedRow } from './enriched-csv.util.js';
import { PdfExtractorClient, type ExtractedPaymentDetail } from './pdf-extractor.client.js';
import { EnrichmentEventsService } from './enrichment-events.service.js';
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service.js';
import { readCheckpointSync, writeCheckpointSync, deleteCheckpointSync } from './enrichment-checkpoint.util.js';
import { cleanupUploadBatch } from './enrichment-batch-upload.util.js';
import { listEnrichmentSources, moveSourcesIntoJob } from './enrichment-sources.util.js';

const PROGRESS_UPDATE_EVERY = 10;
const CHECKPOINT_EVERY = 100;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData | MergeBatchQueueJobData>,
    private readonly extractor: PdfExtractorClient,
    private readonly events: EnrichmentEventsService,
    private readonly overrideService: EnrichmentAddressOverrideService,
    @InjectQueue(CONVERT_CAMPAIGN_QUEUE)
    private readonly convertCampaignQueue: Queue<ConvertCampaignQueueJobData>,
  ) {
    super();
  }

  async process(job: Job<EnrichmentQueueJobData | MergeBatchQueueJobData | ConvertCampaignQueueJobData>): Promise<void> {
    if (job.name === CONVERT_CAMPAIGN_JOB_NAME) {
      // Shim di migrazione deploy: un job 'convert-campaign' rimasto in
      // waiting/active su questa coda da prima che questo tipo di job
      // fosse spostato su CONVERT_CAMPAIGN_QUEUE (BullMQ persiste i job in
      // Redis, sopravvivono al restart del processo) — rispedirlo sulla
      // coda dedicata invece di trattarlo come 'enrich' con dati diversi.
      await this.convertCampaignQueue.add(CONVERT_CAMPAIGN_JOB_NAME, job.data as ConvertCampaignQueueJobData, { jobId: String(job.id) });
      return;
    }
    if (job.name === MERGE_BATCH_JOB_NAME) {
      return this.processMergeBatch(job as Job<MergeBatchQueueJobData>);
    }
    return this.processEnrich(job as Job<EnrichmentQueueJobData>);
  }

  /**
   * NIENTE PIÙ ricostruzione di un ZIP merged: bug reale, un ZIP secondo
   * ricompattato con adm-zip (tutto in RAM: decomprime OGNI PDF, poi
   * ricomprime tutto in un nuovo buffer) teneva simultaneamente in memoria
   * tutti i PDF decompressi più il nuovo ZIP compresso — su batch multi-GB
   * ha causato OOM/freeze dell'intero host (non solo il container), anche
   * dopo l'offload su worker_thread (quello risolveva solo il blocco
   * dell'event loop, non il picco di memoria). Qui si spostano solo i pezzi
   * ZIP originali nella cartella permanente del job (fs.renameSync/copy, I/O
   * a livello OS, nessun buffer in RAM) e si fa il merge dei soli CSV
   * (mergeMaggioliCsv, testo, mai un PDF toccato) — `processEnrich` apre i
   * pezzi al volo e decomprime un PDF alla volta, esattamente come già
   * faceva per il caso a singolo file.
   */
  private async processMergeBatch(job: Job<MergeBatchQueueJobData>): Promise<void> {
    const { jobId, batchId, zipPaths, zipFilenames } = job.data;
    try {
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.PROCESSING });
      this.events.emitStage(jobId, 'Copia pezzi ZIP in corso...');
      moveSourcesIntoJob(jobId, zipPaths, zipFilenames);

      this.events.emitStage(jobId, 'Fusione CSV in corso...');
      const sources = listEnrichmentSources(jobId);
      const zips = sources.map((s) => new AdmZip(readLargeFileSync(s.path)));
      const { records } = mergeMaggioliCsv(
        zips,
        sources.map((s) => s.filename),
      );

      if (records.length === 0) {
        await this.jobRepo.update(jobId, {
          status: EnrichmentJobStatus.FAILED,
          errorMessage: 'Il tracciato non contiene righe di dati',
        });
        return;
      }
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.QUEUED, totalRecords: records.length, errorMessage: null });
      await this.queue.add('enrich', { jobId }, { jobId });
    } catch (err: any) {
      this.logger.error(`Merge batch fallito per EnrichmentJob ${jobId}: ${err.message}`);
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.FAILED, errorMessage: err.message });
    } finally {
      cleanupUploadBatch(batchId);
    }
  }

  private async processEnrich(job: Job<EnrichmentQueueJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`EnrichmentJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    try {
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.PROCESSING });
      this.events.emitStage(jobId, 'Estrazione ZIP e ricerca abbinamenti PDF...');

      // Più pezzi ZIP restano file indipendenti (vedi getEnrichmentSourcesDir) —
      // niente merged.zip: ognuno tiene solo i propri byte compressi in
      // memoria, un PDF alla volta viene decompresso più sotto per riga.
      const sources = listEnrichmentSources(jobId);
      if (sources.length === 0) {
        throw new Error('Nessun file sorgente trovato per il job');
      }
      const zips = sources.map((s) => new AdmZip(readLargeFileSync(s.path)));
      const { records } = mergeMaggioliCsv(
        zips,
        sources.map((s) => s.filename),
      );
      const attachmentsDir = getEnrichmentAttachmentsDir(jobId);
      fs.mkdirSync(attachmentsDir, { recursive: true });

      const checkpoint = readCheckpointSync(jobId);
      const startIndex = checkpoint?.lastRow ?? 0;
      const warnings: EnrichmentWarning[] = checkpoint?.warnings ?? [];
      const rows: EnrichedRow[] = checkpoint?.rows ?? [];
      let maxRate = checkpoint?.maxRate ?? 0;

      for (let i = startIndex; i < records.length; i++) {
        const rec = records[i];
        const rowNum = i + 1;
        const row = this.baseRow(rec);
        let rateCount = 0;
        let result: Awaited<ReturnType<PdfExtractorClient['extract']>> | undefined;

        const entry = rec.pdfFilename ? zips.map((z) => z.getEntry(`allegati/${rec.pdfFilename}`)).find(Boolean) ?? null : null;
        if (!entry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'PDF non trovato nel ZIP' });
          await job.log(`Riga ${rowNum}: PDF "${rec.pdfFilename}" non trovato nel ZIP`);
          this.events.emitLog(jobId, {
            row: rowNum,
            pdf: rec.pdfFilename,
            detail: rowNum === 1 ? 'full' : 'summary',
            payload: { errore: 'PDF non trovato nel ZIP' },
          });
        } else {
          try {
            // Buffer letto una sola volta: scritto su disco (allegati/ piatta,
            // niente più re-parsing di source.zip a valle per download ZIP e
            // creazione bozza campagna) PRIMA di passarlo all'estrattore, così
            // il file resta disponibile anche se l'estrazione fallisce (stesso
            // comportamento di quando il PDF viveva solo dentro lo ZIP).
            const pdfBuffer = entry.getData();
            // basename(): rec.pdfFilename viene dalla colonna del CSV
            // caricato dall'operatore, dato comunque non fidato per
            // costruire un path — previene un valore tipo "../../altra/x.pdf".
            fs.writeFileSync(join(attachmentsDir, basename(rec.pdfFilename)), pdfBuffer);
            result = await this.extractWithRetry(
              pdfBuffer,
              rec.pdfFilename,
              record.searchPayments ?? true,
              rowNum,
              job,
            );
            for (const w of result.warnings) {
              warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: w });
            }
            if (!rec.csvAddress && result.address) {
              row.indirizzo = result.address.indirizzo;
              row.cap = result.address.cap;
              row.comune = result.address.comune;
              row.provincia = result.address.provincia;
              row.stato_estero = result.address.stato_estero;
            }
            if (result.payment?.totale) {
              // QR/testo del PDF vince sempre sul CSV: il tracciato Maggioli può
              // avere un numero avviso disallineato dal vero IUV stampato/embeddato
              // nella notifica (visto dal vivo — CSV riportava un valore che non
              // corrispondeva al QR scansionato realmente sul foglio). Il CSV
              // resta solo un fallback per righe dove l'estrazione non ha trovato
              // alcun dato pagamento.
              row.numero_avviso = result.payment.totale.numero_avviso || rec.csvNumeroAvviso;
              row.numero_avviso_alternativo = result.payment.totale.numero_avviso_alternativo || rec.csvNumeroAvvisoAlt;
              row.importo = result.payment.totale.importo;
              row.scadenza = result.payment.totale.scadenza;
            }
            if (result.payment?.rate?.length) {
              rateCount = result.payment.rate.length;
              maxRate = Math.max(maxRate, rateCount);
              result.payment.rate.forEach((rata: ExtractedPaymentDetail, idx: number) => {
                const n = idx + 1;
                row[`rata${n}_numero_avviso`] = rata.numero_avviso;
                row[`rata${n}_importo`] = rata.importo;
                row[`rata${n}_scadenza`] = rata.scadenza;
              });
            }

            if (rowNum === 1 || result.warnings.length > 0) {
              this.events.emitLog(jobId, {
                row: rowNum,
                pdf: rec.pdfFilename,
                detail: rowNum === 1 ? 'full' : 'summary',
                payload: rowNum === 1
                  ? {
                      indirizzo: result.address,
                      pagamentoTotale: result.payment?.totale ?? null,
                      rate: result.payment?.rate ?? [],
                      warnings: result.warnings,
                    }
                  : {
                      warnings: result.warnings,
                    },
              });
            }
          } catch (err: any) {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Estrazione fallita: ${err.message}` });
            await job.log(`Riga ${rowNum}: estrazione fallita — ${err.message}`);
            this.events.emitLog(jobId, {
              row: rowNum,
              pdf: rec.pdfFilename,
              detail: rowNum === 1 ? 'full' : 'summary',
              payload: { errore: `Estrazione fallita: ${err.message}` },
            });
          }
        }

        // Stesse 3 regole del wizard campagne (Paese/Città/CAP, vedi
        // docs/superpowers/specs/2026-07-29-arricchimento-validazione-design.md)
        // applicate qui: mai bloccanti, solo warning informativi come
        // "PDF non trovato"/"Estrazione fallita" — l'operatore corregge via
        // EnrichmentAddressOverrideService quando vuole. Applicate
        // incondizionatamente: row esiste sempre (baseRow), anche quando il
        // PDF è mancante o l'estrazione è fallita. Funzione condivisa con
        // EnrichmentService.retryFailedPdfs, che deve ricalcolarle sulla riga
        // ripatchata — non solo il warning "Estrazione fallita".
        warnings.push(...validateRowContentWarnings(row, rowNum, rec.pdfFilename, result?.fiscalCode ?? null));

        rows.push(row);

        if (rowNum % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, {
            processedRecords: rowNum,
            warningCount: warnings.length,
            warnings: [...warnings],
          });
        }

        if (rowNum % CHECKPOINT_EVERY === 0) {
          const overrides = await this.overrideService.findByJob(jobId);
          const patchedRows = this.overrideService.applyOverrides(rows, overrides);
          writeCheckpointSync(jobId, { lastRow: rowNum, rows: patchedRows, warnings: [...warnings], maxRate });
          await this.jobRepo.update(jobId, { checkpointRow: rowNum });
        }
      }

      const overrides = await this.overrideService.findByJob(jobId);
      const finalRows = this.overrideService.applyOverrides(rows, overrides);
      const headers = buildEnrichedCsvHeaders(maxRate);
      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(headers, finalRows), 'utf-8');

      // "Un PagoPa a 0 non esiste": dati obbligatori sono numero_avviso e
      // importo (scadenza non è vincolante). `numero_avviso` da solo può
      // restare un fallback dal CSV Maggioli (baseRow(), riga 364) anche
      // quando il PDF non ha alcun PagoPa reale — `importo` non ha mai un
      // fallback CSV. Basta quindi uno dei due vuoto per contare la riga
      // come "senza PagoPa" — un AND su tutte e tre le colonne (bug reale
      // corretto) dava falsi negativi su righe con solo il numero_avviso
      // residuo dal tracciato. Niente warning testuale ("Dati PagoPA non
      // trovati nel PDF"): quello scatta prima del fallback CSV, stesso
      // falso negativo.
      const missingPaymentCount = record.searchPayments
        ? finalRows.filter((r) => !r.numero_avviso || !r.importo).length
        : 0;

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        checkpointRow: records.length,
        warningCount: warnings.length,
        warnings,
        missingPaymentCount,
        completedAt: new Date(),
      });
      deleteCheckpointSync(jobId);
      // I pezzi ZIP sorgente non servono più: i PDF validi sono già su disco
      // in allegati/, il CSV risultato è scritto. Solo sul percorso di
      // successo — un job FAILED deve poterli rileggere in un retry/resume.
      fs.rmSync(getEnrichmentSourcesDir(jobId), { recursive: true, force: true });
      this.events.emitTerminal(jobId, { type: 'done' });
      this.logger.log(`EnrichmentJob ${jobId} completato: ${records.length} righe, ${warnings.length} warning`);
    } catch (err: any) {
      // Stato terminale PRIMA di uscire: mai lasciare il record in PROCESSING
      this.logger.error(`EnrichmentJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
      deleteCheckpointSync(jobId);
      this.events.emitTerminal(jobId, { type: 'error', message: err.message });
    }
  }

  /** Backoff prima di ogni retry — 3 tentativi aggiuntivi oltre al primo. */
  private static readonly EXTRACT_RETRY_DELAYS_MS = [2000, 5000, 10000];

  /**
   * Retry inline SOLO per errori di rete/connessione verso pdf-extractor
   * (es. `fetch failed` — servizio irraggiungibile perché riavviato a metà
   * job, sintomo reale osservato dal vivo: 1142 righe fallite su una
   * campagna Postalizzazione per un redeploy in corso). Mai per un errore
   * applicativo del singolo PDF (es. HTTP 4xx/5xx da pdf-extractor su un
   * file corrotto) — riprovare non cambierebbe l'esito, solo rallenterebbe
   * il job. Fallito anche dopo i retry, torna al chiamante come prima
   * (stesso try/catch esterno, stesso warning "Estrazione fallita").
   */
  private async extractWithRetry(
    pdfBuffer: Buffer,
    filename: string,
    searchPayments: boolean,
    rowNum: number,
    job: Job<EnrichmentQueueJobData>,
  ): Promise<Awaited<ReturnType<PdfExtractorClient['extract']>>> {
    const delays = EnrichmentProcessor.EXTRACT_RETRY_DELAYS_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await this.extractor.extract(pdfBuffer, filename, { searchPayments });
      } catch (err: any) {
        lastError = err;
        if (attempt === delays.length || !this.isTransientExtractorError(err)) break;
        const delayMs = delays[attempt];
        await job.log(`Riga ${rowNum}: estrazione fallita (tentativo ${attempt + 1}/${delays.length + 1}) — ${err.message}, retry tra ${delayMs / 1000}s`);
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }

  private isTransientExtractorError(err: unknown): boolean {
    const message = String((err as Error)?.message ?? '');
    return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private baseRow(rec: MaggioliRecord): EnrichedRow {
    return {
      codice_fiscale: rec.codiceFiscale,
      nominativo: rec.nominativo,
      tipo: rec.tipo,
      pec: rec.pec,
      indirizzo: rec.csvAddress?.indirizzo ?? '',
      cap: rec.csvAddress?.cap ?? '',
      comune: rec.csvAddress?.comune ?? '',
      provincia: rec.csvAddress?.provincia ?? '',
      stato_estero: rec.csvAddress?.statoEstero ?? '',
      allegato: rec.pdfFilename,
      numero_avviso: rec.csvNumeroAvviso,
      numero_avviso_alternativo: rec.csvNumeroAvvisoAlt,
      importo: '',
      scadenza: '',
      numero_provvedimento: rec.numeroProvvedimento,
      data_emissione: rec.dataEmissione,
      oggetto: rec.oggetto,
      external_id: rec.ocrNotifica || rec.numeroProvvedimento,
    };
  }
}
