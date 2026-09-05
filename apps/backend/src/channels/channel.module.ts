import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { PdndModule } from '../pdnd/pdnd.module.js';
import { ProtocolloModule } from '../protocollo/protocollo.module.js';
import { AttachmentModule } from '../attachments/attachment.module.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import type { IChannelStrategy } from './channel.interface.js';
import { CHANNEL_STRATEGIES } from './channel.interface.js';
import { EmailStrategy } from './email/email.strategy.js';
import { PecStrategy } from './pec/pec.strategy.js';
import { AppIoStrategy } from './app-io/app-io.strategy.js';
import { SendAttachmentUploadService } from './send/send-attachment-upload.service.js';
import { SendStatusSyncService } from './send/send-status-sync.service.js';
import { SendBaseFeeService } from './send/send-base-fee.service.js';
import { SendDispatchService } from './send/send-dispatch.service.js';
import { PostalStrategy } from './postal/postal.strategy.js';
import { GlobalComClientModule } from './postal/globalcom-client.module.js';
import { PostalStatusSyncService } from './postal/postal-status-sync.service.js';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service.js';
import { AppIoDeliveryService } from './app-io/app-io-delivery.service.js';

@Module({
  imports: [
    PdndModule,
    ProtocolloModule,
    AttachmentModule,
    GlobalComClientModule,
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
  ],
  providers: [
    EmailStrategy,
    PecStrategy,
    AppIoStrategy,
    PostalStrategy,
    SendAttachmentUploadService,
    SendStatusSyncService,
    SendBaseFeeService,
    SendDispatchService,
    PostalStatusSyncService,
    CampaignCompletionService,
    AppIoDeliveryService,
    {
      provide: CHANNEL_STRATEGIES,
      useFactory: (
        email: EmailStrategy,
        pec: PecStrategy,
        appIo: AppIoStrategy,
        postal: PostalStrategy,
      ): Map<NotificationChannel, IChannelStrategy> => {
        const map = new Map<NotificationChannel, IChannelStrategy>();
        for (const s of [email, pec, appIo, postal]) {
          map.set(s.channel, s);
        }
        return map;
      },
      inject: [EmailStrategy, PecStrategy, AppIoStrategy, PostalStrategy],
    },
  ],
  exports: [CHANNEL_STRATEGIES, CampaignCompletionService, AppIoDeliveryService, PostalStatusSyncService],
})
export class ChannelModule {}
