import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { REGISTRO_IMPRESE_QUEUE, VERIFY_PIVA_JOB_NAME, RegistroImpreseVerifyJobData } from './registro-imprese-job.types';

/**
 * Accoda una verifica Registro Imprese per una singola PIVA. jobId BullMQ =
 * `<InadVerificationJob.id>:<partitaIva>` — dedup naturale, stesso pattern
 * "jobId = attemptId" già in uso per le code di invio (vedi CLAUDE.md).
 * attempts+backoff esponenziale assorbono i 429 senza intervento manuale.
 */
@Injectable()
export class RegistroImpreseVerifyQueueService {
  constructor(@InjectQueue(REGISTRO_IMPRESE_QUEUE) private readonly queue: Queue<RegistroImpreseVerifyJobData>) {}

  async enqueueVerify(jobId: string, partitaIva: string): Promise<void> {
    await this.queue.add(VERIFY_PIVA_JOB_NAME, { jobId, partitaIva }, {
      jobId: `${jobId}:${partitaIva}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
}
