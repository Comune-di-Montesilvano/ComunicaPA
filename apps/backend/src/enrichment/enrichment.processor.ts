import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import { basename, join } from 'path';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  CampaignConversionStatus,
  EnrichmentWarning,
} from '../entities/enrichment-job.entity';
import {
  ENRICHMENT_QUEUE,
  EnrichmentQueueJobData,
  CONVERT_CAMPAIGN_JOB_NAME,
  ConvertCampaignQueueJobData,
} from './enrichment-job.types';
import { getEnrichmentAttachmentsDir, getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { readLargeFileSync } from './large-file-read.util';
import { parseMaggioliZip, type MaggioliRecord } from './maggioli-parser';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient, type ExtractedPaymentDetail } from './pdf-extractor.client';
import { EnrichmentEventsService } from './enrichment-events.service';
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service';
import { readCheckpointSync, writeCheckpointSync, deleteCheckpointSync } from './enrichment-checkpoint.util';
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';

const PROGRESS_UPDATE_EVERY = 10;
const CHECKPOINT_EVERY = 100;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
    private readonly events: EnrichmentEventsService,
    private readonly overrideService: EnrichmentAddressOverrideService,
    private readonly campaignsService: CampaignsService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentQueueJobData | ConvertCampaignQueueJobData>): Promise<void> {
    if (job.name === CONVERT_CAMPAIGN_JOB_NAME) {
      return this.processConvertCampaign(job as Job<ConvertCampaignQueueJobData>);
    }
    return this.processEnrich(job as Job<EnrichmentQueueJobData>);
  }

  /**
   * Lavoro pesante di "Crea bozza campagna" spostato qui da EnrichmentService:
   * unzip del source.zip (fino a centinaia di MB) + scrittura di migliaia di
   * PDF su disco, mai dentro la richiesta HTTP originale (vedi commento in
   * EnrichmentService.requestCampaignConversion — rischio timeout proxy +
   * event loop Node affamato per qualunque richiesta concorrente).
   */
  private async processConvertCampaign(job: Job<ConvertCampaignQueueJobData>): Promise<void> {
    const { jobId, name, channelType, createdBy } = job.data;
    try {
      await this.jobRepo.update(jobId, { campaignConversionStatus: CampaignConversionStatus.PROCESSING });

      const campaign = await this.campaignsService.create(
        {
          name,
          channelType,
          channelConfig: { wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true, wizStep: 1 },
        },
        createdBy,
      );

      const uploadsDir = getUploadsDir(campaign.id);
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.copyFileSync(getEnrichmentResultCsv(jobId), join(uploadsDir, 'draft_recipients.csv'));

      // PDF già scompattati su disco da processEnrich (allegati/ piatta) —
      // nessun re-parsing di source.zip qui (già cancellato a fine
      // arricchimento riuscita, vedi processEnrich): un PDF assente da questa
      // cartella significa semplicemente che l'estrazione lo aveva già
      // segnalato come illeggibile in un warning, niente di nuovo da gestire.
      const attachmentsDir = getEnrichmentAttachmentsDir(jobId);
      if (fs.existsSync(attachmentsDir)) {
        for (const filename of fs.readdirSync(attachmentsDir)) {
          fs.copyFileSync(join(attachmentsDir, filename), join(uploadsDir, filename));
        }
      }

      await this.jobRepo.update(jobId, {
        campaignId: campaign.id,
        campaignConversionStatus: CampaignConversionStatus.DONE,
      });
      fs.rmSync(getEnrichmentDir(jobId), { recursive: true, force: true });
    } catch (err: any) {
      this.logger.error(`Conversione in campagna fallita per EnrichmentJob ${jobId}: ${err.message}`);
      await this.jobRepo.update(jobId, {
        campaignConversionStatus: CampaignConversionStatus.FAILED,
        campaignConversionError: err.message,
      });
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

      const zip = new AdmZip(readLargeFileSync(getEnrichmentSourceZip(jobId)));
      const { records } = parseMaggioliZip(zip);
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

        const entry = rec.pdfFilename ? zip.getEntry(`allegati/${rec.pdfFilename}`) : null;
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
            const result = await this.extractor.extract(pdfBuffer, rec.pdfFilename, {
              searchPayments: record.searchPayments ?? true,
            });
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

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        checkpointRow: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
      deleteCheckpointSync(jobId);
      // source.zip non serve più: i PDF validi sono già su disco in
      // allegati/, il CSV risultato è scritto. Solo sul percorso di
      // successo — un job FAILED deve poterlo rileggere in un retry/resume.
      fs.rmSync(getEnrichmentSourceZip(jobId), { force: true });
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
