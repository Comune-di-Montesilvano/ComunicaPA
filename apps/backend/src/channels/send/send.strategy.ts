import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from './pdnd-auth.service';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class SendStrategy implements IChannelStrategy {
  private readonly logger = new Logger(SendStrategy.name);
  readonly channel: NotificationChannel = 'SEND';

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const baseUrl = await this.settings.get<string>(`${prefix}.baseUrl` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey);

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const notificationBody = interpolate(cfg['body'] ?? '', vars);

    log(`Invio notifica SEND a CF ${recipient.codiceFiscale} via ${baseUrl} (subject="${subject}")`);
    // TODO: endpoint e payload reali sono /delivery/v2.6/requests con schema
    // multipart (allegati via preload) — questo resta un placeholder in attesa
    // dell'implementazione del payload notifica completo.
    const response = await fetch(`${baseUrl}/delivery/notifications/sent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voucher}`,
      },
      body: JSON.stringify({
        recipientTaxId: recipient.codiceFiscale,
        subject,
        notificationBody,
      }),
    });
    log(`Risposta SEND per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      throw new Error(`SEND API error: ${response.status}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND inviata a CF ${recipient.codiceFiscale}: messageId=${data.notificationRequestId}`);
    return {
      messageId: data.notificationRequestId,
      responsePayload: data as unknown as Record<string, unknown>,
    };
  }
}
