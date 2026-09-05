import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { SendLegalFactsModule } from '../channels/send/send-legal-facts.module.js';
import { AttachmentModule } from '../attachments/attachment.module.js';
import { NotificationsSearchService } from './notifications-search.service.js';
import { NotificationsSearchController } from './notifications-search.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, NotificationAttempt, DownloadEvent]), CampaignsModule, SendLegalFactsModule, AttachmentModule],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
