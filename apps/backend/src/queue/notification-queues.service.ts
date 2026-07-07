import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { NotificationChannel, NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES } from './notification-job.types';

@Injectable()
export class NotificationQueuesService {
  private readonly queues: Map<NotificationChannel, Queue<NotificationJobData>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUES.EMAIL) emailQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.PEC) pecQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.APP_IO) appIoQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.SEND) sendQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.POSTAL) postalQueue: Queue<NotificationJobData>,
  ) {
    this.queues = new Map([
      ['EMAIL', emailQueue],
      ['PEC', pecQueue],
      ['APP_IO', appIoQueue],
      ['SEND', sendQueue],
      ['POSTAL', postalQueue],
    ]);
  }

  getQueue(channel: NotificationChannel): Queue<NotificationJobData> {
    const queue = this.queues.get(channel);
    if (!queue) throw new Error(`Nessuna coda registrata per il canale ${channel}`);
    return queue;
  }

  addBulk(
    channel: NotificationChannel,
    jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>,
  ) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJob(channel: NotificationChannel, jobId: string) {
    return this.getQueue(channel).getJob(jobId);
  }

  getJobCounts(channel: NotificationChannel): Promise<Record<string, number>> {
    return this.getQueue(channel).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed') as Promise<Record<string, number>>;
  }

  isPaused(channel: NotificationChannel): Promise<boolean> {
    return this.getQueue(channel).isPaused();
  }

  pause(channel: NotificationChannel): Promise<void> {
    return this.getQueue(channel).pause();
  }

  resume(channel: NotificationChannel): Promise<void> {
    return this.getQueue(channel).resume();
  }

  async getJobsDetail(
    channel: NotificationChannel,
    status: 'failed' | 'completed' | 'active' | 'waiting' | 'delayed',
    limit = 50,
  ): Promise<Array<{
    jobId: string;
    campaignId: string;
    recipientId: string;
    attemptId: string;
    failedReason?: string;
    attemptsMade: number;
    timestamp: number;
    finishedOn?: number;
  }>> {
    const jobs = await this.getQueue(channel).getJobs([status], 0, limit - 1);
    return jobs.map((job) => ({
      jobId: String(job.id),
      campaignId: job.data.campaignId,
      recipientId: job.data.recipientId,
      attemptId: job.data.attemptId,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
    }));
  }

  async getJobLogs(channel: NotificationChannel, jobId: string): Promise<string[]> {
    const { logs } = await this.getQueue(channel).getJobLogs(jobId);
    return logs;
  }
}
