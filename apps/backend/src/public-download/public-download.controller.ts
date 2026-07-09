import { Controller, ForbiddenException, Get, GoneException, Logger, Param, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AppConfiguration } from '../config/configuration';
import { Public } from '../auth/decorators/public.decorator';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService } from '../attachments/attachment.service';
import { verifyDownloadLink } from '../channels/download-link.util';

@Controller('public/download')
@Public()
export class PublicDownloadController {
  private readonly logger = new Logger(PublicDownloadController.name);

  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly attachmentService: AttachmentService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @Get(':recipientId/:index')
  async download(
    @Param('recipientId') recipientId: string,
    @Param('index') indexParam: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('ch') channel: string | undefined,
    @Query('preview') previewParam: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const index = parseInt(indexParam, 10);
    const expiresAtUnix = parseInt(exp, 10);
    const secret = this.config.get('downloadLink.secret', { infer: true });
    // Il flag preview è protetto dalla firma HMAC (vedi download-link.util.ts):
    // non basta aggiungere ?preview=1 a un link reale, la verifica fallirebbe.
    const preview = previewParam === '1';

    if (
      !Number.isFinite(index) ||
      index < 0 ||
      !Number.isFinite(expiresAtUnix) ||
      !verifyDownloadLink(recipientId, index, expiresAtUnix, sig, secret, channel ?? '', preview)
    ) {
      throw new ForbiddenException('Link non valido');
    }
    if (Math.floor(Date.now() / 1000) > expiresAtUnix) {
      throw new GoneException('Link scaduto');
    }

    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId },
      relations: ['campaign'],
    });
    if (!recipient || recipient.attachmentDeletedAt) {
      throw new GoneException('Allegato non più disponibile');
    }

    const pdfBuffer = await this.attachmentService.generatePdfBuffer(recipient, index);

    // Anteprima backoffice (operatore che apre il link dal dettaglio notifica):
    // niente incremento contatori né DownloadEvent, il PDF viene comunque servito.
    if (!preview) {
      await this.recipientRepo.update(recipientId, {
        downloadCount: recipient.downloadCount + 1,
        firstDownloadedAt: recipient.firstDownloadedAt ?? new Date(),
        lastDownloadedAt: new Date(),
      });
      try {
        await this.downloadEventRepo.insert({
          recipientId,
          channel: channel || 'UNKNOWN',
          attachmentIndex: index,
        });
      } catch (err: any) {
        this.logger.warn(`Impossibile registrare DownloadEvent per recipient ${recipientId}: ${err?.message ?? err}`);
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="avviso_${recipientId.slice(0, 8)}_${index + 1}.pdf"`);
    res.end(pdfBuffer);
  }
}
