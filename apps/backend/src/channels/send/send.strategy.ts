import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class SendStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'SEND';

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const apiKey = this.config.get('send.apiKey', { infer: true });
    const baseUrl = this.config.get('send.baseUrl', { infer: true });

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const notificationBody = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${baseUrl}/delivery/notifications/sent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        recipientTaxId: recipient.codiceFiscale,
        subject,
        notificationBody,
      }),
    });

    if (!response.ok) {
      throw new Error(`SEND API error: ${response.status}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    return {
      messageId: data.notificationRequestId,
      responsePayload: data as unknown as Record<string, unknown>,
    };
  }
}
