import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PdndModule } from '../../pdnd/pdnd.module';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseVerifyQueueService } from './registro-imprese-verify-queue.service';
import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor';
import { REGISTRO_IMPRESE_QUEUE } from './registro-imprese-job.types';

@Module({
  imports: [
    PdndModule,
    TypeOrmModule.forFeature([InadVerificationJob]),
    BullModule.registerQueue({ name: REGISTRO_IMPRESE_QUEUE }),
  ],
  providers: [RegistroImpreseService, RegistroImpreseVerifyQueueService, RegistroImpreseVerifyProcessor],
  exports: [RegistroImpreseService, RegistroImpreseVerifyQueueService],
})
export class RegistroImpreseModule {}
