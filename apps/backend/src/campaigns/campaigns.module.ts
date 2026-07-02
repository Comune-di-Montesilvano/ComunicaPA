import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { QueueModule } from '../queue/queue.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { RetentionCleanupService } from './retention-cleanup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt]),
    QueueModule,
  ],
  providers: [CampaignsService, RetentionCleanupService],
  controllers: [CampaignsController],
})
export class CampaignsModule {}
