# Notifiche senza esito legale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In dashboard l'operatore vede, per campagna, le notifiche SEND/Posta-AR con esito bloccante o ferme da oltre 45 giorni, e può dare presa visione o posticiparle.

**Architecture:** Classificazione derivata in lettura (funzione TS pura + gemella SQL nello stesso file), nessuno stato derivato salvato. Unica tabella nuova `notification_reviews`, storico append-only delle azioni (ack/snooze). Nuovo modulo backend `legal-attention/` con 3 endpoint sotto `admin/legal-attention`; due componenti React nuovi montati in `DashboardView`.

**Tech Stack:** NestJS 12 ESM + TypeORM + PostgreSQL, Vitest (API jest-compatibile), React 19 + Vite, Bootstrap.

**Spec:** `docs/superpowers/specs/2026-10-13-notifiche-senza-esito-legale-design.md`

## Global Constraints

- Campagne in perimetro: `channelType = 'SEND'`, oppure `'POSTAL'` con `hasPostalArTracking(campaign)`; escluse `isTest = true`. PEC esclusa.
- Destinatari con `status` `cancelled`/`skipped`, senza tentativi, o con ultimo tentativo `cancelled`: mai segnalati.
- `STALE_AFTER_DAYS = 45`, contati da `created_at` del **primo** tentativo del destinatario; ferma se `now - first >= 45 giorni`.
- SEND bloccante: ultimo tentativo `failed`, oppure `sendStatus` ∈ `REFUSED`, `CANCELLED`, `RETURNED_TO_SENDER`. SEND con data legale (`VIEWED`/`EFFECTIVE_DATE` con `activeFrom` valorizzato, include `UNREACHABLE` perfezionata) mai segnalata.
- Posta bloccante: `postalLegalOutcome(...).outcome === 'not_delivered'`; ferma: `in_progress`/`unclassified` oltre soglia.
- Segnalata = classe ≠ null **e** ultima review con lo stesso `kind` assente, oppure `snooze` con `snoozed_until <= now()`.
- `snooze` solo su `stale`; `snoozedUntil` futuro ed entro 366 giorni. `note` max 1000 caratteri. `recipientIds` 1..500.
- Operatore (`role !== 'admin'`) vede/agisce solo su campagne con `createdBy === username`; admin tutte. Review su campagna altrui → 403 per l'intera richiesta, nessuna scrittura.
- Endpoint del riepilogo mai nel polling a 5s della dashboard: solo all'apertura e dal pulsante "Aggiorna".
- Testi UI e guida in italiano. Ogni modifica visibile all'operatore aggiorna `apps/frontend-admin/public/guida/guida.md` nella stessa PR, data in testa.
- Comandi solo via Docker (`docker compose exec backend ...`). Dopo modifiche a `apps/backend/src/` fare `docker compose restart backend` prima di provare l'API.
- Mai dati reali (CF/nomi/PEC) in test, fixture, commit: usare `ROSSI MARIO`/`RSSMRA80A01H501U`.

## Review Focus

1. **Posticipo scaduto** → la notifica ricompare se ancora ferma (test in Task 1 `isReviewOpen` e Task 3 `applyReviews`/`loadContexts`).
2. **Presa visione su "ferma" poi diventata "bloccante"** → torna segnalata, perché la review è per `kind` (test Task 1 e Task 3).
3. **Operatore che invia review con un destinatario di campagna altrui** → 403, nessuna riga scritta (test Task 3).
4. **Soglia esatta di 45 giorni** e **SEND con storico `VIEWED` ma `activeFrom` vuoto** → bordi della regola (test Task 1).
5. **Destinatario annullato / tentativo `cancelled`** → mai segnalato anche oltre 45 giorni (test Task 1 e verifica SQL Task 5).

---

### Task 1: Classificazione (TS + SQL)

**Files:**
- Create: `apps/backend/src/legal-attention/legal-attention.util.ts`
- Test: `apps/backend/src/legal-attention/legal-attention.util.spec.ts`

**Interfaces:**
- Consumes: `hasPostalArTracking` (`apps/backend/src/campaigns/campaigns.service.ts`), `postalLegalOutcomeCaseSql`, tipo `PostalLegalOutcomeResult` (`apps/backend/src/campaigns/postal-legal-outcome.util.ts`), `sendLegalDateOf` (`apps/backend/src/campaigns/send-legal-date.util.ts`).
- Produces:
  - `type LegalAttentionKind = 'blocking' | 'stale'`
  - `type LegalAttentionAction = 'ack' | 'snooze'`
  - `const STALE_AFTER_DAYS = 45`
  - `isLegalAttentionCampaign(c: Pick<Campaign, 'channelType' | 'channelConfig' | 'isTest'>): boolean`
  - `legalAttentionOf(i: LegalAttentionInput): LegalAttentionResult | null` con `LegalAttentionResult = { kind: LegalAttentionKind; reason: string }`
  - `isReviewOpen(review: { action: string; snoozedUntil: Date | null } | null | undefined, now: Date): boolean`
  - `legalAttentionFlaggedSql(extraWhere?: string): string` — SELECT con colonne `recipient_id, campaign_id, kind, first_at` (solo segnalate)
  - `legalAttentionClassifiedSql(extraWhere?: string): string` — stesso SELECT senza filtro review e con `kind` anche null

- [ ] **Step 1: Write the failing test**

```ts
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
    expect(sql).toContain('ORDER BY na.attempt_number DESC');
    expect(sql).toContain('MIN(na2.created_at) AS first_at');
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
  it('flagged: ultima review per stesso kind, snooze scaduto riapre', () => {
    const sql = legalAttentionFlaggedSql();
    expect(sql).toContain('nr.kind = cl.kind');
    expect(sql).toContain('ORDER BY nr.created_at DESC');
    expect(sql).toContain("lr.action IS NULL OR (lr.action = 'snooze' AND lr.snoozed_until <= now())");
    expect(sql).toContain('cl.kind IS NOT NULL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run legal-attention.util`
Expected: FAIL — `Cannot find module './legal-attention.util.js'` / test file fails to import.

- [ ] **Step 3: Write minimal implementation**

```ts
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

/** Review assente, oppure posticipo scaduto: la notifica è di nuovo da gestire. */
export function isReviewOpen(review: { action: string; snoozedUntil: Date | null } | null | undefined, now: Date): boolean {
  if (!review) return true;
  return review.action === 'snooze' && !!review.snoozedUntil && review.snoozedUntil.getTime() <= now.getTime();
}

const PERIMETER_SQL = `c.is_test = false AND (c.channel_type = 'SEND' OR (c.channel_type = 'POSTAL' AND (
    c.channel_config->>'postalServiceType' LIKE 'Agol%'
    OR (c.channel_config->>'postalServiceType' LIKE 'Raccomandata%' AND c.channel_config->>'postalReturnReceipt' = 'true'))))`;

const STALE_SQL = `fa.first_at <= now() - interval '${STALE_AFTER_DAYS} days'`;

const SEND_LEGAL_DATE_SQL = `EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(la.send_status_history, '[]'::jsonb)) h
    WHERE h->>'status' IN ('VIEWED', 'EFFECTIVE_DATE') AND COALESCE(h->>'activeFrom', '') <> '')`;

/** Stessa regola di legalAttentionOf. Alias: c (campaigns), r (recipients), la (ultimo tentativo), fa (primo), ppt (verifica Poste). */
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

/** Tutti i destinatari in perimetro con la loro classe (anche null). extraWhere in AND, es. "r.campaign_id = $1". */
export function legalAttentionClassifiedSql(extraWhere = ''): string {
  return `SELECT r.id AS recipient_id, r.campaign_id, fa.first_at, ${kindCaseSql()} AS kind
  FROM recipients r
  JOIN campaigns c ON c.id = r.campaign_id
  LEFT JOIN LATERAL (
    SELECT na.id, na.status, na.postal_status, na.postal_delivery_status, na.send_status, na.send_status_history
    FROM notification_attempts na
    WHERE na.recipient_id = r.id
    ORDER BY na.attempt_number DESC
    LIMIT 1
  ) la ON true
  LEFT JOIN LATERAL (
    SELECT MIN(na2.created_at) AS first_at FROM notification_attempts na2 WHERE na2.recipient_id = r.id
  ) fa ON true
  LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = la.id
  WHERE ${PERIMETER_SQL} AND r.status NOT IN ('cancelled', 'skipped')${extraWhere ? ` AND ${extraWhere}` : ''}`;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run legal-attention.util`
