import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue, RedisQueueBackend } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES, ENGINE_NAMES, PROTOCOLLAZIONE_QUEUE, type EngineName } from './notification-job.types.js';

const FAILED_PAGE = 500;

/**
 * Job falliti con `finishedOn >= sinceMs`. Lo ZSET `failed` di BullMQ ha come
 * punteggio `finishedOn` (verificato su BullMQ 6): si legge dal più recente a
 * pagine e ci si ferma al primo più vecchio, quindi il costo dipende dai falliti
 * recenti, non dal totale. Il client astratto di BullMQ 6 non espone ZCOUNT.
 */
export async function countFailedSince(queue: Queue, sinceMs: number): Promise<number> {
  const client = await (queue.getBackend() as RedisQueueBackend).client;
  const key = queue.toKey('failed');
  let count = 0;
  for (let start = 0; ; start += FAILED_PAGE) {
    // [id1, score1, id2, score2, …], dal punteggio più alto.
    const page = await client.zrevrange(key, start, start + FAILED_PAGE - 1, { WITHSCORES: true });
    for (let i = 1; i < page.length; i += 2) {
      if (Number(page[i]) < sinceMs) return count;
      count++;
    }
    if (page.length < FAILED_PAGE * 2) return count;
  }
}

@Injectable()
export class NotificationQueuesService {
  private readonly queues: Map<EngineName, Queue<NotificationJobData>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUES.EMAIL) emailQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.PEC) pecQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.APP_IO) appIoQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.POSTAL) postalQueue: Queue<NotificationJobData>,
    @InjectQueue(PROTOCOLLAZIONE_QUEUE) protocollazioneQueue: Queue<NotificationJobData>,
  ) {
    this.queues = new Map<EngineName, Queue<NotificationJobData>>([
      ['EMAIL', emailQueue],
      ['PEC', pecQueue],
      ['APP_IO', appIoQueue],
      ['POSTAL', postalQueue],
      ['PROTOCOLLAZIONE', protocollazioneQueue],
    ]);
  }

  getQueue(channel: EngineName): Queue<NotificationJobData> {
    const queue = this.queues.get(channel);
    if (!queue) throw new Error(`Nessuna coda registrata per il motore ${channel}`);
    return queue;
  }

  addBulk(
    channel: EngineName,
    jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>,
  ) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJob(channel: EngineName, jobId: string) {
    return this.getQueue(channel).getJob(jobId);
  }

  getJobCounts(channel: EngineName): Promise<Record<string, number>> {
    return this.getQueue(channel).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed') as Promise<Record<string, number>>;
  }

  getFailedCountSince(channel: EngineName, sinceMs: number): Promise<number> {
    return countFailedSince(this.getQueue(channel), sinceMs);
  }

  /** Id di tutti i job falliti del motore (solo gli id, senza caricare i job). */
  getFailedJobIds(channel: EngineName): Promise<string[]> {
    return this.getQueue(channel).getRanges(['failed'], 0, -1);
  }

  /**
   * Toglie il job `jobId` dai falliti di qualunque motore, se c'è ed è ancora
   * `failed` (mai un job in corso/in attesa). Ritorna quanti ne ha rimossi.
   */
  async removeFailedJob(jobId: string, engines: readonly EngineName[] = ENGINE_NAMES): Promise<number> {
    let removed = 0;
    for (const engine of engines) {
      const job = await this.getQueue(engine).getJob(jobId);
      if (job && (await job.getState()) === 'failed') {
        await job.remove();
        removed++;
      }
    }
    return removed;
  }

  async getLastFailedAt(channel: EngineName): Promise<string | null> {
    const [job] = await this.getQueue(channel).getFailed(0, 0);
    return job?.finishedOn ? new Date(job.finishedOn).toISOString() : null;
  }

  isPaused(channel: EngineName): Promise<boolean> {
    return this.getQueue(channel).isPaused();
  }

  pause(channel: EngineName): Promise<void> {
    return this.getQueue(channel).pause();
  }

  resume(channel: EngineName): Promise<void> {
    return this.getQueue(channel).resume();
  }

  /**
   * `queue.getJobs()` per 'completed'/'failed' legge da uno ZSET BullMQ il
   * cui ordine non è garantito "più recenti prima" — ordinamento esplicito
   * qui per rispondere senza ambiguità a "questi sono i job più vecchi o i
   * più nuovi?" (richiesta reale: il pannello mostrava campagne vecchie di
   * mesi in cima, indistinguibili da quelle della campagna corrente senza
   * alcuna data visibile). `finishedOn` quando c'è (job concluso), altrimenti
   * `timestamp` (creazione, per active/waiting/delayed).
   */
  async getJobsDetail(
    channel: EngineName,
    status: 'failed' | 'completed' | 'active' | 'waiting' | 'delayed',
    limit = 50,
  ): Promise<Array<{
    jobId: string;
    campaignId: string;
    campaignName: string | null;
    recipientId: string;
    attemptId: string;
    failedReason?: string;
    attemptsMade: number;
    timestamp: number;
    finishedOn?: number;
  }>> {
    const jobs = await this.getQueue(channel).getJobs([status], 0, limit - 1);
    const sorted = [...jobs].sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp));
    return sorted.map((job) => ({
      jobId: String(job.id),
      campaignId: job.data.campaignId,
      campaignName: null, // risolto dal chiamante (EnginesController), unico punto con accesso al repo Campaign
      recipientId: job.data.recipientId,
      attemptId: job.data.attemptId,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
    }));
  }

  async getJobLogs(channel: EngineName, jobId: string): Promise<string[]> {
    const { logs } = await this.getQueue(channel).getJobLogs(jobId);
    return logs;
  }
}
