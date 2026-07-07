import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { IoServicesService } from '../../io-services/io-services.service';

/** Endpoint ufficiale App IO (PagoPA). Non configurabile: cambia solo con una nuova release. */
export const APP_IO_BASE_URL = 'https://api.io.pagopa.it';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  private readonly logger = new Logger(AppIoStrategy.name);
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(private readonly ioServices: IoServicesService) {}

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

    // 2. Invio effettivo del messaggio
    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const markdown = interpolate(cfg['body'] ?? '', vars);

    log(`Invio messaggio App IO a CF ${recipient.codiceFiscale} (subject="${subject}", markdown length=${markdown.length})`);
    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': resolved.apiKey,
      },
      body: JSON.stringify({
        fiscal_code: recipient.codiceFiscale,
        content: { subject, markdown },
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
