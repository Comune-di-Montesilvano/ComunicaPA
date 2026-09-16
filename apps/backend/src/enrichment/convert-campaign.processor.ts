import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import { join } from 'path';
import { EnrichmentJob, CampaignConversionStatus } from '../entities/enrichment-job.entity.js';
import { CONVERT_CAMPAIGN_QUEUE, ConvertCampaignQueueJobData } from './enrichment-job.types.js';
import { getEnrichmentAttachmentsDir, getEnrichmentDir, getEnrichmentResultCsv } from './enrichment-paths.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';

/**
 * Coda dedicata (vedi CONVERT_CAMPAIGN_QUEUE in enrichment-job.types.ts) —
 * mai la stessa coda/worker di EnrichmentProcessor: questo lavoro legge solo
 * file già finalizzati di un job DONE, non deve aspettare un enrichment
 * pesante indipendente ancora in corso.
 */
@Injectable()
@Processor(CONVERT_CAMPAIGN_QUEUE)
export class ConvertCampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(ConvertCampaignProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly campaignsService: CampaignsService,
  ) {
    super();
  }

  async process(job: Job<ConvertCampaignQueueJobData>): Promise<void> {
    const { jobId, name, channelType, createdBy } = job.data;
    try {
      await this.jobRepo.update(jobId, { campaignConversionStatus: CampaignConversionStatus.PROCESSING });

      const campaign = await this.campaignsService.create(
        {
          name,
          channelType,
          channelConfig: { wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true, wizStep: 1 },
        },
        createdBy,
      );

      const uploadsDir = getUploadsDir(campaign.id);
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.copyFileSync(getEnrichmentResultCsv(jobId), join(uploadsDir, 'draft_recipients.csv'));

      // PDF già scompattati su disco da processEnrich (allegati/ piatta) —
      // nessun re-parsing di source.zip qui (già cancellato a fine
      // arricchimento riuscita, vedi processEnrich): un PDF assente da questa
      // cartella significa semplicemente che l'estrazione lo aveva già
      // segnalato come illeggibile in un warning, niente di nuovo da gestire.
      const attachmentsDir = getEnrichmentAttachmentsDir(jobId);
      if (fs.existsSync(attachmentsDir)) {
        for (const filename of fs.readdirSync(attachmentsDir)) {
          fs.copyFileSync(join(attachmentsDir, filename), join(uploadsDir, filename));
        }
      }

      await this.jobRepo.update(jobId, {
        campaignId: campaign.id,
        campaignConversionStatus: CampaignConversionStatus.DONE,
      });
      fs.rmSync(getEnrichmentDir(jobId), { recursive: true, force: true });
    } catch (err: any) {
      this.logger.error(`Conversione in campagna fallita per EnrichmentJob ${jobId}: ${err.message}`);
      await this.jobRepo.update(jobId, {
        campaignConversionStatus: CampaignConversionStatus.FAILED,
        campaignConversionError: err.message,
      });
    }
  }
}
