import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { basename, join } from 'path';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  TraceFormat,
} from '../entities/enrichment-job.entity';
import { parseMaggioliZip } from './maggioli-parser';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';

export interface CreateEnrichmentJobParams {
  zipPath: string;
  sourceFilename: string;
  traceFormat: TraceFormat;
  createdBy: string;
}

@Injectable()
export class EnrichmentService {
  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
    private readonly campaignsService: CampaignsService,
  ) {}

  async createJob(params: CreateEnrichmentJobParams): Promise<{ jobId?: string; blocked?: boolean; message?: string }> {
    let totalRecords: number;
    try {
      const zip = new AdmZip(params.zipPath);
      const { records } = parseMaggioliZip(zip);
      if (records.length === 0) {
        return { blocked: true, message: 'Il tracciato non contiene righe di dati' };
      }
      totalRecords = records.length;
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'ZIP non leggibile' };
    }

    const saved = await this.jobRepo.save(
      this.jobRepo.create({
        status: EnrichmentJobStatus.QUEUED,
        traceFormat: params.traceFormat,
        sourceFilename: params.sourceFilename,
        totalRecords,
        processedRecords: 0,
        warningCount: 0,
        warnings: [],
        errorMessage: null,
        campaignId: null,
        createdBy: params.createdBy,
        completedAt: null,
      }),
    );

    fs.mkdirSync(getEnrichmentDir(saved.id), { recursive: true });
    fs.copyFileSync(params.zipPath, getEnrichmentSourceZip(saved.id));

    await this.queue.add('enrich', { jobId: saved.id }, { jobId: saved.id });
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
   * ZIP risultato costruito on-the-fly: arricchito.csv + PDF dal source.zip.
   * Ritorna null (mai un'eccezione non-2xx) se il job non è ancora pronto o
   * il file è già stato rimosso (race con retention) — il chiamante HTTP
   * deve rispondere 200+blocked, mai un errore che il proxy esterno
   * sostituirebbe con la sua pagina HTML.
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
    const source = new AdmZip(getEnrichmentSourceZip(id));
    for (const entry of source.getEntries()) {
      if (entry.entryName.startsWith('allegati/') && entry.entryName.toLowerCase().endsWith('.pdf')) {
        out.addFile(basename(entry.entryName), entry.getData());
      }
    }
    return out.toBuffer();
  }

  /**
   * Vincolo repo: la creazione/import destinatari passa SOLO dal wizard.
   * Qui NON importiamo destinatari: creiamo una bozza col meccanismo
   * wizCsvFilename + draft_recipients.csv, così "Riprendi wizard" ricarica il
   * CSV arricchito attraverso parseCsvFile con tutte le validazioni wizard.
   */
  async createCampaignFromJob(
    jobId: string,
    params: { name: string; channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL' },
    createdBy: string,
  ): Promise<{ campaignId?: string; blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessun risultato da convertire' };
    }
    if (job.campaignId) {
      return { blocked: true, message: 'Job già convertito in campagna' };
    }
    if (!fs.existsSync(getEnrichmentResultCsv(jobId))) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }

    const campaign = await this.campaignsService.create(
      {
        name: params.name,
        channelType: params.channelType,
        channelConfig: { wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true, wizStep: 1 },
      },
      createdBy,
    );

    const uploadsDir = getUploadsDir(campaign.id);
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.copyFileSync(getEnrichmentResultCsv(jobId), join(uploadsDir, 'draft_recipients.csv'));

    const source = new AdmZip(getEnrichmentSourceZip(jobId));
    for (const entry of source.getEntries()) {
      if (entry.entryName.startsWith('allegati/') && entry.entryName.toLowerCase().endsWith('.pdf')) {
        // basename(): il nome file nello ZIP è dato attaccante-influenzabile
        // (operatore autenticato), mai usarlo per costruire un path senza
        // sanitizzazione — previene un entry "allegati/../../altra/x.pdf".
        fs.writeFileSync(join(uploadsDir, basename(entry.entryName)), entry.getData());
      }
    }

    await this.jobRepo.update(jobId, { campaignId: campaign.id });
    fs.rmSync(getEnrichmentDir(jobId), { recursive: true, force: true });

    return { campaignId: campaign.id };
  }
}
