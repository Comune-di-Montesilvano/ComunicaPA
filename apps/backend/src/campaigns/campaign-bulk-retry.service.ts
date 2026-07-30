import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Campaign } from '../entities/campaign.entity';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus } from '../entities/campaign-bulk-retry-job.entity';
import { CampaignsService } from './campaigns.service';
import { CAMPAIGN_BULK_RETRY_QUEUE, CampaignBulkRetryJobData } from './campaign-bulk-retry-job.types';

// Guard rail contro un'anomalia dati (mai più un limite legato al body della
// richiesta HTTP — il browser manda solo campaignId+errorMessage, l'elenco
// recipientId è risolto qui lato server via getFailedRecipientIdsByReason,
// mai trasmesso dal client). Margine ampio sopra la campagna PA più grande
// nota (TARI, ~20k destinatari).
const MAX_BULK_RETRY_JOB_SIZE = 100000;

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
    private readonly campaignsService: CampaignsService,
  ) {}

  async createJob(campaignId: string, errorMessage: string, createdBy: string): Promise<{ jobId: string; totalCount: number }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = await this.campaignsService.getFailedRecipientIdsByReason(campaignId, errorMessage);
    if (recipientIds.length === 0) {
      throw new BadRequestException(`Nessun destinatario FAILED trovato per il motivo "${errorMessage}"`);
    }
    if (recipientIds.length > MAX_BULK_RETRY_JOB_SIZE) {
      throw new BadRequestException(
        `Impossibile rimettere in coda più di ${MAX_BULK_RETRY_JOB_SIZE} destinatari in una sola richiesta (trovati: ${recipientIds.length}).`,
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

    return { jobId: saved.id, totalCount: recipientIds.length };
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
