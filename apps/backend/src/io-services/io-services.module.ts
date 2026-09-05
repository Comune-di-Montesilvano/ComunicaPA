import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity.js';
import { IoServicesService } from './io-services.service.js';
import { IoServicesController } from './io-services.controller.js';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service.js';
import { AppIoVerifyBulkProcessor } from './app-io-verify-bulk.processor.js';
import { APP_IO_VERIFY_BULK_QUEUE } from './app-io-verify-bulk-job.types.js';

// @Global(): AppIoStrategy (in ChannelModule) inietta IoServicesService senza importare
// esplicitamente questo modulo — stesso pattern di MailConfigsModule.
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([IoServiceConfig, AppIoVerificationJob]),
    BullModule.registerQueue({ name: APP_IO_VERIFY_BULK_QUEUE }),
  ],
  controllers: [IoServicesController],
  providers: [IoServicesService, AppIoVerifyBulkService, AppIoVerifyBulkProcessor],
  exports: [IoServicesService],
})
export class IoServicesModule {}
