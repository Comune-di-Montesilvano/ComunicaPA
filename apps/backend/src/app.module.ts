import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { QueueModule } from './queue/queue.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { PdfModule } from './pdf/pdf.module';
import { ChannelModule } from './channels/channel.module';
import { CitizenModule } from './citizen/citizen.module';
import { PublicDownloadModule } from './public-download/public-download.module';
import { SettingsModule } from './settings/settings.module';
import { MailConfigsModule } from './mail-configs/mail-configs.module';
import { PostalProvidersModule } from './postal-providers/postal-providers.module';
import { EnginesModule } from './engines/engines.module';
import { IoServicesModule } from './io-services/io-services.module';
import { DomicilioModule } from './channels/domicilio/domicilio.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { NotificationsSearchModule } from './notifications-search/notifications-search.module';
import { TemplatesModule } from './templates/templates.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import configuration from './config/configuration';

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
