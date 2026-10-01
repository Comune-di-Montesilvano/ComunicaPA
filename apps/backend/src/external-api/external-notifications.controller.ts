import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';

@Controller('external/v2/notifications')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalNotificationsController {
  constructor(
    private readonly notifications: ExternalNotificationsService,
    private readonly status: ExternalNotificationStatusService,
  ) {}

  /**
   * `Record<string, unknown>` (metatype Object) è voluto: la ValidationPipe
   * globale lo salta e la validazione con path completo (`details[].field`)
   * la fa il service — vedi validate-body.util.ts.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() body: Record<string, unknown>, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: RequestWithApiClient) {
    return this.notifications.create(body, req.apiClient, idempotencyKey);
  }

  @Get(':notificationId')
  get(@Param('notificationId') notificationId: string, @Req() req: RequestWithApiClient) {
    return this.status.get(notificationId, req.apiClient.id);
  }
}
