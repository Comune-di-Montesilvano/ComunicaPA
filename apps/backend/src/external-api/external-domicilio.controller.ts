import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { DomicilioService } from '../channels/domicilio/domicilio.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto.js';

@Controller('external/v2/domicilio')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalDomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /** CF → INAD+App IO+ANPR; P.IVA (11 cifre) → Registro Imprese (smistamento in DomicilioService). */
  @Post('cerca')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioDto, @Req() req: RequestWithApiClient) {
    const taxId = dto.taxId.toUpperCase().trim();
    const operator = `external:${req.apiClient.name}`;
    const result = await this.domicilioService.cercaDomicilio(taxId, operator);
    await this.auditLogsService.log({ operator, action: 'EXTERNAL_DOMICILIO_SEARCH', details: { taxId: `***${taxId.slice(-4)}` } });
    return { success: true, ...result };
  }
}
