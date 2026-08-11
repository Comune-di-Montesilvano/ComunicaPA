import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { DomicilioService } from '../channels/domicilio/domicilio.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CercaDomicilioExternalDto } from './dto/cerca-domicilio-external.dto';

@Controller('external/v1/domicilio')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalDomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Post('cerca')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioExternalDto, @Req() req: RequestWithApiClient) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    const operatorLabel = `external:${req.apiClient.name}`;
    const result = await this.domicilioService.cercaDomicilio(cf, operatorLabel);
    await this.auditLogsService.log({
      operator: operatorLabel,
      action: 'EXTERNAL_DOMICILIO_SEARCH',
      details: { codiceFiscale: cf },
    });
    return { success: true, ...result };
  }
}
