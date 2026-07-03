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
import { MailConfigsService } from '../../mail-configs/mail-configs.service';

@Injectable()
export class PecStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PecStrategy.name);
  readonly channel: NotificationChannel = 'PEC';

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
    private readonly mailConfigs: MailConfigsService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.pec) {
      throw new Error('Recipient PEC address is missing');
    }

    const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
    const smtp = await this.mailConfigs.resolveForSend('PEC', mailConfigId);
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
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
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.authEnabled && smtp.username
        ? { user: smtp.username, pass: smtp.password }
        : undefined,
      tls: {
        rejectUnauthorized: false,
      },
    });

    const info = (await transporter.sendMail({
      from: (campaign.channelConfig?.['from'] as string) || smtp.fromAddress,
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
