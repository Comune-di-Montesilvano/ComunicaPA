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
    if (paymentConfig && paymentConfig.enabled) {
      const rawAmount = getColumnValue(recipient, paymentConfig.amountColumn);
      const noticeNumber = getColumnValue(recipient, paymentConfig.noticeNumberColumn);

      let amountCents = 0;
      if (paymentConfig.amountType === 'cents') {
        amountCents = parseInt(rawAmount, 10) || 0;
      } else {
        const cleaned = (rawAmount || '').replace(',', '.');
        const parsed = parseFloat(cleaned) || 0;
        amountCents = Math.round(parsed * 100);
      }

      if (noticeNumber && amountCents > 0) {
        const paymentData: Record<string, any> = {
          amount: amountCents,
          notice_number: noticeNumber.replace(/\s+/g, ''),
          invalid_after_due_date: true,
        };

        let payeeFiscalCode = '';
        if (paymentConfig.payeeFiscalCodeType === 'static') {
          payeeFiscalCode = paymentConfig.payeeFiscalCodeStatic || '';
        } else if (paymentConfig.payeeFiscalCodeType === 'column') {
          payeeFiscalCode = getColumnValue(recipient, paymentConfig.payeeFiscalCodeColumn);
        }

        if (payeeFiscalCode) {
          paymentData.payee = {
            fiscal_code: payeeFiscalCode.toUpperCase().trim(),
          };
        }

        contentPayload.payment_data = paymentData;
      }

      if (paymentConfig.dueDateColumn) {
        const rawDate = getColumnValue(recipient, paymentConfig.dueDateColumn);
        const parsedDate = parseDateToIso(rawDate);
        if (parsedDate) {
          contentPayload.due_date = parsedDate;
        }
      }
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

function getColumnValue(recipient: Recipient, columnName?: string): string {
  if (!columnName) return '';
  const col = columnName.toLowerCase().trim();
  if (col === 'codice_fiscale' || col === 'cf') return recipient.codiceFiscale;
  if (col === 'full_name' || col === 'nome' || col === 'nominativo') return recipient.fullName || '';
  if (col === 'email') return recipient.email || '';
  if (col === 'pec') return recipient.pec || '';

  if (recipient.extraData) {
    for (const [key, val] of Object.entries(recipient.extraData)) {
      if (key.toLowerCase().trim() === col) {
        return String(val ?? '');
      }
    }
  }
  return '';
}

function parseDateToIso(dateStr?: string): string | null {
  if (!dateStr) return null;

  // Try parsing ISO format directly: YYYY-MM-DD
  let match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T23:59:59.000Z`;
  }

  // Try parsing DD/MM/YYYY
  match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}T23:59:59.000Z`;
  }

  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {}

  return null;
}
