// apps/backend/src/legal-attention/legal-attention.util.spec.ts
import { describe, it, expect } from 'vitest';
import {
  STALE_AFTER_DAYS,
  isLegalAttentionCampaign,
  legalAttentionOf,
  isReviewOpen,
  legalAttentionClassifiedSql,
  legalAttentionFlaggedSql,
  type LegalAttentionInput,
} from './legal-attention.util.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-13T10:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function send(overrides: Partial<NonNullable<LegalAttentionInput['lastAttempt']>> = {}, firstDaysAgo = 10): LegalAttentionInput {
  return {
    channelType: 'SEND',
    now: NOW,
    firstAttemptAt: daysAgo(firstDaysAgo),
    lastAttempt: { status: 'success', errorMessage: null, sendStatus: 'DELIVERING', sendStatusHistory: [], ...overrides },
    postal: null,
  };
}

function postal(outcome: 'delivered' | 'not_delivered' | 'in_progress' | 'no_legal_value' | 'unclassified', reason: string | null, firstDaysAgo = 10, status = 'success'): LegalAttentionInput {
  return {
    channelType: 'POSTAL',
    now: NOW,
    firstAttemptAt: daysAgo(firstDaysAgo),
    lastAttempt: { status, errorMessage: null, sendStatus: null, sendStatusHistory: null },
    postal: { outcome, reason, at: null },
  };
}

