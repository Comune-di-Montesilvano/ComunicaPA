import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateExternalClientDto } from './dto/create-external-client.dto';

@Controller('admin/external-clients')
@Roles('admin')
export class AdminExternalClientsController {
  constructor(
    private readonly clientsService: ExternalApiClientsService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Get()
  list() {
    return this.clientsService.listMasked();
  }

  @Post()
  async create(@Body() dto: CreateExternalClientDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const result = await this.clientsService.generateKey(dto.name);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_CREATE',
      details: { clientId: result.client.id, name: dto.name },
    });
    return result;
  }

  @Post(':id/regenerate-key')
  async regenerateKey(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    const result = await this.clientsService.regenerateKey(id);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_REGENERATE_KEY',
      details: { clientId: id },
    });
    return result;
  }

  @Delete(':id')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    await this.clientsService.revoke(id);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_REVOKE',
      details: { clientId: id },
    });
    return { revoked: true };
  }
}
