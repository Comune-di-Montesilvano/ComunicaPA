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
import { parseMaggioliZip, type MaggioliRecord } from './maggioli-parser';
import { buildEnrichedCsv, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient } from './pdf-extractor.client';

const PROGRESS_UPDATE_EVERY = 10;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
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

      const zip = new AdmZip(getEnrichmentSourceZip(jobId));
      const { records } = parseMaggioliZip(zip);
      const warnings: EnrichmentWarning[] = [];
      const rows: EnrichedRow[] = [];

      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const rowNum = i + 1;
        const row = this.baseRow(rec);

        const entry = rec.pdfFilename ? zip.getEntry(`allegati/${rec.pdfFilename}`) : null;
        if (!entry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'PDF non trovato nel ZIP' });
          await job.log(`Riga ${rowNum}: PDF "${rec.pdfFilename}" non trovato nel ZIP`);
        } else {
          try {
            const result = await this.extractor.extract(entry.getData(), rec.pdfFilename, 'unica');
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
            if (result.payment) {
              row.numero_avviso = rec.csvNumeroAvviso || result.payment.numero_avviso;
              row.numero_avviso_alternativo = rec.csvNumeroAvvisoAlt || result.payment.numero_avviso_alternativo;
              row.importo = result.payment.importo;
              row.scadenza = result.payment.scadenza;
            }
          } catch (err: any) {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Estrazione fallita: ${err.message}` });
            await job.log(`Riga ${rowNum}: estrazione fallita — ${err.message}`);
          }
        }

        rows.push(row);

        if (rowNum % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedRecords: rowNum, warningCount: warnings.length });
        }
      }

      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(rows), 'utf-8');

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
      this.logger.log(`EnrichmentJob ${jobId} completato: ${records.length} righe, ${warnings.length} warning`);
    } catch (err: any) {
      // Stato terminale PRIMA di uscire: mai lasciare il record in PROCESSING
      this.logger.error(`EnrichmentJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
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
