import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { AppSetting } from '../entities/app-setting.entity';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { Template } from '../entities/template.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { InitialSchema1783023440824 } from './migrations/1783023440824-InitialSchema';
import { AddMailServerConfigs1783071728873 } from './migrations/1783071728873-AddMailServerConfigs';
import { AddIoServiceConfigs1783092759564 } from './migrations/1783092759564-AddIoServiceConfigs';
import { AddTemplates1783109448492 } from './migrations/1783109448492-AddTemplates';
import { FixRecipientCampaignJoin1783148719725 } from './migrations/1783148719725-FixRecipientCampaignJoin';
import { AddDownloadEvents1783200000000 } from './migrations/1783200000000-AddDownloadEvents';
import { FixRecipientAttemptJoin1783358259000 } from './migrations/1783358259000-FixRecipientAttemptJoin';
import { AddCancelledStatus1783426587867 } from './migrations/1783426587867-AddCancelledStatus';
import type { AppConfiguration } from '../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        type: 'postgres',
        url: config.get('database.url', { infer: true }),
        entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent],
        // Dev: schema allineato da synchronize. Prod: migrations eseguite all'avvio.
        synchronize: config.get('nodeEnv', { infer: true }) === 'development',
        migrations: [InitialSchema1783023440824, AddMailServerConfigs1783071728873, AddIoServiceConfigs1783092759564, AddTemplates1783109448492, FixRecipientCampaignJoin1783148719725, AddDownloadEvents1783200000000, FixRecipientAttemptJoin1783358259000, AddCancelledStatus1783426587867],
        migrationsRun: config.get('nodeEnv', { infer: true }) !== 'development',
        logging: config.get('nodeEnv', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