Expected: PASS, all tests green.

- [ ] **Step 5: Type-check spec**

Run: `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/legal-attention/legal-attention.util.ts apps/backend/src/legal-attention/legal-attention.util.spec.ts
git commit -m "feat(legal-attention): classificazione notifiche senza esito legale"
```

---

### Task 2: Entity `NotificationReview` + migration

**Files:**
- Create: `apps/backend/src/entities/notification-review.entity.ts`
- Create: `apps/backend/src/database/migrations/1790500000000-AddNotificationReviews.ts`
- Modify: `apps/backend/src/database/database.module.ts` (array `entities`, riga ~91)
- Modify: `apps/backend/src/database/data-source.ts` (array `entities`, riga ~31)

**Interfaces:**
- Consumes: `LegalAttentionKind`, `LegalAttentionAction` (Task 1).
- Produces: classe `NotificationReview` con proprietà `id, recipientId, campaignId, kind, action, snoozedUntil: Date | null, reason, note: string | null, createdBy, createdAt`.

- [ ] **Step 1: Write the entity**

```ts
// apps/backend/src/entities/notification-review.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { Recipient } from './recipient.entity.js';
import type { LegalAttentionAction, LegalAttentionKind } from '../legal-attention/legal-attention.util.js';

/**
 * Presa visione / posticipo di una notifica senza esito legale. Storico
 * append-only: una riga per azione, mai update. Vale l'ultima riga per
 * (recipient_id, kind): una presa visione su "ferma" non copre un successivo
 * "bloccante".
 */
@Entity('notification_reviews')
@Index('IDX_notification_reviews_recipient_kind', ['recipientId', 'kind', 'createdAt'])
export class NotificationReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'recipient_id' })
  recipientId!: string;

  @ManyToOne('Recipient', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;

  @Index('IDX_notification_reviews_campaign')
  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ type: 'varchar', length: 10 })
  kind!: LegalAttentionKind;

  @Column({ type: 'varchar', length: 10 })
  action!: LegalAttentionAction;

  @Column({ name: 'snoozed_until', type: 'timestamptz', nullable: true })
  snoozedUntil!: Date | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', length: 255 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

- [ ] **Step 2: Write the migration**

```ts
// apps/backend/src/database/migrations/1790500000000-AddNotificationReviews.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationReviews1790500000000 implements MigrationInterface {
    name = 'AddNotificationReviews1790500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "notification_reviews" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "recipient_id" uuid NOT NULL,
                "campaign_id" uuid NOT NULL,
                "kind" character varying(10) NOT NULL,
                "action" character varying(10) NOT NULL,
                "snoozed_until" TIMESTAMP WITH TIME ZONE,
                "reason" text NOT NULL,
                "note" text,
                "created_by" character varying(255) NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_notification_reviews" PRIMARY KEY ("id"),
                CONSTRAINT "FK_notification_reviews_recipient" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_notification_reviews_recipient_kind" ON "notification_reviews" ("recipient_id", "kind", "created_at")`);
        await queryRunner.query(`CREATE INDEX "IDX_notification_reviews_campaign" ON "notification_reviews" ("campaign_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "notification_reviews"`);
    }
}
```

(`uuid_generate_v4()` è la funzione già usata da tutte le migration esistenti.)

- [ ] **Step 3: Register the entity**

In `apps/backend/src/database/database.module.ts` e `apps/backend/src/database/data-source.ts`: aggiungere `import { NotificationReview } from '../entities/notification-review.entity.js';` accanto agli altri import di entity e aggiungere `NotificationReview` in coda all'array `entities` di entrambi i file.

- [ ] **Step 4: Verify the table in dev (synchronize) and the migration on a temp DB**

Run:
```bash
docker compose restart backend
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d notification_reviews"
```
Expected: tabella con le 10 colonne, FK verso `recipients` con `ON DELETE CASCADE`.

Migration su DB temporaneo (pattern CLAUDE.md, la password è `POSTGRES_PASSWORD` di `.env`):
```bash
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
docker exec -e DATABASE_URL="postgresql://comunicapa:<POSTGRES_PASSWORD>@postgres:5432/migration_test" comunicapa-backend-1 node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker exec comunicapa-postgres-1 psql -U comunicapa -d migration_test -c "\d notification_reviews"
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```
Expected: `migration:run` termina con `Migration AddNotificationReviews1790500000000 has been executed successfully`; `\d` mostra la tabella.

- [ ] **Step 5: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/notification-review.entity.ts apps/backend/src/database/migrations/1790500000000-AddNotificationReviews.ts apps/backend/src/database/database.module.ts apps/backend/src/database/data-source.ts
git commit -m "feat(legal-attention): tabella notification_reviews"
```

---

### Task 3: `LegalAttentionService`

**Files:**
- Create: `apps/backend/src/legal-attention/legal-attention.service.ts`
- Test: `apps/backend/src/legal-attention/legal-attention.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`isLegalAttentionCampaign`, `legalAttentionOf`, `isReviewOpen`, `legalAttentionFlaggedSql`, tipi), Task 2 (`NotificationReview`), `postalLegalOutcome` (`campaigns/postal-legal-outcome.util.ts`), `OperatorDirectoryService.resolveMany(usernames: string[]): Promise<Record<string, string>>`, `AuditLogsService.log({ campaignId, campaignName, operator, action, details })`.
- Produces:
  - `interface LegalAttentionUser { username: string; role: string }`
  - `getSummary(user): Promise<{ items: LegalAttentionSummaryItem[] }>` con `LegalAttentionSummaryItem = { campaignId: string; name: string; channelType: string; createdBy: string; createdByDisplayName: string; blockingCount: number; staleCount: number }`
  - `getCampaignItems(campaignId: string, user, page: number, pageSize: number): Promise<{ items: LegalAttentionItem[]; total: number }>` con `LegalAttentionItem = { recipientId: string; fullName: string | null; codiceFiscale: string; kind: LegalAttentionKind; reason: string; firstAttemptAt: string | null; iun: string | null; postalCode: string | null; lastReview: { action: string; snoozedUntil: string | null; note: string | null; createdBy: string; createdAt: string } | null }`
  - `applyReviews(input: ApplyReviewsInput, user): Promise<{ applied: number; skipped: Array<{ recipientId: string; reason: string }> }>` con `ApplyReviewsInput = { recipientIds: string[]; action: LegalAttentionAction; snoozedUntil?: string; note?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/legal-attention/legal-attention.service.spec.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LegalAttentionService } from './legal-attention.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { NotificationReview } from '../entities/notification-review.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const OPERATOR = { username: 'mrossi', role: 'user' };
const ADMIN = { username: 'admin', role: 'admin' };

const sendCampaign = (createdBy = 'mrossi') => ({ id: 'c1', name: 'TARI 2026', channelType: 'SEND', channelConfig: {}, isTest: false, createdBy });

