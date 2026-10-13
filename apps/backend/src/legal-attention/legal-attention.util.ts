// apps/backend/src/legal-attention/legal-attention.util.ts
/**
 * Notifiche a valore legale senza esito (spec 2026-10-13-notifiche-senza-
 * esito-legale): classe derivata in lettura, mai salvata. Regola TS (dettaglio
 * e validazione review) e gemella SQL (conteggi, filtro, paginazione) stanno
 * qui insieme: modificarne una senza l'altra è un bug.
 */
import type { Campaign } from '../entities/campaign.entity.js';
import { hasPostalArTracking } from '../campaigns/campaigns.service.js';
import { postalLegalOutcomeCaseSql, type PostalLegalOutcomeResult } from '../campaigns/postal-legal-outcome.util.js';
import { sendLegalDateOf } from '../campaigns/send-legal-date.util.js';

export type LegalAttentionKind = 'blocking' | 'stale';
export type LegalAttentionAction = 'ack' | 'snooze';

export const STALE_AFTER_DAYS = 45;
const DAY_MS = 86_400_000;

const SEND_BLOCKING_LABELS: Record<string, string> = {
  REFUSED: 'Rifiutata da SEND',
  CANCELLED: 'Notifica annullata',
  RETURNED_TO_SENDER: 'Restituita al mittente',
};
const SEND_BLOCKING_STATUSES = Object.keys(SEND_BLOCKING_LABELS);

export interface LegalAttentionInput {
  channelType: string;
  now: Date;
  /** created_at del primo tentativo del destinatario. */
  firstAttemptAt: Date | null;
  lastAttempt: {
    status: string;
    errorMessage: string | null;
    sendStatus: string | null;
    sendStatusHistory: Array<{ status: string; activeFrom: string }> | null;
  } | null;
  /** Esito legale POSTAL già calcolato dal chiamante (postalLegalOutcome); null per SEND. */
  postal: PostalLegalOutcomeResult | null;
}

export interface LegalAttentionResult {
  kind: LegalAttentionKind;
  reason: string;
}

export function isLegalAttentionCampaign(c: Pick<Campaign, 'channelType' | 'channelConfig' | 'isTest'>): boolean {
  if (c.isTest) return false;
  if (c.channelType === 'SEND') return true;
  return c.channelType === 'POSTAL' && hasPostalArTracking(c);
}

function staleDays(i: LegalAttentionInput): number | null {
  if (!i.firstAttemptAt) return null;
  const elapsed = i.now.getTime() - i.firstAttemptAt.getTime();
  return elapsed >= STALE_AFTER_DAYS * DAY_MS ? Math.floor(elapsed / DAY_MS) : null;
}

export function legalAttentionOf(i: LegalAttentionInput): LegalAttentionResult | null {
  const a = i.lastAttempt;
  if (!a || a.status === 'cancelled') return null;

  if (i.channelType === 'SEND') {
    if (a.status === 'failed') return { kind: 'blocking', reason: a.errorMessage || 'Invio fallito' };
    if (a.sendStatus && SEND_BLOCKING_STATUSES.includes(a.sendStatus)) return { kind: 'blocking', reason: SEND_BLOCKING_LABELS[a.sendStatus] };
    if (sendLegalDateOf(a.sendStatusHistory)) return null;
    const days = staleDays(i);
    return days === null ? null : { kind: 'stale', reason: `${a.sendStatus || 'In attesa'} da ${days} giorni` };
  }

  const p = i.postal;
  if (!p) return null;
  if (p.outcome === 'not_delivered') return { kind: 'blocking', reason: p.reason || 'Non consegnato' };
  if (p.outcome === 'in_progress' || p.outcome === 'unclassified') {
    const days = staleDays(i);
    return days === null ? null : { kind: 'stale', reason: `${p.reason || 'In corso'} da ${days} giorni` };
  }
  return null;
}

/**
 * created_at dei tentativi è "timestamp without time zone" scritto dal DB in
 * UTC, ma node-postgres lo legge come ora locale del processo (container in
 * Europe/Rome → 1-2 ore di scarto). Ricostruisce l'istante UTC corretto, così
 * la soglia dei 45 giorni coincide con quella SQL.
 */
export function fromUtcWallClock(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()));
}

/** Review assente, oppure posticipo scaduto: la notifica è di nuovo da gestire. */
export function isReviewOpen(review: { action: string; snoozedUntil: Date | null } | null | undefined, now: Date): boolean {
  if (!review) return true;
  return review.action === 'snooze' && !!review.snoozedUntil && review.snoozedUntil.getTime() <= now.getTime();
}

/** Stessa verità di `!!channelConfig.postalReturnReceipt` in hasPostalArTracking, per ogni tipo JSON. */
const RETURN_RECEIPT_SQL = `(CASE jsonb_typeof(c.channel_config->'postalReturnReceipt')
      WHEN 'boolean' THEN (c.channel_config->>'postalReturnReceipt')::boolean
      WHEN 'number' THEN (c.channel_config->>'postalReturnReceipt')::numeric <> 0
      WHEN 'string' THEN c.channel_config->>'postalReturnReceipt' <> ''
      ELSE false END)`;

