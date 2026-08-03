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
import { AuditLog } from '../entities/audit-log.entity';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity';
import { InadVerificationJob } from '../entities/inad-verification-job.entity';
import { EnrichmentJob } from '../entities/enrichment-job.entity';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity';
import { OperatorDirectoryEntry } from '../entities/operator-directory-entry.entity';
import { CampaignBulkRetryJob } from '../entities/campaign-bulk-retry-job.entity';
import { InitialSchema1783023440824 } from './migrations/1783023440824-InitialSchema';
import { AddMailServerConfigs1783071728873 } from './migrations/1783071728873-AddMailServerConfigs';
import { AddIoServiceConfigs1783092759564 } from './migrations/1783092759564-AddIoServiceConfigs';
import { AddTemplates1783109448492 } from './migrations/1783109448492-AddTemplates';
import { FixRecipientCampaignJoin1783148719725 } from './migrations/1783148719725-FixRecipientCampaignJoin';
import { AddDownloadEvents1783200000000 } from './migrations/1783200000000-AddDownloadEvents';
import { FixRecipientAttemptJoin1783358259000 } from './migrations/1783358259000-FixRecipientAttemptJoin';
import { AddCancelledStatus1783426587867 } from './migrations/1783426587867-AddCancelledStatus';
import { CreateAuditLogs1783500000000 } from './migrations/1783500000000-CreateAuditLogs';
import { RenamePdndSettingsKeys1783600000000 } from './migrations/1783600000000-RenamePdndSettingsKeys';
import { AddSendStatusColumns1783700000000 } from './migrations/1783700000000-AddSendStatusColumns';
import { AddProtocolColumns1783800000000 } from './migrations/1783800000000-AddProtocolColumns';
import { AddUploadedDocumentsColumn1784100000000 } from './migrations/1784100000000-AddUploadedDocumentsColumn';
import { AddPostalStatusColumns1784200000000 } from './migrations/1784200000000-AddPostalStatusColumns';
import { CreatePostalProviderConfigs1784300000000 } from './migrations/1784300000000-CreatePostalProviderConfigs';
import { SeedStandardTemplates1784400000000 } from './migrations/1784400000000-SeedStandardTemplates';
import { AddSendStatusHistoryColumns1784500000000 } from './migrations/1784500000000-AddSendStatusHistoryColumns';
import { AddPostalStatusHistoryColumn1784600000000 } from './migrations/1784600000000-AddPostalStatusHistoryColumn';
import { CreateAppIoVerificationJobs1784700000000 } from './migrations/1784700000000-CreateAppIoVerificationJobs';
import { AddCheckingInadStatus1784800000000 } from './migrations/1784800000000-AddCheckingInadStatus';
import { AddInadCheckColumn1784800000001 } from './migrations/1784800000001-AddInadCheckColumn';
import { CreateEnrichmentJobs1784900000000 } from './migrations/1784900000000-CreateEnrichmentJobs';
import { AddTestCampaignColumns1785000000000 } from './migrations/1785000000000-AddTestCampaignColumns';
import { AddCostColumns1785100000000 } from './migrations/1785100000000-AddCostColumns';
import { CreateInadVerificationJobs1785200000000 } from './migrations/1785200000000-CreateInadVerificationJobs';
import { AddMailServerConfigDefault1785300000000 } from './migrations/1785300000000-AddMailServerConfigDefault';
import { CreateOperatorDirectory1785400000000 } from './migrations/1785400000000-CreateOperatorDirectory';
import { AddCampaignIsLegalValueColumn1785500000000 } from './migrations/1785500000000-AddCampaignIsLegalValueColumn';
import { AddSearchPaymentsToEnrichmentJobs1785600000000 } from './migrations/1785600000000-AddSearchPaymentsToEnrichmentJobs';
import { AddLastContentResendSignatureToRecipients1785700000000 } from './migrations/1785700000000-AddLastContentResendSignatureToRecipients';
import { AddCheckpointRowToEnrichmentJobs1785700000000 } from './migrations/1785700000000-AddCheckpointRowToEnrichmentJobs';
import { CreateEnrichmentAddressOverrides1785800000000 } from './migrations/1785800000000-CreateEnrichmentAddressOverrides';
import { AddEnrichmentAddressOverridesJobFk1785900000000 } from './migrations/1785900000000-AddEnrichmentAddressOverridesJobFk';
import { AddExtraFieldsToEnrichmentAddressOverrides1786000000000 } from './migrations/1786000000000-AddExtraFieldsToEnrichmentAddressOverrides';
import { AddPostalLastCheckedAtColumn1786100000000 } from './migrations/1786100000000-AddPostalLastCheckedAtColumn';
import { AddCampaignConversionStatusColumns1786200000000 } from './migrations/1786200000000-AddCampaignConversionStatusColumns';
import { AddPostalRequeueCheckedAtColumn1786300000000 } from './migrations/1786300000000-AddPostalRequeueCheckedAtColumn';
import { CreateCampaignBulkRetryJobs1786400000000 } from './migrations/1786400000000-CreateCampaignBulkRetryJobs';
import { AddPostalDeliveryStatusColumns1786500000000 } from './migrations/1786500000000-AddPostalDeliveryStatusColumns';
import { AddRecipientAndAttemptIndexes1786600000000 } from './migrations/1786600000000-AddRecipientAndAttemptIndexes';
import type { AppConfiguration } from '../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        type: 'postgres',
        url: config.get('database.url', { infer: true }),
        entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent, AuditLog, PostalProviderConfig, AppIoVerificationJob, InadVerificationJob, EnrichmentJob, EnrichmentAddressOverride, OperatorDirectoryEntry, CampaignBulkRetryJob],
        // Dev: schema allineato da synchronize. Prod: migrations eseguite all'avvio.
        synchronize: config.get('nodeEnv', { infer: true }) === 'development',
        migrations: [InitialSchema1783023440824, AddMailServerConfigs1783071728873, AddIoServiceConfigs1783092759564, AddTemplates1783109448492, FixRecipientCampaignJoin1783148719725, AddDownloadEvents1783200000000, FixRecipientAttemptJoin1783358259000, AddCancelledStatus1783426587867, CreateAuditLogs1783500000000, RenamePdndSettingsKeys1783600000000, AddSendStatusColumns1783700000000, AddProtocolColumns1783800000000, AddUploadedDocumentsColumn1784100000000, AddPostalStatusColumns1784200000000, CreatePostalProviderConfigs1784300000000, SeedStandardTemplates1784400000000, AddSendStatusHistoryColumns1784500000000, AddPostalStatusHistoryColumn1784600000000, CreateAppIoVerificationJobs1784700000000, AddCheckingInadStatus1784800000000, AddInadCheckColumn1784800000001, CreateEnrichmentJobs1784900000000, AddTestCampaignColumns1785000000000, AddCostColumns1785100000000, CreateInadVerificationJobs1785200000000, AddMailServerConfigDefault1785300000000, CreateOperatorDirectory1785400000000, AddCampaignIsLegalValueColumn1785500000000, AddSearchPaymentsToEnrichmentJobs1785600000000, AddLastContentResendSignatureToRecipients1785700000000, AddCheckpointRowToEnrichmentJobs1785700000000, CreateEnrichmentAddressOverrides1785800000000, AddEnrichmentAddressOverridesJobFk1785900000000, AddExtraFieldsToEnrichmentAddressOverrides1786000000000, AddPostalLastCheckedAtColumn1786100000000, AddCampaignConversionStatusColumns1786200000000, AddPostalRequeueCheckedAtColumn1786300000000, CreateCampaignBulkRetryJobs1786400000000, AddPostalDeliveryStatusColumns1786500000000, AddRecipientAndAttemptIndexes1786600000000],
        migrationsRun: config.get('nodeEnv', { infer: true }) !== 'development',
        logging: config.get('nodeEnv', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
