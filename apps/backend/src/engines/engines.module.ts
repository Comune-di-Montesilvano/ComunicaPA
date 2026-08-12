import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { ChannelModule } from '../channels/channel.module';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule, ChannelModule, TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient])],
  controllers: [EnginesController],
})
export class EnginesModule {}
