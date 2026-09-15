import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE, SignatureVerificationQueueJobData } from './signature-verification-job.types.js';

export interface SignatureVerificationJobStatusDto {
  status: SignatureVerificationJobStatus;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errorMessage: string | null;
}

@Injectable()
export class SignatureVerificationBulkService {
  constructor(
    @InjectRepository(SignatureVerificationJob)
    private readonly jobRepo: Repository<SignatureVerificationJob>,
    @InjectQueue(SIGNATURE_VERIFICATION_QUEUE)
    private readonly queue: Queue<SignatureVerificationQueueJobData>,
  ) {}

  async startForCampaign(campaignId: string): Promise<{ jobId: string }> {
    const entity = this.jobRepo.create({ campaignId, status: SignatureVerificationJobStatus.QUEUED });
    const saved = await this.jobRepo.save(entity);
    await this.queue.add('verify', { jobId: saved.id, campaignId }, { jobId: saved.id });
    return { jobId: saved.id };
  }

  async getLatestStatus(campaignId: string): Promise<SignatureVerificationJobStatusDto | null> {
    const job = await this.jobRepo.findOne({ where: { campaignId }, order: { createdAt: 'DESC' } });
    if (!job) return null;
    return {
      status: job.status,
      totalRows: job.totalRows,
      validCount: job.validCount,
      invalidCount: job.invalidCount,
      errorMessage: job.errorMessage,
    };
  }
}
