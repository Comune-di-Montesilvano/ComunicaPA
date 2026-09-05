import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { CampaignBulkRetryJob } from '../entities/campaign-bulk-retry-job.entity.js';
import { QueueModule } from '../queue/queue.module.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { InadModule } from '../channels/inad/inad.module.js';
import { RegistroImpreseModule } from '../channels/registro-imprese/registro-imprese.module.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { ChannelModule } from '../channels/channel.module.js';
import { CampaignsService } from './campaigns.service.js';
import { CampaignsController } from './campaigns.controller.js';
import { RetentionCleanupService } from './retention-cleanup.service.js';
import { InadCheckSyncService } from './inad-check-sync.service.js';
import { CampaignContentCorrectionService } from './campaign-content-correction.service.js';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service.js';
import { CampaignBulkRetryProcessor } from './campaign-bulk-retry.processor.js';
import { CAMPAIGN_BULK_RETRY_QUEUE } from './campaign-bulk-retry-job.types.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, DownloadEvent, CampaignBulkRetryJob]),
    QueueModule,
    AuditLogsModule,
    InadModule,
    RegistroImpreseModule,
    OperatorDirectoryModule,
    ChannelModule,
    BullModule.registerQueue({ name: CAMPAIGN_BULK_RETRY_QUEUE }),
  ],
  providers: [
    CampaignsService,
    RetentionCleanupService,
    InadCheckSyncService,
    CampaignContentCorrectionService,
    CampaignBulkRetryService,
    CampaignBulkRetryProcessor,
  ],
  controllers: [CampaignsController],
  exports: [CampaignsService],
})
export class CampaignsModule {}
