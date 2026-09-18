import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationQueuesService } from './notification-queues.service.js';
import { NOTIFICATION_JOB_SEND, ENGINE_NAMES, type EngineName } from './notification-job.types.js';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service.js';
import { captureException } from '../common/sentry.util.js';

export interface OrphanReconciliationResult {
  checked: number;
  repaired: number;
  /** Job BullMQ trovato ma già terminale (failed/completed), oppure assente
   * mentre l'attempt era 'processing' (possibile invio già partito) — in
   * entrambi i casi non riaccodabile in automatico, marcato FAILED per
   * sbloccare un retry manuale consapevole. Vedi commento su repair(). */
  markedFailed: number;
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
  attemptStatus: AttemptStatus.QUEUED | AttemptStatus.PROCESSING;
}

/**
 * Ripara attempt rimasti `status='queued'`/`'processing'` in DB il cui job
 * BullMQ è andato perso o è terminato senza che l'attempt venisse mai
 * aggiornato — causa nota: Redis riavviato prima dell'abilitazione AOF (vedi
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
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly notificationQueues: NotificationQueuesService,
    private readonly campaignCompletion: CampaignCompletionService,
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
      attemptStatus: AttemptStatus.QUEUED | AttemptStatus.PROCESSING;
    }> = await this.attemptRepo
      .createQueryBuilder('a')
      .innerJoin('a.recipient', 'r')
      .innerJoin('campaigns', 'c', 'c.id = r.campaign_id')
      .where('a.status IN (:...statuses)', { statuses: [AttemptStatus.QUEUED, AttemptStatus.PROCESSING] })
      .andWhere('a.created_at < :threshold', { threshold })
      .select([
        'a.id AS "attemptId"',
        'a.recipient_id AS "recipientId"',
        'a.channel_type AS "channelType"',
        'r.campaign_id AS "campaignId"',
        'c.channel_type AS "campaignChannelType"',
        `(c.channel_config->>'protocolla')::boolean AS "protocolla"`,
        'a.status AS "attemptStatus"',
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
        attemptStatus: row.attemptStatus,
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
    if (candidates.length === 0) return { checked: 0, repaired: 0, markedFailed: 0 };

    const missing: OrphanCandidate[] = [];
    /** Due sotto-casi diversi finiscono entrambi qui, mai riaccodati con lo
     * stesso jobId:
     * 1. Job Redis trovato ma già terminale (failed/completed) — incidente
     *    reale: Postgres riavviato durante l'invio ha fatto fallire sia
     *    l'invio sia la scrittura dello stato FAILED sull'attempt, che
     *    resta 'queued'/'processing' per sempre pur avendo un job BullMQ
     *    già chiuso. Riaggiungerlo con lo stesso jobId (attemptId) sarebbe
     *    un no-op silenzioso (dedup BullMQ).
     * 2. Job assente MA attempt era già 'processing' (non 'queued'): il
     *    worker aveva preso in carico l'invio quando è arrivato il blip —
     *    l'invio potrebbe essere realmente partito (PEC/email/App IO già
     *    recapitati) prima del crash. Riaccodare in automatico rischia un
     *    doppio invio reale: va marcato FAILED con un messaggio che invita
     *    a verificare a mano prima di un retry (diverso dal caso 'queued'
     *    assente, dove l'invio non è mai nemmeno partito).
     * 'active'/'waiting'/'delayed' non sono toccati qui: in corso o
     * gestiti dal recovery stalled-job di BullMQ. */
    const stalledTerminal: Array<{ candidate: OrphanCandidate; failedReason: string | null }> = [];
    for (const candidate of candidates) {
      const job = await this.notificationQueues.getJob(engine, candidate.attemptId);
      if (!job) {
        if (candidate.attemptStatus === AttemptStatus.PROCESSING) {
          stalledTerminal.push({
            candidate,
            failedReason:
              "Job BullMQ introvabile mentre l'attempt era in lavorazione (worker crashato durante un blip Redis/Postgres) — verificare manualmente se l'invio è stato effettivamente recapitato prima di rimettere in coda (rischio doppio invio)",
          });
        } else {
          missing.push(candidate);
        }
        continue;
      }
      const state = await job.getState();
      if (state === 'failed' || state === 'completed') {
        stalledTerminal.push({ candidate, failedReason: job.failedReason ?? null });
      }
    }

    if (missing.length > 0) {
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
    }

    const touchedCampaigns = new Set<string>();
    for (const { candidate, failedReason } of stalledTerminal) {
      const update = await this.attemptRepo.update(
        { id: candidate.attemptId, status: candidate.attemptStatus },
        {
          status: AttemptStatus.FAILED,
          errorMessage: failedReason ?? 'Job BullMQ terminato (failed/completed) senza che l\'attempt fosse mai marcato terminale — riconciliazione automatica',
        },
      );
      if (!update.affected) continue;
      const recUpdate = await this.recipientRepo.update(
        { id: candidate.recipientId, status: Not(RecipientStatus.FAILED) },
        { status: RecipientStatus.FAILED },
      );
      if (recUpdate.affected) {
        await this.campaignRepo.increment({ id: candidate.campaignId }, 'failedCount', 1);
      }
      touchedCampaigns.add(candidate.campaignId);
    }
    for (const campaignId of touchedCampaigns) {
      await this.campaignCompletion.checkAndComplete(campaignId);
    }

    return { checked: candidates.length, repaired: missing.length, markedFailed: stalledTerminal.length };
  }

  @Cron('0 3 * * *')
  async handleCron(): Promise<void> {
    const result = await this.reconcileAll();
    const totalRepaired = Object.values(result).reduce((sum, r) => sum + r.repaired, 0);
    const totalMarkedFailed = Object.values(result).reduce((sum, r) => sum + r.markedFailed, 0);
    if (totalRepaired === 0 && totalMarkedFailed === 0) return;

    const detail = Object.entries(result)
      .filter(([, r]) => r.repaired > 0 || r.markedFailed > 0)
      .map(([engine, r]) => `${engine}: ${r.repaired} riaccodati + ${r.markedFailed} marcati failed / ${r.checked} controllati`)
      .join(', ');
    this.logger.warn(`Riconciliazione job orfani: ${totalRepaired} riaccodati, ${totalMarkedFailed} marcati failed (${detail})`);
    captureException(new Error(`Riconciliazione job orfani: ${totalRepaired} riaccodati, ${totalMarkedFailed} marcati failed (${detail})`), { result });
  }
}
