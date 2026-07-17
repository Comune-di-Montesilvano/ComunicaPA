import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  TraceFormat,
} from '../entities/enrichment-job.entity';
import { parseMaggioliZip } from './maggioli-parser';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';

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

  async deleteJob(id: string): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(id);
    if (job.status === EnrichmentJobStatus.PROCESSING) {
      return { blocked: true, message: 'Job in elaborazione: attendere il completamento prima di eliminarlo' };
    }
    fs.rmSync(getEnrichmentDir(id), { recursive: true, force: true });
    await this.jobRepo.delete(id);
    return {};
  }

  /** ZIP risultato costruito on-the-fly: arricchito.csv + PDF dal source.zip. */
  async buildResultZip(id: string): Promise<Buffer> {
    const job = await this.getJob(id);
    if (job.status !== EnrichmentJobStatus.DONE) {
      throw new NotFoundException('Risultato non ancora disponibile');
    }
    const out = new AdmZip();
    out.addFile('arricchito.csv', fs.readFileSync(getEnrichmentResultCsv(id)));
    const source = new AdmZip(getEnrichmentSourceZip(id));
    for (const entry of source.getEntries()) {
      if (entry.entryName.startsWith('allegati/') && entry.entryName.toLowerCase().endsWith('.pdf')) {
        out.addFile(entry.entryName.replace(/^allegati\//, ''), entry.getData());
      }
    }
    return out.toBuffer();
  }
}
