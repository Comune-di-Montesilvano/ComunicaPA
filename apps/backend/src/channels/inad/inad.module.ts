import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PdndModule } from '../../pdnd/pdnd.module';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { InadService } from './inad.service';
import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { InadVerifyBulkSyncService } from './inad-verify-bulk-sync.service';
import { InadVerifyController } from './inad-verify.controller';

@Module({
  imports: [PdndModule, TypeOrmModule.forFeature([InadVerificationJob])],
  controllers: [InadVerifyController],
  providers: [InadService, InadVerifyBulkService, InadVerifyBulkSyncService],
  exports: [InadService],
})
export class InadModule {}
