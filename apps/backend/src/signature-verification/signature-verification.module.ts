import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';
import { AgidTrustListService } from './agid-trust-list.service.js';
import { SignatureVerificationService } from './signature-verification.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AgidTrustListCache])],
  providers: [AgidTrustListService, SignatureVerificationService],
  exports: [AgidTrustListService, SignatureVerificationService],
})
export class SignatureVerificationModule {}
