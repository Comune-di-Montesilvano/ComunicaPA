import { Inject, Logger, Injectable } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import Redis from 'ioredis';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { THROTTLE_REDIS } from './notification-job.types';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { processTemplate } from '../channels/template.helper';
import { resolveAttachmentsConfig } from '../attachments/attachment.service';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
import { AppSettingsService } from '../settings/app-settings.service';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';

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
    private readonly ioServices: IoServicesService,
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

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig);
    const isMailChannel = channel === 'EMAIL' || channel === 'PEC';
    // Risolve la api key del servizio App IO scelto (o quello predefinito) solo se serve:
    // niente più api key in chiaro dentro channelConfig (cifrata lato server per servizio).
    const appIoResolved = appIoConfig && isMailChannel
      ? await this.ioServices.resolveApiKey(appIoConfig.ioServiceId)
      : null;
    if (appIoConfig && isMailChannel && !appIoResolved) {
      this.logger.warn(
        `Co-delivery App IO configurata per la campagna ${campaignId} (ioServiceId="${appIoConfig.ioServiceId ?? ''}") ma resolveApiKey non ha trovato un servizio valido con api key primaria impostata: App IO NON verrà tentato per il destinatario ${recipientId}. Verifica che il servizio esista e abbia un'api key configurata in Impostazioni → App IO.`,
      );
    }
    // Retrocompat: config appIo presente senza mode = parallel
    const appIoMode: 'none' | 'parallel' | 'exclusive' =
      appIoResolved ? (appIoConfig!.mode ?? 'parallel') : 'none';

    const responsePayload: Record<string, any> = {};
    let appIoLinkDelivered = false;
    let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
    let primaryError: Error | undefined;
    let skipPrimary = false;

    // Modalità ESCLUSIVA: se il destinatario ha App IO, si invia SOLO lì.
    if (appIoMode === 'exclusive' && isMailChannel && job.attemptsMade === 0) {
      const hasAppIo = await this.checkAppIoProfile(
        APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale,
      );
      if (hasAppIo) {
        const appIoResult = await this.sendAppIoMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        });
        responsePayload.appIo = appIoResult;
        if (appIoResult.success) {
          skipPrimary = true;
          appIoLinkDelivered = true;
          responsePayload.messageId = appIoResult.messageId;
          responsePayload.deliveredVia = 'APP_IO';
          this.logger.log(`Consegna esclusiva App IO per CF ${recipient.codiceFiscale}: canale ${channel} saltato`);
        }
        // App IO fallita ⇒ si prosegue col canale primario (fallback)
      }
    }

    // 1. Invio canale primario (saltato solo in esclusiva riuscita)
    if (!skipPrimary) {
      try {
        primaryResult = await strategy.send(recipient, campaign);
      } catch (err: any) {
        primaryError = err instanceof Error ? err : new Error(String(err));
      }
      Object.assign(responsePayload, primaryResult?.responsePayload || {});
      responsePayload.messageId = primaryResult?.messageId;

      // 2. Co-delivery PARALLELA (comportamento attuale, solo primo tentativo)
      if (appIoMode === 'parallel' && isMailChannel && job.attemptsMade === 0) {
        const hasAppIo = await this.checkAppIoProfile(
          APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale,
        );
        if (hasAppIo) {
          this.logger.log(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
          const appIoResult = await this.sendAppIoMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        });
          responsePayload.appIo = appIoResult;
          if (appIoResult.success) appIoLinkDelivered = true;
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
      await this.checkAndCompleteCampaign(campaignId);
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
    await this.checkAndCompleteCampaign(campaignId);
  }

  /**
   * Se non restano destinatari PENDING/QUEUED per la campagna, la marca
   * COMPLETED. Chiamato dopo ogni esito (successo o fallimento) del canale
   * primario: è l'unico punto che porta una campagna fuori da QUEUED, che
   * altrimenti resterebbe tale per sempre anche a invio terminato.
   */
  private async checkAndCompleteCampaign(campaignId: string): Promise<void> {
    const remaining = await this.recipientRepo.count({
      where: { campaignId, status: In([RecipientStatus.PENDING, RecipientStatus.QUEUED]) },
    });
    if (remaining > 0) return;

    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.COMPLETED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();
  }

  private async checkAppIoProfile(
    baseUrl: string,
    apiKey: string,
    fiscalCode: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/v1/profiles/${fiscalCode}`, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
        },
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { sender_allowed: boolean };
      return !!data?.sender_allowed;
    } catch {
      return false;
    }
  }

  private async sendAppIoMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const publicApiUrl = await this.settings.get<string>('system.publicUrl');
      const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
      const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
      const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
      const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
      );
      const processedMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
      );

      const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
        body: JSON.stringify({
          fiscal_code: recipient.codiceFiscale,
          content: { subject: processedSubject, markdown: processedMarkdown },
        }),
      });

      if (!appIoRes.ok) {
        return { success: false, error: `App IO status: ${appIoRes.status}` };
      }
      const appIoData = (await appIoRes.json()) as { id: string };
      return { success: true, messageId: appIoData.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

