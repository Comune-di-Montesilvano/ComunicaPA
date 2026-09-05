import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module.js';
import { ChannelModule } from '../channels/channel.module.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { EnginesController } from './engines.controller.js';

@Module({
  imports: [QueueModule, ChannelModule, TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient])],
  controllers: [EnginesController],
})
export class EnginesModule {}
