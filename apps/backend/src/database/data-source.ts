import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppSetting } from '../entities/app-setting.entity';
import { Campaign } from '../entities/campaign.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Recipient } from '../entities/recipient.entity';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { Template } from '../entities/template.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity';
import { InadVerificationJob } from '../entities/inad-verification-job.entity';
import { EnrichmentJob } from '../entities/enrichment-job.entity';

// DataSource per la CLI TypeORM (migration:generate / migration:run).
// Il runtime dell'app usa database.module.ts, che condivide entity e migrations.
// Elenco entities allineato a database.module.ts: se disallineato, migration:generate
// può proporre DROP TABLE per le entity mancanti qui ma presenti a runtime.
export default new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'],
  entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent, AuditLog, PostalProviderConfig, AppIoVerificationJob, InadVerificationJob, EnrichmentJob],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
});
