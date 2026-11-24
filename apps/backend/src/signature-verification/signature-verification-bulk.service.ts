import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { IsNull, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
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
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
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
    // Job DONE ma destinatari mai verificati = verifica superata: il wizard
    // ricrea i Recipient a ogni sync (delete+recreate) e quelli nuovi hanno
    // signatureCheck NULL. Trattato come "mai avviata": lo step 6 la riavvia,
    // lancio e firma attendono la nuova (bug reale: "Nessun allegato PDF da
    // firmare" con riquadro arancione ancora acceso dal job vecchio).
    if (job.status === SignatureVerificationJobStatus.DONE) {
      const unchecked = await this.recipientRepo.exists({
        where: { campaignId, status: RecipientStatus.PENDING, signatureCheck: IsNull() },
      });
      if (unchecked) return null;
    }
    return {
      status: job.status,
      totalRows: job.totalRows,
      validCount: job.validCount,
      invalidCount: job.invalidCount,
      errorMessage: job.errorMessage,
    };
  }

  /**
   * Allegati non validi dei destinatari pending, raggruppati per file e
   * motivo (un allegato comune a tutte le righe conta una voce sola), i più
   * frequenti per primi. Verifiche precedenti a `invalidFiles`: solo il
   * motivo, senza nome file.
   */
  async getInvalidFiles(campaignId: string, limit = INVALID_FILES_LIMIT): Promise<{ items: InvalidFileSummary[]; total: number }> {
    const rows: Array<{ filename: string | null; reason: string | null; recipients: number; total: number }> = await this.recipientRepo.query(
      `SELECT f->>'filename' AS filename, f->>'reason' AS reason, count(*)::int AS recipients, count(*) OVER ()::int AS total
         FROM recipients r
         CROSS JOIN LATERAL jsonb_array_elements(
           COALESCE(r.signature_check->'invalidFiles', jsonb_build_array(jsonb_build_object('filename', NULL, 'reason', r.signature_check->>'reason')))
         ) f
        WHERE r.campaign_id = $1 AND r.status = $2 AND r.signature_check->>'valid' = 'false'
        GROUP BY 1, 2
        ORDER BY 3 DESC, 1 NULLS LAST, 2
        LIMIT $3`,
      [campaignId, RecipientStatus.PENDING, limit],
    );
    return {
      items: rows.map((r) => ({ filename: r.filename, reason: r.reason ?? 'Firma non valida', recipients: r.recipients })),
      total: rows[0]?.total ?? 0,
    };
  }
}

export interface InvalidFileSummary {
  filename: string | null;
  reason: string;
  /** Destinatari che hanno questo allegato non valido. */
  recipients: number;
}

const INVALID_FILES_LIMIT = 10;
