import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { captureException } from '../common/sentry.util.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignService } from './remote-sign.service.js';
import { replaceAttachment, safeAttachmentPath } from './attachment-writer.util.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';

@Injectable()
// Esclusività per campagna garantita da hasActiveJob, non dalla coda.
@Processor(REMOTE_SIGN_QUEUE, { concurrency: 3 })
export class RemoteSignProcessor extends WorkerHost {
  private readonly logger = new Logger(RemoteSignProcessor.name);

  constructor(
    @InjectRepository(RemoteSignJob) private readonly jobRepo: Repository<RemoteSignJob>,
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    private readonly client: ArubaSignClient,
    private readonly service: RemoteSignService,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly verification: SignatureVerificationService,
    private readonly audit: AuditLogsService,
  ) {
    super();
  }

  /** Chiusura sessione ARSS best-effort quando il job non deve proseguire. */
  private async closeQuietly(data: RemoteSignQueueJobData): Promise<void> {
    try {
      const creds = { user: data.user, password: this.service.decryptPassword(data.passwordEnc) };
      await this.client.closeSession(data.sessionId, creds);
    } catch {
      // credenziali illeggibili: la sessione scadrà da sola lato Aruba
    }
  }

  async process(job: Job<RemoteSignQueueJobData>): Promise<void> {
    const { jobId, campaignId, sessionId, user, passwordEnc } = job.data;
    // Claim atomico queued→processing: dopo un riavvio BullMQ può rieseguire
    // un job stalled la cui riga è già stata chiusa FAILED dalla
    // riconciliazione — in quel caso non si tocca nulla.
    const claim = await this.jobRepo.createQueryBuilder()
      .update(RemoteSignJob)
      .set({ status: RemoteSignJobStatus.PROCESSING })
      .where('id = :id AND status = :queued', { id: jobId, queued: RemoteSignJobStatus.QUEUED })
      .execute();
    if (claim.affected !== 1) {
      this.logger.warn(`Firma remota ${jobId}: job non più in coda (riavvio?), esecuzione ignorata`);
      await this.closeQuietly(job.data);
      return;
    }
    let campaignRow: Campaign | null = null;
    let abortMessage: string | null = null;
    try {
      campaignRow = await this.campaignRepo.findOneBy({ id: campaignId });
      if (campaignRow?.status !== CampaignStatus.DRAFT) abortMessage = 'La campagna non è più in bozza';
    } catch (err) {
      captureException(err, { jobId, campaignId, stage: 'remoteSignCampaign' });
      abortMessage = 'Errore imprevisto durante la firma: rilancia la firma';
    }
    if (abortMessage || !campaignRow) {
      this.logger.warn(`Firma remota ${jobId}: annullata prima di firmare (${abortMessage})`);
      await this.closeQuietly(job.data);
      await this.jobRepo.update({ id: jobId }, {
        status: RemoteSignJobStatus.FAILED,
        errorMessage: abortMessage,
        completedAt: new Date(),
      });
      return;
    }

    let creds: { user: string; password: string } | null = null;
    const startedAt = Date.now();
    let signedCount = 0;
    let failedCount = 0;
    let alreadyValidCount = 0;
    let signerCn: string | null = null;
    let stop: RemoteSignError | null = null;
    let total = 0;

    try {
      try {
        creds = { user, password: this.service.decryptPassword(passwordEnc) };
      } catch (err) {
        captureException(err, { jobId, campaignId, stage: 'remoteSignDecrypt' });
        throw new RemoteSignError('credentials', 'Impossibile leggere le credenziali di firma: rilancia la firma');
      }
      const { toSign } = await this.service.listFilesToSign(campaignId);
      total = toSign.length;
      for (const filename of toSign) {
        const path = safeAttachmentPath(campaignId, filename);
        if (!path || !fs.existsSync(path)) {
          failedCount++;
          continue;
        }
        try {
          const current = fs.readFileSync(path);
          // signatureCheck è per destinatario, non per file: lo stesso file può
          // essere già firmato validamente (es. ricaricato nel frattempo).
          if ((await this.verification.verify(current, filename)).valid) {
            alreadyValidCount++;
            continue;
          }
          const signed = await this.client.signPdf(sessionId, creds, current);
          replaceAttachment(campaignId, filename, signed);
          signedCount++;
          if (!signerCn) {
            try {
              signerCn = (await this.verification.verify(signed, filename)).signerCn ?? null;
            } catch (err) {
              // Solo informativo (CN nel riepilogo): il file è già firmato e sostituito.
              captureException(err, { jobId, campaignId, stage: 'remoteSignSignerCn' });
            }
          }
        } catch (err) {
          if (err instanceof RemoteSignError && err.kind !== 'file') {
            stop = err;
            break;
          }
          // Rifiuto del singolo file, oppure errore fs/imprevisto su questo file:
          // conta come fallito e si prosegue col successivo.
          failedCount++;
          if (!(err instanceof RemoteSignError)) captureException(err, { jobId, campaignId, stage: 'remoteSign' });
        }
        await this.jobRepo.update({ id: jobId }, { signedCount, failedCount });
      }
    } catch (err) {
      // Qualsiasi errore fuori dal ciclo per-file (elenco file, DB, ...): il job
      // deve comunque chiudersi FAILED, mai restare queued/processing.
      if (err instanceof RemoteSignError) {
        stop = err;
      } else {
        captureException(err, { jobId, campaignId, stage: 'remoteSign' });
        stop = new RemoteSignError('network', 'Errore imprevisto durante la firma: rilancia la firma');
      }
    } finally {
      if (creds) await this.client.closeSession(sessionId, creds);
      // PRIMA della nuova verifica, POI lo stato finale: la UI legge "job
      // concluso" e subito dopo l'ultima verifica — deve già essere la nuova.
      try {
        await this.verificationBulk.startForCampaign(campaignId);
      } catch (err) {
        captureException(err, { jobId, campaignId, stage: 'remoteSignReverify' });
        this.logger.warn(`Firma remota ${jobId}: riavvio verifica firma fallito`);
      }
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const errorMessage = stop
        ? stop.kind === 'session'
          ? `Sessione scaduta dopo ${signedCount} file su ${total} (${seconds} s): inserisci un nuovo OTP per i rimanenti`
          : stop.message
        : null;
      if (stop) this.logger.warn(`Firma remota ${jobId} interrotta (${stop.kind}) dopo ${signedCount}/${total} file in ${seconds} s`);
      else this.logger.log(`Firma remota ${jobId}: ${signedCount} firmati, ${failedCount} falliti, ${alreadyValidCount} già validi su ${total} in ${seconds} s`);
      await this.jobRepo.update({ id: jobId }, {
        status: stop ? RemoteSignJobStatus.FAILED : RemoteSignJobStatus.DONE,
        signedCount,
        failedCount,
        signerCn,
        errorKind: stop?.kind ?? null,
        errorMessage,
        completedAt: new Date(),
      });
      try {
        // Operatore ComunicaPA che ha avviato la firma (non lo username Aruba).
        const jobRow = await this.jobRepo.findOneBy({ id: jobId });
        await this.audit.log({
          campaignId,
          campaignName: campaignRow.name ?? null,
          operator: jobRow?.operator ?? user,
          action: 'REMOTE_SIGN',
          details: { jobId, signerCn, signed: signedCount, failed: failedCount, alreadyValid: alreadyValidCount, total, errorKind: stop?.kind ?? null, seconds },
        });
      } catch (err) {
        captureException(err, { jobId, campaignId, stage: 'remoteSignAudit' });
      }
    }
  }
}
