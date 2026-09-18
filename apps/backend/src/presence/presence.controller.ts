import { Controller, Get, Post, Req, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import { PresenceService } from './presence.service.js';

@Controller('admin/presence')
@Roles('admin', 'user')
export class PresenceController {
  constructor(
    private readonly presenceService: PresenceService,
    private readonly operatorDirectory: OperatorDirectoryService,
  ) {}

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

  @Get('online-users')
  @Roles('admin')
  async onlineUsers(): Promise<{ username: string; displayName: string }[]> {
    const usernames = this.presenceService.getOnlineUsernames();
    const displayNames = await this.operatorDirectory.resolveMany(usernames);
    return usernames.map((username) => ({
      username,
      displayName: displayNames[username] || username,
    }));
  }
}
