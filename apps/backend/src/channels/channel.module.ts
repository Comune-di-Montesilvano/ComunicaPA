import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { PdfModule } from '../pdf/pdf.module';
import { PdndModule } from '../pdnd/pdnd.module';
import { ProtocolloModule } from '../protocollo/protocollo.module';
import { AttachmentModule } from '../attachments/attachment.module';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import type { IChannelStrategy } from './channel.interface';
import { CHANNEL_STRATEGIES } from './channel.interface';
import { EmailStrategy } from './email/email.strategy';
import { PecStrategy } from './pec/pec.strategy';
import { AppIoStrategy } from './app-io/app-io.strategy';
import { SendAttachmentUploadService } from './send/send-attachment-upload.service';
import { SendStatusSyncService } from './send/send-status-sync.service';
import { SendDispatchService } from './send/send-dispatch.service';
import { ProtocollazioneSyncService } from './protocollazione-sync.service';
import { PostalStrategy } from './postal/postal.strategy';

@Module({
  imports: [
    PdfModule,
    PdndModule,
    ProtocolloModule,
    AttachmentModule,
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
  ],
  providers: [
    EmailStrategy,
    PecStrategy,
    AppIoStrategy,
    PostalStrategy,
    SendAttachmentUploadService,
    SendStatusSyncService,
    SendDispatchService,
    ProtocollazioneSyncService,
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
  exports: [CHANNEL_STRATEGIES],
})
export class ChannelModule {}
