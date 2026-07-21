import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DomicilioService } from './domicilio.service';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto';

@Controller('admin/domicilio')
export class DomicilioController {
  constructor(private readonly domicilioService: DomicilioService) {}

  @Post('cerca')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  cerca(@Body() dto: CercaDomicilioDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    return this.domicilioService.cercaDomicilio(cf, req.user.username);
  }
}
