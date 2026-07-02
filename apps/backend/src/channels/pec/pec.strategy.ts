import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import * as nodemailer from 'nodemailer';
import type { AppConfiguration } from '../../config/configuration';
import { processTemplate, wrapInHtmlLayout } from '../template.helper';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
import { AppSettingsService } from '../../settings/app-settings.service';

@Injectable()
export class PecStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PecStrategy.name);
  readonly channel: NotificationChannel = 'PEC';

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.pec) {
      throw new Error('Recipient PEC address is missing');
    }

    const host = await this.settings.get<string>('pec.host');
    const port = await this.settings.get<number>('pec.port');
    const secure = await this.settings.get<boolean>('pec.secure');
    const user = await this.settings.get<string>('pec.user');
    const password = await this.settings.get<string>('pec.password');
    const defaultFrom = await this.settings.get<string>('pec.from');
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = this.config.get('origins.publicApi', { infer: true });
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica PEC ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica PEC.';

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
    const bodyHtml = wrapInHtmlLayout(bodyText, brandName);

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password } : undefined,
      tls: {
        rejectUnauthorized: false,
      },
    });

    const info = (await transporter.sendMail({
      from: (campaign.channelConfig?.['from'] as string) || defaultFrom,
      to: recipient.pec,
      subject,
      text: bodyText,
      html: bodyHtml,
    })) as any;

    this.logger.log(`PEC successfully sent to ${recipient.pec}: messageId=${info.messageId}`);

    return {
      messageId: info.messageId,
      responsePayload: {
        envelope: info.envelope,
        accepted: info.accepted,
      },
    };
  }
}
