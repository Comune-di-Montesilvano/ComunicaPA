import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
import { readLargeFileSync } from './large-file-read.util';
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';
import { EnrichmentAddressOverrideService, type AddressOverrideInput } from './enrichment-address-override.service';
import { readCheckpointSync } from './enrichment-checkpoint.util';
import { buildEnrichedCsv, parseEnrichedCsv, type EnrichedRow } from './enriched-csv.util';
import type { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity';

export interface CreateEnrichmentJobParams {
  zipPath: string;
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
    private readonly queue: Queue<EnrichmentQueueJobData>,
    private readonly campaignsService: CampaignsService,
    private readonly overrideService: EnrichmentAddressOverrideService,
  ) {}

  async createJob(params: CreateEnrichmentJobParams): Promise<{ jobId?: string; blocked?: boolean; message?: string }> {
    let totalRecords: number;
    try {
      const zip = new AdmZip(readLargeFileSync(params.zipPath));
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
        searchPayments: params.searchPayments ?? true,
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
    const source = new AdmZip(readLargeFileSync(getEnrichmentSourceZip(id)));
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

    const source = new AdmZip(readLargeFileSync(getEnrichmentSourceZip(jobId)));
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

  /**
   * Legge lo stato corrente di una riga per pdfFilename. Job DONE → dal CSV
   * risultato già scritto; job ancora PROCESSING → dal checkpoint se
   * esiste (righe non ancora committate non sono raggiungibili: nessun
   * checkpoint le contiene, coerente col gate lato UI su checkpointRow).
   */
  async getRow(jobId: string, pdfFilename: string): Promise<{
    pdfFilename: string;
    codiceFiscale: string;
    indirizzo: string;
    cap: string;
    comune: string;
    provincia: string;
    statoEstero: string;
    override: EnrichmentAddressOverride | null;
  }> {
    const job = await this.getJob(jobId);
    const rows = this.loadCurrentRows(job);
    const row = rows.find((r) => r['allegato'] === pdfFilename);
    if (!row) {
      throw new BadRequestException(`Nessuna riga con allegato "${pdfFilename}" in questo job`);
    }
    const overrides = await this.overrideService.findByJob(jobId);
    const override = overrides.find((o) => o.pdfFilename === pdfFilename) ?? null;
    return {
      pdfFilename,
      codiceFiscale: row['codice_fiscale'] ?? '',
      indirizzo: row['indirizzo'] ?? '',
      cap: row['cap'] ?? '',
      comune: row['comune'] ?? '',
      provincia: row['provincia'] ?? '',
      statoEstero: row['stato_estero'] ?? '',
      override,
    };
  }

  async saveAddressOverride(
    jobId: string,
    pdfFilename: string,
    address: AddressOverrideInput,
    correctedBy: string,
  ): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    const rows = this.loadCurrentRows(job);
    if (!rows.some((r) => r['allegato'] === pdfFilename)) {
      return { blocked: true, message: `Nessuna riga con allegato "${pdfFilename}" in questo job` };
    }
    await this.overrideService.upsert(jobId, pdfFilename, address, correctedBy);
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
    fs.writeFileSync(csvPath, buildEnrichedCsv(headers, patched), 'utf-8');
    return {};
  }

  private loadCurrentRows(job: EnrichmentJob): EnrichedRow[] {
    if (job.status === EnrichmentJobStatus.DONE) {
      const csvPath = getEnrichmentResultCsv(job.id);
      if (!fs.existsSync(csvPath)) return [];
      return parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8')).rows;
    }
    return readCheckpointSync(job.id)?.rows ?? [];
  }
}
