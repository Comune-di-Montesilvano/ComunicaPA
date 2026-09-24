import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { PostalPosteTracking, type PosteTrackingStatus } from '../../../entities/postal-poste-tracking.entity.js';
import { NotificationAttempt } from '../../../entities/notification-attempt.entity.js';
import { Recipient } from '../../../entities/recipient.entity.js';
import { AppSettingsService } from '../../../settings/app-settings.service.js';
import { captureException } from '../../../common/sentry.util.js';
import { PosteTrackingClient } from './poste-tracking-client.service.js';
import { mapPosteOutcome, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';
import { POSTE_MAX_CHECKS } from './poste-tracking-effective.util.js';

export const MAX_POSTE_CHECKS = POSTE_MAX_CHECKS;
const PAUSE_MS = 2_000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const DAY_MS = 86_400_000;
const DISABLED_MESSAGE = 'Verifica consegna su Poste disattivata (Impostazioni → Postalizzazione)';

export type CheckResult = PosteTrackingStatus | 'error';

export interface PosteCampaignRunState {
  running: boolean;
  total: number;
  done: number;
  delivered: number;
  returned: number;
  errors: number;
  aborted: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

const EMPTY_RUN: PosteCampaignRunState = { running: false, total: 0, done: 0, delivered: 0, returned: 0, errors: 0, aborted: false, startedAt: null, finishedAt: null };

/**
 * Verifica consegna su tracking Poste per gli attempt POSTAL che GlobalCom
 * chiude come NonConsegnato. Sola lettura esterna: niente motore BullMQ,
 * stesso modello @Cron di PostalStatusSyncService. Mai scritti i campi
 * postal_* dell'attempt — vedi spec 2026-09-24-postal-verifica-poste-design.md.
 */
@Injectable()
export class PostePostalTrackingService {
  private readonly logger = new Logger(PostePostalTrackingService.name);
  private cronRunning = false;
  private readonly campaignRuns = new Map<string, PosteCampaignRunState>();
  /** Sovrascrivibile nei test. */
  protected sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(PostalPosteTracking)
    private readonly repo: Repository<PostalPosteTracking>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly client: PosteTrackingClient,
    private readonly settings: AppSettingsService,
  ) {}

  private async isEnabled(): Promise<boolean> {
    return !!(await this.settings.get<boolean>('postalPosteTracking.enabled'));
  }

  /**
   * Ingresso idempotente: nessun hook nel sync GlobalCom, basta questo
   * INSERT all'avvio di ogni giro (ritardo max un giorno, irrilevante con
   * un controllo al giorno). Solo ultimo attempt del destinatario: un
   * reinvio successivo rende il vecchio NonConsegnato irrilevante.
   */
  async backfill(campaignId?: string): Promise<number> {
    const params: unknown[] = campaignId ? [campaignId] : [];
    const rows = await this.repo.query(
      `INSERT INTO postal_poste_tracking (attempt_id, tracking_code, status, next_check_at)
       SELECT na.id, na.postal_acceptance_id, 'pending', now()
       FROM notification_attempts na
       JOIN recipients r ON r.id = na.recipient_id
       WHERE na.channel_type = 'POSTAL'
         AND na.postal_status = 'NonConsegnato'
         AND na.postal_acceptance_id IS NOT NULL AND na.postal_acceptance_id <> ''
         AND NOT EXISTS (SELECT 1 FROM notification_attempts newer WHERE newer.recipient_id = na.recipient_id AND newer.attempt_number > na.attempt_number)
         ${campaignId ? 'AND r.campaign_id = $1' : ''}
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING id`,
      params,
    );
    return Array.isArray(rows) ? rows.length : 0;
  }

  async checkOne(row: PostalPosteTracking, mode: 'cron' | 'manual'): Promise<CheckResult> {
    // Cron e run manuale caricano i candidati all'inizio e li salvano anche
    // ore dopo: senza rileggere, uno snapshot vecchio riporterebbe a
    // pending una riga nel frattempo marcata delivered dall'altro giro.
    const fresh = await this.repo.findOneBy({ id: row.id });
    if (fresh) Object.assign(row, fresh);
    const now = new Date();
    row.lastCheckedAt = now;
    let resp: PosteTrackingResponse;
    try {
      resp = await this.client.track(row.trackingCode);
    } catch (err) {
      row.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (mode === 'cron') row.nextCheckAt = new Date(now.getTime() + DAY_MS);
      await this.repo.save(row);
      return 'error';
    }

    row.lastError = null;
    const { outcome, deliveredAt } = mapPosteOutcome(resp);
    // Riga già finale e Poste non dà un esito nuovo (es. spedizione purgata
    // dal tracking, esitoRicerca "1"): movimenti e risposta salvati sono la
    // prova della consegna/ritorno, mai sovrascritti da una risposta vuota.
    if ((row.status === 'delivered' || row.status === 'returned') && outcome === 'pending') {
      await this.repo.save(row);
      return row.status;
    }
    row.posteStato = resp.stato;
    row.posteEsitoRicerca = resp.esitoRicerca;
    row.posteProduct = resp.tipoProdotto;
    row.movements = resp.movements;
    row.lastResponse = resp.raw;
    if (mode === 'cron') row.checkCount += 1;

    if (outcome !== 'pending') {
      row.status = outcome;
      row.deliveredAt = deliveredAt;
      row.nextCheckAt = null;
    } else if (mode === 'cron') {
      if (row.checkCount >= MAX_POSTE_CHECKS) {
        row.status = 'gave_up';
        row.nextCheckAt = null;
      } else {
        row.nextCheckAt = new Date(now.getTime() + DAY_MS);
      }
    }
    await this.repo.save(row);
    return row.status;
  }

  /** Sequenziale con pausa; si ferma dopo N errori consecutivi (endpoint cambiato/giù). */
  private async processSequential(rows: PostalPosteTracking[], mode: 'cron' | 'manual', onResult?: (r: CheckResult) => void): Promise<{ aborted: boolean }> {
    let consecutiveErrors = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) await this.sleep(PAUSE_MS);
      const result = await this.checkOne(rows[i]!, mode);
      onResult?.(result);
      if (result === 'error') {
        consecutiveErrors++;
        if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
          this.logger.warn(`Verifica Poste interrotta dopo ${consecutiveErrors} errori consecutivi (ultimo: ${rows[i]!.lastError}) — endpoint poste.it cambiato o irraggiungibile?`);
          return { aborted: true };
        }
      } else {
        consecutiveErrors = 0;
      }
    }
    return { aborted: false };
  }

  @Cron('0 4 * * *', { timeZone: 'Europe/Rome' })
  async handleCron(): Promise<void> {
    if (this.cronRunning) return;
    if (!(await this.isEnabled())) return;
    this.cronRunning = true;
    try {
      await this.backfill();
      const rows = await this.repo
        .createQueryBuilder('t')
        .innerJoin(NotificationAttempt, 'a', 'a.id = t.attempt_id')
        .where("t.status = 'pending'")
        .andWhere('t.next_check_at <= now()')
        .andWhere("a.postal_status = 'NonConsegnato'")
        .orderBy('COALESCE(t.last_checked_at, t.created_at)', 'ASC')
        .getMany();
      await this.processSequential(rows, 'cron');
    } catch (err) {
      this.logger.warn(`Errore giro verifica Poste: ${err instanceof Error ? err.message : String(err)}`);
      captureException(err instanceof Error ? err : new Error(String(err)), { stage: 'postePostalTrackingCron' });
    } finally {
      this.cronRunning = false;
    }
  }

  async checkRecipientNow(campaignId: string, recipientId: string): Promise<PostalPosteTracking> {
    if (!(await this.isEnabled())) throw new ConflictException(DISABLED_MESSAGE);
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    const attempt = await this.attemptRepo.findOne({ where: { recipientId, channelType: 'POSTAL' }, order: { attemptNumber: 'DESC' } });
    if (!attempt) throw new BadRequestException('Nessun tentativo POSTAL per questo destinatario');

    let row = await this.repo.findOneBy({ attemptId: attempt.id });
    if (!row) {
      if (attempt.postalStatus !== 'NonConsegnato' || !attempt.postalAcceptanceId) {
        throw new BadRequestException('Verifica Poste disponibile solo per notifiche Non consegnate con codice di accettazione Poste');
      }
      row = await this.repo.save(this.repo.create({ attemptId: attempt.id, trackingCode: attempt.postalAcceptanceId, status: 'pending', checkCount: 0, nextCheckAt: new Date() }));
    }
    await this.checkOne(row, 'manual');
    return row;
  }

  /**
   * Tasto "Verifica su Poste" della campagna: a qualsiasi ora, ignora
   * next_check_at, include i gave_up. Risponde subito, il lavoro prosegue
   * in background; stato in memoria per campagna (letto dal GET in polling).
   */
  async startCampaignRun(campaignId: string): Promise<{ total: number }> {
    if (!(await this.isEnabled())) throw new ConflictException(DISABLED_MESSAGE);
    if (this.campaignRuns.get(campaignId)?.running) throw new ConflictException('Verifica su Poste già in corso per questa campagna');
    const state: PosteCampaignRunState = { ...EMPTY_RUN, running: true, startedAt: new Date().toISOString() };
    this.campaignRuns.set(campaignId, state);

    let rows: PostalPosteTracking[];
    try {
      await this.backfill(campaignId);
      rows = await this.repo
        .createQueryBuilder('t')
        .innerJoin(NotificationAttempt, 'a', 'a.id = t.attempt_id')
        .innerJoin(Recipient, 'r', 'r.id = a.recipient_id')
        .where('r.campaign_id = :campaignId', { campaignId })
        .andWhere("t.status IN ('pending', 'gave_up')")
        .andWhere("a.postal_status = 'NonConsegnato'")
        .orderBy('COALESCE(t.last_checked_at, t.created_at)', 'ASC')
        .getMany();
    } catch (err) {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      throw err;
    }
    state.total = rows.length;
    void this.runCampaign(campaignId, state, rows);
    return { total: rows.length };
  }

  private async runCampaign(campaignId: string, state: PosteCampaignRunState, rows: PostalPosteTracking[]): Promise<void> {
    try {
      const { aborted } = await this.processSequential(rows, 'manual', (r) => {
        state.done++;
        if (r === 'delivered') state.delivered++;
        else if (r === 'returned') state.returned++;
        else if (r === 'error') state.errors++;
      });
      state.aborted = aborted;
    } catch (err) {
      this.logger.warn(`Errore verifica Poste campagna ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
      captureException(err instanceof Error ? err : new Error(String(err)), { campaignId, stage: 'postePostalTrackingCampaignRun' });
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }

  getCampaignRun(campaignId: string): PosteCampaignRunState {
    return this.campaignRuns.get(campaignId) ?? { ...EMPTY_RUN };
  }
}
