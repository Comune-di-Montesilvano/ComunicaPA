import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { MailConfigsModule } from '../mail-configs/mail-configs.module.js';
import { IoServicesModule } from '../io-services/io-services.module.js';
import { PostalProvidersModule } from '../postal-providers/postal-providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DomicilioModule } from '../channels/domicilio/domicilio.module.js';
import type { AppConfiguration } from '../config/configuration.js';
import { ExternalApiClientsService } from './external-api-clients.service.js';
import { AdminExternalClientsController } from './admin-external-clients.controller.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { ExternalAttachmentRetentionService } from './external-attachment-retention.service.js';
import { ExternalAttachmentsController } from './external-attachments.controller.js';
import { ExternalNotificationsController } from './external-notifications.controller.js';
import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalIdempotencyStore, EXTERNAL_IDEMPOTENCY_REDIS } from './external-idempotency.store.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExternalApiClient, Recipient, Campaign, NotificationAttempt, PostalPosteTracking]),
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
    ExternalCapabilitiesService,
    ExternalIdempotencyStore,
    ExternalNotificationsService,
    ExternalNotificationStatusService,
    {
      // Stesso pattern di OidcFlowService: client ioredis dedicato, lazyConnect.
      provide: EXTERNAL_IDEMPOTENCY_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) =>
        new Redis(config.get('redis.url', { infer: true }), { lazyConnect: true, maxRetriesPerRequest: 2 }),
    },
  ],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