function recipient(id: string, campaign = sendCampaign()) {
  return { id, campaignId: campaign.id, campaign, status: 'sent', fullName: 'ROSSI MARIO', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null };
}

function attempt(recipientId: string, over: Record<string, unknown> = {}) {
  return {
    id: `a-${recipientId}`, recipientId, attemptNumber: 1, status: 'success', errorMessage: null,
    sendStatus: 'DELIVERING', sendStatusHistory: [], iun: 'AAAA-BBBB-CCCC-202609-X-1',
    postalStatus: null, postalDeliveryStatus: null, postalDeliveryDate: null, postalStatusHistory: null,
    postalAcceptanceId: null, postalTrackingId: null, sentAt: daysAgo(60), createdAt: daysAgo(60), ...over,
  };
}

describe('LegalAttentionService', () => {
  let service: LegalAttentionService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let reviewRepo: any;
  let directory: any;
  let audit: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: vi.fn() };
    recipientRepo = { find: vi.fn().mockResolvedValue([]), query: vi.fn().mockResolvedValue([]) };
    attemptRepo = { find: vi.fn().mockResolvedValue([]) };
    posteRepo = { find: vi.fn().mockResolvedValue([]) };
    reviewRepo = {
      find: vi.fn().mockResolvedValue([]),
      create: vi.fn((x) => x),
      save: vi.fn(async (x) => x),
    };
    directory = { resolveMany: vi.fn().mockResolvedValue({ mrossi: 'Mario Rossi' }) };
    audit = { log: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LegalAttentionService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo },
        { provide: getRepositoryToken(NotificationReview), useValue: reviewRepo },
        { provide: OperatorDirectoryService, useValue: directory },
        { provide: AuditLogsService, useValue: audit },
      ],
    }).compile();
    service = module.get(LegalAttentionService);
  });

  describe('getSummary', () => {
    it('operatore: filtra per created_by e risolve il nome', async () => {
      recipientRepo.query.mockResolvedValueOnce([{ campaign_id: 'c1', name: 'TARI 2026', channel_type: 'SEND', created_by: 'mrossi', blocking_count: 2, stale_count: 3 }]);
      const res = await service.getSummary(OPERATOR);
      const [sql, params] = recipientRepo.query.mock.calls[0];
      expect(sql).toContain('c.created_by = $1');
      expect(params).toEqual(['mrossi']);
      expect(res.items).toEqual([{ campaignId: 'c1', name: 'TARI 2026', channelType: 'SEND', createdBy: 'mrossi', createdByDisplayName: 'Mario Rossi', blockingCount: 2, staleCount: 3 }]);
    });
    it('admin: nessun filtro proprietario; nome mancante → username', async () => {
      recipientRepo.query.mockResolvedValueOnce([{ campaign_id: 'c2', name: 'X', channel_type: 'POSTAL', created_by: 'altro', blocking_count: 1, stale_count: 0 }]);
      const res = await service.getSummary(ADMIN);
      const [sql, params] = recipientRepo.query.mock.calls[0];
      expect(sql).not.toContain('c.created_by = $1');
      expect(params).toEqual([]);
      expect(res.items[0].createdByDisplayName).toBe('altro');
    });
  });

  describe('getCampaignItems', () => {
    it('404 se la campagna non esiste o è fuori perimetro', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(null);
      await expect(service.getCampaignItems('c1', ADMIN, 1, 50)).rejects.toBeInstanceOf(NotFoundException);
      campaignRepo.findOneBy.mockResolvedValueOnce({ ...sendCampaign(), channelType: 'PEC' });
      await expect(service.getCampaignItems('c1', ADMIN, 1, 50)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('403 se operatore non proprietario', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign('altro'));
      await expect(service.getCampaignItems('c1', OPERATOR, 1, 50)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('righe con motivo calcolato in TS, ultima review e codici', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign());
      recipientRepo.query.mockResolvedValueOnce([{ recipient_id: 'r1', kind: 'blocking', total: 1 }]);
      recipientRepo.find.mockResolvedValueOnce([recipient('r1')]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: 'REFUSED' })]);
      reviewRepo.find.mockResolvedValueOnce([{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, note: 'ok', createdBy: 'mrossi', createdAt: daysAgo(5) }]);
      const res = await service.getCampaignItems('c1', OPERATOR, 1, 50);
      const [, params] = recipientRepo.query.mock.calls[0];
      expect(params).toEqual(['c1', 50, 0]);
      expect(res.total).toBe(1);
      expect(res.items[0]).toMatchObject({
        recipientId: 'r1', fullName: 'ROSSI MARIO', codiceFiscale: 'RSSMRA80A01H501U', kind: 'blocking',
        reason: 'Rifiutata da SEND', iun: 'AAAA-BBBB-CCCC-202609-X-1', postalCode: null,
        lastReview: { action: 'ack', note: 'ok', createdBy: 'mrossi' },
      });
    });
    it('pageSize limitato a 200 e page minima 1', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign());
      recipientRepo.query.mockResolvedValueOnce([]);
      await service.getCampaignItems('c1', OPERATOR, 0, 10_000);
      expect(recipientRepo.query.mock.calls[0][1]).toEqual(['c1', 200, 0]);
    });
  });

  describe('applyReviews', () => {
    function setup(attemptOver: Record<string, unknown>, reviews: unknown[] = [], camp = sendCampaign()) {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1', camp)]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', attemptOver)]);
      reviewRepo.find.mockResolvedValueOnce(reviews);
    }

    it('ack su notifica ferma: salva una riga e scrive audit', async () => {
      setup({});
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack', note: ' rinotificata ' }, OPERATOR);
      expect(res).toEqual({ applied: 1, skipped: [] });
      expect(reviewRepo.save).toHaveBeenCalledWith([expect.objectContaining({
        recipientId: 'r1', campaignId: 'c1', kind: 'stale', action: 'ack', snoozedUntil: null,
        reason: 'DELIVERING da 60 giorni', note: 'rinotificata', createdBy: 'mrossi',
      })]);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'c1', campaignName: 'TARI 2026', operator: 'mrossi', action: 'LEGAL_ATTENTION_ACK' }));
    });

    it('snooze su bloccante: scartato, nessuna scrittura', async () => {
      setup({ sendStatus: 'REFUSED' });
      const until = new Date(Date.now() + 10 * DAY).toISOString();
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: until }, OPERATOR);
      expect(res).toEqual({ applied: 0, skipped: [{ recipientId: 'r1', reason: 'Posticipo non ammesso per esito bloccante' }] });
      expect(reviewRepo.save).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('snooze valido su ferma: salva snoozedUntil e audit SNOOZE', async () => {
      setup({});
      const until = new Date(Date.now() + 30 * DAY).toISOString();
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: until }, OPERATOR);
      expect(res.applied).toBe(1);
      expect(reviewRepo.save.mock.calls[0][0][0].snoozedUntil.toISOString()).toBe(until);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEGAL_ATTENTION_SNOOZE' }));
    });

    it('snooze senza data, passata o oltre un anno → 400', async () => {
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze' }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: daysAgo(1).toISOString() }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: new Date(Date.now() + 400 * DAY).toISOString() }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('destinatario inesistente o non più segnalato → scartato col motivo', async () => {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1')]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: 'VIEWED', sendStatusHistory: [{ status: 'VIEWED', activeFrom: '2026-09-01T10:00:00Z' }] })]);
      reviewRepo.find.mockResolvedValueOnce([]);
      const res = await service.applyReviews({ recipientIds: ['r1', 'r404'], action: 'ack' }, OPERATOR);
      expect(res).toEqual({ applied: 0, skipped: [
        { recipientId: 'r1', reason: 'Non più segnalata' },
        { recipientId: 'r404', reason: 'Destinatario non trovato' },
      ] });
    });

    it('già gestita (ack sullo stesso kind) → scartata; ack su "stale" non copre "blocking"', async () => {
      setup({}, [{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, createdAt: daysAgo(1) }]);
      const res1 = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res1.skipped).toEqual([{ recipientId: 'r1', reason: 'Già gestita' }]);

      setup({ sendStatus: 'RETURNED_TO_SENDER' }, [{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, createdAt: daysAgo(1) }]);
      const res2 = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res2.applied).toBe(1);
    });

    it('posticipo scaduto → di nuovo gestibile', async () => {
      setup({}, [{ recipientId: 'r1', kind: 'stale', action: 'snooze', snoozedUntil: daysAgo(1), createdAt: daysAgo(31) }]);
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res.applied).toBe(1);
    });

    it('operatore con un destinatario di campagna altrui → 403, nessuna scrittura', async () => {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1'), recipient('r2', { ...sendCampaign('altro'), id: 'c2' })]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1'), attempt('r2')]);
      reviewRepo.find.mockResolvedValueOnce([]);
      await expect(service.applyReviews({ recipientIds: ['r1', 'r2'], action: 'ack' }, OPERATOR)).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviewRepo.save).not.toHaveBeenCalled();
    });

    it('admin può agire su campagne altrui', async () => {
      setup({}, [], sendCampaign('altro'));
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, ADMIN);
      expect(res.applied).toBe(1);
    });

    it('destinatario annullato → non più segnalato', async () => {
      recipientRepo.find.mockResolvedValueOnce([{ ...recipient('r1'), status: 'cancelled' }]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1')]);
      reviewRepo.find.mockResolvedValueOnce([]);
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res.skipped).toEqual([{ recipientId: 'r1', reason: 'Non più segnalata' }]);
    });

    it('POSTAL deceduto → bloccante col motivo GlobalCom', async () => {
      const postalCampaign = { id: 'c3', name: 'AR', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true }, isTest: false, createdBy: 'mrossi' };
      recipientRepo.find.mockResolvedValueOnce([recipient('r1', postalCampaign)]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: null, postalStatus: 'Restituito', postalDeliveryStatus: 'Destinatario deceduto', createdAt: daysAgo(3) })]);
      reviewRepo.find.mockResolvedValueOnce([]);
      await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(reviewRepo.save.mock.calls[0][0][0]).toMatchObject({ kind: 'blocking', reason: 'Destinatario deceduto' });
    });
  });
});
```

Nota sul caso POSTAL: la fixture usa `postalStatus: 'Restituito'` di proposito. In `postalLegalOutcome` la regola `postalStatus === 'Consegnato' → delivered` viene prima di `LEGAL_NOT_DELIVERED_STATUSES`: con `'Consegnato'` il caso diventerebbe consegnato.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run legal-attention.service`
Expected: FAIL — `Cannot find module './legal-attention.service.js'`.

