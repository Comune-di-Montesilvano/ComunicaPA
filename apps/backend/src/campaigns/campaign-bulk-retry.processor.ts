import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CampaignBulkRetryJob, CampaignBulkRetryJobStatus, CampaignBulkRetryFailure } from '../entities/campaign-bulk-retry-job.entity';
import { CampaignsService } from './campaigns.service';
import { CAMPAIGN_BULK_RETRY_QUEUE, CampaignBulkRetryJobData } from './campaign-bulk-retry-job.types';

const PROGRESS_UPDATE_EVERY = 50;
// Solo lavoro DB + queue.add() per destinatario (nessuna chiamata HTTP
// esterna, a differenza di CampaignContentCorrectionService/App IO) —
// concorrenza più alta sicura, vedi CLAUDE.md sezione bulk/reverse proxy.
const CONCURRENCY = 10;

@Injectable()
@Processor(CAMPAIGN_BULK_RETRY_QUEUE)
export class CampaignBulkRetryProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignBulkRetryProcessor.name);

  constructor(
    @InjectRepository(CampaignBulkRetryJob)
    private readonly jobRepo: Repository<CampaignBulkRetryJob>,
    private readonly campaignsService: CampaignsService,
  ) {
    super();
  }

  async process(job: Job<CampaignBulkRetryJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`CampaignBulkRetryJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    await this.jobRepo.update(jobId, { status: CampaignBulkRetryJobStatus.PROCESSING });

    try {
      const failed: CampaignBulkRetryFailure[] = [];
      let requeued = 0;
      let processed = 0;

      const runOne = async (recipientId: string) => {
        try {
          await this.campaignsService.retryRecipient(record.campaignId, recipientId);
          requeued += 1;
        } catch (e) {
          failed.push({ recipientId, reason: e instanceof Error ? e.message : 'Errore sconosciuto' });
        }
        processed += 1;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedCount: processed, requeuedCount: requeued, failed });
        }
      };

      for (let i = 0; i < record.recipientIds.length; i += CONCURRENCY) {
        const batch = record.recipientIds.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(runOne));
      }

      await this.jobRepo.update(jobId, {
        status: CampaignBulkRetryJobStatus.DONE,
        processedCount: processed,
        requeuedCount: requeued,
        failed,
        completedAt: new Date(),
      });
      this.logger.log(`CampaignBulkRetryJob ${jobId} completato: ${requeued} rimessi in coda, ${failed.length} falliti`);
    } catch (err: any) {
      this.logger.error(`CampaignBulkRetryJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: CampaignBulkRetryJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }
  }
}
