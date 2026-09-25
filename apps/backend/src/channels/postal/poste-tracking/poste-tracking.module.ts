import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';
import { NotificationAttempt } from '../../../entities/notification-attempt.entity.js';
import { Recipient } from '../../../entities/recipient.entity.js';
import { PosteTrackingClient } from './poste-tracking-client.service.js';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { PosteTrackingController, PosteTrackingEnginesController } from './poste-tracking.controller.js';
import { PostalProvidersModule } from '../../../postal-providers/postal-providers.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([PostalPosteTracking, NotificationAttempt, Recipient]), PostalProvidersModule],
  controllers: [PosteTrackingController, PosteTrackingEnginesController],
  providers: [PosteTrackingClient, PostePostalTrackingService],
})
export class PosteTrackingModule {}