- [ ] **Step 3: Write the implementation**

```ts
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
  lastReview: { action: string; snoozedUntil: string | null; note: string | null; createdBy: string; createdAt: string } | null;
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

@Injectable()
export class LegalAttentionService {
  private readonly logger = new Logger(LegalAttentionService.name);

  constructor(
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient) private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt) private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(PostalPosteTracking) private readonly posteRepo: Repository<PostalPosteTracking>,
    @InjectRepository(NotificationReview) private readonly reviewRepo: Repository<NotificationReview>,
    private readonly operatorDirectory: OperatorDirectoryService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getSummary(user: LegalAttentionUser): Promise<{ items: LegalAttentionSummaryItem[] }> {
    const isAdmin = user.role === 'admin';
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
    return {
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
        firstAttemptAt: ctx.firstAttempt ? ctx.firstAttempt.createdAt.toISOString() : null,
        iun: a?.iun ?? null,
        postalCode: a?.postalAcceptanceId ?? a?.postalTrackingId ?? null,
        lastReview: ctx.latest
          ? {
              action: ctx.latest.action,
              snoozedUntil: ctx.latest.snoozedUntil ? ctx.latest.snoozedUntil.toISOString() : null,
              note: ctx.latest.note,
              createdBy: ctx.latest.createdBy,
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
          firstAttemptAt: firstAttempt?.createdAt ?? null,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run legal-attention`
Expected: PASS (util + service).

- [ ] **Step 5: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/legal-attention/legal-attention.service.ts apps/backend/src/legal-attention/legal-attention.service.spec.ts
git commit -m "feat(legal-attention): service riepilogo, dettaglio e prese visione"
```

---

### Task 4: Controller, DTO, modulo

**Files:**
- Create: `apps/backend/src/legal-attention/dto/create-legal-attention-review.dto.ts`
- Create: `apps/backend/src/legal-attention/legal-attention.controller.ts`
- Create: `apps/backend/src/legal-attention/legal-attention.module.ts`
- Modify: `apps/backend/src/app.module.ts` (array `imports`, accanto a `NotificationsSearchModule`)
- Test: `apps/backend/src/legal-attention/legal-attention.controller.spec.ts`

**Interfaces:**
- Consumes: `LegalAttentionService` (Task 3) con `getSummary`, `getCampaignItems`, `applyReviews`; `Roles` (`auth/decorators/roles.decorator.js`); `JwtOperatorPayload` (`@comunicapa/shared-types`).
- Produces: route `GET admin/legal-attention`, `GET admin/legal-attention/campaigns/:id?page=&pageSize=`, `POST admin/legal-attention/reviews` (HTTP 200).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/legal-attention/legal-attention.controller.spec.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { LegalAttentionController } from './legal-attention.controller.js';
import { LegalAttentionService } from './legal-attention.service.js';

describe('LegalAttentionController', () => {
  let controller: LegalAttentionController;
  const svc = { getSummary: vi.fn(), getCampaignItems: vi.fn(), applyReviews: vi.fn() };
  const req = { user: { sub: 'x', username: 'mrossi', role: 'user', type: 'operator' } } as any;

  beforeEach(async () => {
    Object.values(svc).forEach((f) => f.mockReset());
    const module = await Test.createTestingModule({
      controllers: [LegalAttentionController],
      providers: [{ provide: LegalAttentionService, useValue: svc }],
    }).compile();
    controller = module.get(LegalAttentionController);
  });

  it('summary delega con utente', async () => {
    svc.getSummary.mockResolvedValueOnce({ items: [] });
    await expect(controller.getSummary(req)).resolves.toEqual({ items: [] });
    expect(svc.getSummary).toHaveBeenCalledWith({ username: 'mrossi', role: 'user' });
  });

  it('campaign items: page/pageSize numerici con default', async () => {
    svc.getCampaignItems.mockResolvedValueOnce({ items: [], total: 0 });
    await controller.getCampaignItems('c1', undefined, undefined, req);
    expect(svc.getCampaignItems).toHaveBeenCalledWith('c1', { username: 'mrossi', role: 'user' }, 1, 50);
    await controller.getCampaignItems('c1', '3', '20', req);
    expect(svc.getCampaignItems).toHaveBeenLastCalledWith('c1', { username: 'mrossi', role: 'user' }, 3, 20);
  });

  it('reviews delega il body', async () => {
    svc.applyReviews.mockResolvedValueOnce({ applied: 1, skipped: [] });
    const dto = { recipientIds: ['r1'], action: 'ack' as const };
    await expect(controller.applyReviews(dto, req)).resolves.toEqual({ applied: 1, skipped: [] });
    expect(svc.applyReviews).toHaveBeenCalledWith(dto, { username: 'mrossi', role: 'user' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run legal-attention.controller`
Expected: FAIL — `Cannot find module './legal-attention.controller.js'`.

