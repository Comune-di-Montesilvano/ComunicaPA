import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { join } from 'path';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { captureException } from '../common/sentry.util.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignService } from './remote-sign.service.js';
import { replaceAttachment } from './attachment-writer.util.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';

@Injectable()
@Processor(REMOTE_SIGN_QUEUE, { concurrency: 1 })
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

  async process(job: Job<RemoteSignQueueJobData>): Promise<void> {
    const { jobId, campaignId, sessionId, user, passwordEnc } = job.data;
    let creds: { user: string; password: string } | null = null;
    const startedAt = Date.now();
    let signedCount = 0;
    let failedCount = 0;
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
      await this.jobRepo.update({ id: jobId }, { status: RemoteSignJobStatus.PROCESSING });
      const { toSign } = await this.service.listFilesToSign(campaignId);
      total = toSign.length;
      for (const filename of toSign) {
        const path = join(getUploadsDir(campaignId), filename);
        if (!fs.existsSync(path)) {
          failedCount++;
          continue;
        }
        try {
          const signed = await this.client.signPdf(sessionId, creds, fs.readFileSync(path));
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
      else this.logger.log(`Firma remota ${jobId}: ${signedCount} firmati, ${failedCount} falliti su ${total} in ${seconds} s`);
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
        const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
        // Operatore ComunicaPA che ha avviato la firma (non lo username Aruba).
        const jobRow = await this.jobRepo.findOneBy({ id: jobId });
        await this.audit.log({
          campaignId,
          campaignName: campaign?.name ?? null,
          operator: jobRow?.operator ?? user,
          action: 'REMOTE_SIGN',
          details: { jobId, signerCn, signed: signedCount, failed: failedCount, total, errorKind: stop?.kind ?? null, seconds },
        });
      } catch (err) {
        captureException(err, { jobId, campaignId, stage: 'remoteSignAudit' });
      }
    }
  }
}
