import { Controller, Get, Post, Param, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { ALL_CHANNELS } from '../queue/notification-job.types';
import type { NotificationChannel } from '@comunicapa/shared-types';

@Controller('engines')
export class EnginesController {
  constructor(private readonly queues: NotificationQueuesService) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines = await Promise.all(
      ALL_CHANNELS.map(async (channel) => {
        const [paused, counts] = await Promise.all([
          this.queues.isPaused(channel),
          this.queues.getJobCounts(channel),
        ]);
        return {
          channel,
          queueName: `notifications-${channel.toLowerCase()}`,
          paused,
          counts,
        };
      }),
    );
    return { engines };
  }

  @Post(':channel/pause')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async pause(@Param('channel') channel: string) {
    const uc = channel.toUpperCase() as NotificationChannel;
    if (!ALL_CHANNELS.includes(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    await this.queues.pause(uc);
    return { success: true, channel: uc, paused: true };
  }

  @Post(':channel/resume')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('channel') channel: string) {
    const uc = channel.toUpperCase() as NotificationChannel;
    if (!ALL_CHANNELS.includes(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    await this.queues.resume(uc);
    return { success: true, channel: uc, paused: false };
  }
}
