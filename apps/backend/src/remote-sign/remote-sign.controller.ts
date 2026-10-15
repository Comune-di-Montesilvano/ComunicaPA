import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
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

  @Get('campaigns/:id/remote-sign')
  @Roles('user', 'admin')
  async status(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    await this.service.assertCanRead(id, { username: req.user.username, role: req.user.role });
    const status = await this.service.getLatestStatus(id);
    if (!status) throw new NotFoundException('Nessuna firma remota avviata per questa campagna');
    return status;
  }

  @Post('settings/remote-sign/test')
  @HttpCode(200)
  @Roles('admin')
  test(@Body() dto: RemoteSignCredentialsDto) {
    return this.service.testSign(dto);
  }
}
