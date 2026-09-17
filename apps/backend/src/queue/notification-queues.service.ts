import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES, PROTOCOLLAZIONE_QUEUE, type EngineName } from './notification-job.types.js';

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
