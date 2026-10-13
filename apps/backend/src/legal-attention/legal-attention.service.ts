// apps/backend/src/legal-attention/legal-attention.service.ts
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { NotificationReview } from '../entities/notification-review.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { postalLegalOutcome } from '../campaigns/postal-legal-outcome.util.js';
import {
  fromUtcWallClock,
  isLegalAttentionCampaign,
  isReviewOpen,
  legalAttentionFlaggedSql,
  legalAttentionOf,
  type LegalAttentionAction,
  type LegalAttentionKind,
  type LegalAttentionResult,
} from './legal-attention.util.js';

export interface LegalAttentionUser {
  username: string;
  role: string;
}

export interface LegalAttentionSummaryItem {
  campaignId: string;
  name: string;
  channelType: string;
  createdBy: string;
  createdByDisplayName: string;
  blockingCount: number;
  staleCount: number;
}

export interface LegalAttentionItem {
  recipientId: string;
  fullName: string | null;
  codiceFiscale: string;
  kind: LegalAttentionKind;
  reason: string;
  firstAttemptAt: string | null;
  iun: string | null;
  postalCode: string | null;
  lastReview: { action: string; snoozedUntil: string | null; note: string | null; createdBy: string; createdByDisplayName: string; createdAt: string } | null;
}

export interface ApplyReviewsInput {
  recipientIds: string[];
  action: LegalAttentionAction;
  snoozedUntil?: string;
  note?: string;
}

export interface ApplyReviewsResult {
  applied: number;
  skipped: Array<{ recipientId: string; reason: string }>;
}

interface RecipientContext {
  recipient: Recipient;
  campaign: Campaign;
  firstAttempt: NotificationAttempt | null;
  lastAttempt: NotificationAttempt | null;
  classification: LegalAttentionResult | null;
  /** Ultima review per kind. */
  latestByKind: Map<string, NotificationReview>;
  /** Ultima review in assoluto, per la colonna "ultima azione". */
  latest: NotificationReview | null;
}

const DAY_MS = 86_400_000;
const MAX_SNOOZE_DAYS = 366;
const MAX_PAGE_SIZE = 200;
const EXCLUDED_RECIPIENT_STATUSES = ['cancelled', 'skipped'];
/**
 * Cache in memoria del riepilogo per utente: la query lavora su tutti i
 * destinatari delle campagne legali. Valida a singola istanza backend (come
 * gli eventi SSE dell'arricchimento); svuotata da ogni review applicata, il
 * pulsante "Aggiorna" la scavalca con refresh.
 */
const SUMMARY_CACHE_TTL_MS = 60_000;
/** "Aggiorna" ripetuto: sotto questa età la cache vale comunque (niente query a raffica). */
const SUMMARY_MIN_REFRESH_MS = 10_000;

@Injectable()
export class LegalAttentionService {
  private readonly logger = new Logger(LegalAttentionService.name);
  private readonly summaryCache = new Map<string, { at: number; value: { items: LegalAttentionSummaryItem[] } }>();

