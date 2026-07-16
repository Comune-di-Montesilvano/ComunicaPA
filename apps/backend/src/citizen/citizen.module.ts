import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';
import { AuthModule } from '../auth/auth.module';
import { AttachmentModule } from '../attachments/attachment.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SendLegalFactsModule } from '../channels/send/send-legal-facts.module';

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
