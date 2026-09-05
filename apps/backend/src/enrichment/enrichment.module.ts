import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EnrichmentJob } from '../entities/enrichment-job.entity.js';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity.js';
import { EnrichmentService } from './enrichment.service.js';
import { EnrichmentController } from './enrichment.controller.js';
import { PdfExtractorClient } from './pdf-extractor.client.js';
import { EnrichmentProcessor } from './enrichment.processor.js';
import { EnrichmentRetentionService } from './enrichment-retention.service.js';
import { EnrichmentEventsService } from './enrichment-events.service.js';
import { EnrichmentResumeService } from './enrichment-resume.service.js';
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service.js';
import { ENRICHMENT_QUEUE } from './enrichment-job.types.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([EnrichmentJob, EnrichmentAddressOverride]),
    BullModule.registerQueue({ name: ENRICHMENT_QUEUE }),
    CampaignsModule,
  ],
  controllers: [EnrichmentController],
  providers: [
    EnrichmentService,
    PdfExtractorClient,
    EnrichmentProcessor,
    EnrichmentRetentionService,
    EnrichmentEventsService,
    EnrichmentResumeService,
    EnrichmentAddressOverrideService,
  ],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}
