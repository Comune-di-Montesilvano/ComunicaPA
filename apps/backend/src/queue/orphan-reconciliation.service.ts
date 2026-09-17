import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity.js';
import { NotificationQueuesService } from './notification-queues.service.js';
import { NOTIFICATION_JOB_SEND, ENGINE_NAMES, type EngineName } from './notification-job.types.js';
import { captureException } from '../common/sentry.util.js';

export interface OrphanReconciliationResult {
  checked: number;
  repaired: number;
}

/** Un attempt appena creato impiega qualche secondo prima che il job compaia
 * in coda (chunk bulk, latenza Redis) — soglia ampia per non ri-accodare un
 * invio che sta semplicemente per partire da solo. */
const ORPHAN_THRESHOLD_MINUTES = 30;

interface OrphanCandidate {
  attemptId: string;
  recipientId: string;
  campaignId: string;
  channelType: NotificationChannel;
}

/**
 * Ripara attempt rimasti `status='queued'` in DB il cui job BullMQ è andato
 * perso — causa nota: Redis riavviato prima dell'abilitazione AOF (vedi
 * docker-compose.yml `redis-server --appendonly yes`), o la finestra residua
 * tra scrittura attempt su Postgres e job accodato su Redis (due write non
 * transazionali). Incidente reale corretto a mano: campagna PEC, 2557
 * attempt orfani (vedi CLAUDE.md). Stesso pattern jobId=attemptId di
 * CampaignsService.createAttemptsAndEnqueue, riusato qui per il re-add.
 *
 * La coda BullMQ di destinazione è quella dell'ENGINE (calcolato dal
 * canale/flag protocollazione della CAMPAGNA, vedi createAttemptsAndEnqueue),
 * non quella dell'attempt.channelType da solo — un attempt dirottato da INAD
 * (es. campagna EMAIL, attempt.channelType='PEC') va comunque cercato/
 * riparato nella coda EMAIL se la campagna non richiede protocollazione,
 * esattamente come lo accoderebbe il lancio originale.
 */
@Injectable()
export class OrphanReconciliationService {
  private readonly logger = new Logger(OrphanReconciliationService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly notificationQueues: NotificationQueuesService,
  ) {}

  private async findCandidatesByEngine(): Promise<Map<EngineName, OrphanCandidate[]>> {
    const threshold = new Date(Date.now() - ORPHAN_THRESHOLD_MINUTES * 60_000);
    const rows: Array<{
      attemptId: string;
      recipientId: string;
      channelType: NotificationChannel;
      campaignId: string;
      campaignChannelType: string;
      protocolla: boolean;
    }> = await this.attemptRepo
      .createQueryBuilder('a')
      .innerJoin('a.recipient', 'r')
      .innerJoin('campaigns', 'c', 'c.id = r.campaign_id')
      .where('a.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('a.created_at < :threshold', { threshold })
      .select([
        'a.id AS "attemptId"',
        'a.recipient_id AS "recipientId"',
        'a.channel_type AS "channelType"',
        'r.campaign_id AS "campaignId"',
        'c.channel_type AS "campaignChannelType"',
        `(c.channel_config->>'protocolla')::boolean AS "protocolla"`,
      ])
      .getRawMany();

    const byEngine = new Map<EngineName, OrphanCandidate[]>();
    for (const row of rows) {
      const engine: EngineName =
        row.campaignChannelType === 'SEND' || row.protocolla === true
          ? 'PROTOCOLLAZIONE'
          : (row.campaignChannelType as EngineName);
      const list = byEngine.get(engine) ?? [];
      list.push({
        attemptId: row.attemptId,
        recipientId: row.recipientId,
        campaignId: row.campaignId,
        channelType: row.channelType,
      });
      byEngine.set(engine, list);
    }
    return byEngine;
  }

  /** Ripara un singolo motore. Usata sia dal cron sia dal bottone manuale. */
  async reconcileEngine(engine: EngineName): Promise<OrphanReconciliationResult> {
    const byEngine = await this.findCandidatesByEngine();
    const candidates = byEngine.get(engine) ?? [];
    return this.repair(engine, candidates);
  }

  /** Ripara tutti i motori BullMQ in un solo giro (usata dal cron). */
  async reconcileAll(): Promise<Record<EngineName, OrphanReconciliationResult>> {
    const byEngine = await this.findCandidatesByEngine();
    const result = {} as Record<EngineName, OrphanReconciliationResult>;
    for (const engine of ENGINE_NAMES) {
      result[engine] = await this.repair(engine, byEngine.get(engine) ?? []);
    }
    return result;
  }

  private async repair(engine: EngineName, candidates: OrphanCandidate[]): Promise<OrphanReconciliationResult> {
    if (candidates.length === 0) return { checked: 0, repaired: 0 };

    const missing: OrphanCandidate[] = [];
    for (const candidate of candidates) {
      const job = await this.notificationQueues.getJob(engine, candidate.attemptId);
      if (!job) missing.push(candidate);
    }
    if (missing.length === 0) return { checked: candidates.length, repaired: 0 };

    const CHUNK = 500;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      await this.notificationQueues.addBulk(
        engine,
        chunk.map((c) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId: c.campaignId,
            recipientId: c.recipientId,
            attemptId: c.attemptId,
            channel: c.channelType,
          },
          opts: { jobId: c.attemptId },
        })),
      );
    }
    return { checked: candidates.length, repaired: missing.length };
  }

  @Cron('0 3 * * *')
  async handleCron(): Promise<void> {
    const result = await this.reconcileAll();
    const total = Object.values(result).reduce((sum, r) => sum + r.repaired, 0);
    if (total === 0) return;

    const detail = Object.entries(result)
      .filter(([, r]) => r.repaired > 0)
      .map(([engine, r]) => `${engine}: ${r.repaired}/${r.checked}`)
      .join(', ');
    this.logger.warn(`Riconciliazione job orfani: riparati ${total} attempt (${detail})`);
    captureException(new Error(`Riconciliazione job orfani: riparati ${total} attempt (${detail})`), { result });
  }
}
