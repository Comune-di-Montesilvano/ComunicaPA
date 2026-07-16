import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity';
import { IoServicesService } from './io-services.service';
import { IoServicesController } from './io-services.controller';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { AppIoVerifyBulkProcessor } from './app-io-verify-bulk.processor';
import { APP_IO_VERIFY_BULK_QUEUE } from './app-io-verify-bulk-job.types';

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
