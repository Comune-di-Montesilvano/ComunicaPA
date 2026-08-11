import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreateExternalNotificationDto } from './dto/create-external-notification.dto';

@Controller('external/v1/notifications')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalNotificationsController {
  constructor(
    private readonly externalApiService: ExternalApiService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateExternalNotificationDto, @Req() req: RequestWithApiClient) {
    return this.externalApiService.createAndLaunch(dto, req.apiClient);
  }

  @Get(':campaignId')
  async getStatus(@Param('campaignId') campaignId: string, @Req() req: RequestWithApiClient) {
    const campaign = await this.campaignsService.findOne(campaignId).catch(() => null);
    // Stesso messaggio sia per "non esiste" sia per "non è tuo" — mai enumeration
    // (vedi design doc, gotcha già noto in altri endpoint di questo repo).
    if (!campaign || campaign.externalClientId !== req.apiClient.id) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } };
    }
    return { success: true, campaignId: campaign.id, status: campaign.status, channelType: campaign.channelType };
  }
}
