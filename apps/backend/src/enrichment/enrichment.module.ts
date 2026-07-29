import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EnrichmentJob } from '../entities/enrichment-job.entity';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity';
import { EnrichmentService } from './enrichment.service';
import { EnrichmentController } from './enrichment.controller';
import { PdfExtractorClient } from './pdf-extractor.client';
import { EnrichmentProcessor } from './enrichment.processor';
import { EnrichmentRetentionService } from './enrichment-retention.service';
import { EnrichmentEventsService } from './enrichment-events.service';
import { EnrichmentResumeService } from './enrichment-resume.service';
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service';
import { ENRICHMENT_QUEUE } from './enrichment-job.types';
import { CampaignsModule } from '../campaigns/campaigns.module';

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
