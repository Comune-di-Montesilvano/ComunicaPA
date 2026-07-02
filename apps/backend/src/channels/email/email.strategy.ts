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
export class EmailStrategy implements IChannelStrategy {
  private readonly logger = new Logger(EmailStrategy.name);
  readonly channel: NotificationChannel = 'EMAIL';

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.email) {
      throw new Error('Recipient email address is missing');
    }

    const host = await this.settings.get<string>('smtp.host');
    const port = await this.settings.get<number>('smtp.port');
    const secure = await this.settings.get<boolean>('smtp.secure');
    const user = await this.settings.get<string>('smtp.user');
    const password = await this.settings.get<string>('smtp.password');
    const defaultFrom = await this.settings.get<string>('smtp.from');
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';

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
      to: recipient.email,
      subject,
      text: bodyText,
      html: bodyHtml,
    })) as any;

    this.logger.log(`Email successfully sent to ${recipient.email}: messageId=${info.messageId}`);

    return {
      messageId: info.messageId,
      responsePayload: {
        envelope: info.envelope,
        accepted: info.accepted,
      },
    };
  }
}
