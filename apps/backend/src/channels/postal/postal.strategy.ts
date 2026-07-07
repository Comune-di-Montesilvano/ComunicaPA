import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { PdfService } from '../../pdf/pdf.service';

@Injectable()
export class PostalStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PostalStrategy.name);
  readonly channel: NotificationChannel = 'POSTAL';

  constructor(private readonly pdfService: PdfService) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, string>;
    const pdfTemplateId = cfg['pdfTemplateId'];

    if (!pdfTemplateId) {
      throw new BadRequestException('channelConfig.pdfTemplateId richiesto per canale POSTAL');
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const stamp = `TARI/${recipient.codiceFiscale}/${date}`;

    log(`Timbratura PDF per CF ${recipient.codiceFiscale} (template=${pdfTemplateId}, stamp="${stamp}")`);
    const stampedId = await this.pdfService.stampWithProtocol(pdfTemplateId, stamp);
    this.logger.log(`PDF timbrato per CF ${recipient.codiceFiscale}: stampedId=${stampedId}`);
    log(`PDF timbrato per CF ${recipient.codiceFiscale}: stampedId=${stampedId}`);

    return {
      messageId: stampedId,
      responsePayload: { stampedId },
    };
  }
}
