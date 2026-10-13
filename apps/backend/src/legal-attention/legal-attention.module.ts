// apps/backend/src/legal-attention/legal-attention.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { NotificationReview } from '../entities/notification-review.entity.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { LegalAttentionService } from './legal-attention.service.js';
import { LegalAttentionController } from './legal-attention.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, PostalPosteTracking, NotificationReview]),
    OperatorDirectoryModule,
    AuditLogsModule,
  ],
  controllers: [LegalAttentionController],
  providers: [LegalAttentionService],
})
export class LegalAttentionModule {}
