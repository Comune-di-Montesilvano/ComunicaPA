import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { EnrichmentJob, EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { readCheckpointSync } from './enrichment-checkpoint.util';

/**
 * Un job lasciato in PROCESSING da un riavvio backend non ha altrimenti
 * alcun modo di uscire da quello stato (nessun demone lo tocca, BullMQ non
 * ha retry configurato) — questo scan gira una sola volta a boot.
 */
@Injectable()
export class EnrichmentResumeService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentResumeService.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.resumeStuckJobs();
  }

  async resumeStuckJobs(): Promise<void> {
    const stuck = await this.jobRepo.find({ where: { status: EnrichmentJobStatus.PROCESSING } });
    for (const job of stuck) {
      const checkpoint = readCheckpointSync(job.id);
      if (checkpoint) {
        this.logger.warn(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio — riprendo da riga ${checkpoint.lastRow}`);
        await this.queue.add('enrich', { jobId: job.id }, { jobId: job.id });
      } else {
        this.logger.error(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio, nessun checkpoint disponibile — marcato FAILED`);
        await this.jobRepo.update(job.id, {
          status: EnrichmentJobStatus.FAILED,
          errorMessage: 'Interrotto da riavvio, nessun checkpoint disponibile',
          completedAt: new Date(),
        });
      }
    }
  }
}
