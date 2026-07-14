import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import type { AppConfiguration } from '../config/configuration';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE, THROTTLE_REDIS } from './notification-job.types';
import {
  EmailNotificationProcessor,
  PecNotificationProcessor,
  AppIoNotificationProcessor,
  PostalNotificationProcessor,
} from './channel-processors';
import { NotificationQueuesService } from './notification-queues.service';
import { ProtocollazioneProcessor } from './protocollazione.processor';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { ChannelModule } from '../channels/channel.module';
import { ProtocolloModule } from '../protocollo/protocollo.module';
import { AttachmentModule } from '../attachments/attachment.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => {
        const redisUrl = new URL(config.get('redis.url', { infer: true }));
        return {
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port) || 6379,
          },
        };
      },
    }),
    BullModule.registerQueue(
      ...Object.values(CHANNEL_QUEUES).map((name) => ({ name })),
      { name: PROTOCOLLAZIONE_QUEUE },
    ),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
    ProtocolloModule,
    AttachmentModule,
  ],
  providers: [
    EmailNotificationProcessor,
    PecNotificationProcessor,
    AppIoNotificationProcessor,
    PostalNotificationProcessor,
    ProtocollazioneProcessor,
    NotificationQueuesService,
    {
      provide: THROTTLE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) =>
        new Redis(config.get('redis.url', { infer: true }), { maxRetriesPerRequest: null }),
    },
  ],
  exports: [BullModule, NotificationQueuesService, THROTTLE_REDIS],
})
export class QueueModule {}
