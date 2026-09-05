import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { Recipient } from '../../entities/recipient.entity';
import {
  REGISTRO_IMPRESE_QUEUE,
  VERIFY_PIVA_JOB_NAME,
  VERIFY_PIVA_CAMPAIGN_JOB_NAME,
  RegistroImpreseVerifyJobData,
  RegistroImpreseCampaignVerifyJobData,
} from './registro-imprese-job.types';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

type AnyJobData = RegistroImpreseVerifyJobData | RegistroImpreseCampaignVerifyJobData;

/**
 * Stessa coda/worker per due job.name diversi (stesso rate limiter 5/sec
 * verso Registro Imprese, mai superato anche se i due percorsi corrono in
 * parallelo — vedi CLAUDE.md "queue.add() con jobId esistente"):
 * - VERIFY_PIVA_JOB_NAME: 1 job = 1 Partita IVA per l'ad-hoc "Verifica INAD
 *   Massiva" — scrive su inad_verification_jobs.piva_results (UPDATE jsonb
 *   concat, mai read-modify-write — job paralleli sullo stesso job padre).
 * - VERIFY_PIVA_CAMPAIGN_JOB_NAME: 1 job = 1 destinatario di una campagna
 *   massiva in CHECKING_INAD — scrive direttamente su recipients.inad_check/
 *   pec, stesso schema del loop sincrono runInadExtractLoop
 *   (campaigns.service.ts) per campagne piccole. Nessuna scrittura
 *   concorrente sulla stessa riga (1 destinatario = 1 job), un semplice
 *   `.update()` basta.
 */
@Injectable()
@Processor(REGISTRO_IMPRESE_QUEUE, { concurrency: 1, limiter: { max: 5, duration: 1000 } })
export class RegistroImpreseVerifyProcessor extends WorkerHost {
  private readonly logger = new Logger(RegistroImpreseVerifyProcessor.name);

  constructor(
    private readonly registroImpreseService: RegistroImpreseService,
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {
    super();
  }

  async process(job: Job<AnyJobData>): Promise<void> {
    if (job.name === VERIFY_PIVA_JOB_NAME) {
      return this.processAdHocVerify(job as Job<RegistroImpreseVerifyJobData>);
    }
    if (job.name === VERIFY_PIVA_CAMPAIGN_JOB_NAME) {
      return this.processCampaignVerify(job as Job<RegistroImpreseCampaignVerifyJobData>);
    }
  }

  private async processAdHocVerify(job: Job<RegistroImpreseVerifyJobData>): Promise<void> {
    const { jobId, partitaIva } = job.data;

    let pec: string | null = null;
    let found = false;
    try {
      const result = await this.registroImpreseService.dettaglioImpresa(partitaIva);
      found = result.found;
      pec = result.pec ?? null;
    } catch (error) {
      if (error instanceof RegistroImpreseRateLimitError) {
        throw error; // BullMQ ritenta con backoff esponenziale (opts su queue.add)
      }
      this.logger.warn(`Verifica Registro Imprese fallita per ${partitaIva} (job ${jobId}): ${error instanceof Error ? error.message : error}`);
      found = false;
      pec = null;
    }

    await this.jobRepo.query(
      `UPDATE inad_verification_jobs
       SET piva_results = COALESCE(piva_results, '{}'::jsonb) || $1::jsonb,
           piva_done = piva_done + 1,
           piva_found_count = piva_found_count + $2
       WHERE id = $3`,
      [JSON.stringify({ [partitaIva]: pec }), found ? 1 : 0, jobId],
    );
  }

  /**
   * Errore generico (non rate-limit): il job va comunque a 'completed' (nessun
   * throw) — il poller (InadCheckSyncService) tratta 'completed'/'failed' allo
   * stesso modo (job concluso), e qui nessuna scrittura su recipient.inadCheck
   * equivale a "nessun override, resta sul canale originale" — stesso
   * comportamento del catch in runInadExtractLoop per un CF persona fisica.
   */
  private async processCampaignVerify(job: Job<RegistroImpreseCampaignVerifyJobData>): Promise<void> {
    const { recipientId, partitaIva, originalChannel, originalAddress, recipientPec } = job.data;

    let result: { found: boolean; pec?: string } | undefined;
    try {
      result = await this.registroImpreseService.dettaglioImpresa(partitaIva);
    } catch (error) {
      if (error instanceof RegistroImpreseRateLimitError) {
        throw error;
      }
      this.logger.warn(`Verifica Registro Imprese fallita per destinatario ${recipientId} (PIVA ${partitaIva}): ${error instanceof Error ? error.message : error}`);
      return;
    }

    const found = result.found;
    const pec = found ? result.pec ?? null : null;
    // Stessa base di confronto del loop sincrono runInadExtractLoop:
    // SEMPRE recipient.pec grezzo, mai originalAddress (che per canali
    // diversi da PEC è recipient.email, un campo audit-only).
    const diverted = found && pec !== recipientPec;

    await this.recipientRepo.update(
      { id: recipientId },
      {
        inadCheck: {
          found,
          diverted,
          originalChannel,
          originalAddress,
          checkedAt: new Date().toISOString(),
        },
        ...(diverted ? { pec } : {}),
      },
    );
  }

  /**
   * BullMQ emette 'failed' ad OGNI tentativo fallito, non solo all'esaurimento
   * finale — va ignorato finché ci sono ancora retry pianificati (altrimenti
   * il job padre resta bloccato in PROCESSING per sempre: process() qui non
   * scrive mai piva_done su RegistroImpreseRateLimitError, la riscrive solo
   * process() su esito/errore generico o questo handler sull'esaurimento
   * finale — mai entrambi per lo stesso tentativo). Solo VERIFY_PIVA_JOB_NAME
   * ha bisogno di questo: il completamento del job padre (InadVerificationJob)
   * dipende dal contatore piva_done, mai incrementato su un throw ripetuto.
   * VERIFY_PIVA_CAMPAIGN_JOB_NAME non serve qui — il poller tratta 'failed'
   * come concluso a prescindere (RegistroImpreseVerifyQueueService.isCampaignJobDone),
   * nessun contatore da sbloccare.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AnyJobData> | undefined): Promise<void> {
    if (!job || job.name !== VERIFY_PIVA_JOB_NAME) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if ((job.attemptsMade ?? 0) < maxAttempts) return; // ritenterà ancora, non è esaurimento finale

    const { jobId, partitaIva } = job.data as RegistroImpreseVerifyJobData;
    this.logger.warn(
      `Verifica Registro Imprese esaurita per ${partitaIva} (job ${jobId}) dopo ${job.attemptsMade} tentativi: trattata come non trovata per sbloccare il job padre.`,
    );
    await this.jobRepo.query(
      `UPDATE inad_verification_jobs
       SET piva_results = COALESCE(piva_results, '{}'::jsonb) || $1::jsonb,
           piva_done = piva_done + 1
       WHERE id = $2`,
      [JSON.stringify({ [partitaIva]: null }), jobId],
    );
  }
}
