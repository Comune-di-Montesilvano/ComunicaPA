import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient])],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
