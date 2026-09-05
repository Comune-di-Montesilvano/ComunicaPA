import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppSetting } from '../entities/app-setting.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
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

// DataSource per la CLI TypeORM (migration:generate / migration:run).
// Il runtime dell'app usa database.module.ts, che condivide entity e migrations.
// Elenco entities allineato a database.module.ts: se disallineato, migration:generate
// può proporre DROP TABLE per le entity mancanti qui ma presenti a runtime.
export default new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'],
  entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent, AuditLog, PostalProviderConfig, AppIoVerificationJob, InadVerificationJob, EnrichmentJob, EnrichmentAddressOverride, OperatorDirectoryEntry, CampaignBulkRetryJob],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
});
