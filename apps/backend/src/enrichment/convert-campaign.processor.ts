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
import { buildEnrichedCsv, parseEnrichedCsv, type EnrichedRow } from './enriched-csv.util.js';

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
    const { jobId, name, channelType, createdBy, splitMissingPayment } = job.data;
    try {
      await this.jobRepo.update(jobId, { campaignConversionStatus: CampaignConversionStatus.PROCESSING });

      const attachmentsDir = getEnrichmentAttachmentsDir(jobId);
      const { headers, rows } = parseEnrichedCsv(fs.readFileSync(getEnrichmentResultCsv(jobId), 'utf-8'));
      let campaignId: string;
      let secondaryCampaignId: string | null = null;

      if (splitMissingPayment) {
        // Stessa regola di enrichment.processor.ts (missingPaymentCount): un
        // PagoPa non esiste mai "a metà" — numero_avviso/importo/scadenza sono
        // sempre valorizzate insieme o mai.
        const withPayment = rows.filter((r) => r.numero_avviso || r.importo || r.scadenza);
        const withoutPayment = rows.filter((r) => !r.numero_avviso && !r.importo && !r.scadenza);

        if (withPayment.length > 0 && withoutPayment.length > 0) {
          campaignId = await this.createDraftCampaign(`${name} — PagoPa`, channelType, createdBy, headers, withPayment, attachmentsDir);
          secondaryCampaignId = await this.createDraftCampaign(`${name} — Senza PagoPa`, channelType, createdBy, headers, withoutPayment, attachmentsDir);
        } else {
          // Una delle due partizioni è vuota (tutti o nessuno hanno PagoPa):
          // niente da separare, stesso comportamento di sempre.
          campaignId = await this.createDraftCampaign(name, channelType, createdBy, headers, rows, attachmentsDir);
        }
      } else {
        campaignId = await this.createDraftCampaign(name, channelType, createdBy, headers, rows, attachmentsDir);
      }

      await this.jobRepo.update(jobId, {
        campaignId,
        secondaryCampaignId,
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

  /**
   * Scrive un CSV con la sola partizione di righe passata (l'intero set nel
   * percorso senza split) e copia solo gli allegati referenziati da quelle
   * righe (colonna `allegato`) — mai l'intera cartella: nel percorso split
   * eviterebbe di duplicare su disco i PDF dell'altra partizione.
   */
  private async createDraftCampaign(
    name: string,
    channelType: ConvertCampaignQueueJobData['channelType'],
    createdBy: string,
    headers: string[],
    rows: EnrichedRow[],
    attachmentsDir: string,
  ): Promise<string> {
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
    fs.writeFileSync(join(uploadsDir, 'draft_recipients.csv'), buildEnrichedCsv(headers, rows), 'utf-8');

    const wantedFilenames = new Set(rows.map((r) => r.allegato).filter((f): f is string => !!f));
    if (fs.existsSync(attachmentsDir)) {
      for (const filename of fs.readdirSync(attachmentsDir)) {
        if (wantedFilenames.has(filename)) {
          fs.copyFileSync(join(attachmentsDir, filename), join(uploadsDir, filename));
        }
      }
    }

    return campaign.id;
  }
}
