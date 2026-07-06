import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, NotificationAttempt, DownloadEvent]), CampaignsModule],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
