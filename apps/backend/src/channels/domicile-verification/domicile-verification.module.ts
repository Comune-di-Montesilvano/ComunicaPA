import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { DomicileVerificationJob } from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { InadModule } from '../inad/inad.module.js';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module.js';
import { DomicileVerificationEventsModule } from './domicile-verification-events.module.js';
import { DomicileVerificationService } from './domicile-verification.service.js';
import { DomicileVerificationSyncService } from './domicile-verification-sync.service.js';
import { DomicileVerificationRetentionService } from './domicile-verification-retention.service.js';
import { DomicileVerificationController } from './domicile-verification.controller.js';
import { AppIoVerifyBulkProcessor } from '../../io-services/app-io-verify-bulk.processor.js';
import { APP_IO_VERIFY_BULK_QUEUE } from '../../io-services/app-io-verify-bulk-job.types.js';

@Module({
  imports: [
    InadModule,
    RegistroImpreseModule,
    DomicileVerificationEventsModule,
    // IoServicesService è @Global() (IoServicesModule) — non serve importare
    // quel modulo esplicitamente, stesso pattern già in uso per AppIoStrategy.
    // IoServiceConfig invece NON è esportato da IoServicesModule (solo il
    // service lo è) — va ri-registrato qui per il repository diretto usato
    // da AppIoVerifyBulkProcessor.
    TypeOrmModule.forFeature([DomicileVerificationJob, IoServiceConfig]),
    BullModule.registerQueue({ name: APP_IO_VERIFY_BULK_QUEUE }),
  ],
  controllers: [DomicileVerificationController],
  providers: [
    DomicileVerificationService,
    DomicileVerificationSyncService,
    DomicileVerificationRetentionService,
    AppIoVerifyBulkProcessor,
  ],
})
export class DomicileVerificationModule {}
