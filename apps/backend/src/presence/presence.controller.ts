import { Controller, Get, Post, Req, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PresenceService } from './presence.service.js';

@Controller('admin/presence')
@Roles('admin', 'user')
export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Req() req: Request & { user: JwtOperatorPayload }): { success: true } {
    this.presenceService.heartbeat(req.user.username);
    return { success: true };
  }

  @Get('online')
  online(): { count: number } {
    return { count: this.presenceService.getOnlineCount() };
  }
}
