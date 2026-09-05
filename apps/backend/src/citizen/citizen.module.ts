import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { CitizenController } from './citizen.controller.js';
import { CitizenService } from './citizen.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AttachmentModule } from '../attachments/attachment.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { SendLegalFactsModule } from '../channels/send/send-legal-facts.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Recipient, Campaign, NotificationAttempt, DownloadEvent]),
    AuthModule,
    AttachmentModule,
    CampaignsModule,
    SendLegalFactsModule,
  ],
  controllers: [CitizenController],
  providers: [CitizenService],
  exports: [CitizenService],
})
export class CitizenModule {}