- [ ] **Step 3: Write DTO, controller, module**

```ts
// apps/backend/src/legal-attention/dto/create-legal-attention-review.dto.ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { LegalAttentionAction } from '../legal-attention.util.js';

export class CreateLegalAttentionReviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  recipientIds!: string[];

  @IsIn(['ack', 'snooze'])
  action!: LegalAttentionAction;

  @IsOptional()
  @IsISO8601()
  snoozedUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
```

```ts
// apps/backend/src/legal-attention/legal-attention.controller.ts
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { LegalAttentionService } from './legal-attention.service.js';
import { CreateLegalAttentionReviewDto } from './dto/create-legal-attention-review.dto.js';

type OperatorRequest = Request & { user: JwtOperatorPayload };

const userOf = (req: OperatorRequest) => ({ username: req.user.username, role: req.user.role });

@Controller('admin/legal-attention')
@Roles('user', 'admin')
export class LegalAttentionController {
  constructor(private readonly service: LegalAttentionService) {}

  @Get()
  getSummary(@Req() req: OperatorRequest) {
    return this.service.getSummary(userOf(req));
  }

  @Get('campaigns/:id')
  getCampaignItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: OperatorRequest,
  ) {
    return this.service.getCampaignItems(id, userOf(req), Number(page) || 1, Number(pageSize) || 50);
  }

  @Post('reviews')
  @HttpCode(200)
  applyReviews(@Body() dto: CreateLegalAttentionReviewDto, @Req() req: OperatorRequest) {
    return this.service.applyReviews(dto, userOf(req));
  }
}
```

```ts
// apps/backend/src/legal-attention/legal-attention.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { NotificationReview } from '../entities/notification-review.entity.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { LegalAttentionService } from './legal-attention.service.js';
import { LegalAttentionController } from './legal-attention.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, PostalPosteTracking, NotificationReview]),
    OperatorDirectoryModule,
    AuditLogsModule,
  ],
  controllers: [LegalAttentionController],
  providers: [LegalAttentionService],
})
export class LegalAttentionModule {}
```

In `apps/backend/src/app.module.ts`: aggiungere `import { LegalAttentionModule } from './legal-attention/legal-attention.module.js';` e `LegalAttentionModule,` subito dopo `NotificationsSearchModule,` nell'array `imports`.

- [ ] **Step 4: Run tests and type-check**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run legal-attention
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Smoke test API in dev**

Run:
```bash
docker compose restart backend
# attendere ~25s, poi:
TOKEN=$(docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))" | tr -d '\r')
docker compose exec -e T="$TOKEN" backend node -e "fetch('http://localhost:8080/admin/legal-attention',{headers:{Authorization:'Bearer '+process.env.T}}).then(async r=>console.log(r.status, await r.text()))"
docker compose exec -e T="$TOKEN" backend node -e "fetch('http://localhost:8080/admin/legal-attention/reviews',{method:'POST',headers:{Authorization:'Bearer '+process.env.T,'Content-Type':'application/json'},body:JSON.stringify({recipientIds:['not-a-uuid'],action:'ack'})}).then(async r=>console.log(r.status, await r.text()))"
```
Expected: primo `200 {"items":[...]}`; secondo `400` con messaggio di validazione su `recipientIds`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/legal-attention apps/backend/src/app.module.ts
git commit -m "feat(legal-attention): endpoint admin/legal-attention"
```

---

### Task 5: Verifica SQL su dati reali dev — parità TS/SQL e benchmark

Nessun codice che resta nel repo: script temporanei, cancellati a fine task.

**Files:**
- Create (temporaneo, da cancellare): `apps/backend/src/debug/_legal-attention-parity.mjs`

**Interfaces:**
- Consumes: `legalAttentionClassifiedSql`, `legalAttentionOf`, `postalLegalOutcome` compilati in `dist/` (dopo `docker compose restart backend`).

- [ ] **Step 1: Write the parity script**

```js
// apps/backend/src/debug/_legal-attention-parity.mjs — TEMPORANEO
import pg from 'pg';
import { legalAttentionClassifiedSql, legalAttentionOf } from '/app/apps/backend/dist/legal-attention/legal-attention.util.js';
import { postalLegalOutcome } from '/app/apps/backend/dist/campaigns/postal-legal-outcome.util.js';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const sql = `SELECT x.*, r.status AS r_status, r.inad_check, c.channel_type,
    la.id AS la_id, la.status AS la_status, la.error_message, la.send_status, la.send_status_history,
    la.postal_status, la.postal_delivery_status, la.postal_delivery_date, la.sent_at, la.postal_status_history,
    ppt.status AS ppt_status, ppt.outcome_at
  FROM (${legalAttentionClassifiedSql()}) x
  JOIN recipients r ON r.id = x.recipient_id
  JOIN campaigns c ON c.id = x.campaign_id
  LEFT JOIN LATERAL (SELECT * FROM notification_attempts na WHERE na.recipient_id = r.id ORDER BY na.attempt_number DESC LIMIT 1) la ON true
  LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = la.id`;
const { rows } = await client.query(sql);
const now = new Date();
let mismatches = 0;
const counts = {};
for (const row of rows) {
  const lastAttempt = row.la_id ? { status: row.la_status, errorMessage: row.error_message, sendStatus: row.send_status, sendStatusHistory: row.send_status_history } : null;
  const postal = row.channel_type === 'POSTAL' ? postalLegalOutcome({
    diverted: !!row.inad_check?.diverted, arTracking: true,
    attempt: row.la_id ? { status: row.la_status, postalStatus: row.postal_status, postalDeliveryStatus: row.postal_delivery_status, postalDeliveryDate: row.postal_delivery_date, sentAt: row.sent_at, errorMessage: row.error_message, postalStatusHistory: row.postal_status_history } : null,
    poste: row.ppt_status ? { status: row.ppt_status, outcomeAt: row.outcome_at } : null,
  }) : null;
  const ts = legalAttentionOf({ channelType: row.channel_type, now, firstAttemptAt: row.first_at, lastAttempt, postal });
  const tsKind = ts?.kind ?? null;
  counts[`${row.channel_type}:${row.kind ?? 'null'}`] = (counts[`${row.channel_type}:${row.kind ?? 'null'}`] ?? 0) + 1;
  if (tsKind !== row.kind) { mismatches++; if (mismatches <= 10) console.log('MISMATCH', row.recipient_id, 'sql=', row.kind, 'ts=', tsKind); }
}
console.log('righe', rows.length, 'mismatch', mismatches, counts);
await client.end();
```

Se il nome colonna `error_message` non esiste: `docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d notification_attempts"` e correggere.

- [ ] **Step 2: Run parity**

Run:
```bash
docker compose restart backend
MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend backend node src/debug/_legal-attention-parity.mjs
```
Expected: `mismatch 0`. Se ci sono mismatch: correggere la regola (TS o SQL) in `legal-attention.util.ts`, aggiungere il caso al test di Task 1, rieseguire. I destinatari restano anonimi: stampare solo l'id.

- [ ] **Step 3: Benchmark su volume realistico (BEGIN … ROLLBACK)**

Creare `C:\...\scratchpad\legal-attention-bench.sql` (scratchpad di sessione, NON nel repo) con:

