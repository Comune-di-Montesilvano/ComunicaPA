import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Not, IsNull, In, Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { OrphanReconciliationService } from '../queue/orphan-reconciliation.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { ENGINE_NAMES, type EngineName } from '../queue/notification-job.types.js';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity.js';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';

function isEngineName(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    private readonly orphanReconciliation: OrphanReconciliationService,
    private readonly postalStatusSync: PostalStatusSyncService,
    @InjectQueue(ENRICHMENT_QUEUE) private readonly enrichmentQueue: Queue,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines: Array<{
      channel: EngineName | 'INAD' | 'ENRICHMENT';
      queueName: string;
      paused: boolean;
      pausable: boolean;
      counts: Record<string, number>;
      lastFailedAt: string | null;
    }> = await Promise.all(
      ENGINE_NAMES.map(async (name) => {
        const [paused, counts, lastFailedAt] = await Promise.all([
          this.queues.isPaused(name),
          this.queues.getJobCounts(name),
          this.queues.getLastFailedAt(name),
        ]);
        return {
          channel: name,
          queueName: `notifications-${name.toLowerCase()}`,
          paused,
          pausable: true,
          counts,
          lastFailedAt,
        };
      }),
    );

    const [inadCheckingCampaigns, inadPendingRecipients, inadTotalCheckedRecipients] = await Promise.all([
      this.campaignRepo.count({ where: { status: CampaignStatus.CHECKING_INAD } }),
      this.recipientRepo.count({ where: { status: RecipientStatus.PENDING, campaign: { status: CampaignStatus.CHECKING_INAD } } }),
      this.recipientRepo.count({ where: { inadCheck: Not(IsNull()) } }),
    ]);

    engines.push({
      channel: 'INAD',
      queueName: 'inad-check-bulk',
      paused: false,
      pausable: false,
      counts: {
        active: inadPendingRecipients,
        completed: inadTotalCheckedRecipients,
        failed: 0,
        delayed: 0,
        waiting: inadCheckingCampaigns,
        paused: 0,
      },
      lastFailedAt: null,
    });

    const [enrichmentCounts, enrichmentFailedJobs] = await Promise.all([
      this.enrichmentQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.enrichmentQueue.getFailed(0, 0),
    ]);
    engines.push({
      channel: 'ENRICHMENT',
      queueName: ENRICHMENT_QUEUE,
      paused: false,
      pausable: false,
      counts: enrichmentCounts as Record<string, number>,
      lastFailedAt: enrichmentFailedJobs[0]?.finishedOn ? new Date(enrichmentFailedJobs[0].finishedOn).toISOString() : null,
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

  @Get('postal/queue-health')
  @Roles('admin', 'user')
  async postalQueueHealth() {
    return this.postalStatusSync.getQueueHealth();
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

  @Post(':channel/reconcile-orphans')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async reconcileOrphans(@Param('channel') channel: string) {
    const uc = channel.toUpperCase();
    if (!isEngineName(uc)) {
      throw new BadRequestException(`Motore ${channel} non supportato`);
    }
    const result = await this.orphanReconciliation.reconcileEngine(uc);
    return { channel: uc, ...result };
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
    // Nome campagna risolto qui (unico punto con accesso al repo Campaign,
    // NotificationQueuesService lavora solo su BullMQ) — batch su ID unici,
    // mai una query per job: prima il pannello mostrava solo l'UUID grezzo,
    // impossibile distinguere una campagna corrente da una di mesi fa senza
    // andare a cercarla a mano.
    const uniqueCampaignIds = [...new Set(jobs.map((j) => j.campaignId))];
    const campaigns = uniqueCampaignIds.length
      ? await this.campaignRepo.find({ where: { id: In(uniqueCampaignIds) }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(campaigns.map((c) => [c.id, c.name]));
    const jobsWithNames = jobs.map((j) => ({ ...j, campaignName: nameById.get(j.campaignId) ?? null }));
    return { channel: uc, status, jobs: jobsWithNames };
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
