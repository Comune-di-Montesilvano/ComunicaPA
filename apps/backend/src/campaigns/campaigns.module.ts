import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { QueueModule } from '../queue/queue.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { RetentionCleanupService } from './retention-cleanup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, DownloadEvent]),
    QueueModule,
    AuditLogsModule,
  ],
  providers: [CampaignsService, RetentionCleanupService],
  controllers: [CampaignsController],
  exports: [CampaignsService],
})
export class CampaignsModule {}