```sql
BEGIN;
CREATE INDEX IF NOT EXISTS tmp_na_recipient ON notification_attempts (recipient_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS tmp_r_campaign ON recipients (campaign_id);
INSERT INTO campaigns (id, name, status, channel_type, channel_config, created_by, is_test)
SELECT gen_random_uuid(), 'BENCH ' || g, 'completed', 'SEND', '{}'::jsonb, 'bench', false FROM generate_series(1, 20) g;
INSERT INTO recipients (id, campaign_id, codice_fiscale, status)
SELECT gen_random_uuid(), c.id, 'RSSMRA80A01H501U', 'sent' FROM campaigns c CROSS JOIN generate_series(1, 20000) WHERE c.created_by = 'bench';
INSERT INTO notification_attempts (id, recipient_id, channel_type, status, attempt_number, send_status, created_at)
SELECT gen_random_uuid(), r.id, 'SEND', 'success', 1,
  (ARRAY['DELIVERING','VIEWED','REFUSED','EFFECTIVE_DATE'])[1 + floor(random() * 4)::int], now() - (floor(random() * 90) || ' days')::interval
FROM recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.created_by = 'bench';
ANALYZE recipients; ANALYZE notification_attempts;
\timing on
-- incollare qui l'output di legalAttentionFlaggedSql() avvolto dalla query di getSummary (vedi sotto)
ROLLBACK;
```

Ottenere la query completa di `getSummary` con:
```bash
MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend backend node --input-type=module -e "import { legalAttentionFlaggedSql } from '/app/apps/backend/dist/legal-attention/legal-attention.util.js'; console.log(\"SELECT f.campaign_id, COUNT(*) FILTER (WHERE f.kind = 'blocking') b, COUNT(*) FILTER (WHERE f.kind = 'stale') s FROM (\" + legalAttentionFlaggedSql() + \") f GROUP BY f.campaign_id;\")"
```
Incollarla al posto del commento, poi:
```bash
docker cp <scratchpad>/legal-attention-bench.sql comunicapa-postgres-1:/tmp/bench.sql
MSYS_NO_PATHCONV=1 docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -f /tmp/bench.sql
MSYS_NO_PATHCONV=1 docker exec comunicapa-postgres-1 rm /tmp/bench.sql
```
Se un `INSERT` fallisce per colonna NOT NULL senza default, aggiungere la colonna con un valore fittizio (`\d campaigns` / `\d recipients` per i nomi). Expected: tempo della query di riepilogo su 400.000 destinatari; annotarlo nella PR. Se > 2s: riportarlo all'utente prima di proseguire (la spec prevede di valutare la tabella materializzata).

- [ ] **Step 4: Cleanup**

```bash
rm apps/backend/src/debug/_legal-attention-parity.mjs
git status --short
```
Expected: nessun file debug residuo. Nessun commit in questo task.

---

### Task 6: Frontend — riquadro dashboard e pannello

**Files:**
- Create: `apps/frontend-admin/src/components/legal-attention/types.ts`
- Create: `apps/frontend-admin/src/components/legal-attention/LegalAttentionCard.tsx`
- Create: `apps/frontend-admin/src/components/legal-attention/LegalAttentionPanel.tsx`
- Modify: `apps/frontend-admin/src/components/DashboardView.tsx` (interfaccia `Props` riga ~51-71; render subito dopo il blocco `stx-hero`, prima di `{/* ── Da attenzionare ── */}`)
- Modify: `apps/frontend-admin/src/App.tsx` (props di `<DashboardView` riga ~9658)

**Interfaces:**
- Consumes: endpoint di Task 4 via `apiFetch(path, init)` (prefisso `ADMIN_API_BASE` già applicato: path `/legal-attention`, `/legal-attention/campaigns/:id?page=&pageSize=`, `/legal-attention/reviews`); `getChannelMeta(channel)` (`src/data/channels.ts`); `openNotificationDetail(recipientId)` (App.tsx riga ~1915, modale globale).
- Produces: `LegalAttentionCard` props `{ apiFetch, isAdmin: boolean, onOpenNotification: (recipientId: string) => void, onOpenCampaign: (id: string) => void }`; nuove props `DashboardView`: `isAdmin: boolean`, `onOpenNotification: (recipientId: string) => void`.

- [ ] **Step 1: Types**

```ts
// apps/frontend-admin/src/components/legal-attention/types.ts
export type LegalAttentionKind = 'blocking' | 'stale';

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
  lastReview: { action: string; snoozedUntil: string | null; note: string | null; createdBy: string; createdAt: string } | null;
}

export interface ApplyReviewsResult {
  applied: number;
  skipped: Array<{ recipientId: string; reason: string }>;
}

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const KIND_LABELS: Record<LegalAttentionKind, string> = {
  blocking: 'Esito bloccante',
  stale: 'Ferma da oltre 45 giorni',
};
```

- [ ] **Step 2: Card**

```tsx
// apps/frontend-admin/src/components/legal-attention/LegalAttentionCard.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { getChannelMeta } from '../../data/channels';
import { LegalAttentionPanel } from './LegalAttentionPanel';
import type { ApiFetch, LegalAttentionSummaryItem } from './types';

interface Props {
  apiFetch: ApiFetch;
  isAdmin: boolean;
  onOpenNotification: (recipientId: string) => void;
  onOpenCampaign: (id: string) => void;
}

// Notifiche SEND / Posta con AR senza esito legale (bloccanti o ferme da 45
// giorni). Caricato all'apertura e da "Aggiorna", mai nel polling della
// dashboard: la query lavora su tutti i destinatari delle campagne legali.
// apiFetch arriva ricreata a ogni render di App (polling 5s): tenuta in ref,
// altrimenti useEffect ricaricherebbe a ogni giro.
export function LegalAttentionCard({ apiFetch, isAdmin, onOpenNotification, onOpenCampaign }: Props) {
  const apiFetchRef = useRef(apiFetch);
  apiFetchRef.current = apiFetch;
  const [items, setItems] = useState<LegalAttentionSummaryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCampaign, setOpenCampaign] = useState<LegalAttentionSummaryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current('/legal-attention');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      setError('Impossibile caricare le notifiche senza esito legale.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!error && (!items || items.length === 0)) return null;

  return (
    <div className="stx-card stx-alerts">
      <div className="stx-card-head">
        <h3 className="stx-card-title"><ShieldAlert size={16} style={{ color: '#b42318' }} />Notifiche senza esito legale</h3>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="icon-spin me-1" size={14} /> : <RefreshCw className="me-1" size={14} />}Aggiorna
        </button>
      </div>
      {error && <div className="text-danger small px-3 pb-2">{error}</div>}
      {(items ?? []).map((c) => {
        const meta = getChannelMeta(c.channelType);
        return (
          <div key={c.campaignId} className="stx-alert-row" onClick={() => setOpenCampaign(c)} role="button">
            <span className="stx-alert-main">
              <span className="stx-alert-kind">{meta.label}</span>
              <strong>{c.name}</strong>
              {isAdmin && <span className="text-muted small">di {c.createdByDisplayName}</span>}
              {c.blockingCount > 0 && <span className="stx-status is-bad">{c.blockingCount} esito bloccante</span>}
              {c.staleCount > 0 && <span className="stx-status is-warn">{c.staleCount} ferme da oltre 45 giorni</span>}
            </span>
            <span className="stx-alert-cta">Gestisci<ChevronRight size={14} /></span>
          </div>
        );
      })}
      {openCampaign && (
        <LegalAttentionPanel
          apiFetch={apiFetch}
          campaign={openCampaign}
          onClose={() => { setOpenCampaign(null); void load(); }}
          onOpenNotification={onOpenNotification}
          onOpenCampaign={(id) => { setOpenCampaign(null); onOpenCampaign(id); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Panel**

```tsx
// apps/frontend-admin/src/components/legal-attention/LegalAttentionPanel.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock, ExternalLink, Loader2, X } from 'lucide-react';
import { KIND_LABELS } from './types';
import type { ApiFetch, ApplyReviewsResult, LegalAttentionItem, LegalAttentionSummaryItem } from './types';

