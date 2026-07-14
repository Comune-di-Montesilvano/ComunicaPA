import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { QUEUED_CHANNELS } from '../queue/notification-job.types';
import type { NotificationChannel } from '@comunicapa/shared-types';

function isQueuedChannel(channel: NotificationChannel): channel is Exclude<NotificationChannel, 'SEND'> {
  return (QUEUED_CHANNELS as readonly NotificationChannel[]).includes(channel);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(private readonly queues: NotificationQueuesService) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines = await Promise.all(
      QUEUED_CHANNELS.map(async (channel) => {
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
    if (!isQueuedChannel(uc)) {
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
    if (!isQueuedChannel(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    await this.queues.resume(uc);
    return { success: true, channel: uc, paused: false };
  }

  @Get(':channel/jobs')
  @Roles('admin', 'user')
  async jobs(
    @Param('channel') channel: string,
    @Query('status') status = 'failed',
    @Query('limit') limit = '50',
  ) {
    const uc = channel.toUpperCase() as NotificationChannel;
    if (!isQueuedChannel(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    const allowedStatuses = ['failed', 'completed', 'active', 'waiting', 'delayed'] as const;
    if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
      throw new BadRequestException(`Status ${status} non supportato`);
    }
    const parsedLimit = parseInt(limit, 10);
    const jobs = await this.queues.getJobsDetail(
      uc,
      status as (typeof allowedStatuses)[number],
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    );
    return { channel: uc, status, jobs };
  }

  @Get(':channel/jobs/:jobId/logs')
  @Roles('admin', 'user')
  async jobLogs(@Param('channel') channel: string, @Param('jobId') jobId: string) {
    const uc = channel.toUpperCase() as NotificationChannel;
    if (!isQueuedChannel(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    const logs = await this.queues.getJobLogs(uc, jobId);
    return { channel: uc, jobId, logs };
  }
}
