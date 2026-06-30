import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { NOTIFICATION_QUEUE } from './notification-job.types';

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { campaignId, attemptId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} channel=${channel}`);

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    try {
      // Fase 4: qui verranno chiamate le strategy di canale (SEND, Email, PEC, AppIO, Postal)
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.SUCCESS,
        sentAt: new Date(),
      });
      await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: msg,
      });
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      throw error;
    }
  }
}
