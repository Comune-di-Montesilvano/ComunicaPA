import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EnrichmentJob } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';
import { PdfExtractorClient } from './pdf-extractor.client';
import { EnrichmentProcessor } from './enrichment.processor';
import { ENRICHMENT_QUEUE } from './enrichment-job.types';

@Module({
  imports: [
    TypeOrmModule.forFeature([EnrichmentJob]),
    BullModule.registerQueue({ name: ENRICHMENT_QUEUE }),
  ],
  providers: [EnrichmentService, PdfExtractorClient, EnrichmentProcessor],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}
