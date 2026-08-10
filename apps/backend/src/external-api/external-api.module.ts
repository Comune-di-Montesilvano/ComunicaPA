import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalApiClient } from '../entities/external-api-client.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AdminExternalClientsController } from './admin-external-clients.controller';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { ExternalAttachmentRetentionService } from './external-attachment-retention.service';
import { ExternalAttachmentsController } from './external-attachments.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExternalApiClient]), AuditLogsModule],
  controllers: [AdminExternalClientsController, ExternalAttachmentsController],
  providers: [ExternalApiClientsService, ExternalAttachmentTokensService, ExternalAttachmentRetentionService],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
