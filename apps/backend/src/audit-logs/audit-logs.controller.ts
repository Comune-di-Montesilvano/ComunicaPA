import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AuditLogsService } from './audit-logs.service.js';

@Controller('admin/audit-logs')
@Roles('user', 'admin')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Req() req?: Request & { user: JwtOperatorPayload },
  ) {
    return this.auditLogsService.findAll({
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      search,
      // Registro completo solo per admin — un 'user' vede solo le proprie righe.
      operatorFilter: req?.user.role === 'admin' ? undefined : req?.user.username,
    });
  }
}
