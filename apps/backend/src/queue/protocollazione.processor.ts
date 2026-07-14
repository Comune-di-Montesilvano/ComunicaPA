import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
import { splitFullName } from '../channels/send/name.util';
import { PROTOCOLLAZIONE_QUEUE } from './notification-job.types';

/**
 * Sostituisce ProtocollazioneSyncService (cron poll): ogni attempt da
 * protocollare passa da un job BullMQ dedicato invece che da un poll ogni 2
 * minuti — stessa gestione operativa (pausa/riprendi/job falliti/log) degli
 * altri 4 canali. Un fallimento riceve lo stesso trattamento di un
 * fallimento SEND vero (attempt/recipient FAILED, CampaignCompletionService
 * chiamato), poi rilancia l'errore così BullMQ registra il job come failed
 * — un job senza `attempts` esplicito fallisce una volta sola, risolvendo
 * il retry infinito silenzioso del vecchio cron.
 */
@Injectable()
@Processor(PROTOCOLLAZIONE_QUEUE)
export class ProtocollazioneProcessor extends WorkerHost {
  private readonly logger = new Logger(ProtocollazioneProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
    private readonly campaignCompletion: CampaignCompletionService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { attemptId, recipientId, campaignId } = job.data;
    const jobLog = (msg: string) => job.log(msg);

    // Fresh read: guardia contro cancel() concorrente, stesso spirito del
    // guard in SendDispatchService.markSuccess/markFailed — un attempt
    // non più QUEUED (es. CANCELLED) non va protocollato.
    const attempt = await this.attemptRepo.findOne({ where: { id: attemptId }, relations: { recipient: { campaign: true } } });
    if (!attempt || attempt.status !== AttemptStatus.QUEUED) {
      const msg = `Attempt ${attemptId} non più QUEUED (probabile cancel() concorrente) — protocollazione saltata.`;
      this.logger.warn(msg);
      jobLog(msg);
      return;
    }

    const recipient = attempt.recipient;
    const campaign = recipient.campaign;
    const cfg = campaign.channelConfig as Record<string, unknown>;
    const subject = (cfg['subject'] as string) ?? campaign.name;

    try {
      const { nome, cognome } = splitFullName(recipient.fullName);
      const buffer = await this.attachments.generatePdfBuffer(recipient, 0);
      const result = await this.protocollo.protocolla({
        oggetto: subject,
        destinatario: {
          codiceFiscale: recipient.codiceFiscale,
          nome,
          cognome,
          denominazione: recipient.fullName ?? recipient.codiceFiscale,
        },
        documentBuffer: buffer,
        documentFilename: `${recipient.codiceFiscale}.pdf`,
      });
      await this.attemptRepo.update(attemptId, {
        protocolNumber: result.numeroProtocollo,
        protocolYear: result.annoProtocollo,
        protocolledAt: new Date(),
      });
      const msg = `Attempt ${attemptId} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`;
      this.logger.log(msg);
      jobLog(msg);
    } catch (err: any) {
      const msg = `Protocollazione fallita per attempt ${attemptId}: ${err.message}`;
      this.logger.warn(msg);
      jobLog(msg);
      // Stesso trattamento di un fallimento SendDispatchService.markFailed:
      // la protocollazione è un prerequisito legale all'invio, un suo
      // fallimento è un fallimento reale del destinatario. Guardia su
      // status=QUEUED: se cancel() ha già annullato l'attempt tra la
      // find() sopra e qui, non sovrascrivere.
      const result = await this.attemptRepo.update(
        { id: attemptId, status: AttemptStatus.QUEUED },
        { status: AttemptStatus.FAILED, errorMessage: err.message },
      );
      if (result.affected) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
        await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
        await this.campaignCompletion.checkAndComplete(campaignId);
      }
      throw err;
    }
  }
}
