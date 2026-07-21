import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { ENGINE_NAMES, type EngineName } from '../queue/notification-job.types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';

function isEngineName(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
  ) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines = await Promise.all(
      ENGINE_NAMES.map(async (name) => {
        const [paused, counts] = await Promise.all([
          this.queues.isPaused(name),
          this.queues.getJobCounts(name),
        ]);
        return {
          channel: name,
          queueName: `notifications-${name.toLowerCase()}`,
          paused,
          counts,
        };
      }),
    );

    const [sendQueued, sendFailed, sendSuccess] = await Promise.all([
      this.attemptRepo.count({
        where: { channelType: 'SEND', status: AttemptStatus.QUEUED },
      }),
      this.attemptRepo.count({
        where: { channelType: 'SEND', status: AttemptStatus.FAILED },
      }),
      this.attemptRepo.count({
        where: { channelType: 'SEND', status: AttemptStatus.SUCCESS },
      }),
    ]);

    engines.push({
      channel: 'SEND',
      queueName: 'notifications-send',
      paused: false,
      counts: {
        active: 0,
        completed: sendSuccess,
        failed: sendFailed,
        delayed: 0,
        waiting: sendQueued,
        paused: 0,
      },
    });

    return { engines };
  }

  @Get('send/stage-counts')
  @Roles('admin', 'user')
  async sendStageCounts() {
    const [protocollato, inviato, fallito] = await Promise.all([
      this.attemptRepo.count({
        where: { channelType: 'SEND', status: AttemptStatus.QUEUED, protocolledAt: Not(IsNull()) },
      }),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.SUCCESS } }),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.FAILED } }),
    ]);
    return { protocollato, inviato, fallito };
  }

  @Post(':channel/pause')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async pause(@Param('channel') channel: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    await this.queues.pause(uc);
    return { success: true, channel: uc, paused: true };
  }

  @Post(':channel/resume')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('channel') channel: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
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
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
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
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    const logs = await this.queues.getJobLogs(uc, jobId);
    return { channel: uc, jobId, logs };
  }
}
