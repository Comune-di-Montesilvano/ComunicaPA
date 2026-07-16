import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsSearchService } from './notifications-search.service';

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
  ) {
    return this.svc.search({
      query,
      codiceFiscale,
      campaignId,
      channelType,
      status,
      dateFrom,
      dateTo,
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

  @Get(':recipientId/send-legal-facts/:legalFactId/download')
  async downloadSendLegalFact(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Param('legalFactId') legalFactId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.svc.downloadSendLegalFact(recipientId, legalFactId);
    if (!result.ready) {
      res.status(200).json({ ready: false, retryAfterSeconds: result.retryAfterSeconds, error: result.error });
      return;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
    res.end(result.buffer);
  }
}
