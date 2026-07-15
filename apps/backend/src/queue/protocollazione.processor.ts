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
import { PROTOCOLLAZIONE_QUEUE, NOTIFICATION_JOB_SEND, type EngineName } from './notification-job.types';
import { NotificationQueuesService } from './notification-queues.service';
import { ConfigService } from '@nestjs/config';
import { processTemplate, wrapInHtmlLayout } from '../channels/template.helper';
import { resolveAttachmentsConfig } from '../attachments/attachment.service';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
import { AppSettingsService } from '../settings/app-settings.service';
import type { ProtocollaAllegato } from '../protocollo/protocollo.service';

/**
 * Sostituisce ProtocollazioneSyncService (cron poll): ogni attempt da
 * protocollare passa da un job BullMQ dedicato invece che da un poll ogni 2
 * minuti — stessa gestione operativa (pausa/riprendi/job falliti/log) degli
 * altri 4 canali. Un fallimento riceve lo same trattamento di un
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
    private readonly notificationQueues: NotificationQueuesService,
    private readonly config: ConfigService,
    private readonly settings: AppSettingsService,
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

      const allegati: ProtocollaAllegato[] = [];

      if (campaign.channelType === 'EMAIL' || campaign.channelType === 'PEC') {
        const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
        const publicApiUrl = (await this.settings.get<string>('system.publicUrl')) || '';
        const downloadLinkSecret = this.config.get<string>('downloadLink.secret') || '';
        const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
        const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
        const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

        const brandLogo = await this.settings.get<string>('brand.logo');
        const logoUrl = brandLogo
          ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`)
          : null;
        const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;

        const subjectTemplate = (cfg['subject'] as string) || (campaign.channelType === 'PEC' ? 'Notifica PEC ComunicaPA' : 'Notifica Email ComunicaPA');
        const bodyTemplate = (cfg['body'] as string) || (campaign.channelType === 'PEC' ? 'Hai ricevuto una nuova notifica PEC.' : 'Hai ricevuto una nuova notifica Email.');
        const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

        // Resolve body templates with temp protocol number
        const tempRecipient = {
          ...recipient,
          protocolNumber: '[Numero Protocollo generato in trasmissione]',
        } as any;

        const resolvedSubject = processTemplate(subjectTemplate, tempRecipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', campaign.channelType);
        const resolvedBodyText = processTemplate(bodyTemplate, tempRecipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', campaign.channelType);
        const resolvedBodyHtml = wrapInHtmlLayout(resolvedBodyText, brandName, { logoUrl, portalUrl });

        const toAddress = campaign.channelType === 'PEC' ? recipient.pec : recipient.email;
        const emlContent = [
          `From: ${brandName}`,
          `To: ${toAddress || ''}`,
          `Subject: ${resolvedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          resolvedBodyHtml,
        ].join('\r\n');
        
        allegati.push({
          buffer: Buffer.from(emlContent, 'utf-8'),
          filename: 'messaggio.eml',
          oggetto: `Messaggio ${campaign.channelType} trasmesso`,
        });
      }

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
        allegati: allegati.length > 0 ? allegati : undefined,
      });
      await this.attemptRepo.update(attemptId, {
        protocolNumber: result.numeroProtocollo,
        protocolYear: result.annoProtocollo,
        protocolledAt: new Date(),
      });
      const msg = `Attempt ${attemptId} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`;
      this.logger.log(msg);
      jobLog(msg);

      if (campaign.channelType !== 'SEND') {
        const primaryChannel = campaign.channelType;
        await this.notificationQueues.addBulk(primaryChannel as EngineName, [
          {
            name: NOTIFICATION_JOB_SEND,
            data: {
              campaignId,
              recipientId,
              attemptId,
              channel: primaryChannel,
            },
            opts: { jobId: attemptId },
          },
        ]);
        const dispatchMsg = `Attempt ${attemptId} accodato sul canale primario ${primaryChannel} dopo protocollazione`;
        this.logger.log(dispatchMsg);
        jobLog(dispatchMsg);
      }
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
