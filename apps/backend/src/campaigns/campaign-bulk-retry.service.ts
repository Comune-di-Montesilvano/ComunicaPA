import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Campaign } from '../entities/campaign.entity';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus } from '../entities/campaign-bulk-retry-job.entity';
import { CAMPAIGN_BULK_RETRY_QUEUE, CampaignBulkRetryJobData } from './campaign-bulk-retry-job.types';

// Guard rail contro input assurdi (es. selezione client rotta), non più il
// vincolo "operazione sincrona nella richiesta HTTP" — vedi CLAUDE.md,
// il job gira in background su CAMPAIGN_BULK_RETRY_QUEUE, nessun rischio
// timeout proxy/event-loop indipendentemente da quanti destinatari.
const MAX_BULK_RETRY_JOB_SIZE = 20000;

export interface BulkRetryStatus {
  status: CampaignBulkRetryJobStatus;
  totalCount: number;
  processedCount: number;
  requeuedCount: number;
  failed: Array<{ recipientId: string; reason: string }>;
  errorMessage: string | null;
}

@Injectable()
export class CampaignBulkRetryService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(CampaignBulkRetryJob)
    private readonly jobRepo: Repository<CampaignBulkRetryJob>,
    @InjectQueue(CAMPAIGN_BULK_RETRY_QUEUE)
    private readonly queue: Queue<CampaignBulkRetryJobData>,
  ) {}

  async createJob(campaignId: string, recipientIds: string[], createdBy: string): Promise<{ jobId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (recipientIds.length > MAX_BULK_RETRY_JOB_SIZE) {
      throw new BadRequestException(
        `Impossibile rimettere in coda più di ${MAX_BULK_RETRY_JOB_SIZE} destinatari in una sola richiesta (richiesti: ${recipientIds.length}).`,
      );
    }

    const job = this.jobRepo.create({
      campaignId,
      status: CampaignBulkRetryJobStatus.QUEUED,
      recipientIds,
      totalCount: recipientIds.length,
      processedCount: 0,
      requeuedCount: 0,
      failed: [],
      errorMessage: null,
      createdBy,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    await this.queue.add('retry', { jobId: saved.id }, { jobId: saved.id });

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<BulkRetryStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di rimessa in coda ${jobId} non trovato`);
    return {
      status: job.status,
      totalCount: job.totalCount,
      processedCount: job.processedCount,
      requeuedCount: job.requeuedCount,
      failed: job.failed,
      errorMessage: job.errorMessage,
    };
  }
}