interface Props {
  apiFetch: ApiFetch;
  campaign: LegalAttentionSummaryItem;
  onClose: () => void;
  onOpenNotification: (recipientId: string) => void;
  onOpenCampaign: (id: string) => void;
}

const PAGE_SIZE = 50;
const SNOOZE_PRESETS = [15, 30, 45];

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function tomorrowIsoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function LegalAttentionPanel({ apiFetch, campaign, onClose, onOpenNotification, onOpenCampaign }: Props) {
  const apiFetchRef = useRef(apiFetch);
  apiFetchRef.current = apiFetch;
  const [items, setItems] = useState<LegalAttentionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [snoozeDays, setSnoozeDays] = useState<number | 'custom'>(30);
  const [customDate, setCustomDate] = useState(tomorrowIsoDate());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string; skipped: ApplyReviewsResult['skipped'] } | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await apiFetchRef.current(`/legal-attention/campaigns/${campaign.campaignId}?page=${p}&pageSize=${PAGE_SIZE}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setSelected(new Set());
    } catch {
      setMessage({ tone: 'danger', text: 'Impossibile caricare le notifiche della campagna.', skipped: [] });
    } finally {
      setLoading(false);
    }
  }, [campaign.campaignId]);

  useEffect(() => { void load(page); }, [load, page]);

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.recipientId)), [items, selected]);
  const hasBlockingSelected = selectedItems.some((i) => i.kind === 'blocking');
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.recipientId));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = async (action: 'ack' | 'snooze') => {
    if (selectedItems.length === 0) return;
    const body: Record<string, unknown> = { recipientIds: selectedItems.map((i) => i.recipientId), action };
    if (note.trim()) body.note = note.trim();
    if (action === 'snooze') {
      body.snoozedUntil = snoozeDays === 'custom' ? new Date(`${customDate}T00:00:00`).toISOString() : addDays(snoozeDays);
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetchRef.current('/legal-attention/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const text = Array.isArray(err.message) ? err.message.join(', ') : (err.message ?? `HTTP ${res.status}`);
        setMessage({ tone: 'danger', text, skipped: [] });
        return;
      }
      const result: ApplyReviewsResult = await res.json();
      const verb = action === 'ack' ? 'Presa visione registrata' : 'Posticipo registrato';
      setMessage({ tone: 'success', text: `${verb} per ${result.applied} notifiche.`, skipped: result.skipped });
      setNote('');
      await load(page);
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => {
    const it = items.find((i) => i.recipientId === id);
    return it ? (it.fullName || it.codiceFiscale) : id;
  };

  return (
    <div className="modal fade show d-block" style={{ background: 'rgba(0,0,0,0.5)' }} tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-dialog modal-xl modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Notifiche senza esito legale — {campaign.name}</h5>
            <button type="button" className="btn btn-sm btn-link" onClick={() => onOpenCampaign(campaign.campaignId)}>
              <ExternalLink size={14} className="me-1" />Apri campagna
            </button>
            <button type="button" className="btn-close" aria-label="Chiudi" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body">
            {message && (
              <div className={`alert alert-${message.tone} small`}>
                {message.text}
                {message.skipped.length > 0 && (
                  <ul className="mb-0 mt-1">
                    {message.skipped.map((s) => <li key={s.recipientId}>{nameOf(s.recipientId)}: {s.reason}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
              <div className="flex-grow-1">
                <label className="form-label small mb-1" htmlFor="la-note">Nota (facoltativa)</label>
                <input id="la-note" className="form-control form-control-sm" maxLength={1000} value={note}
                  onChange={(e) => setNote(e.target.value)} placeholder="Es. rinotificata tramite messo" />
              </div>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || selectedItems.length === 0} onClick={() => void apply('ack')}>
                <CheckCircle2 size={14} className="me-1" />Presa visione ({selectedItems.length})
              </button>
              <div className="d-flex gap-1 align-items-end">
                <select className="form-select form-select-sm" style={{ width: 'auto' }} aria-label="Durata posticipo"
                  value={String(snoozeDays)} onChange={(e) => setSnoozeDays(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
                  {SNOOZE_PRESETS.map((d) => <option key={d} value={d}>{d} giorni</option>)}
                  <option value="custom">Altra data…</option>
                </select>
                {snoozeDays === 'custom' && (
                  <input type="date" className="form-control form-control-sm" style={{ width: 'auto' }} aria-label="Data posticipo"
                    min={tomorrowIsoDate()} value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
                )}
                <button type="button" className="btn btn-sm btn-outline-secondary"
                  disabled={busy || selectedItems.length === 0 || hasBlockingSelected}
                  title={hasBlockingSelected ? 'Il posticipo vale solo per le notifiche ferme: le notifiche con esito bloccante si possono solo prendere in visione.' : undefined}
                  onClick={() => void apply('snooze')}>
                  <Clock size={14} className="me-1" />Posticipa
                </button>
              </div>
            </div>

            {loading ? (
              <div className="text-muted small"><Loader2 className="icon-spin me-1" size={14} />Caricamento…</div>
            ) : items.length === 0 ? (
              <div className="text-muted small">Nessuna notifica da gestire per questa campagna.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th><input type="checkbox" aria-label="Seleziona tutte" checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.recipientId)))} /></th>
                      <th>Destinatario</th>
                      <th>Codice fiscale</th>
                      <th>Situazione</th>
                      <th>Motivo</th>
                      <th>IUN / Raccomandata</th>
                      <th>Ultima azione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.recipientId}>
                        <td><input type="checkbox" aria-label={`Seleziona ${i.fullName || i.codiceFiscale}`} checked={selected.has(i.recipientId)} onChange={() => toggle(i.recipientId)} /></td>
                        <td><button type="button" className="btn btn-link btn-sm p-0" onClick={() => onOpenNotification(i.recipientId)}>{i.fullName || '—'}</button></td>
                        <td className="small">{i.codiceFiscale}</td>
                        <td><span className={`stx-status ${i.kind === 'blocking' ? 'is-bad' : 'is-warn'}`}>{KIND_LABELS[i.kind]}</span></td>
                        <td className="small">{i.reason}</td>
                        <td className="small">{i.iun ?? i.postalCode ?? '—'}</td>
                        <td className="small text-muted">
                          {i.lastReview
                            ? `${i.lastReview.action === 'ack' ? 'Presa visione' : 'Posticipo'} di ${i.lastReview.createdBy} il ${new Date(i.lastReview.createdAt).toLocaleDateString('it-IT')}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pages > 1 && (
              <div className="d-flex justify-content-between align-items-center small">
                <span>{total} notifiche · pagina {page} di {pages}</span>
                <div className="btn-group">
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Precedente</button>
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Successiva</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into DashboardView and App**

In `apps/frontend-admin/src/components/DashboardView.tsx`:
- import: `import { LegalAttentionCard } from './legal-attention/LegalAttentionCard';`
- in `interface Props` aggiungere:
```ts
  isAdmin: boolean;
  onOpenNotification: (recipientId: string) => void;
```
- subito prima di `{/* ── Da attenzionare ── */}` aggiungere:
```tsx
      {/* ── Notifiche senza esito legale ── */}
      <LegalAttentionCard
        apiFetch={props.apiFetch}
        isAdmin={props.isAdmin}
        onOpenNotification={props.onOpenNotification}
        onOpenCampaign={props.onOpenCampaign}
      />
```

In `apps/frontend-admin/src/App.tsx`, nelle props di `<DashboardView` (dopo `onSeeAllCampaigns=...`):
```tsx
              isAdmin={role === 'admin'}
              onOpenNotification={(recipientId) => { void openNotificationDetail(recipientId); }}
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: solo l'errore preesistente `src/App.tsx(...): error TS2322: Type 'string' is not assignable to type 'string[]'` (attributo `rel` in `rehypeRewrite`, presente anche su `main`, CI verde). Nessun errore nei file nuovi.

- [ ] **Step 6: Lint**

Run: `docker compose exec frontend-admin node_modules/.bin/eslint src/components/legal-attention src/components/DashboardView.tsx`
Expected: nessun errore.

- [ ] **Step 7: Browser check in dev**

Creare dati di prova in dev (nessun cleanup necessario in dev):
```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "
WITH c AS (INSERT INTO campaigns (id, name, status, channel_type, channel_config, created_by, is_test) VALUES (gen_random_uuid(), 'PROVA esito legale', 'completed', 'SEND', '{}'::jsonb, 'admin', false) RETURNING id),
r AS (INSERT INTO recipients (id, campaign_id, codice_fiscale, full_name, status) SELECT gen_random_uuid(), c.id, 'RSSMRA80A01H501U', 'ROSSI MARIO', 'sent' FROM c, generate_series(1, 2) RETURNING id)
INSERT INTO notification_attempts (id, recipient_id, channel_type, status, attempt_number, send_status, created_at)
SELECT gen_random_uuid(), r.id, 'SEND', 'success', 1, s, now() - interval '60 days'
FROM (SELECT id, row_number() OVER () n FROM r) r, LATERAL (SELECT CASE WHEN r.n = 1 THEN 'REFUSED' ELSE 'DELIVERING' END s) x;"
```
(se un INSERT fallisce per colonna NOT NULL: `\d <tabella>` e aggiungere il valore). Poi login admin/admin su `http://localhost:3000`, dashboard: verificare riquadro con "PROVA esito legale", badge "1 esito bloccante" e "1 ferme da oltre 45 giorni"; aprire il pannello; con la riga bloccante selezionata "Posticipa" è disabilitato; "Presa visione" sulla riga bloccante la rimuove; "Posticipa 15 giorni" sulla ferma la rimuove e il riquadro sparisce alla chiusura; clic sul nome apre il dettaglio notifica sopra il pannello.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/components/legal-attention apps/frontend-admin/src/components/DashboardView.tsx apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): riquadro notifiche senza esito legale in dashboard"
```

---

### Task 7: Guida operatori, note dev, suite completa

**Files:**
- Modify: `apps/frontend-admin/public/guida/guida.md`
- Modify: `apps/frontend-admin/src/guida.ts` (oggetto `GUIDA_PER_VISTA`, riga ~30)
- Modify: `docs/claude/campaigns-wizard.md` (nuova sezione in coda)
- Modify: `publiccode.yml` (`softwareVersion`, `releaseDate`) — **numero di versione da chiedere all'utente** (memoria progetto: mai scegliere da soli; proporre patch/minor e attendere conferma)

**Interfaces:**
- Consumes: titoli guida esistenti; `guidaSlug` (`src/guida.ts`).
- Produces: anchor `gestire-le-notifiche-senza-esito-legale`.

- [ ] **Step 1: Guida — data in testa**

Sostituire la riga `_Ultimo aggiornamento: ..._` con `_Ultimo aggiornamento: <data di oggi AAAA-MM-GG>_`.

- [ ] **Step 2: Guida — nuova sezione in "Operazioni frequenti"**

Inserire subito dopo il paragrafo che chiude la sezione `### Cercare una singola notifica` (prima di `### Verificare i domicili digitali di un elenco`):

```markdown
### Gestire le notifiche senza esito legale

In **Dashboard** il riquadro **Notifiche senza esito legale** elenca, per campagna, le notifiche SEND e le raccomandate con ricevuta di ritorno (o atti giudiziari) che non arriveranno a una data legale di notifica. Ogni operatore vede le campagne che ha creato; gli amministratori le vedono tutte.

Le notifiche segnalate sono di due tipi:

- **Esito bloccante**: la notifica non andrà a buon fine, ad esempio destinatario deceduto o sconosciuto, indirizzo errato, notifica rifiutata o annullata da SEND. Compare subito.
- **Ferma da oltre 45 giorni**: dopo 45 giorni dal primo invio non c'è ancora una data legale.

1. Premi sulla campagna per aprire l'elenco delle notifiche.
2. Seleziona le notifiche e scegli:
   - **Presa visione**, per confermare di averle viste: escono dall'elenco;
   - **Posticipa**, solo per le notifiche ferme, di 15, 30 o 45 giorni o fino a una data a scelta: ricompaiono alla scadenza se sono ancora senza esito.
3. Puoi aggiungere una nota, ad esempio come hai proceduto. Ogni azione resta registrata con nome e data.

Se una notifica già presa in visione come ferma riceve in seguito un esito bloccante, ricompare. Premi sul nome del destinatario per aprire il dettaglio della notifica.
```

- [ ] **Step 3: Guida — problema frequente**

In `## Problemi frequenti`, prima di `### Non riesco a modificare o eliminare una campagna`:

```markdown
### Una notifica SEND irreperibile non compare tra le segnalazioni

**Causa:** per SEND il destinatario irreperibile non blocca la notifica: la piattaforma la perfeziona comunque e assegna una data legale. Non è quindi una notifica senza esito.

**Soluzione:** nessuna. La data legale si legge nel dettaglio della notifica.

**Apri un ticket se:** la notifica risulta irreperibile e dopo 45 giorni non ha ancora una data legale nel dettaglio.
```

- [ ] **Step 4: GUIDA_PER_VISTA**

In `apps/frontend-admin/src/guida.ts`, nell'oggetto `GUIDA_PER_VISTA` aggiungere la riga:
```ts
  dashboard: 'gestire-le-notifiche-senza-esito-legale',
```

- [ ] **Step 5: Check guida**

Run: `docker compose exec frontend-admin node scripts/check-guida.mjs`
Expected: `check-guida: ok (38 titoli)` (36 + 2 nuovi).

- [ ] **Step 6: Nota dev**

In coda a `docs/claude/campaigns-wizard.md`:

```markdown
## Notifiche senza esito legale (dashboard) — classe derivata, review append-only

`legal-attention/legal-attention.util.ts` contiene la regola TS
(`legalAttentionOf`, dettaglio e validazione review) e la gemella SQL
(`legalAttentionClassifiedSql`/`legalAttentionFlaggedSql`, conteggi e
paginazione): cambiarne una senza l'altra è un bug — il service logga
`Classificazione SQL/TS divergente` se divergono su una riga mostrata.
Perimetro: SEND + POSTAL con `hasPostalArTracking`, no test. SEND
`UNREACHABLE` NON è bloccante (si perfeziona). `notification_reviews` è
append-only: vale l'ultima riga per `(recipient_id, kind)`, quindi un ack su
`stale` non copre un successivo `blocking`. Endpoint riepilogo mai nel
polling 5s della dashboard (`apiFetch` tenuta in ref nei componenti).
```

- [ ] **Step 7: Full backend suite**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: unico fallimento il noto `app.controller.spec.ts › senza APP_VERSION → versione da publiccode.yml o dev`; tutto il resto verde. Qualunque altro fallimento è una regressione da correggere prima di proseguire.

Run: `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: exit 0.

- [ ] **Step 8: Versione**

Chiedere all'utente il numero di versione (proposta: minor `v1.10.0`, nuova funzionalità; l'ultimo tag noto è `v1.9.5`, con `v1.9.6` in `publiccode.yml` non ancora taggata). Aggiornare `softwareVersion` e `releaseDate` (data di oggi) in `publiccode.yml` con il valore confermato.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/public/guida/guida.md apps/frontend-admin/src/guida.ts docs/claude/campaigns-wizard.md publiccode.yml
git commit -m "docs(guida): notifiche senza esito legale"
```
