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
import { mapPosteOutcome, PosteTrackingError, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';
import { POSTE_MAX_CHECKS } from './poste-tracking-effective.util.js';

export const MAX_POSTE_CHECKS = POSTE_MAX_CHECKS;
const NETWORK_ERROR_THRESHOLD = 5;
const BLOCK_THRESHOLD = 2;
const MAX_COOLDOWN_MS = 4 * 60 * 60_000;
const JITTER_RATIO = 0.3;
const DAY_MS = 86_400_000;
const DISABLED_MESSAGE = 'Verifica consegna su Poste disattivata (Impostazioni → Postalizzazione)';

export type CheckResult = PosteTrackingStatus | 'error' | 'blocked';

export interface PosteCampaignRunState {
  running: boolean;
  total: number;
  done: number;
  delivered: number;
  returned: number;
  errors: number;
  remaining: number;
  /** Stima: rimanenti × intervallo tra le chiamate (pause per blocco escluse). */
  etaSeconds: number;
  /** Coda in pausa perché Poste limita le richieste: ripresa automatica a questa ora. */
  blockedUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface CampaignRun {
  queue: string[];
  total: number;
  done: number;
  delivered: number;
  returned: number;
  errors: number;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Verifica consegna su tracking Poste per gli attempt POSTAL che GlobalCom
 * chiude come NonConsegnato. Una sola coda "a goccia" per tutto il backend
 * (cron ogni 5 minuti + run di campagna messi in testa alla stessa coda):
 * poste.it limita le richieste ravvicinate dallo stesso IP (400 dopo ~20
 * chiamate a 2 s, visto in produzione), quindi mai due giri in parallelo,
 * pausa configurabile tra le chiamate e pausa progressiva quando blocca.
 * Mai scritti i campi postal_* dell'attempt — vedi spec
 * 2026-09-24-postal-verifica-poste-design.md.
 */
@Injectable()
export class PostePostalTrackingService {
  private readonly logger = new Logger(PostePostalTrackingService.name);
  private processing = false;
  private blockedUntil: Date | null = null;
  private currentCooldownMs: number | null = null;
  private consecutiveBlocks = 0;
  private readonly campaignRuns = new Map<string, CampaignRun>();
  /** Ultimo intervallo letto dalle Impostazioni, per la stima del tempo residuo. */
  private intervalSeconds = 15;
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

  private async intervalMs(): Promise<number> {
    const s = Number(await this.settings.get<number>('postalPosteTracking.intervalSeconds'));
    this.intervalSeconds = Number.isFinite(s) && s > 0 ? s : 15;
    return this.intervalSeconds * 1000;
  }

  private async baseCooldownMs(): Promise<number> {
    const m = Number(await this.settings.get<number>('postalPosteTracking.cooldownMinutes'));
    return (Number.isFinite(m) && m > 0 ? m : 30) * 60_000;
  }

  private isBlocked(): boolean {
    return !!this.blockedUntil && this.blockedUntil.getTime() > Date.now();
  }

  getBlockedUntil(): Date | null {
    return this.isBlocked() ? this.blockedUntil : null;
  }

  /**
   * Ingresso idempotente: nessun hook nel sync GlobalCom, basta questo
   * INSERT all'avvio di ogni giro. Solo ultimo attempt del destinatario:
   * un reinvio successivo rende il vecchio NonConsegnato irrilevante.
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
    // Rilettura: un giro può aver caricato la riga molto prima di salvarla,
    // uno snapshot vecchio riporterebbe a pending una riga già delivered.
    const fresh = await this.repo.findOneBy({ id: row.id });
    if (fresh) Object.assign(row, fresh);
    const now = new Date();
    row.lastCheckedAt = now;
    let resp: PosteTrackingResponse;
    try {
      resp = await this.client.track(row.trackingCode);
    } catch (err) {
      row.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      // Blocco (4xx o pagina HTML): non è un esito del codice, si riprova
      // alla ripresa della coda senza spostare il prossimo controllo.
      const blocked = err instanceof PosteTrackingError && (err.kind === 'blocked' || err.kind === 'invalid_body');
      if (!blocked && mode === 'cron') row.nextCheckAt = new Date(now.getTime() + DAY_MS);
      await this.repo.save(row);
      return blocked ? 'blocked' : 'error';
    }

    row.lastError = null;
    const { outcome, outcomeAt } = mapPosteOutcome(resp);
    // Riga già finale e Poste non dà un esito nuovo (es. spedizione purgata
    // dal tracking): movimenti, risposta e date salvati sono la prova
    // della consegna/ritorno, mai sovrascritti da una risposta vuota.
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
      row.outcomeAt = outcomeAt;
      row.deliveredAt = outcome === 'delivered' ? outcomeAt : null;
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

  /** Prossimo lavoro: prima le campagne lanciate a mano, poi i dovuti del giorno. */
  private async nextWork(): Promise<{ row: PostalPosteTracking; mode: 'cron' | 'manual'; run?: CampaignRun } | null> {
    for (const run of this.campaignRuns.values()) {
      while (!run.finishedAt && run.queue.length > 0) {
        const row = await this.repo.findOneBy({ id: run.queue[0]! });
        if (row) return { row, mode: 'manual', run };
        run.queue.shift();
        run.done++;
      }
      if (!run.finishedAt) run.finishedAt = new Date().toISOString();
    }
    const row = await this.repo
      .createQueryBuilder('t')
      .innerJoin(NotificationAttempt, 'a', 'a.id = t.attempt_id')
      .where("t.status = 'pending'")
      .andWhere('t.next_check_at <= now()')
      .andWhere("a.postal_status = 'NonConsegnato'")
      .orderBy('COALESCE(t.last_checked_at, t.created_at)', 'ASC')
      .take(1)
      .getOne();
    return row ? { row, mode: 'cron' } : null;
  }

  private async enterCooldown(): Promise<void> {
    const base = await this.baseCooldownMs();
    this.currentCooldownMs = this.currentCooldownMs ? Math.min(this.currentCooldownMs * 2, MAX_COOLDOWN_MS) : base;
    this.blockedUntil = new Date(Date.now() + this.currentCooldownMs);
    this.consecutiveBlocks = 0;
    this.logger.warn(`Poste limita le richieste: verifica in pausa fino alle ${this.blockedUntil.toISOString()} (${Math.round(this.currentCooldownMs / 60_000)} min)`);
  }

  /**
   * Coda a goccia: ogni 5 minuti smaltisce il lavoro dovuto, una chiamata
   * alla volta con la pausa configurata. Non rientrante; in pausa per blocco
   * non parte finché non scade blockedUntil.
   */
  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (this.processing) return;
    if (!(await this.isEnabled())) return;
    if (this.isBlocked()) return;
    this.processing = true;
    try {
      await this.backfill();
      const interval = await this.intervalMs();
      let first = true;
      let networkErrors = 0;
      for (;;) {
        const work = await this.nextWork();
        if (!work) break;
        if (!first) await this.sleep(interval + Math.floor(Math.random() * interval * JITTER_RATIO));
        first = false;
        const result = await this.checkOne(work.row, work.mode);
        if (result === 'blocked') {
          this.consecutiveBlocks++;
          if (this.consecutiveBlocks >= BLOCK_THRESHOLD) {
            await this.enterCooldown();
            break;
          }
          continue;
        }
        this.consecutiveBlocks = 0;
        if (work.run) {
          work.run.queue.shift();
          work.run.done++;
          if (result === 'delivered') work.run.delivered++;
          else if (result === 'returned') work.run.returned++;
          else if (result === 'error') work.run.errors++;
        }
        if (result === 'error') {
          networkErrors++;
          if (networkErrors >= NETWORK_ERROR_THRESHOLD) {
            this.logger.warn(`Verifica Poste interrotta dopo ${networkErrors} errori di rete consecutivi (ultimo: ${work.row.lastError})`);
            break;
          }
        } else {
          networkErrors = 0;
          this.currentCooldownMs = null;
        }
      }
    } catch (err) {
      this.logger.warn(`Errore giro verifica Poste: ${err instanceof Error ? err.message : String(err)}`);
      captureException(err instanceof Error ? err : new Error(String(err)), { stage: 'postePostalTrackingTick' });
    } finally {
      this.processing = false;
    }
  }

  async checkRecipientNow(campaignId: string, recipientId: string): Promise<PostalPosteTracking> {
    if (!(await this.isEnabled())) throw new ConflictException(DISABLED_MESSAGE);
    if (this.isBlocked()) throw new ConflictException(`Poste sta limitando le richieste: riprova dopo le ${this.blockedUntil!.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`);
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
   * Tasto "Verifica su Poste": le righe della campagna (anche gave_up e non
   * ancora scadute) vanno in testa alla coda unica, che parte subito se è
   * ferma. Avanzamento letto dal GET in polling.
   */
  async startCampaignRun(campaignId: string): Promise<{ total: number }> {
    if (!(await this.isEnabled())) throw new ConflictException(DISABLED_MESSAGE);
    const existing = this.campaignRuns.get(campaignId);
    if (existing && !existing.finishedAt) throw new ConflictException('Verifica su Poste già in corso per questa campagna');

    await this.intervalMs();
    await this.backfill(campaignId);
    const rows = await this.repo
      .createQueryBuilder('t')
      .innerJoin(NotificationAttempt, 'a', 'a.id = t.attempt_id')
      .innerJoin(Recipient, 'r', 'r.id = a.recipient_id')
      .where('r.campaign_id = :campaignId', { campaignId })
      .andWhere("t.status IN ('pending', 'gave_up')")
      .andWhere("a.postal_status = 'NonConsegnato'")
      .orderBy('COALESCE(t.last_checked_at, t.created_at)', 'ASC')
      .getMany();
    const now = new Date().toISOString();
    this.campaignRuns.set(campaignId, {
      queue: rows.map((r) => r.id),
      total: rows.length,
      done: 0,
      delivered: 0,
      returned: 0,
      errors: 0,
      startedAt: now,
      finishedAt: rows.length === 0 ? now : null,
    });
    if (rows.length > 0) void this.tick();
    return { total: rows.length };
  }

  getCampaignRun(campaignId: string): PosteCampaignRunState {
    const run = this.campaignRuns.get(campaignId);
    const blockedUntil = this.getBlockedUntil()?.toISOString() ?? null;
    if (!run) return { running: false, total: 0, done: 0, delivered: 0, returned: 0, errors: 0, remaining: 0, etaSeconds: 0, blockedUntil, startedAt: null, finishedAt: null };
    const remaining = run.queue.length;
    return {
      running: !run.finishedAt,
      total: run.total,
      done: run.done,
      delivered: run.delivered,
      returned: run.returned,
      errors: run.errors,
      remaining,
      etaSeconds: remaining * this.intervalSeconds,
      blockedUntil,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

}
