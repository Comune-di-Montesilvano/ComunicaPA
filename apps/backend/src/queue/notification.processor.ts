import { Inject, Logger, Injectable } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import Redis from 'ioredis';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { THROTTLE_REDIS } from './notification-job.types';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { processTemplate } from '../channels/template.helper';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
import { AppSettingsService } from '../settings/app-settings.service';
import { MailConfigsService } from '../mail-configs/mail-configs.service';

@Injectable()
export class NotificationProcessor extends WorkerHost {
  protected readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @Inject(CHANNEL_STRATEGIES)
    private readonly strategies: Map<NotificationChannel, IChannelStrategy>,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
    @Inject(THROTTLE_REDIS)
    private readonly redis: Redis,
    private readonly mailConfigs: MailConfigsService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>, token?: string): Promise<void> {
    const { campaignId, attemptId, recipientId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} recipient=${recipientId} channel=${channel}`);

    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient) {
      throw new Error(`Recipient ${recipientId} not found`);
    }

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Throttling per configurazione mittente (solo canali mail)
    if (channel === 'EMAIL' || channel === 'PEC') {
      const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
      const resolved = await this.mailConfigs.resolveForSend(channel, mailConfigId);
      const windowMs = resolved.batchIntervalSeconds * 1000;
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const throttleKey = `comunicapa:throttle:${channel}:${resolved.configId ?? 'legacy'}:${windowStart}`;

      const count = await this.redis.incr(throttleKey);
      if (count === 1) {
        await this.redis.pexpire(throttleKey, windowMs * 2);
      }
      if (count > resolved.batchSize) {
        // Batch pieno: rimanda il job all'inizio della finestra successiva.
        // Decrementa: questo job non consuma quota in questa finestra.
        await this.redis.decr(throttleKey);
        this.logger.log(
          `Throttle ${channel} (${resolved.configId ?? 'legacy'}): batch ${resolved.batchSize} pieno, job ${job.id} rimandato`,
        );
        await job.moveToDelayed(windowStart + windowMs, token);
        throw new DelayedError();
      }
    }

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    const strategy = this.strategies.get(channel);
    if (!strategy) {
      throw new Error(`Nessuna strategy per channel ${channel}`);
    }

    // 1. Invio canale primario — l'esito NON condiziona più l'invio App IO
    let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
    let primaryError: Error | undefined;
    try {
      primaryResult = await strategy.send(recipient, campaign);
    } catch (err: any) {
      primaryError = err instanceof Error ? err : new Error(String(err));
    }

    const responsePayload: Record<string, any> = {
      ...(primaryResult?.responsePayload || {}),
      messageId: primaryResult?.messageId,
    };

    // 2. Invio App IO indipendente: parte se configurato, a prescindere dall'esito del canale primario.
    //    Eseguito SOLO al primo tentativo (job.attemptsMade === 0): se il canale primario fallisce e
    //    BullMQ ripete l'intero job, non vogliamo re-inviare la push App IO ad ogni retry (duplicati).
    let appIoLinkDelivered = false;
    const appIoConfig = campaign.channelConfig?.['appIo'] as any;
    if (job.attemptsMade === 0 && (channel === 'EMAIL' || channel === 'PEC') && appIoConfig?.apiKey) {
      const hasAppIo = await this.checkAppIoProfile(appIoConfig.baseUrl, appIoConfig.apiKey, recipient.codiceFiscale);

      if (hasAppIo) {
        try {
          this.logger.log(`Invio App IO indipendente per CF: ${recipient.codiceFiscale}`);
          const publicApiUrl = await this.settings.get<string>('system.publicUrl');
          const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
          const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
          const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
          const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

          const processedSubject = processTemplate(
            (campaign.channelConfig?.['subject'] as string) || campaign.name,
            recipient,
            publicApiUrl,
            downloadLinkSecret,
            expiresAtUnix,
          );
          const processedMarkdown = processTemplate(
            (campaign.channelConfig?.['body'] as string) || '',
            recipient,
            publicApiUrl,
            downloadLinkSecret,
            expiresAtUnix,
          );

          const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
            body: JSON.stringify({
              fiscal_code: recipient.codiceFiscale,
              content: { subject: processedSubject, markdown: processedMarkdown },
            }),
          });

          if (appIoRes.ok) {
            const appIoData = (await appIoRes.json()) as { id: string };
            responsePayload.appIo = { success: true, messageId: appIoData.id };
            appIoLinkDelivered = true;
            this.logger.log(`App IO delivery success: messageId=${appIoData.id}`);
          } else {
            responsePayload.appIo = { success: false, error: `App IO status: ${appIoRes.status}` };
            this.logger.warn(`App IO delivery failed with status ${appIoRes.status}`);
          }
        } catch (appIoErr: any) {
          responsePayload.appIo = { success: false, error: appIoErr.message };
          this.logger.error(`App IO delivery error: ${appIoErr.message}`);
        }
      }
    }

    // 3. Esito canale primario determina lo stato del tentativo/destinatario
    if (primaryError) {
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: primaryError.message,
        responsePayload,
      });
      // Anche se il canale primario fallisce, se App IO ha consegnato un link firmato valido
      // il cittadino può scaricare l'allegato: la sua vita deve essere limitata dalla retention,
      // quindi impostiamo comunque attachmentExpiresAt (altrimenti il cron non lo cancellerà mai).
      const failedUpdate: { status: RecipientStatus; attachmentExpiresAt?: Date } = {
        status: RecipientStatus.FAILED,
      };
      if (appIoLinkDelivered) {
        const retentionMaxDaysOnFail = await this.settings.get<number>('retention.maxDays');
        const retentionDaysOnFail = getEffectiveRetentionDays(campaign, retentionMaxDaysOnFail);
        failedUpdate.attachmentExpiresAt = new Date(Date.now() + retentionDaysOnFail * 86400 * 1000);
      }
      await this.recipientRepo.update(recipientId, failedUpdate);
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      throw primaryError;
    }

    const retentionMaxDaysForExpiry = await this.settings.get<number>('retention.maxDays');
    const retentionDaysForExpiry = getEffectiveRetentionDays(campaign, retentionMaxDaysForExpiry);
    const attachmentExpiresAt = new Date(Date.now() + retentionDaysForExpiry * 86400 * 1000);

    await this.attemptRepo.update(attemptId, {
      status: AttemptStatus.SUCCESS,
      sentAt: new Date(),
      responsePayload,
    });
    await this.recipientRepo.update(recipientId, {
      status: RecipientStatus.SENT,
      attachmentExpiresAt,
    });
    await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
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
