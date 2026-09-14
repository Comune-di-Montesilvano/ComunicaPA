import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import { join } from 'path';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE, SignatureVerificationQueueJobData } from './signature-verification-job.types.js';
import { SignatureVerificationService } from './signature-verification.service.js';
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { captureException } from '../common/sentry.util.js';

@Injectable()
@Processor(SIGNATURE_VERIFICATION_QUEUE)
export class SignatureVerificationProcessor extends WorkerHost {
  private readonly logger = new Logger(SignatureVerificationProcessor.name);

  constructor(
    @InjectRepository(SignatureVerificationJob)
    private readonly jobRepo: Repository<SignatureVerificationJob>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly verificationService: SignatureVerificationService,
  ) {
    super();
  }

  async process(job: Job<SignatureVerificationQueueJobData>): Promise<void> {
    const { jobId, campaignId } = job.data;
    try {
      await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.PROCESSING });

      const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
      if (!campaign) {
        await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.FAILED, errorMessage: 'Campagna non trovata', completedAt: new Date() });
        return;
      }

      const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
      const recipients = await this.recipientRepo.find({
        where: { campaignId, status: RecipientStatus.PENDING },
        select: { id: true, extraData: true },
      });

      let validCount = 0;
      let invalidCount = 0;
      const dir = getUploadsDir(campaignId);

      for (const recipient of recipients) {
        // Un solo allegato per SEND nella pratica comune, ma il ciclo copre
        // eventuali slot multipli configurati — basta un allegato non
        // valido per marcare il destinatario invalid.
        let recipientValid = attachmentsConfig.length > 0;
        let recipientReason: string | null = attachmentsConfig.length > 0 ? null : 'Nessun allegato configurato per SEND';

        for (let index = 0; index < attachmentsConfig.length; index++) {
          const filename = resolveCustomAttachmentFilename({ campaign, extraData: recipient.extraData } as unknown as Recipient, index);
          if (!filename) {
            recipientValid = false;
            recipientReason = 'Allegato non configurato per questo destinatario';
            break;
          }
          const filePath = join(dir, filename);
          if (!fs.existsSync(filePath)) {
            recipientValid = false;
            recipientReason = `Allegato ${filename} non trovato su disco`;
            break;
          }
          const buffer = fs.readFileSync(filePath);
          const result = await this.verificationService.verify(buffer, filename);
          if (!result.valid) {
            recipientValid = false;
            recipientReason = result.reason;
            break;
          }
        }

        await this.recipientRepo.update(
          { id: recipient.id },
          { signatureCheck: { valid: recipientValid, reason: recipientReason, checkedAt: new Date().toISOString() } },
        );

        if (recipientValid) validCount++;
        else invalidCount++;
      }

      await this.jobRepo.update(
        { id: jobId },
        {
          status: SignatureVerificationJobStatus.DONE,
          totalRows: recipients.length,
          validCount,
          invalidCount,
          completedAt: new Date(),
        },
      );
    } catch (err: any) {
      this.logger.error(`Job verifica firma ${jobId} fallito: ${err?.message ?? err}`);
      captureException(err);
      await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.FAILED, errorMessage: err?.message ?? 'Errore sconosciuto', completedAt: new Date() });
    }
  }
}
