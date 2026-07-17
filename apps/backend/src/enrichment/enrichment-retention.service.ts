import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import { EnrichmentJob, EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { getEnrichmentDir } from './enrichment-paths';

@Injectable()
export class EnrichmentRetentionService {
  private readonly logger = new Logger(EnrichmentRetentionService.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly settings: AppSettingsService,
  ) {}

  @Cron('30 3 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<number> {
    const days = Number(await this.settings.get('enrichment.retentionDays'));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const expired = await this.jobRepo.find({
      where: {
        createdAt: LessThan(cutoff),
        // PROCESSING escluso: mai cancellare un job in corso
        status: In([EnrichmentJobStatus.QUEUED, EnrichmentJobStatus.DONE, EnrichmentJobStatus.FAILED]),
      },
      take: 200,
    });

    let removed = 0;
    for (const job of expired) {
      try {
        fs.rmSync(getEnrichmentDir(job.id), { recursive: true, force: true });
        await this.jobRepo.delete(job.id);
        removed++;
      } catch (err: any) {
        this.logger.warn(`Job arricchimento ${job.id} non eliminabile: ${err.message}`);
      }
    }
    if (removed > 0) this.logger.log(`Retention arricchimento: ${removed} job eliminati`);
    return removed;
  }
}
