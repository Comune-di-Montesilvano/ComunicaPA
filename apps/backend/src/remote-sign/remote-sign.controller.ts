import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignCredentialsDto } from './dto/remote-sign-credentials.dto.js';

@Controller('admin')
export class RemoteSignController {
  constructor(private readonly service: RemoteSignService) {}

  @Get('remote-sign/config')
  @Roles('user', 'admin')
  async config(): Promise<{ enabled: boolean; otpDomain: string }> {
    return { enabled: await this.service.isEnabled(), otpDomain: await this.service.getOtpDomain() };
  }

  @Post('campaigns/:id/remote-sign')
  @HttpCode(200)
  @Roles('user', 'admin')
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoteSignCredentialsDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.service.start(id, { username: req.user.username, role: req.user.role }, dto);
  }

  // Nessun job = 200 con body vuoto (null), non 404: il modal lo chiede a
  // ogni apertura per riprendere una firma in corso, non è un errore.
  @Get('campaigns/:id/remote-sign')
  @Roles('user', 'admin')
  async status(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    await this.service.assertCanRead(id, { username: req.user.username, role: req.user.role });
    return (await this.service.getLatestStatus(id)) ?? null;
  }

  @Post('settings/remote-sign/test')
  @HttpCode(200)
  @Roles('admin')
  test(@Body() dto: RemoteSignCredentialsDto) {
    return this.service.testSign(dto);
  }
}
