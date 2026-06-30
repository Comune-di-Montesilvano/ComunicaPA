import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NOTIFICATION_QUEUE } from './notification-job.types';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { processTemplate } from '../channels/template.helper';

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
    const { campaignId, attemptId, recipientId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} recipient=${recipientId} channel=${channel}`);

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    try {
      // 1. Reperisce destinatario
      const recipient = await this.recipientRepo.findOne({
        where: { id: recipientId },
      });
      if (!recipient) {
        throw new Error(`Recipient ${recipientId} not found`);
      }

      // 2. Reperisce campagna
      const campaign = await this.campaignRepo.findOne({
        where: { id: campaignId },
      });
      if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found`);
      }

      // 3. Esegue invio tramite strategy
      const strategy = this.strategies.get(channel);
      if (!strategy) {
        throw new Error(`Strategy for channel ${channel} not found`);
      }

      const result = await strategy.send(recipient, campaign);

      const responsePayload: Record<string, any> = {
        ...(result.responsePayload || {}),
        messageId: result.messageId,
      };

      // 4. Co-delivery su App IO
      const appIoConfig = campaign.channelConfig?.['appIo'] as any;
      if ((channel === 'EMAIL' || channel === 'PEC') && appIoConfig?.apiKey) {
        const hasAppIo = await this.checkAppIoProfile(
          appIoConfig.baseUrl,
          appIoConfig.apiKey,
          recipient.codiceFiscale,
        );

        if (hasAppIo) {
          try {
            this.logger.log(`Performing simultaneous App IO delivery for CF: ${recipient.codiceFiscale}`);
            const citizenPortalUrl = appIoConfig.citizenPortalUrl || 'http://localhost:3001';
            const processedSubject = processTemplate(
              (campaign.channelConfig?.['subject'] as string) || campaign.name,
              recipient,
              citizenPortalUrl,
            );
            const processedMarkdown = processTemplate(
              (campaign.channelConfig?.['body'] as string) || '',
              recipient,
              citizenPortalUrl,
            );

            const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': appIoConfig.apiKey,
              },
              body: JSON.stringify({
                fiscal_code: recipient.codiceFiscale,
                content: {
                  subject: processedSubject,
                  markdown: processedMarkdown,
                },
              }),
            });

            if (appIoRes.ok) {
              const appIoData = (await appIoRes.json()) as { id: string };
              responsePayload.appIo = {
                success: true,
                messageId: appIoData.id,
              };
              this.logger.log(`Simultaneous App IO delivery success: messageId=${appIoData.id}`);
            } else {
              responsePayload.appIo = {
                success: false,
                error: `App IO status: ${appIoRes.status}`,
              };
              this.logger.warn(`Simultaneous App IO delivery failed with status ${appIoRes.status}`);
            }
          } catch (appIoErr: any) {
            responsePayload.appIo = {
              success: false,
              error: appIoErr.message,
            };
            this.logger.error(`Simultaneous App IO delivery error: ${appIoErr.message}`);
          }
        }
      }

      // 5. Salva tentativo con successo
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.SUCCESS,
        sentAt: new Date(),
        responsePayload,
      });

      // 6. Salva destinatario con successo
      await this.recipientRepo.update(recipientId, {
        status: RecipientStatus.SENT,
      });

      await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
    } catch (error: any) {
      const msg = error.message || String(error);
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: msg,
      });
      await this.recipientRepo.update(recipientId, {
        status: RecipientStatus.FAILED,
      });
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      throw error;
    }
  }

  private async checkAppIoProfile(
    baseUrl: string,
    apiKey: string,
    fiscalCode: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/v1/profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': apiKey,
        },
        body: JSON.stringify({ fiscal_code: fiscalCode }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { sender_allowed: boolean };
      return !!data?.sender_allowed;
    } catch {
      return false;
    }
  }
}
