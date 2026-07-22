import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  EnrichmentWarning,
} from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { readLargeFileSync } from './large-file-read.util';
import { parseMaggioliZip, type MaggioliRecord } from './maggioli-parser';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient, type ExtractedPaymentDetail } from './pdf-extractor.client';
import { EnrichmentEventsService } from './enrichment-events.service';

const PROGRESS_UPDATE_EVERY = 10;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
    private readonly events: EnrichmentEventsService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentQueueJobData>): Promise<void> {
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
      const warnings: EnrichmentWarning[] = [];
      const rows: EnrichedRow[] = [];
      let maxRate = 0;

      for (let i = 0; i < records.length; i++) {
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
            const result = await this.extractor.extract(entry.getData(), rec.pdfFilename);
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
              row.numero_avviso = rec.csvNumeroAvviso || result.payment.totale.numero_avviso;
              row.numero_avviso_alternativo = rec.csvNumeroAvvisoAlt || result.payment.totale.numero_avviso_alternativo;
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
                    indirizzoTrovato: Boolean(result.address || rec.csvAddress),
                    pagamentoTotaleTrovato: Boolean(result.payment?.totale),
                    numeroRate: rateCount,
                    warningCount: result.warnings.length,
                  },
            });
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
          await this.jobRepo.update(jobId, { processedRecords: rowNum, warningCount: warnings.length });
        }
      }

      const headers = buildEnrichedCsvHeaders(maxRate);
      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(headers, rows), 'utf-8');

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
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
    };
  }
}
