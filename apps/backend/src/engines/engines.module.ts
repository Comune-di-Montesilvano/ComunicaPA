import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule],
  controllers: [EnginesController],
})
export class EnginesModule {}
