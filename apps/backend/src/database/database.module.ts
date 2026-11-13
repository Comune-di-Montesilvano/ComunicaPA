import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ENTITIES, MIGRATIONS } from './schema.list.js';
import type { AppConfiguration } from '../config/configuration.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        type: 'postgres',
        url: config.get('database.url', { infer: true }),
        entities: ENTITIES,
        // Dev: schema allineato da synchronize. Prod: migrations eseguite all'avvio.
        synchronize: config.get('nodeEnv', { infer: true }) === 'development',
        migrations: MIGRATIONS,
        migrationsRun: config.get('nodeEnv', { infer: true }) !== 'development',
        logging: config.get('nodeEnv', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
