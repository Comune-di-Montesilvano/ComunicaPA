import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';
import { NotificationAttempt } from '../../../entities/notification-attempt.entity.js';
import { Recipient } from '../../../entities/recipient.entity.js';
import { PosteTrackingClient } from './poste-tracking-client.service.js';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { PosteTrackingController } from './poste-tracking.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([PostalPosteTracking, NotificationAttempt, Recipient])],
  controllers: [PosteTrackingController],
  providers: [PosteTrackingClient, PostePostalTrackingService],
})
export class PosteTrackingModule {}
