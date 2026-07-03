import { Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';

/** Endpoint ufficiale App IO (PagoPA). Non configurabile: cambia solo con una nuova release. */
export const APP_IO_BASE_URL = 'https://api.io.pagopa.it';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(private readonly settings: AppSettingsService) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const apiKey = await this.settings.get<string>('appIo.apiKey');

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const markdown = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      body: JSON.stringify({
        fiscal_code: recipient.codiceFiscale,
        content: { subject, markdown },
      }),
    });

    if (!response.ok) {
      throw new Error(`App IO API error: ${response.status}`);
    }

    const data = (await response.json()) as { id: string };
    return { messageId: data.id, responsePayload: data as unknown as Record<string, unknown> };
  }
}
