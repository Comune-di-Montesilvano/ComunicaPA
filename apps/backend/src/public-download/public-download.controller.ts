import { Controller, ForbiddenException, Get, GoneException, Param, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AppConfiguration } from '../config/configuration';
import { Public } from '../auth/decorators/public.decorator';
import { Recipient } from '../entities/recipient.entity';
import { AttachmentService } from '../attachments/attachment.service';
import { verifyDownloadLink } from '../channels/download-link.util';

@Controller('public/download')
@Public()
export class PublicDownloadController {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly attachmentService: AttachmentService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @Get(':recipientId/:index')
  async download(
    @Param('recipientId') recipientId: string,
    @Param('index') indexParam: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    const index = parseInt(indexParam, 10);
    const expiresAtUnix = parseInt(exp, 10);
    const secret = this.config.get('downloadLink.secret', { infer: true });

    if (
      !Number.isFinite(index) ||
      index < 0 ||
      !Number.isFinite(expiresAtUnix) ||
      !verifyDownloadLink(recipientId, index, expiresAtUnix, sig, secret)
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

    await this.recipientRepo.update(recipientId, {
      downloadCount: recipient.downloadCount + 1,
      firstDownloadedAt: recipient.firstDownloadedAt ?? new Date(),
      lastDownloadedAt: new Date(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avviso_${recipientId.slice(0, 8)}_${index + 1}.pdf"`);
    res.end(pdfBuffer);
  }
}
