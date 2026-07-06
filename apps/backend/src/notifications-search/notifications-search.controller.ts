import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsSearchService } from './notifications-search.service';

@Controller('admin/notifications-search')
@Roles('user', 'admin')
export class NotificationsSearchController {
  constructor(private readonly svc: NotificationsSearchService) {}

  @Get()
  search(
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
}
