import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../../../auth/decorators/roles.decorator.js';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { toPosteVerificationDto } from './poste-tracking-effective.util.js';

/**
 * Endpoint manuali verifica Poste, sotto lo stesso prefisso delle route
 * campagna ma in un controller proprio: nessuna dipendenza nuova su
 * CampaignsController (e sulle sue spec). Sola lettura esterna → tutti gli
 * operatori, come "Ricontrolla stato GlobalCom".
 */
@Controller('admin/campaigns')
@Roles('user', 'admin')
export class PosteTrackingController {
  constructor(private readonly svc: PostePostalTrackingService) {}

  @Post(':id/postal/poste-check')
  @HttpCode(202)
  startCampaignRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.startCampaignRun(id);
  }

  @Get(':id/postal/poste-check')
  getCampaignRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCampaignRun(id);
  }

  @Post(':id/recipients/:recipientId/postal/poste-check')
  @HttpCode(200)
  async checkRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    const { row, result } = await this.svc.checkRecipientNow(id, recipientId);
    // skipped: controllata con successo nelle ultime 23 ore, Poste non richiamato.
    return { ...toPosteVerificationDto(row), skipped: result === 'skipped' };
  }
}
