import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { DomicilioService } from './domicilio.service';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto';

@Controller('admin/domicilio')
export class DomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Post('cerca')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    const result = await this.domicilioService.cercaDomicilio(cf, req.user.username);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'DOMICILIO_SEARCH',
      details: { codiceFiscale: cf },
    });
    return result;
  }
}
