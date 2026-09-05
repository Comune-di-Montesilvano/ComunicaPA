import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { AppSetting } from '../entities/app-setting.entity.js';
import { MailServerConfig } from '../entities/mail-server-config.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { Template } from '../entities/template.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { AuditLog } from '../entities/audit-log.entity.js';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity.js';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity.js';
import { InadVerificationJob } from '../entities/inad-verification-job.entity.js';
import { EnrichmentJob } from '../entities/enrichment-job.entity.js';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity.js';
import { OperatorDirectoryEntry } from '../entities/operator-directory-entry.entity.js';
import { CampaignBulkRetryJob } from '../entities/campaign-bulk-retry-job.entity.js';
import { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { InitialSchema1783023440824 } from './migrations/1783023440824-InitialSchema.js';
import { AddMailServerConfigs1783071728873 } from './migrations/1783071728873-AddMailServerConfigs.js';
import { AddIoServiceConfigs1783092759564 } from './migrations/1783092759564-AddIoServiceConfigs.js';
import { AddTemplates1783109448492 } from './migrations/1783109448492-AddTemplates.js';
import { FixRecipientCampaignJoin1783148719725 } from './migrations/1783148719725-FixRecipientCampaignJoin.js';
import { AddDownloadEvents1783200000000 } from './migrations/1783200000000-AddDownloadEvents.js';
import { FixRecipientAttemptJoin1783358259000 } from './migrations/1783358259000-FixRecipientAttemptJoin.js';
import { AddCancelledStatus1783426587867 } from './migrations/1783426587867-AddCancelledStatus.js';
import { CreateAuditLogs1783500000000 } from './migrations/1783500000000-CreateAuditLogs.js';
import { RenamePdndSettingsKeys1783600000000 } from './migrations/1783600000000-RenamePdndSettingsKeys.js';
import { AddSendStatusColumns1783700000000 } from './migrations/1783700000000-AddSendStatusColumns.js';
import { AddProtocolColumns1783800000000 } from './migrations/1783800000000-AddProtocolColumns.js';
import { AddUploadedDocumentsColumn1784100000000 } from './migrations/1784100000000-AddUploadedDocumentsColumn.js';
import { AddPostalStatusColumns1784200000000 } from './migrations/1784200000000-AddPostalStatusColumns.js';
import { CreatePostalProviderConfigs1784300000000 } from './migrations/1784300000000-CreatePostalProviderConfigs.js';
import { SeedStandardTemplates1784400000000 } from './migrations/1784400000000-SeedStandardTemplates.js';
import { AddSendStatusHistoryColumns1784500000000 } from './migrations/1784500000000-AddSendStatusHistoryColumns.js';
import { AddPostalStatusHistoryColumn1784600000000 } from './migrations/1784600000000-AddPostalStatusHistoryColumn.js';
import { CreateAppIoVerificationJobs1784700000000 } from './migrations/1784700000000-CreateAppIoVerificationJobs.js';
import { AddCheckingInadStatus1784800000000 } from './migrations/1784800000000-AddCheckingInadStatus.js';
import { AddInadCheckColumn1784800000001 } from './migrations/1784800000001-AddInadCheckColumn.js';
import { CreateEnrichmentJobs1784900000000 } from './migrations/1784900000000-CreateEnrichmentJobs.js';
import { AddTestCampaignColumns1785000000000 } from './migrations/1785000000000-AddTestCampaignColumns.js';
import { AddCostColumns1785100000000 } from './migrations/1785100000000-AddCostColumns.js';
import { CreateInadVerificationJobs1785200000000 } from './migrations/1785200000000-CreateInadVerificationJobs.js';
import { AddMailServerConfigDefault1785300000000 } from './migrations/1785300000000-AddMailServerConfigDefault.js';
import { CreateOperatorDirectory1785400000000 } from './migrations/1785400000000-CreateOperatorDirectory.js';
import { AddCampaignIsLegalValueColumn1785500000000 } from './migrations/1785500000000-AddCampaignIsLegalValueColumn.js';
import { AddSearchPaymentsToEnrichmentJobs1785600000000 } from './migrations/1785600000000-AddSearchPaymentsToEnrichmentJobs.js';
import { AddLastContentResendSignatureToRecipients1785700000000 } from './migrations/1785700000000-AddLastContentResendSignatureToRecipients.js';
import { AddCheckpointRowToEnrichmentJobs1785700000000 } from './migrations/1785700000000-AddCheckpointRowToEnrichmentJobs.js';
import { CreateEnrichmentAddressOverrides1785800000000 } from './migrations/1785800000000-CreateEnrichmentAddressOverrides.js';
import { AddEnrichmentAddressOverridesJobFk1785900000000 } from './migrations/1785900000000-AddEnrichmentAddressOverridesJobFk.js';
import { AddExtraFieldsToEnrichmentAddressOverrides1786000000000 } from './migrations/1786000000000-AddExtraFieldsToEnrichmentAddressOverrides.js';
import { AddPostalLastCheckedAtColumn1786100000000 } from './migrations/1786100000000-AddPostalLastCheckedAtColumn.js';
import { AddCampaignConversionStatusColumns1786200000000 } from './migrations/1786200000000-AddCampaignConversionStatusColumns.js';
import { AddPostalRequeueCheckedAtColumn1786300000000 } from './migrations/1786300000000-AddPostalRequeueCheckedAtColumn.js';
import { CreateCampaignBulkRetryJobs1786400000000 } from './migrations/1786400000000-CreateCampaignBulkRetryJobs.js';
import { AddPostalDeliveryStatusColumns1786500000000 } from './migrations/1786500000000-AddPostalDeliveryStatusColumns.js';
import { AddRecipientAndAttemptIndexes1786600000000 } from './migrations/1786600000000-AddRecipientAndAttemptIndexes.js';
import { CreateExternalApiClients1786700000000 } from './migrations/1786700000000-CreateExternalApiClients.js';
import { AddPivaColumnsToInadVerificationJobs1786800000000 } from './migrations/1786800000000-AddPivaColumnsToInadVerificationJobs.js';
import type { AppConfiguration } from '../config/configuration.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        type: 'postgres',
        url: config.get('database.url', { infer: true }),
        entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent, AuditLog, PostalProviderConfig, AppIoVerificationJob, InadVerificationJob, EnrichmentJob, EnrichmentAddressOverride, OperatorDirectoryEntry, CampaignBulkRetryJob, ExternalApiClient],
        // Dev: schema allineato da synchronize. Prod: migrations eseguite all'avvio.
        synchronize: config.get('nodeEnv', { infer: true }) === 'development',
        migrations: [InitialSchema1783023440824, AddMailServerConfigs1783071728873, AddIoServiceConfigs1783092759564, AddTemplates1783109448492, FixRecipientCampaignJoin1783148719725, AddDownloadEvents1783200000000, FixRecipientAttemptJoin1783358259000, AddCancelledStatus1783426587867, CreateAuditLogs1783500000000, RenamePdndSettingsKeys1783600000000, AddSendStatusColumns1783700000000, AddProtocolColumns1783800000000, AddUploadedDocumentsColumn1784100000000, AddPostalStatusColumns1784200000000, CreatePostalProviderConfigs1784300000000, SeedStandardTemplates1784400000000, AddSendStatusHistoryColumns1784500000000, AddPostalStatusHistoryColumn1784600000000, CreateAppIoVerificationJobs1784700000000, AddCheckingInadStatus1784800000000, AddInadCheckColumn1784800000001, CreateEnrichmentJobs1784900000000, AddTestCampaignColumns1785000000000, AddCostColumns1785100000000, CreateInadVerificationJobs1785200000000, AddMailServerConfigDefault1785300000000, CreateOperatorDirectory1785400000000, AddCampaignIsLegalValueColumn1785500000000, AddSearchPaymentsToEnrichmentJobs1785600000000, AddLastContentResendSignatureToRecipients1785700000000, AddCheckpointRowToEnrichmentJobs1785700000000, CreateEnrichmentAddressOverrides1785800000000, AddEnrichmentAddressOverridesJobFk1785900000000, AddExtraFieldsToEnrichmentAddressOverrides1786000000000, AddPostalLastCheckedAtColumn1786100000000, AddCampaignConversionStatusColumns1786200000000, AddPostalRequeueCheckedAtColumn1786300000000, CreateCampaignBulkRetryJobs1786400000000, AddPostalDeliveryStatusColumns1786500000000, AddRecipientAndAttemptIndexes1786600000000, CreateExternalApiClients1786700000000, AddPivaColumnsToInadVerificationJobs1786800000000],
        migrationsRun: config.get('nodeEnv', { infer: true }) !== 'development',
        logging: config.get('nodeEnv', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
