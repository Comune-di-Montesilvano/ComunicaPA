import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { QueueModule } from './queue/queue.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { PdfModule } from './pdf/pdf.module.js';
import { ChannelModule } from './channels/channel.module.js';
import { CitizenModule } from './citizen/citizen.module.js';
import { PublicDownloadModule } from './public-download/public-download.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { MailConfigsModule } from './mail-configs/mail-configs.module.js';
import { PostalProvidersModule } from './postal-providers/postal-providers.module.js';
import { EnginesModule } from './engines/engines.module.js';
import { IoServicesModule } from './io-services/io-services.module.js';
import { DomicilioModule } from './channels/domicilio/domicilio.module.js';
import { EnrichmentModule } from './enrichment/enrichment.module.js';
import { NotificationsSearchModule } from './notifications-search/notifications-search.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { AuditLogsModule } from './audit-logs/audit-logs.module.js';
import { ExternalApiModule } from './external-api/external-api.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { RolesGuard } from './auth/guards/roles.guard.js';
import configuration from './config/configuration.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    QueueModule,
    CampaignsModule,
    PdfModule,
    ChannelModule,
    CitizenModule,
    PublicDownloadModule,
    SettingsModule,
    MailConfigsModule,
    PostalProvidersModule,
    EnginesModule,
    IoServicesModule,
    DomicilioModule,
    EnrichmentModule,
    NotificationsSearchModule,
    TemplatesModule,
    AuditLogsModule,
    ExternalApiModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
