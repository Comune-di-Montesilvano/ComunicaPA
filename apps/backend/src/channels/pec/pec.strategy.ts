import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class PecStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'PEC';

  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {
    this.transporter = nodemailer.createTransport({
      host: config.get('pec.host', { infer: true }),
      port: config.get('pec.port', { infer: true }),
      secure: config.get('pec.secure', { infer: true }),
      auth: {
        user: config.get('pec.user', { infer: true }),
        pass: config.get('pec.password', { infer: true }),
      },
    });
  }

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.pec) {
      throw new BadRequestException('Recipient non ha indirizzo PEC');
    }

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };

    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const body = interpolate(cfg['body'] ?? '', vars);

    const info = await this.transporter.sendMail({
      from: this.config.get('pec.from', { infer: true }),
      to: recipient.pec,
      subject,
      text: body,
    });

    return {
      messageId: String(info.messageId ?? ''),
      responsePayload: { accepted: info.accepted },
    };
  }
}
