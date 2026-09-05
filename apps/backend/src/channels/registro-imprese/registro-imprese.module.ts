import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity.js';
import { Recipient } from '../../entities/recipient.entity.js';
import { RegistroImpreseService } from './registro-imprese.service.js';
import { RegistroImpreseVerifyQueueService } from './registro-imprese-verify-queue.service.js';
import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor.js';
import { REGISTRO_IMPRESE_QUEUE } from './registro-imprese-job.types.js';

@Module({
  imports: [
    PdndModule,
    TypeOrmModule.forFeature([InadVerificationJob, Recipient]),
    BullModule.registerQueue({ name: REGISTRO_IMPRESE_QUEUE }),
  ],
  providers: [RegistroImpreseService, RegistroImpreseVerifyQueueService, RegistroImpreseVerifyProcessor],
  exports: [RegistroImpreseService, RegistroImpreseVerifyQueueService],
})
export class RegistroImpreseModule {}
