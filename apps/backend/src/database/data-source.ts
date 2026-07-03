import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppSetting } from '../entities/app-setting.entity';
import { Campaign } from '../entities/campaign.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Recipient } from '../entities/recipient.entity';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';

// DataSource per la CLI TypeORM (migration:generate / migration:run).
// Il runtime dell'app usa database.module.ts, che condivide entity e migrations.
export default new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'],
  entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
});