const PERIMETER_SQL = `c.is_test = false AND (c.channel_type = 'SEND' OR (c.channel_type = 'POSTAL' AND (
    c.channel_config->>'postalServiceType' LIKE 'Agol%'
    OR (c.channel_config->>'postalServiceType' LIKE 'Raccomandata%' AND ${RETURN_RECEIPT_SQL}))))`;

// created_at è timestamp senza fuso scritto in UTC: confronto in UTC esplicito,
// indipendente dal fuso della sessione e dall'ora legale.
const STALE_SQL = `la.first_at <= (now() AT TIME ZONE 'UTC') - interval '${STALE_AFTER_DAYS} days'`;

const SEND_LEGAL_DATE_SQL = `EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(la.send_status_history, '[]'::jsonb)) h
    WHERE h->>'status' IN ('VIEWED', 'EFFECTIVE_DATE') AND COALESCE(h->>'activeFrom', '') <> '')`;

/** Stessa regola di legalAttentionOf. Alias: c (campaigns), r (recipients), la (ultimo tentativo + first_at), ppt (verifica Poste). */
function kindCaseSql(): string {
  return `CASE
    WHEN la.id IS NULL THEN NULL
    WHEN la.status = 'cancelled' THEN NULL
    WHEN c.channel_type = 'SEND' THEN (CASE
      WHEN la.status = 'failed' THEN 'blocking'
      WHEN la.send_status IN (${SEND_BLOCKING_STATUSES.map((s) => `'${s}'`).join(', ')}) THEN 'blocking'
      WHEN ${SEND_LEGAL_DATE_SQL} THEN NULL
      WHEN ${STALE_SQL} THEN 'stale'
      ELSE NULL END)
    ELSE (CASE (${postalLegalOutcomeCaseSql(true, { r: 'r', la: 'la', ppt: 'ppt' })})
      WHEN 'not_delivered' THEN 'blocking'
      WHEN 'in_progress' THEN (CASE WHEN ${STALE_SQL} THEN 'stale' END)
      WHEN 'unclassified' THEN (CASE WHEN ${STALE_SQL} THEN 'stale' END)
      ELSE NULL END)
  END`;
}

/**
 * Tutti i destinatari in perimetro con la loro classe (anche null). extraWhere
 * in AND, es. "r.campaign_id = $1". Set-based: ultimo tentativo e first_at in
 * un solo passaggio (DISTINCT ON + MIN() OVER), mai due LATERAL per
 * destinatario (bench 400k destinatari: 2.9s → 1.8s). extraWhere è ripetuto
 * nella sottoquery dei tentativi, altrimenti il dettaglio di una campagna
 * leggerebbe i tentativi di tutte; lì il perimetro è solo grezzo (canale e
 * test), quello esatto su channel_config lo applica il join esterno.
 */
export function legalAttentionClassifiedSql(extraWhere = ''): string {
  const extra = extraWhere ? ` AND ${extraWhere}` : '';
  const where = `${PERIMETER_SQL} AND r.status NOT IN ('cancelled', 'skipped')${extra}`;
  // Filtro grezzo e veloce: il perimetro esatto (channel_config jsonb) lo applica il join esterno.
  const attemptsWhere = `c.is_test = false AND c.channel_type IN ('SEND', 'POSTAL')${extra}`;
  return `SELECT r.id AS recipient_id, r.campaign_id, la.first_at, ${kindCaseSql()} AS kind
  FROM recipients r
  JOIN campaigns c ON c.id = r.campaign_id
  LEFT JOIN (
    SELECT DISTINCT ON (na.recipient_id) na.recipient_id, na.id, na.status, na.postal_status, na.postal_delivery_status,
      na.send_status, na.send_status_history,
      MIN(na.created_at) OVER (PARTITION BY na.recipient_id) AS first_at
    FROM notification_attempts na
    JOIN recipients r ON r.id = na.recipient_id
    JOIN campaigns c ON c.id = r.campaign_id
    WHERE ${attemptsWhere}
    ORDER BY na.recipient_id, na.attempt_number DESC
  ) la ON la.recipient_id = r.id
  LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = la.id
  WHERE ${where}`;
}

/** Solo le segnalate: classe non null e ultima review dello stesso kind assente o posticipo scaduto. */
export function legalAttentionFlaggedSql(extraWhere = ''): string {
  return `WITH classified AS (${legalAttentionClassifiedSql(extraWhere)})
  SELECT cl.recipient_id, cl.campaign_id, cl.kind, cl.first_at
  FROM classified cl
  LEFT JOIN LATERAL (
    SELECT nr.action, nr.snoozed_until FROM notification_reviews nr
    WHERE nr.recipient_id = cl.recipient_id AND nr.kind = cl.kind
    ORDER BY nr.created_at DESC
    LIMIT 1
  ) lr ON true
  WHERE cl.kind IS NOT NULL AND (lr.action IS NULL OR (lr.action = 'snooze' AND lr.snoozed_until <= now()))`;
}
