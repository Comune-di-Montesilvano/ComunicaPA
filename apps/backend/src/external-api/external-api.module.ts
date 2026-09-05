import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { ExternalApiClientsService } from './external-api-clients.service.js';
import { AdminExternalClientsController } from './admin-external-clients.controller.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { ExternalAttachmentRetentionService } from './external-attachment-retention.service.js';
import { ExternalAttachmentsController } from './external-attachments.controller.js';
import { ExternalApiService } from './external-api.service.js';
import { ExternalNotificationsController } from './external-notifications.controller.js';
import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { MailConfigsModule } from '../mail-configs/mail-configs.module.js';
import { IoServicesModule } from '../io-services/io-services.module.js';
import { PostalProvidersModule } from '../postal-providers/postal-providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DomicilioModule } from '../channels/domicilio/domicilio.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExternalApiClient]),
    AuditLogsModule,
    CampaignsModule,
    MailConfigsModule,
    IoServicesModule,
    PostalProvidersModule,
    SettingsModule,
    DomicilioModule,
  ],
  controllers: [
    AdminExternalClientsController,
    ExternalAttachmentsController,
    ExternalNotificationsController,
    ExternalCapabilitiesController,
    ExternalDomicilioController,
  ],
  providers: [
    ExternalApiClientsService,
    ExternalAttachmentTokensService,
    ExternalAttachmentRetentionService,
    ExternalApiService,
  ],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
