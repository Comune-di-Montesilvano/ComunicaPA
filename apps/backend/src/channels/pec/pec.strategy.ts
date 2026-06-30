import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import * as nodemailer from 'nodemailer';
import type { AppConfiguration } from '../../config/configuration';
import { processTemplate, wrapInHtmlLayout } from '../template.helper';

@Injectable()
export class PecStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PecStrategy.name);
  readonly channel: NotificationChannel = 'PEC';

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.pec) {
      throw new Error('Recipient PEC address is missing');
    }

    const host = this.config.get('pec.host', { infer: true });
    const port = this.config.get('pec.port', { infer: true });
    const secure = this.config.get('pec.secure', { infer: true });
    const user = this.config.get('pec.user', { infer: true });
    const password = this.config.get('pec.password', { infer: true });
    const defaultFrom = this.config.get('pec.from', { infer: true });
    const citizenPortalUrl = this.config.get('origins.citizen', { infer: true });
    const brandName = this.config.get('brand.name', { infer: true }) || 'Comune di Montesilvano';

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica PEC ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica PEC.';

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, citizenPortalUrl);
    const bodyText = processTemplate(bodyTemplate, recipient, citizenPortalUrl);
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
