import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@comunicapa/shared-types';
import type { ChannelLogFn } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import type { AppConfiguration } from '../../config/configuration';
import { processTemplate, buildParallelChannelNotice, formatAppIoMarkdown, resolveCitizenPortalUrl } from '../template.helper';
import { resolveAttachmentsConfig, resolveAttachmentLabel } from '../../attachments/attachment.service';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
import { AppSettingsService } from '../../settings/app-settings.service';
import { resolvePaymentData } from '../payment-config.util';

@Injectable()
export class AppIoDeliveryService {
  private readonly logger = new Logger(AppIoDeliveryService.name);

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
  ) {}

  async checkProfile(
    baseUrl: string,
    apiKey: string,
    fiscalCode: string,
    onLog?: ChannelLogFn,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/v1/profiles/${fiscalCode}`, {
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      });
      if (!res.ok) {
        const detail = res.status === 404 ? '' : await res.text().catch(() => '');
        const msg = `Profilo App IO non disponibile per CF ${fiscalCode}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        this.logger.debug(msg);
        onLog?.(msg);
        return false;
      }
      const data = (await res.json()) as { sender_allowed: boolean };
      if (!data?.sender_allowed) {
        const msg = `Cittadino CF ${fiscalCode} ha disabilitato i messaggi da questo servizio App IO`;
        this.logger.debug(msg);
        onLog?.(msg);
      }
      return !!data?.sender_allowed;
    } catch (err: any) {
      const msg = `Verifica profilo App IO fallita per CF ${fiscalCode}: ${err?.message ?? err}`;
      this.logger.warn(msg);
      onLog?.(msg);
      return false;
    }
  }

  async sendMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
    onLog?: ChannelLogFn,
    parallelPrimaryChannel?: NotificationChannel,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const publicApiUrl = await this.settings.get<string>('system.publicUrl');
      const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
      const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
      const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
      const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => resolveAttachmentLabel(a, recipient));
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'APP_IO',
      );
      const rawMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'markdown', 'APP_IO',
      );

      const portalUrl = await resolveCitizenPortalUrl(this.settings);
      const parallelNotice = parallelPrimaryChannel
        ? buildParallelChannelNotice(recipient, parallelPrimaryChannel, campaign.channelConfig?.['physicalAddressConfig'] as Record<string, unknown> | undefined)
        : undefined;
      const processedMarkdown = formatAppIoMarkdown(rawMarkdown, { parallelNotice, portalUrl });

      const contentPayload: Record<string, any> = { subject: processedSubject, markdown: processedMarkdown };

      const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
      const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
      if (resolvedPayment?.noticeCode && resolvedPayment.amountCents != null) {
        const paymentData: Record<string, any> = {
          amount: resolvedPayment.amountCents,
          notice_number: resolvedPayment.noticeCode,
          invalid_after_due_date: true,
        };
        if (resolvedPayment.creditorTaxId) paymentData.payee = { fiscal_code: resolvedPayment.creditorTaxId };
        contentPayload.payment_data = paymentData;
      }
      if (resolvedPayment?.dueDateIso) contentPayload.due_date = resolvedPayment.dueDateIso;

      onLog?.(`Invio App IO (co-delivery) a CF ${recipient.codiceFiscale}: markdown length=${processedMarkdown.length}`);
      const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
        body: JSON.stringify({ fiscal_code: recipient.codiceFiscale, content: contentPayload }),
      });
      onLog?.(`Risposta App IO (co-delivery) per CF ${recipient.codiceFiscale}: HTTP ${appIoRes.status}`);

      if (!appIoRes.ok) {
        const detail = await appIoRes.text().catch(() => '');
        const error = `App IO status: ${appIoRes.status}${detail ? ` — ${detail}` : ''}`;
        onLog?.(error);
        return { success: false, error };
      }
      const appIoData = (await appIoRes.json()) as { id: string };
      return { success: true, messageId: appIoData.id };
    } catch (err: any) {
      onLog?.(`Eccezione invio App IO (co-delivery) per CF ${recipient.codiceFiscale}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
