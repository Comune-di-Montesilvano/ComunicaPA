import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { AuditLogsService } from '../../audit-logs/audit-logs.service.js';
import { SendIunLookupService } from './send-iun-lookup.service.js';
import type { SendLegalFactDownloadResult } from './send-legal-facts.service.js';
import { SendIunLookupQueryDto } from './dto/send-iun-lookup-query.dto.js';

/**
 * Ricerca IUN per protocollo e apertura di notifiche SEND inviate anche fuori
 * da ComunicaPA, con la apiKey PN dedicata. Senza chiave: tutto 404 e il
 * frontend nasconde la voce di menu (`status`).
 */
@Controller('admin/send-iun-lookup')
export class SendIunLookupController {
  constructor(
    private readonly service: SendIunLookupService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Get('status')
  @Roles('user', 'admin')
  async status() {
    return { enabled: await this.service.isEnabled() };
  }

  @Get()
  @Roles('user', 'admin')
  async lookup(@Query() dto: SendIunLookupQueryDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    if (!(await this.service.isEnabled())) throw new NotFoundException('Ricerca IUN non configurata');
    const result = await this.service.lookup(dto.protocollo, dto.token);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'SEND_IUN_LOOKUP',
      details: {
        paProtocolNumber: dto.protocollo.trim(),
        idempotenceToken: dto.token?.trim() || undefined,
        found: result.found,
        iun: result.found ? result.iun : undefined,
      },
    });
    return result;
  }

  @Get('notifications/:iun')
  @Roles('user', 'admin')
  async notification(@Param('iun') iun: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    const detail = await this.service.getNotification(iun);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'SEND_IUN_LOOKUP_VIEW',
      details: { iun, paProtocolNumber: detail.paProtocolNumber },
    });
    return detail;
  }

  // Atto notificato (la comunicazione originale): solo admin. Con la chiave di
  // ricerca si aprono anche notifiche di altri uffici; gli operatori vedono
  // percorso, AAR e attestazioni, non il contenuto dell'atto.
  @Get('notifications/:iun/documents/:docIdx')
  @Roles('admin')
  async notifiedDocument(
    @Param('iun') iun: string,
    @Param('docIdx', ParseIntPipe) docIdx: number,
    @Req() req: Request & { user: JwtOperatorPayload },
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.service.downloadNotifiedDocument(iun, docIdx);
    if (result.ready) {
      await this.auditLogsService.log({
        operator: req.user.username,
        action: 'SEND_IUN_LOOKUP_DOWNLOAD',
        details: { iun, docIdx },
      });
    }
    sendDownload(res, result);
  }

  // legalFactId in query string, mai nel path: contiene "/" e il reverse proxy
  // di produzione rifiuta gli slash codificati (vedi notifications-search).
  @Get('notifications/:iun/send-documents/download')
  @Roles('user', 'admin')
  async sendDocument(
    @Param('iun') iun: string,
    @Query('legalFactId') legalFactId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.service.downloadSendDocument(iun, legalFactId);
    if (result.ready) {
      await this.auditLogsService.log({
        operator: req.user.username,
        action: 'SEND_IUN_LOOKUP_DOWNLOAD',
        details: { iun, legalFactId },
      });
    }
    sendDownload(res, result);
  }
}

function sendDownload(res: Response, result: SendLegalFactDownloadResult): void {
  if (!result.ready) {
    res.status(200).json({ ready: false, retryAfterSeconds: result.retryAfterSeconds, error: result.error });
    return;
  }
  const isPdf = result.filename.toLowerCase().endsWith('.pdf');
  res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
  res.end(result.buffer);
}
