import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';

@Controller('admin/campaigns/:id/signature-verification')
@Roles('user', 'admin')
export class SignatureVerificationController {
  constructor(private readonly bulkService: SignatureVerificationBulkService) {}

  @Post()
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkService.startForCampaign(id);
  }

  @Get()
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const status = await this.bulkService.getLatestStatus(id);
    if (!status) throw new NotFoundException('Nessuna verifica firma avviata per questa campagna');
    return status;
  }
}
