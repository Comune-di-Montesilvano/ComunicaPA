import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  REGISTRO_IMPRESE_QUEUE,
  VERIFY_PIVA_JOB_NAME,
  VERIFY_PIVA_CAMPAIGN_JOB_NAME,
  RegistroImpreseVerifyJobData,
  RegistroImpreseCampaignVerifyJobData,
} from './registro-imprese-job.types';

type AnyJobData = RegistroImpreseVerifyJobData | RegistroImpreseCampaignVerifyJobData;

function campaignJobId(campaignId: string, recipientId: string): string {
  return `campaign:${campaignId}:${recipientId}`;
}

/**
 * Accoda verifiche Registro Imprese — sia per l'ad-hoc "Verifica INAD
 * Massiva" (`enqueueVerify`) sia per il check "dirottamento domicilio
 * digitale" al lancio di una campagna massiva (`enqueueCampaignVerify`).
 * Stessa coda/rate-limiter per entrambi i percorsi: mai superare il limite
 * reale verso Registro Imprese anche se corrono in parallelo.
 */
@Injectable()
export class RegistroImpreseVerifyQueueService {
  constructor(@InjectQueue(REGISTRO_IMPRESE_QUEUE) private readonly queue: Queue<AnyJobData>) {}

  async enqueueVerify(jobId: string, partitaIva: string): Promise<void> {
    await this.queue.add(VERIFY_PIVA_JOB_NAME, { jobId, partitaIva }, {
      jobId: `${jobId}:${partitaIva}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async enqueueCampaignVerify(
    campaignId: string,
    recipientId: string,
    partitaIva: string,
    originalChannel: string,
    originalAddress: string | null,
    recipientPec: string | null,
  ): Promise<void> {
    await this.queue.add(
      VERIFY_PIVA_CAMPAIGN_JOB_NAME,
      { campaignId, recipientId, partitaIva, originalChannel, originalAddress, recipientPec },
      {
        jobId: campaignJobId(campaignId, recipientId),
        attempts: 8,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  /**
   * Stato del job di verifica per un singolo destinatario di campagna —
   * 'done' copre sia 'completed' sia 'failed' (retry esauriti): in entrambi
   * i casi il job non produrrà più scritture, il poller (InadCheckSyncService)
   * può considerarlo concluso e procedere. 'missing' non dovrebbe mai capitare
   * in condizioni normali (job rimosso da qualcun altro) — trattato come 'done'
   * per non bloccare la campagna per sempre.
   */
  async isCampaignJobDone(campaignId: string, recipientId: string): Promise<boolean> {
    const job = await this.queue.getJob(campaignJobId(campaignId, recipientId));
    if (!job) return true;
    const state = await job.getState();
    return state === 'completed' || state === 'failed';
  }
}
