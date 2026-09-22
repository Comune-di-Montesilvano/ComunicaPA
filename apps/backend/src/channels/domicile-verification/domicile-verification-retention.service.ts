import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

@Injectable()
export class DomicileVerificationRetentionService {
  private readonly logger = new Logger(DomicileVerificationRetentionService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    private readonly settings: AppSettingsService,
  ) {}

  @Cron('0 4 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<number> {
    const days = Number(await this.settings.get('domicileVerification.retentionDays'));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const expired = await this.jobRepo.find({
      where: {
        createdAt: LessThan(cutoff),
        // PROCESSING escluso: mai cancellare un job in corso
        status: In([DomicileVerificationJobStatus.QUEUED, DomicileVerificationJobStatus.DONE, DomicileVerificationJobStatus.FAILED]),
      },
      take: 200,
    });

    let removed = 0;
    for (const job of expired) {
      await this.jobRepo.delete(job.id);
      removed++;
    }
    if (removed > 0) this.logger.log(`Retention verifica domicili: ${removed} job eliminati`);
    return removed;
  }
}
