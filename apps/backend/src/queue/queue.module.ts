import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import type { AppConfiguration } from '../config/configuration.js';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE, THROTTLE_REDIS } from './notification-job.types.js';
import {
  EmailNotificationProcessor,
  PecNotificationProcessor,
  AppIoNotificationProcessor,
  PostalNotificationProcessor,
} from './channel-processors.js';
import { NotificationQueuesService } from './notification-queues.service.js';
import { ProtocollazioneProcessor } from './protocollazione.processor.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { ChannelModule } from '../channels/channel.module.js';
import { ProtocolloModule } from '../protocollo/protocollo.module.js';
import { AttachmentModule } from '../attachments/attachment.module.js';

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
