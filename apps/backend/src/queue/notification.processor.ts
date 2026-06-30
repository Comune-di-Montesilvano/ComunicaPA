import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { NOTIFICATION_QUEUE } from './notification-job.types';

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @Inject(CHANNEL_STRATEGIES)
    private readonly strategies: Map<NotificationChannel, IChannelStrategy>,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { campaignId, recipientId, attemptId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} channel=${channel}`);

    const strategy = this.strategies.get(channel);
    if (!strategy) {
      throw new Error(`Nessuna strategy per channel ${channel}`);
    }

    const [campaign, recipient] = await Promise.all([
      this.campaignRepo.findOne({
        where: { id: campaignId },
        select: ['id', 'status', 'name', 'channelType', 'channelConfig', 'sentCount', 'failedCount', 'totalRecipients'],
      }),
      this.recipientRepo.findOne({
        where: { id: recipientId },
        select: ['id', 'codiceFiscale', 'email', 'pec', 'fullName'],
      }),
    ]);

    if (!campaign || !recipient) {
      throw new Error(`Campaign o Recipient non trovati: campaignId=${campaignId} recipientId=${recipientId}`);
    }

    // QUEUED → RUNNING (atomic, solo il primo worker che elabora vince)
    if (campaign.status === CampaignStatus.QUEUED) {
      await this.campaignRepo
        .createQueryBuilder()
        .update()
        .set({ status: CampaignStatus.RUNNING })
        .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
        .execute();
    }

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    try {
      const result = await strategy.send(recipient, campaign);

      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.SUCCESS,
        sentAt: new Date(),
        // TypeORM _QueryDeepPartialEntity<Record<string,unknown>|null> resolves to {}
        // Widen through unknown so TypeScript accepts the jsonb payload assignment
        responsePayload: (result.responsePayload ?? null) as unknown as {},
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
    } finally {
      await this.checkAndCompleteCampaign(campaignId);
    }
  }

  private async checkAndCompleteCampaign(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId },
      select: ['id', 'status', 'sentCount', 'failedCount', 'totalRecipients'],
    });

    if (!campaign || campaign.status !== CampaignStatus.RUNNING) return;
    if (campaign.sentCount + campaign.failedCount < campaign.totalRecipients) return;

    const finalStatus =
      campaign.sentCount === 0 ? CampaignStatus.FAILED : CampaignStatus.COMPLETED;

    // Atomic: WHERE status = 'running' — solo un worker completa la campagna
    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: finalStatus, completedAt: new Date() })
      .where('id = :id AND status = :running', { id: campaignId, running: CampaignStatus.RUNNING })
      .execute();

    this.logger.log(`Campaign ${campaignId} → ${finalStatus}`);
  }
}
