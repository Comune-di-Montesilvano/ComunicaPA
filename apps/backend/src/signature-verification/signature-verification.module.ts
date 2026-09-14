import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';
import { SignatureVerificationJob } from '../entities/signature-verification-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { AgidTrustListService } from './agid-trust-list.service.js';
import { SignatureVerificationService } from './signature-verification.service.js';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import { SignatureVerificationProcessor } from './signature-verification.processor.js';
import { SignatureVerificationController } from './signature-verification.controller.js';
import { SIGNATURE_VERIFICATION_QUEUE } from './signature-verification-job.types.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AgidTrustListCache, SignatureVerificationJob, Campaign, Recipient]),
    BullModule.registerQueue({ name: SIGNATURE_VERIFICATION_QUEUE }),
  ],
  controllers: [SignatureVerificationController],
  providers: [AgidTrustListService, SignatureVerificationService, SignatureVerificationBulkService, SignatureVerificationProcessor],
  exports: [AgidTrustListService, SignatureVerificationService, SignatureVerificationBulkService],
})
export class SignatureVerificationModule {}
