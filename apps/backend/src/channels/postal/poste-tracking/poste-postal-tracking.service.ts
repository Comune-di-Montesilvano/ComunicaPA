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
import { isDeliveryToSender, lastMovement, mapPosteOutcome, PosteTrackingError, type DeliveryContext, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';
import { PostalProvidersService } from '../../../postal-providers/postal-providers.service.js';
import { resolvePhysicalAddress } from '../../payment-config.util.js';
import { POSTE_TRACKING_DAYS } from './poste-tracking-effective.util.js';
const NETWORK_ERROR_THRESHOLD = 5;
const BLOCK_THRESHOLD = 2;
const MAX_COOLDOWN_MS = 4 * 60 * 60_000;
const JITTER_RATIO = 0.3;
const DAY_MS = 86_400_000;
/** Mai due chiamate a Poste per la stessa notifica entro 23 ore, da chiunque partano. */
const MIN_RECHECK_MS = 23 * 60 * 60_000;
// Priorità della coda (cron e run di campagna): prima le notifiche mai
// controllate su Poste (nessuna risposta valida), poi le controllate più
// vecchie.
const NEVER_CHECKED_FIRST_SQL = 'CASE WHEN t.poste_esito_ricerca IS NULL THEN 0 ELSE 1 END';
const DISABLED_MESSAGE = 'Verifica consegna su Poste disattivata (Impostazioni → Postalizzazione)';

export type CheckResult = PosteTrackingStatus | 'error' | 'blocked' | 'skipped';

export interface PosteCampaignRunState {
  running: boolean;
  total: number;
  done: number;
  delivered: number;
  returned: number;
  errors: number;
  /** Già controllate nelle ultime 23 ore: nessuna chiamata a Poste. */
  skipped: number;
  remaining: number;
  /** Stima: rimanenti × intervallo tra le chiamate (pause per blocco escluse). */
  etaSeconds: number;
  /** Coda in pausa perché Poste limita le richieste: ripresa automatica a questa ora. */
  blockedUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PosteQueueHealth {
  enabled: boolean;
  processing: boolean;
  blockedUntil: string | null;
  pending: number;
  dueNow: number;
  delivered: number;
  returned: number;
  gaveUp: number;
  intervalSeconds: number;
  activeCampaignRuns: number;
  lastTickAt: string | null;
  lastTickChecks: number;
}

interface CampaignRun {
  queue: string[];
  total: number;
  done: number;
  delivered: number;
  returned: number;
  errors: number;
  skipped: number;
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
  private lastTickAt: Date | null = null;
  private lastTickChecks = 0;
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
    private readonly providers: PostalProvidersService,
  ) {}

  private reclassifiedOnce = false;

  /**
   * Contesto per riconoscere un ritorno che Poste chiude come "consegnata"
   * senza flagRitorno: città/nazione del destinatario (stessa risoluzione
   * dell'invio) e città del mittente del provider postale attivo.
   */
  protected async deliveryContextFor(row: PostalPosteTracking): Promise<DeliveryContext> {
    const attempt = await this.attemptRepo.findOne({ where: { id: row.attemptId }, relations: { recipient: { campaign: true } } });
    const recipient = attempt?.recipient;
    const address = recipient
      ? resolvePhysicalAddress(recipient, recipient.campaign?.channelConfig?.['physicalAddressConfig'] as Record<string, unknown> | undefined)
      : null;
    const provider = await this.providers.getActive();
    return {
      recipientForeign: !!address?.foreignState,
      recipientCity: address?.municipality ?? null,
      senderCity: provider?.mittente?.citta ?? null,
    };
  }

  /**
   * Righe già chiuse come "delivered" prima di questa regola: riesame dai
   * movimenti salvati (nessuna chiamata a Poste). Una volta per avvio.
   */
  async reclassifyDeliveredToSender(): Promise<number> {
    const rows = (await this.repo.find({ where: { status: 'delivered' } })) ?? [];
    let changed = 0;
    for (const row of rows) {
      const last = lastMovement(row.movements ?? []);
      if (!last) continue;
      if (isDeliveryToSender(last.luogo, await this.deliveryContextFor(row))) {
        row.status = 'returned';
        row.deliveredAt = null;
        row.outcomeAt = row.outcomeAt ?? (last.at ? new Date(last.at) : null);
        await this.repo.save(row);
        changed++;
      }
    }
    if (changed > 0) this.logger.log(`Verifica Poste: ${changed} righe "consegnate" riclassificate come restituite al mittente`);
    return changed;
  }

  private async isEnabled(): Promise<boolean> {
    return !!(await this.settings.get<boolean>('postalPosteTracking.enabled'));
  }

  private async intervalMs(): Promise<number> {
    const s = Number(await this.settings.get<number>('postalPosteTracking.intervalSeconds'));
    this.intervalSeconds = Number.isFinite(s) && s > 0 ? s : 15;
    return this.intervalSeconds * 1000;
  }

  private async staleDays(): Promise<number> {
    const d = Math.floor(Number(await this.settings.get<number>('postalPosteTracking.staleDays')));
    return Number.isFinite(d) && d > 0 ? d : 30;
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
    // staleDays è un intero validato (mai input utente grezzo nel testo SQL).
    const staleDays = await this.staleDays();
    const params: unknown[] = campaignId ? [campaignId] : [];
    const rows = await this.repo.query(
      `INSERT INTO postal_poste_tracking (attempt_id, tracking_code, status, next_check_at, tracking_until)
       SELECT na.id, na.postal_acceptance_id, 'pending', now(), COALESCE(na.sent_at, na.created_at) + interval '90 days'
       FROM notification_attempts na
       JOIN recipients r ON r.id = na.recipient_id
       WHERE na.channel_type = 'POSTAL'
         -- NonConsegnato terminale, oppure invio "fermo": GlobalCom non lo dà
         -- consegnato e non lo aggiorna da staleDays giorni (smette di seguirlo
         -- senza stato finale, es. Confermato/Accettato per settimane).
         AND (
           na.postal_status = 'NonConsegnato'
           OR (COALESCE(na.postal_status, '') <> 'Consegnato'
               AND COALESCE(na.postal_status_updated_at, na.sent_at, na.created_at) < now() - interval '${staleDays} days')
         )
         AND na.postal_acceptance_id IS NOT NULL AND na.postal_acceptance_id <> ''
         AND COALESCE(na.sent_at, na.created_at) > now() - interval '90 days'
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
    // Finestra di 90 giorni dalla notifica chiusa: il cron smette senza
    // chiamare Poste (il tasto manuale resta sempre disponibile).
    if (mode === 'cron' && row.status === 'pending' && this.windowClosed(row, now)) {
      row.status = 'gave_up';
      row.nextCheckAt = null;
      await this.repo.save(row);
      return 'gave_up';
    }
    // Ultimo controllo riuscito (nessun errore) da meno di 23 ore: niente
    // chiamata. Un tentativo bloccato/fallito non conta, si può riprovare.
    if (row.lastCheckedAt && !row.lastError && now.getTime() - row.lastCheckedAt.getTime() < MIN_RECHECK_MS) {
      if (mode === 'cron') {
        // Il controllo del giorno l'ha già fatto qualcun altro (tasto/campagna):
        // il giorno conta, prossimo controllo a 24 ore da quello.
        row.checkCount += 1;
        const next = new Date(row.lastCheckedAt.getTime() + DAY_MS);
        if (row.status === 'pending' && this.windowClosed(row, next)) {
          row.status = 'gave_up';
          row.nextCheckAt = null;
        } else {
          row.nextCheckAt = next;
        }
        await this.repo.save(row);
      }
      return 'skipped';
    }
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
    const { outcome, outcomeAt } = mapPosteOutcome(resp, await this.deliveryContextFor(row));
    // Riga già finale e Poste non dà un esito nuovo (es. spedizione purgata
    // dal tracking): movimenti, risposta e date salvati sono la prova
    // della consegna/ritorno, mai sovrascritti da una risposta vuota.
    if ((row.status === 'delivered' || row.status === 'returned') && outcome === 'pending') {
      // Riverifica di una riga già chiusa senza esito nuovo: fine riverifica.
      if (mode === 'cron') row.nextCheckAt = null;
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
      // Il prossimo controllo cadrebbe oltre la finestra: questo era l'ultimo.
      const next = new Date(now.getTime() + DAY_MS);
      if (this.windowClosed(row, next)) {
        row.status = 'gave_up';
        row.nextCheckAt = null;
      } else {
        row.nextCheckAt = next;
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
      // delivered con next_check_at impostato = riverifica una tantum (righe
      // valutate prima del flusso verifica+cookie, su dati ridotti di Poste).
      .where("t.status IN ('pending', 'delivered')")
      .andWhere('t.next_check_at <= now()')
      .andWhere("COALESCE(a.postal_status, '') <> 'Consegnato'")
      .orderBy(NEVER_CHECKED_FIRST_SQL, 'ASC')
      .addOrderBy('t.last_checked_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('t.created_at', 'ASC')
      // limit(), mai take(): take() con un join fa riscrivere a TypeORM la
      // query in DISTINCT + subquery, dove un ORDER BY su espressione SQL
      // fallisce ("alias was not found") — bug reale v1.8.3, coda ferma.
      .limit(1)
      .getOne();
    return row ? { row, mode: 'cron' } : null;
  }

  /** Righe pre-migrazione senza tracking_until: ripiego sul vecchio limite di 90 controlli. */
  private windowClosed(row: PostalPosteTracking, at: Date): boolean {
    return row.trackingUntil ? at.getTime() >= row.trackingUntil.getTime() : row.checkCount >= POSTE_TRACKING_DAYS;
  }

  private isRecentlyChecked(row: PostalPosteTracking): boolean {
    return !!row.lastCheckedAt && !row.lastError && Date.now() - row.lastCheckedAt.getTime() < MIN_RECHECK_MS;
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
      if (!this.reclassifiedOnce) {
        this.reclassifiedOnce = true;
        await this.reclassifyDeliveredToSender();
      }
      await this.backfill();
      const interval = await this.intervalMs();
      this.lastTickAt = new Date();
      this.lastTickChecks = 0;
      let calledBefore = false;
      let networkErrors = 0;
      for (;;) {
        const work = await this.nextWork();
        if (!work) break;
        // Pausa solo tra due chiamate reali: una riga saltata non chiama Poste.
        if (calledBefore && !this.isRecentlyChecked(work.row)) {
          await this.sleep(interval + Math.floor(Math.random() * interval * JITTER_RATIO));
        }
        const result = await this.checkOne(work.row, work.mode);
        if (result !== 'skipped') {
          calledBefore = true;
          this.lastTickChecks++;
        }
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
          if (result === 'skipped') work.run.skipped++;
          else if (result === 'delivered') work.run.delivered++;
          else if (result === 'returned') work.run.returned++;
          else if (result === 'error') work.run.errors++;
        }
        if (result === 'error') {
          networkErrors++;
          if (networkErrors >= NETWORK_ERROR_THRESHOLD) {
            this.logger.warn(`Verifica Poste interrotta dopo ${networkErrors} errori di rete consecutivi (ultimo: ${work.row.lastError})`);
            break;
          }
        } else if (result !== 'skipped') {
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

  async checkRecipientNow(campaignId: string, recipientId: string): Promise<{ row: PostalPosteTracking; result: CheckResult }> {
    if (!(await this.isEnabled())) throw new ConflictException(DISABLED_MESSAGE);
    if (this.isBlocked()) throw new ConflictException(`Poste sta limitando le richieste: riprova dopo le ${this.blockedUntil!.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`);
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    const attempt = await this.attemptRepo.findOne({ where: { recipientId, channelType: 'POSTAL' }, order: { attemptNumber: 'DESC' } });
    if (!attempt) throw new BadRequestException('Nessun tentativo POSTAL per questo destinatario');

    let row = await this.repo.findOneBy({ attemptId: attempt.id });
    if (!row) {
      if (attempt.postalStatus === 'Consegnato' || !attempt.postalAcceptanceId) {
        throw new BadRequestException('Verifica Poste disponibile solo per notifiche non ancora consegnate secondo GlobalCom e con codice di accettazione Poste');
      }
      const notifiedAt = attempt.sentAt ?? attempt.createdAt;
      row = await this.repo.save(this.repo.create({
        attemptId: attempt.id,
        trackingCode: attempt.postalAcceptanceId,
        status: 'pending',
        checkCount: 0,
        nextCheckAt: new Date(),
        trackingUntil: notifiedAt ? new Date(notifiedAt.getTime() + POSTE_TRACKING_DAYS * DAY_MS) : null,
      }));
    }
    const result = await this.checkOne(row, 'manual');
    return { row, result };
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
      .andWhere("COALESCE(a.postal_status, '') <> 'Consegnato'")
      .orderBy(NEVER_CHECKED_FIRST_SQL, 'ASC')
      .addOrderBy('t.last_checked_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('t.created_at', 'ASC')
      .getMany();
    const now = new Date().toISOString();
    this.campaignRuns.set(campaignId, {
      queue: rows.map((r) => r.id),
      total: rows.length,
      done: 0,
      delivered: 0,
      returned: 0,
      errors: 0,
      skipped: 0,
      startedAt: now,
      finishedAt: rows.length === 0 ? now : null,
    });
    if (rows.length > 0) void this.tick();
    return { total: rows.length };
  }

  /** Salute della coda per la tab Motori: stesso ruolo di PostalStatusSyncService.getQueueHealth. */
  async getQueueHealth(): Promise<PosteQueueHealth> {
    const rows: Array<{ status: string; n: number; due: number }> = (await this.repo.query(
      `SELECT status, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'pending' AND next_check_at <= now())::int AS due
       FROM postal_poste_tracking GROUP BY status`,
    )) ?? [];
    const by = (s: string) => rows.find((r) => r.status === s);
    return {
      enabled: await this.isEnabled(),
      processing: this.processing,
      blockedUntil: this.getBlockedUntil()?.toISOString() ?? null,
      pending: Number(by('pending')?.n ?? 0),
      dueNow: Number(by('pending')?.due ?? 0),
      delivered: Number(by('delivered')?.n ?? 0),
      returned: Number(by('returned')?.n ?? 0),
      gaveUp: Number(by('gave_up')?.n ?? 0),
      intervalSeconds: this.intervalSeconds,
      activeCampaignRuns: [...this.campaignRuns.values()].filter((r) => !r.finishedAt).length,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastTickChecks: this.lastTickChecks,
    };
  }

  getCampaignRun(campaignId: string): PosteCampaignRunState {
    const run = this.campaignRuns.get(campaignId);
    const blockedUntil = this.getBlockedUntil()?.toISOString() ?? null;
    if (!run) return { running: false, total: 0, done: 0, delivered: 0, returned: 0, errors: 0, skipped: 0, remaining: 0, etaSeconds: 0, blockedUntil, startedAt: null, finishedAt: null };
    const remaining = run.queue.length;
    return {
      running: !run.finishedAt,
      total: run.total,
      done: run.done,
      delivered: run.delivered,
      returned: run.returned,
      errors: run.errors,
      skipped: run.skipped,
      remaining,
      etaSeconds: remaining * this.intervalSeconds,
      blockedUntil,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

}
