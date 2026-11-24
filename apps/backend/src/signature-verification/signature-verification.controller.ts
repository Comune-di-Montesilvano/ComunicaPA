import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';

@Controller('admin/campaigns/:id/signature-verification')
@Roles('user', 'admin')
export class SignatureVerificationController {
  constructor(
    private readonly bulkService: SignatureVerificationBulkService,
    private readonly settings: AppSettingsService,
  ) {}

  @Post()
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkService.startForCampaign(id);
  }

  @Get()
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const status = await this.bulkService.getLatestStatus(id);
    if (!status) throw new NotFoundException('Nessuna verifica firma avviata per questa campagna');
    // `required`: obbligo di firma attivo (Impostazioni → SEND), il wizard non propone di procedere comunque.
    const required = (await this.settings.get<boolean>('send.requireSignedAttachments')) === true;
    // Quali file non passano: senza, l'operatore vede solo un conteggio di destinatari.
    const invalid = status.status === SignatureVerificationJobStatus.DONE && status.invalidCount > 0
      ? await this.bulkService.getInvalidFiles(id)
      : { items: [], total: 0 };
    return { ...status, required, invalidFiles: invalid.items, invalidFilesTotal: invalid.total };
  }
}
