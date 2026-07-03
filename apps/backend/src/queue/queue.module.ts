import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfiguration } from '../config/configuration';
import { CHANNEL_QUEUES } from './notification-job.types';
import {
  EmailNotificationProcessor,
  PecNotificationProcessor,
  AppIoNotificationProcessor,
  SendNotificationProcessor,
  PostalNotificationProcessor,
} from './channel-processors';
import { NotificationQueuesService } from './notification-queues.service';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { ChannelModule } from '../channels/channel.module';

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
    ),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
  ],
  providers: [
    EmailNotificationProcessor,
    PecNotificationProcessor,
    AppIoNotificationProcessor,
    SendNotificationProcessor,
    PostalNotificationProcessor,
    NotificationQueuesService,
  ],
  exports: [BullModule, NotificationQueuesService],
})
export class QueueModule {}
