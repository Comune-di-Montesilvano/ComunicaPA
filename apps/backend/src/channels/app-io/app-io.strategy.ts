import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { IoServicesService } from '../../io-services/io-services.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { processTemplate } from '../template.helper';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
import { resolvePaymentData } from '../payment-config.util';

/** Endpoint ufficiale App IO (PagoPA). Non configurabile: cambia solo con una nuova release. */
export const APP_IO_BASE_URL = 'https://api.io.pagopa.it';

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  private readonly logger = new Logger(AppIoStrategy.name);
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(
    private readonly config: ConfigService,
    private readonly settings: AppSettingsService,
    private readonly ioServices: IoServicesService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, string>;
    const resolved = await this.ioServices.resolveApiKey(cfg['ioServiceId']);
    if (!resolved) {
      throw new Error('Nessun servizio App IO configurato (né specifico né predefinito)');
    }

    // 1. Verifica il profilo del cittadino su App IO
    log(`Verifica profilo App IO per CF ${recipient.codiceFiscale}`);
    const profileRes = await fetch(`${APP_IO_BASE_URL}/api/v1/profiles/${recipient.codiceFiscale}`, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': resolved.apiKey,
      },
    });
    log(`Risposta verifica profilo per CF ${recipient.codiceFiscale}: HTTP ${profileRes.status}`);

    if (!profileRes.ok) {
      if (profileRes.status === 404) {
        throw new Error('Cittadino non iscritto ad App IO');
      }
      const detail = await profileRes.text().catch(() => '');
      throw new Error(`Errore verifica profilo App IO: HTTP ${profileRes.status}${detail ? ` — ${detail}` : ''}`);
    }

    const profileData = (await profileRes.json()) as { sender_allowed: boolean };
    if (!profileData.sender_allowed) {
      throw new Error('Messaggi da questo servizio disabilitati dal cittadino su App IO');
    }

    // 2. Invio effettivo del messaggio (elaborando i template in formato markdown)
    const publicApiUrl = (await this.settings.get<string>('system.publicUrl')) || '';
    const downloadLinkSecret = this.config.get<string>('downloadLink.secret', { infer: true }) || '';
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

    const subjectTemplate = cfg['subject'] || campaign.name;
    const bodyTemplate = cfg['body'] || '';

    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'markdown', 'APP_IO');
    const markdown = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'markdown', 'APP_IO');

    const contentPayload: Record<string, any> = {
      subject,
      markdown,
    };

    const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    if (resolvedPayment?.noticeCode && resolvedPayment.amountCents != null) {
      const paymentData: Record<string, any> = {
        amount: resolvedPayment.amountCents,
        notice_number: resolvedPayment.noticeCode,
        invalid_after_due_date: true,
      };
      if (resolvedPayment.creditorTaxId) {
        paymentData.payee = { fiscal_code: resolvedPayment.creditorTaxId };
      }
      contentPayload.payment_data = paymentData;
    }
    if (resolvedPayment?.dueDateIso) {
      contentPayload.due_date = resolvedPayment.dueDateIso;
    }

    log(`Invio messaggio App IO a CF ${recipient.codiceFiscale} (subject="${subject}", markdown length=${markdown.length})`);
    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': resolved.apiKey,
      },
      body: JSON.stringify({
        fiscal_code: recipient.codiceFiscale,
        content: contentPayload,
      }),
    });
    log(`Risposta invio messaggio App IO per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`App IO API error: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    const data = (await response.json()) as { id: string };
    this.logger.log(`Messaggio App IO inviato a CF ${recipient.codiceFiscale}: messageId=${data.id}`);
    return { messageId: data.id, responsePayload: data as unknown as Record<string, unknown> };
  }
}
