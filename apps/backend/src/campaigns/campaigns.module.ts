import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignBulkRetryJob } from '../entities/campaign-bulk-retry-job.entity';
import { QueueModule } from '../queue/queue.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { InadModule } from '../channels/inad/inad.module';
import { RegistroImpreseModule } from '../channels/registro-imprese/registro-imprese.module';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module';
import { ChannelModule } from '../channels/channel.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { RetentionCleanupService } from './retention-cleanup.service';
import { InadCheckSyncService } from './inad-check-sync.service';
import { CampaignContentCorrectionService } from './campaign-content-correction.service';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service';
import { CampaignBulkRetryProcessor } from './campaign-bulk-retry.processor';
import { CAMPAIGN_BULK_RETRY_QUEUE } from './campaign-bulk-retry-job.types';

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
