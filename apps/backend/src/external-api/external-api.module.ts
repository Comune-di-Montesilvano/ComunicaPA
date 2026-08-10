import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalApiClient } from '../entities/external-api-client.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AdminExternalClientsController } from './admin-external-clients.controller';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { ExternalAttachmentRetentionService } from './external-attachment-retention.service';
import { ExternalAttachmentsController } from './external-attachments.controller';
import { ExternalApiService } from './external-api.service';
import { ExternalNotificationsController } from './external-notifications.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExternalApiClient]), AuditLogsModule, CampaignsModule],
  controllers: [AdminExternalClientsController, ExternalAttachmentsController, ExternalNotificationsController],
  providers: [
    ExternalApiClientsService,
    ExternalAttachmentTokensService,
    ExternalAttachmentRetentionService,
    ExternalApiService,
  ],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
