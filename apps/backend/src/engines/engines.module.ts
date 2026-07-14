import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule, TypeOrmModule.forFeature([NotificationAttempt])],
  controllers: [EnginesController],
})
export class EnginesModule {}
