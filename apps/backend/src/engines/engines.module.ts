import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from '../queue/queue.module.js';
import { ChannelModule } from '../channels/channel.module.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';
import { EnginesController } from './engines.controller.js';

@Module({
  imports: [
    QueueModule,
    ChannelModule,
    BullModule.registerQueue({ name: ENRICHMENT_QUEUE }),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
  ],
  controllers: [EnginesController],
})
export class EnginesModule {}
