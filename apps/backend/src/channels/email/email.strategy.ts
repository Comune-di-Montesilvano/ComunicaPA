import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import * as nodemailer from 'nodemailer';
import type { AppConfiguration } from '../../config/configuration';
import { processTemplate, wrapInHtmlLayout } from '../template.helper';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
import { AppSettingsService } from '../../settings/app-settings.service';
import { MailConfigsService } from '../../mail-configs/mail-configs.service';

@Injectable()
export class EmailStrategy implements IChannelStrategy {
  private readonly logger = new Logger(EmailStrategy.name);
  readonly channel: NotificationChannel = 'EMAIL';

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
    private readonly mailConfigs: MailConfigsService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.email) {
      throw new BadRequestException('Recipient non ha indirizzo email');
    }

    const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
    const smtp = await this.mailConfigs.resolveForSend('EMAIL', mailConfigId);
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const brandLogo = await this.settings.get<string>('brand.logo');
    const logoUrl = brandLogo
      ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`)
      : null;
    const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'EMAIL');
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'EMAIL');
    const bodyHtml = wrapInHtmlLayout(bodyText, brandName, { logoUrl, portalUrl });

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