  constructor(
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient) private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt) private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(PostalPosteTracking) private readonly posteRepo: Repository<PostalPosteTracking>,
    @InjectRepository(NotificationReview) private readonly reviewRepo: Repository<NotificationReview>,
    private readonly operatorDirectory: OperatorDirectoryService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getSummary(user: LegalAttentionUser, opts: { refresh?: boolean } = {}): Promise<{ items: LegalAttentionSummaryItem[] }> {
    const isAdmin = user.role === 'admin';
    const cacheKey = isAdmin ? 'admin' : `user:${user.username}`;
    const cached = this.summaryCache.get(cacheKey);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < (opts.refresh ? SUMMARY_MIN_REFRESH_MS : SUMMARY_CACHE_TTL_MS)) return cached.value;

    const params: unknown[] = isAdmin ? [] : [user.username];
    const rows: Array<{ campaign_id: string; name: string; channel_type: string; created_by: string; blocking_count: number; stale_count: number }> =
      await this.recipientRepo.query(
        `SELECT f.campaign_id, c.name, c.channel_type, c.created_by,
                COUNT(*) FILTER (WHERE f.kind = 'blocking')::int AS blocking_count,
                COUNT(*) FILTER (WHERE f.kind = 'stale')::int AS stale_count
         FROM (${legalAttentionFlaggedSql(isAdmin ? '' : 'c.created_by = $1')}) f
         JOIN campaigns c ON c.id = f.campaign_id
         GROUP BY f.campaign_id, c.name, c.channel_type, c.created_by
         ORDER BY blocking_count DESC, stale_count DESC, c.name`,
        params,
      );
    const names = await this.operatorDirectory.resolveMany(rows.map((r) => r.created_by));
    const value = {
      items: rows.map((r) => ({
        campaignId: r.campaign_id,
        name: r.name,
        channelType: r.channel_type,
        createdBy: r.created_by,
        createdByDisplayName: names[r.created_by] ?? r.created_by,
        blockingCount: Number(r.blocking_count),
        staleCount: Number(r.stale_count),
      })),
    };
    this.summaryCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  async getCampaignItems(campaignId: string, user: LegalAttentionUser, page: number, pageSize: number): Promise<{ items: LegalAttentionItem[]; total: number }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign || !isLegalAttentionCampaign(campaign)) throw new NotFoundException(`Campagna ${campaignId} non trovata`);
    this.assertOwner(campaign, user);

    const size = Math.min(Math.max(Number(pageSize) || 50, 1), MAX_PAGE_SIZE);
    const current = Math.max(Number(page) || 1, 1);
    const rows: Array<{ recipient_id: string; kind: LegalAttentionKind; total: number }> = await this.recipientRepo.query(
      `SELECT f.recipient_id, f.kind, COUNT(*) OVER()::int AS total
       FROM (${legalAttentionFlaggedSql('r.campaign_id = $1')}) f
       ORDER BY (f.kind = 'blocking') DESC, f.first_at ASC, f.recipient_id
       LIMIT $2 OFFSET $3`,
      [campaignId, size, (current - 1) * size],
    );
    const total = rows.length ? Number(rows[0].total) : 0;
    const contexts = await this.loadContexts(rows.map((r) => r.recipient_id), new Date());
    const names = await this.operatorDirectory.resolveMany(
      [...contexts.values()].map((ctx) => ctx.latest?.createdBy ?? '').filter(Boolean),
    );

    const items: LegalAttentionItem[] = [];
    for (const row of rows) {
      const ctx = contexts.get(row.recipient_id);
      if (!ctx) continue;
      const c = ctx.classification;
      if (c?.kind !== row.kind) {
        this.logger.warn(`Classificazione SQL/TS divergente per destinatario ${row.recipient_id}: SQL=${row.kind} TS=${c?.kind ?? 'null'}`);
      }
      const a = ctx.lastAttempt;
      items.push({
        recipientId: ctx.recipient.id,
        fullName: ctx.recipient.fullName,
        codiceFiscale: ctx.recipient.codiceFiscale,
        kind: c?.kind ?? row.kind,
        reason: c?.reason ?? '',
        firstAttemptAt: ctx.firstAttempt ? fromUtcWallClock(ctx.firstAttempt.createdAt).toISOString() : null,
        iun: a?.iun ?? null,
        postalCode: a?.postalAcceptanceId ?? a?.postalTrackingId ?? null,
        lastReview: ctx.latest
          ? {
              action: ctx.latest.action,
              snoozedUntil: ctx.latest.snoozedUntil ? ctx.latest.snoozedUntil.toISOString() : null,
              note: ctx.latest.note,
              createdBy: ctx.latest.createdBy,
              createdByDisplayName: names[ctx.latest.createdBy] ?? ctx.latest.createdBy,
              createdAt: ctx.latest.createdAt.toISOString(),
            }
          : null,
      });
    }
    return { items, total };
  }

  async applyReviews(input: ApplyReviewsInput, user: LegalAttentionUser): Promise<ApplyReviewsResult> {
    const now = new Date();
    let snoozedUntil: Date | null = null;
    if (input.action === 'snooze') {
      if (!input.snoozedUntil) throw new BadRequestException('Data di posticipo obbligatoria');
      snoozedUntil = new Date(input.snoozedUntil);
      if (Number.isNaN(snoozedUntil.getTime()) || snoozedUntil.getTime() <= now.getTime()) {
        throw new BadRequestException('La data di posticipo deve essere futura');
      }
      if (snoozedUntil.getTime() - now.getTime() > MAX_SNOOZE_DAYS * DAY_MS) {
        throw new BadRequestException('Il posticipo massimo è di un anno');
      }
    }

    const ids = [...new Set(input.recipientIds)];
    const contexts = await this.loadContexts(ids, now);
    // Proprietà verificata su TUTTO prima di qualunque scrittura: 403 = nessuna riga.
    for (const ctx of contexts.values()) this.assertOwner(ctx.campaign, user);

    const note = input.note?.trim() || null;
    const skipped: ApplyReviewsResult['skipped'] = [];
    const toSave: NotificationReview[] = [];
    for (const id of ids) {
      const ctx = contexts.get(id);
      if (!ctx) { skipped.push({ recipientId: id, reason: 'Destinatario non trovato' }); continue; }
      const c = ctx.classification;
      if (!c) { skipped.push({ recipientId: id, reason: 'Non più segnalata' }); continue; }
      if (!isReviewOpen(ctx.latestByKind.get(c.kind), now)) { skipped.push({ recipientId: id, reason: 'Già gestita' }); continue; }
      if (input.action === 'snooze' && c.kind === 'blocking') {
        skipped.push({ recipientId: id, reason: 'Posticipo non ammesso per esito bloccante' });
        continue;
      }
      toSave.push(this.reviewRepo.create({
        recipientId: id,
        campaignId: ctx.campaign.id,
        kind: c.kind,
        action: input.action,
        snoozedUntil,
        reason: c.reason,
        note,
        createdBy: user.username,
      }));
    }

    if (toSave.length > 0) {
      await this.reviewRepo.save(toSave);
      this.summaryCache.clear();
      const byCampaign = new Map<string, { campaign: Campaign; recipientIds: string[] }>();
      for (const r of toSave) {
        const ctx = contexts.get(r.recipientId)!;
        const entry = byCampaign.get(ctx.campaign.id) ?? { campaign: ctx.campaign, recipientIds: [] };
        entry.recipientIds.push(r.recipientId);
        byCampaign.set(ctx.campaign.id, entry);
      }
      for (const { campaign, recipientIds } of byCampaign.values()) {
        await this.auditLogs.log({
          campaignId: campaign.id,
          campaignName: campaign.name,
          operator: user.username,
          action: input.action === 'ack' ? 'LEGAL_ATTENTION_ACK' : 'LEGAL_ATTENTION_SNOOZE',
          details: { count: recipientIds.length, recipientIds, snoozedUntil: snoozedUntil?.toISOString() ?? null, note },
        });
      }
    }
    return { applied: toSave.length, skipped };
  }

  private assertOwner(campaign: Campaign, user: LegalAttentionUser): void {
    if (user.role === 'admin') return;
    if (campaign.createdBy !== user.username) {
      throw new ForbiddenException('Operazione consentita solo su campagne create da te');
    }
  }

  private async loadContexts(ids: string[], now: Date): Promise<Map<string, RecipientContext>> {
    const out = new Map<string, RecipientContext>();
    if (ids.length === 0) return out;

    const recipients = await this.recipientRepo.find({ where: { id: In(ids) }, relations: { campaign: true } });
    const attempts = await this.attemptRepo.find({ where: { recipientId: In(ids) }, order: { attemptNumber: 'ASC' } });
    const reviews = await this.reviewRepo.find({ where: { recipientId: In(ids) }, order: { createdAt: 'DESC' } });

    const attemptsBy = new Map<string, NotificationAttempt[]>();
    for (const a of attempts) {
      const list = attemptsBy.get(a.recipientId) ?? [];
      list.push(a);
      attemptsBy.set(a.recipientId, list);
    }
    const lastIds = [...attemptsBy.values()].map((list) => list[list.length - 1].id);
    const poste = lastIds.length ? await this.posteRepo.find({ where: { attemptId: In(lastIds) } }) : [];
    const posteBy = new Map(poste.map((p) => [p.attemptId, p]));

    for (const recipient of recipients) {
      const campaign = recipient.campaign;
      const list = attemptsBy.get(recipient.id) ?? [];
      const firstAttempt = list.reduce<NotificationAttempt | null>((min, a) => (!min || a.createdAt < min.createdAt ? a : min), null);
      const lastAttempt = list.length ? list[list.length - 1] : null;

      let classification: LegalAttentionResult | null = null;
      if (isLegalAttentionCampaign(campaign) && !EXCLUDED_RECIPIENT_STATUSES.includes(recipient.status)) {
        const ppt = lastAttempt ? posteBy.get(lastAttempt.id) : undefined;
        const postal = campaign.channelType === 'POSTAL'
          ? postalLegalOutcome({
              diverted: !!recipient.inadCheck?.diverted,
              arTracking: true,
              attempt: lastAttempt,
              poste: ppt ? { status: ppt.status, outcomeAt: ppt.outcomeAt } : null,
            })
          : null;
        classification = legalAttentionOf({
          channelType: campaign.channelType,
          now,
          firstAttemptAt: firstAttempt ? fromUtcWallClock(firstAttempt.createdAt) : null,
          lastAttempt: lastAttempt
            ? {
                status: lastAttempt.status,
                errorMessage: lastAttempt.errorMessage,
                sendStatus: lastAttempt.sendStatus,
                sendStatusHistory: lastAttempt.sendStatusHistory,
              }
            : null,
          postal,
        });
      }

      const own = reviews.filter((r) => r.recipientId === recipient.id);
      const latestByKind = new Map<string, NotificationReview>();
      for (const r of own) if (!latestByKind.has(r.kind)) latestByKind.set(r.kind, r);

      out.set(recipient.id, { recipient, campaign, firstAttempt, lastAttempt, classification, latestByKind, latest: own[0] ?? null });
    }
    return out;
  }
}