describe('isLegalAttentionCampaign', () => {
  it('SEND sempre, salvo test', () => {
    expect(isLegalAttentionCampaign({ channelType: 'SEND', channelConfig: {}, isTest: false })).toBe(true);
    expect(isLegalAttentionCampaign({ channelType: 'SEND', channelConfig: {}, isTest: true })).toBe(false);
  });
  it('POSTAL solo con AR o Agol', () => {
    expect(isLegalAttentionCampaign({ channelType: 'POSTAL', channelConfig: { postalServiceType: 'AgolMarket' }, isTest: false })).toBe(true);
    expect(isLegalAttentionCampaign({ channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true }, isTest: false })).toBe(true);
    expect(isLegalAttentionCampaign({ channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4' }, isTest: false })).toBe(false);
    expect(isLegalAttentionCampaign({ channelType: 'POSTAL', channelConfig: { postalServiceType: 'Ordinaria' }, isTest: false })).toBe(false);
  });
  it('PEC/EMAIL/APPIO esclusi', () => {
    expect(isLegalAttentionCampaign({ channelType: 'PEC', channelConfig: {}, isTest: false })).toBe(false);
  });
});

describe('legalAttentionOf — SEND', () => {
  it('nessun tentativo o tentativo annullato → null', () => {
    expect(legalAttentionOf({ ...send(), lastAttempt: null, firstAttemptAt: null })).toBeNull();
    expect(legalAttentionOf(send({ status: 'cancelled' }, 90))).toBeNull();
  });
  it('tentativo fallito → bloccante con errorMessage', () => {
    expect(legalAttentionOf(send({ status: 'failed', errorMessage: 'Protocollazione fallita', sendStatus: null }))).toEqual({ kind: 'blocking', reason: 'Protocollazione fallita' });
    expect(legalAttentionOf(send({ status: 'failed', errorMessage: null, sendStatus: null }))).toEqual({ kind: 'blocking', reason: 'Invio fallito' });
  });
  it('REFUSED / CANCELLED / RETURNED_TO_SENDER → bloccante subito, senza soglia', () => {
    expect(legalAttentionOf(send({ sendStatus: 'REFUSED' }, 1))).toEqual({ kind: 'blocking', reason: 'Rifiutata da SEND' });
    expect(legalAttentionOf(send({ sendStatus: 'CANCELLED' }, 1))).toEqual({ kind: 'blocking', reason: 'Notifica annullata' });
    expect(legalAttentionOf(send({ sendStatus: 'RETURNED_TO_SENDER' }, 1))).toEqual({ kind: 'blocking', reason: 'Restituita al mittente' });
  });
  it('data legale presente (anche UNREACHABLE perfezionata) → null', () => {
    const history = [{ status: 'UNREACHABLE', activeFrom: '2026-09-02T09:01:00Z' }, { status: 'EFFECTIVE_DATE', activeFrom: '2026-09-12T09:01:00Z' }];
    expect(legalAttentionOf(send({ sendStatus: 'EFFECTIVE_DATE', sendStatusHistory: history }, 90))).toBeNull();
  });
  it('VIEWED con activeFrom vuoto non vale come data legale', () => {
    expect(legalAttentionOf(send({ sendStatus: 'VIEWED', sendStatusHistory: [{ status: 'VIEWED', activeFrom: '' }] }, 50))?.kind).toBe('stale');
  });
  it('soglia 45 giorni: 44 no, 45 sì', () => {
    expect(legalAttentionOf(send({}, STALE_AFTER_DAYS - 1))).toBeNull();
    expect(legalAttentionOf(send({}, STALE_AFTER_DAYS))).toEqual({ kind: 'stale', reason: 'DELIVERING da 45 giorni' });
  });
  it('ferma senza sendStatus → motivo "In attesa"', () => {
    expect(legalAttentionOf(send({ sendStatus: null }, 60))).toEqual({ kind: 'stale', reason: 'In attesa da 60 giorni' });
  });
});

describe('legalAttentionOf — POSTAL', () => {
  it('not_delivered → bloccante col motivo GlobalCom, anche subito', () => {
    expect(legalAttentionOf(postal('not_delivered', 'Destinatario deceduto', 1))).toEqual({ kind: 'blocking', reason: 'Destinatario deceduto' });
    expect(legalAttentionOf(postal('not_delivered', null, 1))).toEqual({ kind: 'blocking', reason: 'Non consegnato' });
  });
  it('in_progress / unclassified oltre soglia → ferma', () => {
    expect(legalAttentionOf(postal('in_progress', 'In giacenza', 50))).toEqual({ kind: 'stale', reason: 'In giacenza da 50 giorni' });
    expect(legalAttentionOf(postal('in_progress', null, 50))).toEqual({ kind: 'stale', reason: 'In corso da 50 giorni' });
    expect(legalAttentionOf(postal('unclassified', 'Eliminato', 50))).toEqual({ kind: 'stale', reason: 'Eliminato da 50 giorni' });
    expect(legalAttentionOf(postal('in_progress', null, 44))).toBeNull();
  });
  it('delivered / no_legal_value → null', () => {
    expect(legalAttentionOf(postal('delivered', 'Consegnato', 90))).toBeNull();
    expect(legalAttentionOf(postal('no_legal_value', 'Solo App IO', 90))).toBeNull();
  });
  it('tentativo annullato → null anche se in_progress da tanto', () => {
    expect(legalAttentionOf(postal('in_progress', null, 90, 'cancelled'))).toBeNull();
  });
});

describe('isReviewOpen', () => {
  it('nessuna review → aperta', () => {
    expect(isReviewOpen(null, NOW)).toBe(true);
  });
  it('ack → chiusa', () => {
    expect(isReviewOpen({ action: 'ack', snoozedUntil: null }, NOW)).toBe(false);
  });
  it('snooze futuro → chiusa; scaduto o uguale a now → aperta', () => {
    expect(isReviewOpen({ action: 'snooze', snoozedUntil: new Date(NOW.getTime() + DAY) }, NOW)).toBe(false);
    expect(isReviewOpen({ action: 'snooze', snoozedUntil: new Date(NOW.getTime() - DAY) }, NOW)).toBe(true);
    expect(isReviewOpen({ action: 'snooze', snoozedUntil: NOW }, NOW)).toBe(true);
  });
});

describe('SQL', () => {
  it('classified: perimetro, ultimo e primo tentativo, esclusioni', () => {
    const sql = legalAttentionClassifiedSql();
    expect(sql).toContain('c.is_test = false');
    expect(sql).toContain("c.channel_config->>'postalReturnReceipt' = 'true'");
    expect(sql).toContain('ORDER BY na.recipient_id, na.attempt_number DESC');
    expect(sql).toContain('MIN(na.created_at) OVER (PARTITION BY na.recipient_id) AS first_at');
    expect(sql).toContain("r.status NOT IN ('cancelled', 'skipped')");
    expect(sql).toContain("la.status = 'cancelled' THEN NULL");
    expect(sql).toContain("'REFUSED', 'CANCELLED', 'RETURNED_TO_SENDER'");
    expect(sql).toContain("interval '45 days'");
  });
  it('classified: SEND data legale richiede activeFrom valorizzato', () => {
    expect(legalAttentionClassifiedSql()).toContain("COALESCE(h->>'activeFrom', '') <> ''");
  });
  it('extraWhere viene aggiunto in AND', () => {
    expect(legalAttentionClassifiedSql('r.campaign_id = $1')).toContain('AND r.campaign_id = $1');
  });
  it('set-based: tentativi letti in un solo passaggio, mai un LATERAL per destinatario', () => {
    const sql = legalAttentionClassifiedSql();
    expect(sql).toContain('DISTINCT ON (na.recipient_id)');
    expect(sql).not.toContain('LATERAL');
  });
  it('extraWhere e filtro grezzo di perimetro ripetuti nella sottoquery dei tentativi (dettaglio di una campagna non legge tutto)', () => {
    const sql = legalAttentionClassifiedSql('r.campaign_id = $1');
    expect(sql.split('AND r.campaign_id = $1').length - 1).toBe(2);
    expect(sql.split('c.is_test = false').length - 1).toBe(2);
    expect(sql).toContain("c.channel_type IN ('SEND', 'POSTAL') AND r.campaign_id = $1");
  });
  it('flagged: ultima review per stesso kind, snooze scaduto riapre', () => {
    const sql = legalAttentionFlaggedSql();
    expect(sql).toContain('nr.kind = cl.kind');
    expect(sql).toContain('ORDER BY nr.created_at DESC');
    expect(sql).toContain("lr.action IS NULL OR (lr.action = 'snooze' AND lr.snoozed_until <= now())");
    expect(sql).toContain('cl.kind IS NOT NULL');
  });
});
