import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module.js';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity.js';
import { InadService } from './inad.service.js';
import { InadVerifyBulkService } from './inad-verify-bulk.service.js';
import { InadVerifyBulkSyncService } from './inad-verify-bulk-sync.service.js';
import { InadVerifyController } from './inad-verify.controller.js';

@Module({
  imports: [PdndModule, RegistroImpreseModule, TypeOrmModule.forFeature([InadVerificationJob])],
  controllers: [InadVerifyController],
  providers: [InadService, InadVerifyBulkService, InadVerifyBulkSyncService],
  exports: [InadService],
})
export class InadModule {}
