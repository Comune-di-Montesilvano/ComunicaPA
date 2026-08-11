import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { REGISTRO_IMPRESE_QUEUE, VERIFY_PIVA_JOB_NAME, RegistroImpreseVerifyJobData } from './registro-imprese-job.types';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

/**
 * 1 job = 1 Partita IVA. Scrive l'esito con una UPDATE SQL raw che concatena
 * jsonb (mai una read-modify-write sull'intera colonna piva_results — job
 * paralleli sullo stesso InadVerificationJob altrimenti perderebbero
 * scritture in race). Il completamento del job padre (tutti i piva_done
 * raggiunti) è rilevato dal demone Cron InadVerifyBulkSyncService, non qui.
 */
@Injectable()
@Processor(REGISTRO_IMPRESE_QUEUE, { concurrency: 1, limiter: { max: 5, duration: 1000 } })
export class RegistroImpreseVerifyProcessor extends WorkerHost {
  private readonly logger = new Logger(RegistroImpreseVerifyProcessor.name);

  constructor(
    private readonly registroImpreseService: RegistroImpreseService,
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
  ) {
    super();
  }

  async process(job: Job<RegistroImpreseVerifyJobData>): Promise<void> {
    if (job.name !== VERIFY_PIVA_JOB_NAME) return;
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
   * BullMQ emette 'failed' ad OGNI tentativo fallito, non solo all'esaurimento
   * finale — va ignorato finché ci sono ancora retry pianificati (altrimenti
   * il job padre resta bloccato in PROCESSING per sempre: process() qui non
   * scrive mai piva_done su RegistroImpreseRateLimitError, la riscrive solo
   * process() su esito/errore generico o questo handler sull'esaurimento
   * finale — mai entrambi per lo stesso tentativo).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<RegistroImpreseVerifyJobData> | undefined): Promise<void> {
    if (!job || job.name !== VERIFY_PIVA_JOB_NAME) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if ((job.attemptsMade ?? 0) < maxAttempts) return; // ritenterà ancora, non è esaurimento finale

    const { jobId, partitaIva } = job.data;
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
