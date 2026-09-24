import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { NotificationsSearchService, POSTE_VERIFICATION_FILTERS, type PosteVerificationFilter } from './notifications-search.service.js';

@Controller('admin/notifications-search')
@Roles('user', 'admin')
export class NotificationsSearchController {
  constructor(private readonly svc: NotificationsSearchService) {}

  @Get()
  search(
    @Query('query') query?: string,
    @Query('codiceFiscale') codiceFiscale?: string,
    @Query('campaignId') campaignId?: string,
    @Query('channelType') channelType?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
    @Query('posteVerification') posteVerification?: string,
  ) {
    return this.svc.search({
      query,
      codiceFiscale,
      campaignId,
      channelType,
      status,
      dateFrom,
      dateTo,
      posteVerification: POSTE_VERIFICATION_FILTERS.includes(posteVerification as PosteVerificationFilter) ? (posteVerification as PosteVerificationFilter) : undefined,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50)),
    });
  }

  @Get(':recipientId')
  getDetail(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return this.svc.getDetail(recipientId);
  }

  @Get(':recipientId/send-legal-facts')
  getSendLegalFacts(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return this.svc.getSendLegalFacts(recipientId);
  }

  // legalFactId in query string, mai come path param: contiene "/" (es.
  // "safestorage://PN_LEGAL_FACTS-...") — anche URL-encoded (%2F), il
  // reverse proxy esterno di produzione rigetta gli slash codificati nel
  // path con un 404 proprio, mai raggiungendo questo controller (routing
  // Express/Nest locale gestisce %2F correttamente, verificato — non è un
  // bug qui). Stesso pattern già in uso in citizen.controller.ts
  // downloadSendDocument per lo stesso identico download.
  @Get(':recipientId/send-legal-facts/download')
  async downloadSendLegalFact(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Query('legalFactId') legalFactId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.svc.downloadSendLegalFact(recipientId, legalFactId);
    if (!result.ready) {
      res.status(200).json({ ready: false, retryAfterSeconds: result.retryAfterSeconds, error: result.error });
      return;
    }
    const isPdf = result.filename.toLowerCase().endsWith('.pdf');
    const contentType = isPdf ? 'application/pdf' : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
    res.end(result.buffer);
  }

  @Get(':recipientId/attachment/:index')
  async downloadAttachment(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.svc.downloadAttachment(recipientId, index);
    const isPdf = filename.toLowerCase().endsWith('.pdf');
    const contentType = isPdf ? 'application/pdf' : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.end(buffer);
  }
}
