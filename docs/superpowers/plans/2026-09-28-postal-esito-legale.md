# POSTAL — Esito legale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Stato Documento" delle campagne POSTAL mostra l'esito legale (Consegnato / Non consegnato / In corso / Senza valore legale / Senza AR / Non classificato) con motivo e data legale; "Stato notifica" mostra Fallito quando GlobalCom è in `Errore`.

**Architecture:** Un solo modulo `campaigns/postal-legal-outcome.util.ts` contiene le tabelle dei valori GlobalCom, la regola in TypeScript e l'espressione SQL generata dalle stesse tabelle. Tutto è derivato in lettura (nessuna migration, nessuna scrittura). Backend: pagina destinatari, opzioni filtro, report CSV e dettaglio notifica usano il modulo; frontend: barra esito, filtro, grafico, colonna e verdetto del dettaglio leggono i nuovi valori.

**Tech Stack:** NestJS 12 (ESM) + TypeORM + Postgres 17, Vitest; React 19 (frontend-admin, nessun test runner: verifica con tsc + browser).

**Spec:** `docs/superpowers/specs/2026-09-28-postal-esito-legale-design.md`

## Global Constraints

- Solo campagne `channelType === 'POSTAL'`; SEND e canali digitali invariati.
- Codici esito: `delivered`, `not_delivered`, `in_progress`, `no_legal_value`, `no_ar`, `unclassified`.
- CONSEGNATO (valori `postal_delivery_status`): `Consegnato`, `Consegnato a Domicilio`, `Consegnato a Sportello`, `Consegnato in Digitale`, `Compiuta Giacenza`, `Invio Rifiutato`.
- NON_CONSEGNATO: `Destinatario deceduto`, `Destinatario irreperibile`, `Destinatario sconosciuto`, `Destinatario trasferito`, `Indirizzo errato o inesatto`, `Indirizzo insufficiente`, `Indirizzo sconosciuto`, `Smarrito`, `Inesitato`.
- Valore non elencato → `in_progress`, mai `delivered`.
- Poste può solo promuovere a `delivered`; `returned` non cambia mai l'esito.
- `recipient.status` non viene mai scritto: "Fallito" per `Errore` GlobalCom è solo derivato.
- Mai dati reali (CF, nomi, IDPRO, codici raccomandata) in codice, test o commit: fixture con `ROSSI MARIO` / `RSSMRA80A01H501U` / `SOA_test-...`.
- Comandi da Git Bash: prefissare `MSYS_NO_PATHCONV=1` quando si passano path unix assoluti al container. Dopo modifiche a `apps/backend/src/` fare `docker compose restart backend` (il watch su Windows non sempre vede i cambi).
- Suite backend: baseline 1 fallimento noto (`app.controller.spec.ts` isLdapMock); criterio = failure set identico.
- Gotcha spec: `campaigns.service.spec.ts` mocka una sequenza fissa di `createQueryBuilder`; le nuove query in `getRecipientFilterOptions` passano da `recipientRepo.query()` (raw), mai da un `createQueryBuilder` in più.

## Scostamenti dalla spec (decisi in pianificazione)

- Barra esito e grafico "Stato Documento" leggono i conteggi esito da `filter-options.deliveryStatuses` (stessa sorgente del filtro, già in polling) invece di cambiare `getPostalStatusBreakdown`, che resta lo stato GlobalCom grezzo per "Andamento Invio POSTAL" e per il tasto "Verifica su Poste".
- CSV "attuale": oltre a "Stato Documento" (esito) e "Stato GlobalCom", colonne esplicite "Motivo", "Data Legale" e "Data Stato GlobalCom" (invece di riusare "Data Stato" per la data legale: evita ambiguità sul valore probatorio).

## Review Focus

- Destinatario dirottato INAD con ultimo tentativo PEC: deve risultare `delivered` "Via PEC", non `in_progress` (il suo ultimo tentativo non è POSTAL). Test in Task 1.
- Destinatario senza alcun tentativo (campagna appena lanciata): `in_progress`, nessun crash né `null` nel conteggio. Test in Task 1 (TS) e verifica SQL in Task 1 Step 7.
- Compiuta Giacenza con verifica Poste `returned`: resta `delivered` con motivo GlobalCom. Test in Task 1.
- Filtro "Stato documento" su POSTAL con valore legale combinato con filtro "Recapito Poste": i due filtri si sommano (AND) senza annullarsi. Test in Task 2.
- Campagna POSTAL senza AR (Ordinaria): tutti `no_ar` tranne dirottati (`delivered`) e App IO (`no_legal_value`). Test in Task 1.

---

## File map

- Create `apps/backend/src/campaigns/postal-legal-outcome.util.ts` — tabelle, `postalLegalOutcome()`, `postalLegalOutcomeCaseSql()`, `postalLegalOutcomeSql()`, `POSTAL_GLOBALCOM_ERROR_SQL`, `isPostalLegalOutcome()`, `POSTAL_LEGAL_OUTCOME_LABELS`.
- Create `apps/backend/src/campaigns/postal-legal-outcome.util.spec.ts`.
- Create `apps/backend/src/debug/postal-legal-outcome-parity.mjs` — confronto SQL vs TS su Postgres dev.
- Modify `apps/backend/src/campaigns/campaigns.service.ts` — `getRecipientStats`, `getRecipientFilterOptions`, `getPostalReport`.
- Modify `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` — campi nuovi su `RecipientStatDto`, `PostalReportRowDto`.
- Modify `apps/backend/src/campaigns/postal-report-csv.util.ts` (+ spec).
- Modify `apps/backend/src/notifications-search/notifications-search.service.ts`, `dto/notification-detail.dto.ts`.
- Modify `apps/frontend-admin/src/App.tsx`, `apps/frontend-admin/src/components/notification-detail/journey.ts`.
- Modify `docs/claude/postal-globalcom.md`.

---

### Task 1: Modulo esito legale (TS + SQL)

**Files:**
- Create: `apps/backend/src/campaigns/postal-legal-outcome.util.ts`
- Create: `apps/backend/src/campaigns/postal-legal-outcome.util.spec.ts`
- Create: `apps/backend/src/debug/postal-legal-outcome-parity.mjs`

**Interfaces:**
- Produces:
  - `type PostalLegalOutcome = 'delivered' | 'not_delivered' | 'in_progress' | 'no_legal_value' | 'no_ar' | 'unclassified'`
  - `interface PostalLegalOutcomeInput { diverted: boolean; arTracking: boolean; attempt: LegalOutcomeAttempt | null; poste: { status: string; outcomeAt: Date | null } | null }`
  - `interface LegalOutcomeAttempt { status: string; postalStatus: string | null; postalDeliveryStatus: string | null; postalDeliveryDate: Date | null; sentAt: Date | null; errorMessage?: string | null; postalStatusHistory?: Array<{ codiceErrore?: string; descrizione?: string }> | null }`
  - `interface PostalLegalOutcomeResult { outcome: PostalLegalOutcome; reason: string | null; at: Date | null }`
  - `postalLegalOutcome(input: PostalLegalOutcomeInput): PostalLegalOutcomeResult`
  - `postalLegalOutcomeCaseSql(arTracking: boolean, aliases?: { r?: string; la?: string; ppt?: string }): string` — `CASE … END` su colonne `r.inad_check`, `la.id`, `la.status`, `la.postal_status`, `la.postal_delivery_status`, `ppt.status`
  - `postalLegalOutcomeSql(arTracking: boolean, recipientAlias?: string): string` — sottoquery scalare correlata al destinatario
  - `POSTAL_GLOBALCOM_ERROR_SQL: string` — predicato "ultimo tentativo in Errore GlobalCom" (alias `r`)
  - `isPostalLegalOutcome(v: unknown): v is PostalLegalOutcome`
  - `POSTAL_LEGAL_OUTCOME_LABELS: Record<PostalLegalOutcome, string>`

- [ ] **Step 1: Write the failing test**

`apps/backend/src/campaigns/postal-legal-outcome.util.spec.ts`:

```ts
import {
  postalLegalOutcome,
  postalLegalOutcomeCaseSql,
  postalLegalOutcomeSql,
  isPostalLegalOutcome,
  POSTAL_LEGAL_OUTCOME_LABELS,
  type PostalLegalOutcomeInput,
  type LegalOutcomeAttempt,
} from './postal-legal-outcome.util.js';

const D = (s: string) => new Date(s);

function attempt(over: Partial<LegalOutcomeAttempt> = {}): LegalOutcomeAttempt {
  return { status: 'success', postalStatus: 'Confermato', postalDeliveryStatus: null, postalDeliveryDate: null, sentAt: D('2026-07-30T08:00:00Z'), ...over };
}
function input(over: Partial<PostalLegalOutcomeInput> = {}): PostalLegalOutcomeInput {
  return { diverted: false, arTracking: true, attempt: attempt(), poste: null, ...over };
}

describe('postalLegalOutcome', () => {
  it('dirottato INAD → delivered via PEC con data invio PEC', () => {
    const r = postalLegalOutcome(input({ diverted: true, attempt: attempt({ postalStatus: null, sentAt: D('2026-08-01T10:00:00Z') }) }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Via PEC', at: D('2026-08-01T10:00:00Z') });
  });

  it('App IO esclusiva → no_legal_value', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'AppIoSostituito' }) })).outcome).toBe('no_legal_value');
  });

  it('senza AR → no_ar, ma dirottato e App IO restano i loro', () => {
    expect(postalLegalOutcome(input({ arTracking: false })).outcome).toBe('no_ar');
    expect(postalLegalOutcome(input({ arTracking: false, diverted: true })).outcome).toBe('delivered');
    expect(postalLegalOutcome(input({ arTracking: false, attempt: attempt({ postalStatus: 'AppIoSostituito' }) })).outcome).toBe('no_legal_value');
  });

  it('nessun tentativo → in_progress', () => {
    expect(postalLegalOutcome(input({ attempt: null }))).toEqual({ outcome: 'in_progress', reason: null, at: null });
  });

  it('tentativo fallito → not_delivered col messaggio di errore', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ status: 'failed', postalStatus: null, errorMessage: 'CAP non valido' }) }));
    expect(r).toEqual({ outcome: 'not_delivered', reason: 'CAP non valido', at: null });
  });

  it('Errore GlobalCom → not_delivered con codice e descrizione dallo storico', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Errore', postalStatusHistory: [{ codiceErrore: '0' }, { codiceErrore: '1327', descrizione: 'Nazione in zona non ammessa' }] }) }));
    expect(r).toEqual({ outcome: 'not_delivered', reason: '1327: Nazione in zona non ammessa', at: null });
  });

  it('Errore GlobalCom senza storico → motivo generico', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Errore' }) })).reason).toBe('Errore GlobalCom');
  });

  it.each(['Consegnato', 'Consegnato a Domicilio', 'Consegnato a Sportello', 'Consegnato in Digitale', 'Compiuta Giacenza', 'Invio Rifiutato'])(
    '%s → delivered con DataConsegna GlobalCom',
    (v) => {
      const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: v === 'Consegnato' ? 'Consegnato' : 'NonConsegnato', postalDeliveryStatus: v, postalDeliveryDate: D('2026-09-08T00:00:00Z') }) }));
      expect(r).toEqual({ outcome: 'delivered', reason: v, at: D('2026-09-08T00:00:00Z') });
    },
  );

  it('Compiuta Giacenza con Poste returned → resta delivered (motivo GlobalCom)', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Compiuta Giacenza', postalDeliveryDate: D('2026-09-08T00:00:00Z') }), poste: { status: 'returned', outcomeAt: D('2026-09-18T14:00:00Z') } }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Compiuta Giacenza', at: D('2026-09-08T00:00:00Z') });
  });

  it('Indirizzo errato con Poste delivered → delivered da verifica Poste', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' }), poste: { status: 'delivered', outcomeAt: D('2026-09-04T09:00:00Z') } }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Verifica Poste', at: D('2026-09-04T09:00:00Z') });
  });

  it('Confermato fermo con Poste delivered → delivered da verifica Poste', () => {
    expect(postalLegalOutcome(input({ poste: { status: 'delivered', outcomeAt: D('2026-08-03T14:00:00Z') } })).outcome).toBe('delivered');
  });

  it.each(['Destinatario deceduto', 'Destinatario irreperibile', 'Destinatario sconosciuto', 'Destinatario trasferito', 'Indirizzo errato o inesatto', 'Indirizzo insufficiente', 'Indirizzo sconosciuto', 'Smarrito', 'Inesitato'])(
    '%s → not_delivered',
    (v) => {
      expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: v }) }))).toEqual({ outcome: 'not_delivered', reason: v, at: null });
    },
  );

  it('Poste returned da sola non cambia l\'esito', () => {
    expect(postalLegalOutcome(input({ poste: { status: 'returned', outcomeAt: D('2026-09-01T00:00:00Z') } })).outcome).toBe('in_progress');
  });

  it('Eliminato → unclassified con stato grezzo', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Eliminato' }) }))).toEqual({ outcome: 'unclassified', reason: 'Eliminato', at: null });
  });

  it('valore sconosciuto → in_progress, mai delivered', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'Valore mai visto' }) }))).toEqual({ outcome: 'in_progress', reason: 'Valore mai visto', at: null });
  });

  it('In giacenza / Accettato online → in_progress', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'In giacenza' }) })).outcome).toBe('in_progress');
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'Accettato online' }) })).outcome).toBe('in_progress');
  });
});

describe('postalLegalOutcomeCaseSql / postalLegalOutcomeSql', () => {
  it('con AR contiene tutte le regole nell\'ordine della spec', () => {
    const sql = postalLegalOutcomeCaseSql(true);
    const order = ['inad_check', 'AppIoSostituito', 'la.id IS NULL', "la.status = 'failed'", "la.postal_status = 'Errore'", "'Compiuta Giacenza'", "ppt.status = 'delivered'", "'Smarrito'", "'Eliminato'"]
      .map((frag) => sql.indexOf(frag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('senza AR: dopo dirottato e App IO tutto no_ar', () => {
    const sql = postalLegalOutcomeCaseSql(false);
    expect(sql).toContain("ELSE 'no_ar'");
    expect(sql).not.toContain('Compiuta Giacenza');
  });

  it('sottoquery scalare correlata al destinatario, sempre una riga', () => {
    const sql = postalLegalOutcomeSql(true, 'rx');
    expect(sql).toContain('na.recipient_id = rx.id');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('rx.inad_check');
  });

  it('valori quotati come letterali SQL', () => {
    expect(postalLegalOutcomeCaseSql(true)).toContain("'Invio Rifiutato'");
    expect(postalLegalOutcomeCaseSql(true)).toContain("'Indirizzo errato o inesatto'");
  });
});

describe('isPostalLegalOutcome / labels', () => {
  it('riconosce solo i codici', () => {
    expect(isPostalLegalOutcome('delivered')).toBe(true);
    expect(isPostalLegalOutcome('Consegnato')).toBe(false);
    expect(Object.keys(POSTAL_LEGAL_OUTCOME_LABELS).sort()).toEqual(['delivered', 'in_progress', 'no_ar', 'no_legal_value', 'not_delivered', 'unclassified']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run postal-legal-outcome`
Expected: FAIL — `Cannot find module './postal-legal-outcome.util.js'`

- [ ] **Step 3: Write minimal implementation**

`apps/backend/src/campaigns/postal-legal-outcome.util.ts`:

```ts
/**
 * Esito legale di una notifica POSTAL (spec 2026-09-28-postal-esito-legale):
 * "Consegnato" = ogni caso che per legge equivale a consegna, con la data
 * legale (valore probatorio). Derivato in lettura, mai scritto. Stesse
 * tabelle per la regola TypeScript (CSV, dettaglio, righe tabella) e per
 * l'espressione SQL (conteggi, filtro, ordinamento): mai duplicarle a mano.
 *
 * Il motivo lo dà GlobalCom (`postal_delivery_status`): Poste non distingue
 * compiuta giacenza/rifiuto da un indirizzo errato (vede solo "restituita"),
 * quindi può solo promuovere a consegnato, mai togliere un esito.
 */

export type PostalLegalOutcome = 'delivered' | 'not_delivered' | 'in_progress' | 'no_legal_value' | 'no_ar' | 'unclassified';

export const POSTAL_LEGAL_OUTCOMES: readonly PostalLegalOutcome[] = ['delivered', 'not_delivered', 'in_progress', 'no_legal_value', 'no_ar', 'unclassified'];

export const POSTAL_LEGAL_OUTCOME_LABELS: Record<PostalLegalOutcome, string> = {
  delivered: 'Consegnato',
  not_delivered: 'Non consegnato',
  in_progress: 'In corso',
  no_legal_value: 'Senza valore legale (solo App IO)',
  no_ar: 'Senza AR',
  unclassified: 'Non classificato',
};

/** Valori reali di `StatoConsegna` GlobalCom (verificati in produzione) che valgono consegna. */
export const LEGAL_DELIVERED_STATUSES: readonly string[] = [
  'Consegnato', 'Consegnato a Domicilio', 'Consegnato a Sportello', 'Consegnato in Digitale', 'Compiuta Giacenza', 'Invio Rifiutato',
];

export const LEGAL_NOT_DELIVERED_STATUSES: readonly string[] = [
  'Destinatario deceduto', 'Destinatario irreperibile', 'Destinatario sconosciuto', 'Destinatario trasferito',
  'Indirizzo errato o inesatto', 'Indirizzo insufficiente', 'Indirizzo sconosciuto', 'Smarrito', 'Inesitato',
];

export interface LegalOutcomeAttempt {
  status: string;
  postalStatus: string | null;
  postalDeliveryStatus: string | null;
  postalDeliveryDate: Date | null;
  sentAt: Date | null;
  errorMessage?: string | null;
  postalStatusHistory?: Array<{ codiceErrore?: string; descrizione?: string }> | null;
}

export interface PostalLegalOutcomeInput {
  diverted: boolean;
  arTracking: boolean;
  /** Ultimo tentativo del destinatario (qualunque canale: il dirottato ha un PEC). */
  attempt: LegalOutcomeAttempt | null;
  /** Riga verifica Poste dell'ultimo tentativo. */
  poste: { status: string; outcomeAt: Date | null } | null;
}

export interface PostalLegalOutcomeResult {
  outcome: PostalLegalOutcome;
  reason: string | null;
  at: Date | null;
}

export function isPostalLegalOutcome(v: unknown): v is PostalLegalOutcome {
  return typeof v === 'string' && (POSTAL_LEGAL_OUTCOMES as readonly string[]).includes(v);
}

function globalcomErrorReason(a: LegalOutcomeAttempt): string {
  const last = [...(a.postalStatusHistory ?? [])].reverse().find((h) => h.codiceErrore && h.codiceErrore !== '0');
  if (!last) return 'Errore GlobalCom';
  return last.descrizione ? `${last.codiceErrore}: ${last.descrizione}` : String(last.codiceErrore);
}

export function postalLegalOutcome(i: PostalLegalOutcomeInput): PostalLegalOutcomeResult {
  const a = i.attempt;
  if (i.diverted) return { outcome: 'delivered', reason: 'Via PEC', at: a?.sentAt ?? null };
  if (a?.postalStatus === 'AppIoSostituito') return { outcome: 'no_legal_value', reason: 'Solo App IO', at: null };
  if (!i.arTracking) return { outcome: 'no_ar', reason: null, at: null };
  if (!a) return { outcome: 'in_progress', reason: null, at: null };
  if (a.status === 'failed') return { outcome: 'not_delivered', reason: a.errorMessage ?? 'Invio fallito', at: null };
  if (a.postalStatus === 'Errore') return { outcome: 'not_delivered', reason: globalcomErrorReason(a), at: null };
  const ds = a.postalDeliveryStatus;
  if (ds && LEGAL_DELIVERED_STATUSES.includes(ds)) return { outcome: 'delivered', reason: ds, at: a.postalDeliveryDate };
  if (i.poste?.status === 'delivered') return { outcome: 'delivered', reason: 'Verifica Poste', at: i.poste.outcomeAt };
  if (ds && LEGAL_NOT_DELIVERED_STATUSES.includes(ds)) return { outcome: 'not_delivered', reason: ds, at: null };
  if (a.postalStatus === 'Eliminato') return { outcome: 'unclassified', reason: 'Eliminato', at: null };
  return { outcome: 'in_progress', reason: ds ?? null, at: null };
}

const sqlList = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

/**
 * `CASE … END` con la stessa regola di postalLegalOutcome, su colonne
 * `<r>.inad_check`, `<la>.id/status/postal_status/postal_delivery_status`
 * (ultimo tentativo) e `<ppt>.status` (verifica Poste dell'ultimo tentativo).
 */
export function postalLegalOutcomeCaseSql(arTracking: boolean, aliases: { r?: string; la?: string; ppt?: string } = {}): string {
  const r = aliases.r ?? 'r';
  const la = aliases.la ?? 'la';
  const ppt = aliases.ppt ?? 'ppt';
  const head = `CASE
    WHEN COALESCE((${r}.inad_check->>'diverted')::boolean, false) THEN 'delivered'
    WHEN ${la}.postal_status = 'AppIoSostituito' THEN 'no_legal_value'`;
  if (!arTracking) return `${head}
    ELSE 'no_ar' END`;
  return `${head}
    WHEN ${la}.id IS NULL THEN 'in_progress'
    WHEN ${la}.status = 'failed' THEN 'not_delivered'
    WHEN ${la}.postal_status = 'Errore' THEN 'not_delivered'
    WHEN ${la}.postal_delivery_status IN (${sqlList(LEGAL_DELIVERED_STATUSES)}) THEN 'delivered'
    WHEN ${ppt}.status = 'delivered' THEN 'delivered'
    WHEN ${la}.postal_delivery_status IN (${sqlList(LEGAL_NOT_DELIVERED_STATUSES)}) THEN 'not_delivered'
    WHEN ${la}.postal_status = 'Eliminato' THEN 'unclassified'
    ELSE 'in_progress' END`;
}

/**
 * Sottoquery scalare: esito legale del destinatario `<recipientAlias>`,
 * sempre una riga (anche senza tentativi). Usabile in SELECT, WHERE,
 * GROUP BY e ORDER BY.
 */
export function postalLegalOutcomeSql(arTracking: boolean, recipientAlias = 'r'): string {
  return `(SELECT ${postalLegalOutcomeCaseSql(arTracking, { r: recipientAlias, la: 'la', ppt: 'ppt' })}
    FROM (SELECT 1) AS _one
    LEFT JOIN LATERAL (
      SELECT na.id, na.status, na.postal_status, na.postal_delivery_status
      FROM notification_attempts na
      WHERE na.recipient_id = ${recipientAlias}.id
      ORDER BY na.attempt_number DESC
      LIMIT 1
    ) la ON true
    LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = la.id)`;
}

/**
 * Ultimo tentativo del destinatario `r` in `Errore` GlobalCom (es. nazione
 * non ammessa): "Stato notifica" lo mostra Fallito, `recipient.status`
 * resta `sent` (governa completamento e retry). Se GlobalCom corregge o
 * riaccoda, torna da solo.
 */
export const POSTAL_GLOBALCOM_ERROR_SQL = `EXISTS (
  SELECT 1 FROM notification_attempts na_err
  WHERE na_err.recipient_id = r.id
    AND na_err.attempt_number = (SELECT MAX(na_err2.attempt_number) FROM notification_attempts na_err2 WHERE na_err2.recipient_id = r.id)
    AND na_err.postal_status = 'Errore'
)`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run postal-legal-outcome`
Expected: PASS (tutti).

- [ ] **Step 5: Parity script SQL vs TS su Postgres dev**

`apps/backend/src/debug/postal-legal-outcome-parity.mjs` (cartella `debug/` esclusa dall'immagine):

```js
// Confronta postalLegalOutcomeCaseSql (valutata da Postgres) con
// postalLegalOutcome (TS) su una matrice di casi, senza toccare tabelle.
// Uso: docker compose exec -w /app/apps/backend backend node src/debug/postal-legal-outcome-parity.mjs
import pg from 'pg';
import { postalLegalOutcome, postalLegalOutcomeCaseSql } from '../../dist/campaigns/postal-legal-outcome.util.js';

const statuses = [null, 'Consegnato', 'Consegnato a Domicilio', 'Compiuta Giacenza', 'Invio Rifiutato', 'Indirizzo errato o inesatto', 'Smarrito', 'Inesitato', 'In giacenza', 'Valore mai visto'];
const postalStatuses = [null, 'Confermato', 'NonConsegnato', 'Consegnato', 'Errore', 'Eliminato', 'AppIoSostituito'];
const cases = [];
for (const diverted of [false, true]) for (const hasAttempt of [false, true]) for (const status of ['success', 'failed'])
  for (const ps of postalStatuses) for (const ds of statuses) for (const poste of [null, 'delivered', 'returned', 'pending'])
    cases.push({ diverted, hasAttempt, status, ps, ds, poste });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let mismatches = 0;
for (const ar of [true, false]) {
  const values = cases.map((c, i) => `(${i}, '{"diverted": ${c.diverted}}'::jsonb, ${c.hasAttempt ? `'00000000-0000-0000-0000-${String(i).padStart(12, '0')}'::uuid` : 'NULL::uuid'}, ${c.hasAttempt ? `'${c.status}'` : 'NULL'}, ${c.hasAttempt && c.ps ? `'${c.ps}'` : 'NULL'}, ${c.hasAttempt && c.ds ? `'${c.ds}'` : 'NULL'}, ${c.hasAttempt && c.poste ? `'${c.poste}'` : 'NULL'})`).join(',\n');
  const sql = `SELECT v.i, ${postalLegalOutcomeCaseSql(ar, { r: 'v', la: 'v', ppt: 'vp' })} AS outcome
    FROM (VALUES ${values}) AS v(i, inad_check, id, status, postal_status, postal_delivery_status, ppt_status)
    CROSS JOIN LATERAL (SELECT v.ppt_status AS status) vp
    ORDER BY v.i`;
  const { rows } = await client.query(sql);
  for (const row of rows) {
    const c = cases[row.i];
    const ts = postalLegalOutcome({
      diverted: c.diverted,
      arTracking: ar,
      attempt: c.hasAttempt ? { status: c.status, postalStatus: c.ps, postalDeliveryStatus: c.ds, postalDeliveryDate: null, sentAt: null } : null,
      poste: c.hasAttempt && c.poste ? { status: c.poste, outcomeAt: null } : null,
    }).outcome;
    if (ts !== row.outcome) { mismatches++; if (mismatches <= 20) console.log('MISMATCH', { ar, ...c, sql: row.outcome, ts }); }
  }
  console.log(`ar=${ar}: ${rows.length} casi confrontati`);
}
await client.end();
console.log(mismatches === 0 ? 'OK: SQL e TS coincidono' : `KO: ${mismatches} differenze`);
process.exit(mismatches === 0 ? 0 : 1);
```

Nota: nel caso "nessun tentativo" la TS riceve `attempt: null` mentre la riga SQL ha tutti i campi NULL e `id` NULL — stessa semantica di `LEFT JOIN LATERAL` senza righe.

- [ ] **Step 6: Run parity script**

Run:
```bash
docker compose restart backend
docker compose exec backend ls -la dist/campaigns/postal-legal-outcome.util.js
MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend backend node src/debug/postal-legal-outcome-parity.mjs
```
Expected: `OK: SQL e TS coincidono`. Il file in `dist/` deve essere più recente del `src/` (se no, attendere il rebuild del watch o rilanciare `restart`).

- [ ] **Step 7: Verifica sottoquery scalare su tabelle reali**

Run:
```bash
MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend backend node -e "import('./dist/campaigns/postal-legal-outcome.util.js').then(async (m) => { const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); const r = await c.query('SELECT ' + m.postalLegalOutcomeSql(true) + ' AS o, COUNT(*)::int AS n FROM recipients r GROUP BY 1'); console.log(r.rows); await c.end(); })"
```
Expected: righe `{ o, n }` senza errori SQL e senza `o: null`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/postal-legal-outcome.util.ts apps/backend/src/campaigns/postal-legal-outcome.util.spec.ts apps/backend/src/debug/postal-legal-outcome-parity.mjs
git commit -m "feat(postal): modulo esito legale (regola TS + SQL dalle stesse tabelle)"
```

---

### Task 2: Pagina destinatari — filtro, ordinamento, campi riga, Stato notifica derivato

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`getRecipientStats`, ~righe 2575-2890)
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (`RecipientStatDto`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes (Task 1): `postalLegalOutcome`, `postalLegalOutcomeSql`, `POSTAL_GLOBALCOM_ERROR_SQL`, `isPostalLegalOutcome`.
- Produces: `RecipientStatDto.legalOutcome?: PostalLegalOutcome | null`, `legalOutcomeReason?: string | null`, `legalOutcomeAt?: Date | null`. Per POSTAL: filtro `deliveryStatus` accetta i codici esito; `status=failed` include gli `Errore` GlobalCom; `status=sent` li esclude; `item.status` = `'failed'` per quelli.

- [ ] **Step 1: Write the failing tests**

In `campaigns.service.spec.ts`, nel `describe` di `getRecipientStats` (cercare `describe('getRecipientStats'`), riusare il setup esistente che costruisce `qb` mock con `andWhere`/`orderBy` spiati (stesso pattern dei test già presenti per `status === 'read'`). Aggiungere:

```ts
it('POSTAL: deliveryStatus con codice esito legale filtra sull\'espressione esito, non su postal_status', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1', postalReturnReceipt: true } });
  await service.getRecipientStats('c1', 1, 50, undefined, undefined, 'delivered');
  const where = qb.andWhere.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(where.some((w) => w.includes('LEFT JOIN LATERAL') && w.includes('= :legalOutcome'))).toBe(true);
  expect(where.some((w) => w.includes('na.postal_status = :deliveryStatus'))).toBe(false);
});

it('POSTAL: filtro esito legale e filtro Recapito Poste si sommano', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1', postalReturnReceipt: true } });
  await service.getRecipientStats('c1', 1, 50, undefined, undefined, 'delivered', undefined, undefined, 'Compiuta Giacenza');
  const where = qb.andWhere.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(where.some((w) => w.includes('= :legalOutcome'))).toBe(true);
  expect(where.some((w) => w.includes('na.postal_delivery_status = :postalDeliveryStatus'))).toBe(true);
});

it('POSTAL: status=failed include gli Errore GlobalCom, status=sent li esclude', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: {} });
  await service.getRecipientStats('c1', 1, 50, undefined, 'failed');
  let where = qb.andWhere.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(where.some((w) => w.includes("r.status = 'failed' OR") && w.includes("na_err.postal_status = 'Errore'"))).toBe(true);
  qb.andWhere.mockClear();
  await service.getRecipientStats('c1', 1, 50, undefined, 'sent');
  where = qb.andWhere.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(where.some((w) => w.includes("NOT EXISTS") || w.includes('NOT (EXISTS'))).toBe(true);
});

it('POSTAL: riga con esito legale, motivo, data e stato Fallito per Errore GlobalCom', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1', postalReturnReceipt: true } });
  qb.getManyAndCount.mockResolvedValue([[
    { id: 'r1', status: 'sent', inadCheck: null, downloadCount: 0 },
    { id: 'r2', status: 'sent', inadCheck: null, downloadCount: 0 },
  ], 2]);
  mockAttemptRepo.find.mockResolvedValue([
    { id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Compiuta Giacenza', postalDeliveryDate: new Date('2026-09-08T00:00:00Z'), sentAt: new Date('2026-07-30T00:00:00Z') },
    { id: 'a2', recipientId: 'r2', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'Errore', postalStatusHistory: [{ stato: 'Errore', rilevatoIl: '2026-07-31', codiceErrore: '1327', descrizione: 'Nazione non ammessa' }], sentAt: new Date('2026-07-30T00:00:00Z') },
  ]);
  const res = await service.getRecipientStats('c1', 1, 50);
  expect(res.items[0]).toMatchObject({ status: 'sent', legalOutcome: 'delivered', legalOutcomeReason: 'Compiuta Giacenza', legalOutcomeAt: new Date('2026-09-08T00:00:00Z') });
  expect(res.items[1]).toMatchObject({ status: 'failed', legalOutcome: 'not_delivered', legalOutcomeReason: '1327: Nazione non ammessa' });
});
```

Adattare i nomi dei mock (`mockCampaignRepo`, `mockAttemptRepo`, `qb`) a quelli effettivamente usati nel file: leggere prima il `describe('getRecipientStats'` esistente e copiarne il setup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec -t "POSTAL:"`
Expected: FAIL (nessun filtro `:legalOutcome`, nessun `legalOutcome` sulle righe).

- [ ] **Step 3: DTO**

In `dto/campaign-stats.dto.ts`, dentro `RecipientStatDto` (dopo `posteDeliveredAt`), aggiungere:

```ts
  /** Solo POSTAL: esito legale derivato (spec 2026-09-28-postal-esito-legale). */
  legalOutcome?: PostalLegalOutcome | null;
  legalOutcomeReason?: string | null;
  legalOutcomeAt?: Date | null;
```
con `import type { PostalLegalOutcome } from '../postal-legal-outcome.util.js';` in testa.

- [ ] **Step 4: Filtri status/deliveryStatus**

In `campaigns.service.ts` importare:
```ts
import { postalLegalOutcome, postalLegalOutcomeSql, POSTAL_GLOBALCOM_ERROR_SQL, isPostalLegalOutcome } from './postal-legal-outcome.util.js';
```

In `getRecipientStats`, sostituire il blocco status (da `const tracksRead = …` fino alla chiusura dell'`else if (status)`) con:

```ts
    const tracksRead = READ_STATUS_CHANNELS.includes(campaign.channelType);
    const isPostal = campaign.channelType === 'POSTAL';
    if (status === READ_STATUS && tracksRead) {
      qb.andWhere('r.status = :status', { status: 'sent' });
      qb.andWhere(HAS_DOWNLOAD_SQL);
    } else if (status === 'failed' && isPostal) {
      // Errore GlobalCom dopo l'accettazione: mostrato Fallito, recipient.status resta sent.
      qb.andWhere(`(r.status = 'failed' OR (r.status = 'sent' AND ${POSTAL_GLOBALCOM_ERROR_SQL}))`);
    } else if (status) {
      qb.andWhere('r.status = :status', { status });
      // "Inviato" su canale digitale = inviato e non ancora letto.
      if (status === 'sent' && tracksRead) qb.andWhere(`NOT ${HAS_DOWNLOAD_SQL}`);
      if (status === 'sent' && isPostal) qb.andWhere(`NOT ${POSTAL_GLOBALCOM_ERROR_SQL}`);
    }
```

Subito dopo, prima del blocco `if (deliveryStatus === 'DirottatoAPec' || …)`, aggiungere:

```ts
    // POSTAL: "Stato documento" = esito legale. Il valore del filtro è un
    // codice esito, mai un postal_status grezzo.
    const legalFilter = isPostal && isPostalLegalOutcome(deliveryStatus);
    if (legalFilter) {
      qb.andWhere(`${postalLegalOutcomeSql(hasPostalArTracking(campaign))} = :legalOutcome`, { legalOutcome: deliveryStatus });
    }
    const rawDeliveryStatus = legalFilter ? undefined : deliveryStatus;
```

e nei tre rami successivi che leggono `deliveryStatus` (`=== 'DirottatoAPec'`, `=== PENDING_DELIVERY_STATUS_SENTINEL`, `else if (deliveryStatus && deliveryStatus !== 'DirottatoAPec')`) sostituire `deliveryStatus` con `rawDeliveryStatus` (anche nel parametro `{ deliveryStatus }` → `{ deliveryStatus: rawDeliveryStatus }`). I rami `postalDeliveryStatus` restano invariati.

- [ ] **Step 5: Ordinamento**

Nel ramo `else if (sortBy === 'postalStatus')` sostituire con:

```ts
    } else if (sortBy === 'postalStatus') {
      if (isPostal) {
        qb.orderBy(postalLegalOutcomeSql(hasPostalArTracking(campaign)), dir);
      } else {
        qb.orderBy(
          `(SELECT na.postal_status FROM notification_attempts na WHERE na.recipient_id = r.id AND na.postal_status IS NOT NULL ORDER BY na.attempt_number DESC LIMIT 1)`,
          dir,
          'NULLS LAST',
        );
      }
      if (typeof (qb as any).addOrderBy === 'function') (qb as any).addOrderBy('r.id', 'ASC');
```

- [ ] **Step 6: Campi riga**

Nel ciclo `for (const item of items)`, dopo `item.costCents = latest.costCents ?? null;` e fuori dall'`if (latest)` (serve anche senza tentativi), aggiungere:

```ts
        if (isPostal) {
          const poste = latest ? posteByAttempt.get(latest.id) : undefined;
          const legal = postalLegalOutcome({
            diverted: !!item.inadCheck?.diverted,
            arTracking: hasPostalArTracking(campaign),
            attempt: latest ?? null,
            poste: poste ? { status: poste.status, outcomeAt: poste.outcomeAt ?? null } : null,
          });
          item.legalOutcome = legal.outcome;
          item.legalOutcomeReason = legal.reason;
          item.legalOutcomeAt = legal.at;
          if (item.status === 'sent' && latest?.postalStatus === 'Errore') {
            item.status = 'failed';
            item.lastError = item.lastError ?? legal.reason;
          }
        }
```

`latest` è un `NotificationAttempt` (campi `status`, `postalStatus`, `postalDeliveryStatus`, `postalDeliveryDate`, `sentAt`, `errorMessage`, `postalStatusHistory` compatibili con `LegalOutcomeAttempt`); se tsc segnala incompatibilità su `postalStatusHistory`, passare `{ ...latest, postalStatusHistory: latest.postalStatusHistory ?? null }`. Il caricamento `posteByAttempt` esistente filtra già gli attempt POSTAL: nessuna query in più.

- [ ] **Step 7: Run tests**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec`
Expected: PASS i nuovi test; nessun test preesistente rotto. Poi `docker compose exec backend node_modules/.bin/tsc --noEmit` pulito.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(postal): esito legale e stato Fallito derivato nella pagina destinatari"
```

---

### Task 3: Opzioni filtro — conteggi esito legale e Stato notifica

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`getRecipientFilterOptions`, ~righe 2898-3075)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes (Task 1): `postalLegalOutcomeSql`, `POSTAL_GLOBALCOM_ERROR_SQL`.
- Produces: per POSTAL, `deliveryStatuses` = `[{ value: PostalLegalOutcome, count }]` (nient'altro: niente sentinella pending né `DirottatoAPec`, già inclusi negli esiti); `statuses` con `failed` che include gli `Errore` GlobalCom. Il frontend (Task 5) legge questi valori per barra, filtro e grafico.

- [ ] **Step 1: Write the failing test**

Nel `describe` di `getRecipientFilterOptions` (riusare il setup esistente con la sequenza di `createQueryBuilder` mockata), aggiungere:

```ts
it('POSTAL: deliveryStatuses = conteggi per esito legale da query raw', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1', postalReturnReceipt: true } });
  mockRecipientRepo.query = vi.fn().mockResolvedValue([{ value: 'delivered', count: 3 }, { value: 'in_progress', count: 2 }]);
  const res = await service.getRecipientFilterOptions('c1');
  expect(res.deliveryStatuses).toEqual([{ value: 'delivered', count: 3 }, { value: 'in_progress', count: 2 }]);
  const sql = String(mockRecipientRepo.query.mock.calls[0][0]);
  expect(sql).toContain('LEFT JOIN LATERAL');
  expect(sql).toContain('GROUP BY 1');
});

it('POSTAL: statuses conta come failed gli Errore GlobalCom', async () => {
  mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: {} });
  mockRecipientRepo.query = vi.fn().mockResolvedValue([]);
  await service.getRecipientFilterOptions('c1');
  const selects = qb.select.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(selects.some((s) => s.includes("THEN 'failed'") && s.includes("na_err.postal_status = 'Errore'"))).toBe(true);
});
```

Adattare `mockRecipientRepo`/`qb` ai nomi del file. Se il mock del repo recipients non ha `query`, i test esistenti per POSTAL andranno aggiornati con `query: vi.fn().mockResolvedValue([])` (nessun cambio di sequenza `createQueryBuilder`).

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec -t "POSTAL:"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Sostituire la definizione di `statusExpr` con:

```ts
    // Canali digitali: "read" (inviato + download) separato da "sent".
    // POSTAL: "failed" include gli Errore GlobalCom dopo l'accettazione
    // (derivato, recipient.status resta sent).
    const statusExpr = READ_STATUS_CHANNELS.includes(campaign.channelType)
      ? `CASE WHEN r.status = 'sent' AND ${HAS_DOWNLOAD_SQL} THEN '${READ_STATUS}' ELSE r.status::text END`
      : campaign.channelType === 'POSTAL'
        ? `CASE WHEN r.status = 'sent' AND ${POSTAL_GLOBALCOM_ERROR_SQL} THEN 'failed' ELSE r.status::text END`
        : 'r.status';
```

Dopo il calcolo di `posteCheckedCount` (prima del `return`), aggiungere:

```ts
    // POSTAL: "Stato documento" = esito legale. Query raw (niente
    // createQueryBuilder in più: le spec ne mockano una sequenza fissa).
    const legalOutcomeRows = campaign.channelType === 'POSTAL'
      ? ((await this.recipientRepo.query(
        `SELECT ${postalLegalOutcomeSql(hasPostalArTracking(campaign))} AS value, COUNT(*)::int AS count
         FROM recipients r WHERE r.campaign_id = $1 GROUP BY 1`,
        [campaignId],
      )) as Array<{ value: string; count: number }> | undefined) ?? []
      : null;
```

e nel `return` sostituire la chiave `deliveryStatuses` con:

```ts
      deliveryStatuses: legalOutcomeRows
        ? legalOutcomeRows.map((r) => ({ value: r.value, count: Number(r.count) }))
        : [
          ...deliveryRows.map((r) => ({ value: r.value, count: Number(r.count) })),
          ...(pendingCount > 0 ? [{ value: PENDING_DELIVERY_STATUS_SENTINEL, count: pendingCount }] : []),
          ...(divertedCount > 0 ? [{ value: 'DirottatoAPec', count: divertedCount }] : []),
        ],
```

- [ ] **Step 4: Run tests + tsc**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: PASS, tsc pulito.

- [ ] **Step 5: Verifica SQL reale**

Run (token dallo snippet in CLAUDE.md, sostituire `<TOKEN>` e un id di campagna POSTAL dev, se presente; altrimenti una qualunque campagna: la query deve comunque girare):
```bash
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -At -c "SELECT id FROM campaigns WHERE channel_type = 'POSTAL' LIMIT 1;"
MSYS_NO_PATHCONV=1 docker compose exec -T backend node -e "fetch('http://localhost:8080/admin/campaigns/<ID>/stats/recipients/filter-options',{headers:{Authorization:'Bearer <TOKEN>'}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.deliveryStatuses), JSON.stringify(j.statuses)))"
```
Expected: HTTP 200, `deliveryStatuses` con codici esito (se POSTAL), nessun 500.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(postal): conteggi esito legale e Fallito derivato nelle opzioni filtro"
```

---

### Task 4: Report CSV e dettaglio notifica

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`getPostalReport`, ~righe 3509-3569)
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (`PostalReportRowDto`)
- Modify: `apps/backend/src/campaigns/postal-report-csv.util.ts`
- Test: `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts` (`getDetail`)
- Modify: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Consumes (Task 1): `postalLegalOutcome`, `POSTAL_LEGAL_OUTCOME_LABELS`, `PostalLegalOutcome`.
- Produces:
  - `PostalReportRowDto.legalOutcome: PostalLegalOutcome`, `legalOutcomeReason: string | null`, `legalOutcomeAt: string | null` (ISO)
  - `NotificationDetailDto.legalOutcome: { outcome: PostalLegalOutcome; reason: string | null; at: string | null } | null` (null se campagna non POSTAL)
  - CSV "attuale": colonne `Stato Documento` (etichetta esito), `Motivo`, `Data Legale`, `Stato GlobalCom`, `Data Stato GlobalCom`, poi le colonne esistenti da `Stato Consegna Poste` in avanti.

- [ ] **Step 1: Write the failing CSV test**

In `postal-report-csv.util.spec.ts` aggiornare l'asserzione dell'header esistente (riga ~32) a:

```ts
expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IDPRO";"Stato Documento";"Motivo";"Data Legale";"Stato GlobalCom";"Data Stato GlobalCom";"Stato Consegna Poste";"Codice Consegna";"Data Consegna Poste";"ID Accettazione Poste";"Codice Errore";"Descrizione Errore";"Verifica Poste";"Sintesi Poste";"Data Esito Poste";"Ultimo Movimento Poste";"Discrepanza GlobalCom/Poste"');
```

e aggiungere:

```ts
it('attuale: Stato Documento = esito legale con motivo e data legale, stato GlobalCom a parte', () => {
  const csv = buildPostalReportAttualeCsv({
    hasAppIoCoDelivery: false,
    hasExternalId: false,
    rows: [{
      ...baseRow, // riusare la riga di fixture già definita nel file (ROSSI MARIO / RSSMRA80A01H501U)
      postalStatus: 'NonConsegnato',
      postalDeliveryStatus: 'Compiuta Giacenza',
      legalOutcome: 'delivered',
      legalOutcomeReason: 'Compiuta Giacenza',
      legalOutcomeAt: '2026-09-08T00:00:00.000Z',
    }],
  });
  const fields = csv.split('\n')[1].split(';');
  expect(fields[3]).toBe('"Consegnato"');
  expect(fields[4]).toBe('"Compiuta Giacenza"');
  expect(fields[5]).toContain('8/9/2026'); // formatDate usa toLocaleString it-IT, senza zeri iniziali
  expect(fields[6]).toBe('"Non consegnato"');
});
```

(`fields[6]` = etichetta di `postalStatusLabel('NonConsegnato')`: verificare il valore esatto in `postal-status-labels.util.ts` e allinearlo. Se nel file non esiste una fixture `baseRow`, definirla copiando la riga usata dal test dell'header, aggiungendo i tre campi `legalOutcome*`.)

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run postal-report-csv`
Expected: FAIL.

- [ ] **Step 3: DTO + report + CSV**

`PostalReportRowDto` (in `campaign-stats.dto.ts`), aggiungere:

```ts
  /** Esito legale (spec 2026-09-28-postal-esito-legale). */
  legalOutcome: PostalLegalOutcome;
  legalOutcomeReason: string | null;
  legalOutcomeAt: string | null;
```

`getPostalReport`: nella `recipientRepo.find` aggiungere `inadCheck: true` al `select`; nel `map` delle righe, prima del `return {`, calcolare:

```ts
      const legal = postalLegalOutcome({
        diverted: !!r.inadCheck?.diverted,
        arTracking: hasPostalArTracking(campaign),
        attempt: latest ?? null,
        poste: poste ? { status: poste.status, outcomeAt: poste.outcomeAt ?? null } : null,
      });
```

e aggiungere all'oggetto riga:

```ts
        legalOutcome: legal.outcome,
        legalOutcomeReason: legal.reason,
        legalOutcomeAt: legal.at ? legal.at.toISOString() : null,
```

`postal-report-csv.util.ts`: importare `import { POSTAL_LEGAL_OUTCOME_LABELS } from './postal-legal-outcome.util.js';`, poi in `buildPostalReportAttualeCsv` usare:

```ts
  const headers = ['Codice Fiscale', 'Nominativo', 'IDPRO', 'Stato Documento', 'Motivo', 'Data Legale', 'Stato GlobalCom', 'Data Stato GlobalCom', 'Stato Consegna Poste', 'Codice Consegna', 'Data Consegna Poste', 'ID Accettazione Poste', 'Codice Errore', 'Descrizione Errore', ...POSTE_HEADERS];
```

e nei `fields` sostituire le due voci `postalStatusLabel(r.postalStatus), formatDate(latestEntry?.rilevatoIl),` con:

```ts
      POSTAL_LEGAL_OUTCOME_LABELS[r.legalOutcome],
      r.legalOutcomeReason ?? '',
      formatDate(r.legalOutcomeAt ?? undefined),
      postalStatusLabel(r.postalStatus),
      formatDate(latestEntry?.rilevatoIl),
```

Il CSV "storico" resta invariato.

- [ ] **Step 4: Run CSV tests**

Run: `docker compose exec backend node_modules/.bin/vitest run postal-report-csv campaigns.service.spec`
Expected: PASS. Correggere eventuali test di `getPostalReport` che confrontano l'oggetto riga intero (aggiungere i tre campi attesi).

- [ ] **Step 5: Write the failing detail test**

In `notifications-search.service.spec.ts`, nel `describe` di `getDetail`, aggiungere (riusare il setup esistente per una notifica POSTAL; se non c'è, copiare quello di un test POSTAL con `posteVerification`):

```ts
it('POSTAL: dettaglio con esito legale (Compiuta Giacenza = consegnato, data GlobalCom)', async () => {
  // recipient con campaign { channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1', postalReturnReceipt: true } }, inadCheck null
  // attempt POSTAL success, postalStatus 'NonConsegnato', postalDeliveryStatus 'Compiuta Giacenza', postalDeliveryDate 2026-09-08
  const res = await service.getDetail('r1');
  expect(res.legalOutcome).toEqual({ outcome: 'delivered', reason: 'Compiuta Giacenza', at: '2026-09-08T00:00:00.000Z' });
});

it('non POSTAL: legalOutcome null', async () => {
  // recipient con campaign EMAIL
  const res = await service.getDetail('r1');
  expect(res.legalOutcome).toBeNull();
});
```

Completare i commenti con i mock reali del file (stessi `mockRecipientRepo.findOne` / `mockAttemptRepo.find` degli altri test di `getDetail`).

- [ ] **Step 6: Implement detail**

`notification-detail.dto.ts`, in `NotificationDetailDto` aggiungere:

```ts
  /** Solo POSTAL: esito legale derivato (spec 2026-09-28-postal-esito-legale). */
  legalOutcome: { outcome: PostalLegalOutcome; reason: string | null; at: string | null } | null;
```

`notifications-search.service.ts` `getDetail`: importare `postalLegalOutcome` da `../campaigns/postal-legal-outcome.util.js` e `hasPostalArTracking` da `../campaigns/campaigns.service.js`. Dopo il calcolo di `posteByAttempt`, aggiungere:

```ts
    const latestAttempt = attempts.reduce<typeof attempts[number] | null>((acc, a) => (!acc || a.attemptNumber > acc.attemptNumber ? a : acc), null);
    const latestPoste = latestAttempt ? posteByAttempt.get(latestAttempt.id) : undefined;
    const legal = recipient.campaign.channelType === 'POSTAL'
      ? postalLegalOutcome({
        diverted: !!recipient.inadCheck?.diverted,
        arTracking: hasPostalArTracking(recipient.campaign),
        attempt: latestAttempt,
        poste: latestPoste ? { status: latestPoste.status, outcomeAt: latestPoste.outcomeAt ?? null } : null,
      })
      : null;
```

e nel `return` aggiungere `legalOutcome: legal ? { outcome: legal.outcome, reason: legal.reason, at: legal.at ? legal.at.toISOString() : null } : null,`.

Se `recipientRepo.findOne` in `getDetail` usa un `select` che esclude `inadCheck`, aggiungerlo.

- [ ] **Step 7: Run tests + tsc**

Run: `docker compose exec backend node_modules/.bin/vitest run notifications-search postal-report-csv campaigns.service.spec` poi `docker compose exec backend node_modules/.bin/tsc --noEmit` e `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: PASS, tsc pulito.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns apps/backend/src/notifications-search
git commit -m "feat(postal): esito legale nel report CSV e nel dettaglio notifica"
```

---

### Task 5: Frontend — registro esito, barra, filtro, grafico, colonna, verdetto

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`
- Modify: `apps/frontend-admin/src/components/notification-detail/journey.ts`

**Interfaces:**
- Consumes: `recipientsFilterOptions.deliveryStatuses` (codici esito per POSTAL, Task 3); righe `legalOutcome`, `legalOutcomeReason`, `legalOutcomeAt` (Task 2); `notifDetail.legalOutcome` (Task 4).
- Produces: nessuna interfaccia per altri task.

- [ ] **Step 1: Registro esito legale + etichette recapito reali**

In `App.tsx`, subito dopo la chiusura di `POSTAL_DELIVERY_STATUS_META`, aggiungere:

```tsx
// Esito legale POSTAL ("Stato Documento"): unico registro etichette/colori,
// codici calcolati dal backend (campaigns/postal-legal-outcome.util.ts).
const POSTAL_LEGAL_OUTCOME_META: Record<string, { label: string; badge: string; color: string; tone: OutcomeTone; icon: React.ComponentType<{ className?: string; size?: number }> }> = {
  delivered: { label: 'Consegnato', badge: 'bg-success-subtle text-success-emphasis border', color: '#198754', tone: 'ok', icon: CheckCircle2 },
  not_delivered: { label: 'Non consegnato', badge: 'bg-danger-subtle text-danger-emphasis border', color: '#dc3545', tone: 'ko', icon: XCircle },
  in_progress: { label: 'In corso', badge: 'bg-light text-dark border', color: '#adb5bd', tone: 'muted', icon: Clock },
  no_legal_value: { label: 'Senza valore legale (solo App IO)', badge: 'bg-info-subtle text-info-emphasis border', color: '#0dcaf0', tone: 'alt', icon: Smartphone },
  no_ar: { label: 'Senza AR', badge: 'bg-secondary-subtle text-secondary-emphasis border', color: '#6c757d', tone: 'muted', icon: HelpCircle },
  unclassified: { label: 'Non classificato', badge: 'bg-secondary-subtle text-secondary-emphasis border', color: '#6c757d', tone: 'muted', icon: HelpCircle },
};
const POSTAL_LEGAL_OUTCOME_RANK: Record<string, number> = { delivered: 0, not_delivered: 1, in_progress: 2, no_legal_value: 3, no_ar: 4, unclassified: 5 };

function PostalLegalOutcomeBadge({ outcome, reason, at, postalStatus }: { outcome?: string | null; reason?: string | null; at?: string | null; postalStatus?: string | null }): React.JSX.Element {
  if (!outcome) return <span className="badge bg-light text-dark border">—</span>;
  const meta = POSTAL_LEGAL_OUTCOME_META[outcome] ?? POSTAL_LEGAL_OUTCOME_META['unclassified']!;
  const title = postalStatus ? `GlobalCom: ${POSTAL_STATUS_META[postalStatus]?.label ?? postalStatus}` : undefined;
  return (
    <div className="d-inline-flex flex-column align-items-start gap-1" title={title}>
      <span className={`badge ${meta.badge}`}><meta.icon className="me-1" size={14} />{meta.label}</span>
      {(reason || at) && (
        <span className="text-muted" style={{ fontSize: '0.7rem' }}>
          {reason}{reason && at ? ' · ' : ''}{at ? new Date(at).toLocaleDateString('it-IT') : ''}
        </span>
      )}
    </div>
  );
}
```

`OutcomeTone` deve essere già dichiarato prima di questo punto: se è dichiarato più in basso nel file, spostare la dichiarazione del registro subito dopo quella di `OutcomeTone` (verificare con `grep -n "type OutcomeTone" apps/frontend-admin/src/App.tsx`). Verificare anche che `Clock`, `XCircle`, `Smartphone`, `HelpCircle`, `CheckCircle2` siano già importati da `lucide-react` (lo sono: usati da `POSTAL_DELIVERY_STATUS_META`).

Nello stesso `POSTAL_DELIVERY_STATUS_META` aggiungere le etichette dei valori reali mancanti:

```tsx
  'Consegnato a Domicilio': { label: 'Consegnato a domicilio', badge: 'bg-success-subtle text-success-emphasis border', icon: CheckCircle2 },
  'Consegnato a Sportello': { label: 'Consegnato a sportello', badge: 'bg-success-subtle text-success-emphasis border', icon: CheckCircle2 },
  'Consegnato in Digitale': { label: 'Consegnato in digitale', badge: 'bg-success-subtle text-success-emphasis border', icon: CheckCircle2 },
  'Compiuta Giacenza': { label: 'Compiuta giacenza', badge: 'bg-success-subtle text-success-emphasis border', icon: CheckCircle2 },
  'Invio Rifiutato': { label: 'Invio rifiutato', badge: 'bg-success-subtle text-success-emphasis border', icon: CheckCircle2 },
  'In giacenza': { label: 'In giacenza', badge: 'bg-warning-subtle text-warning-emphasis border', icon: Clock },
```

(Compiuta giacenza e rifiuto in verde: per legge valgono consegna.) E in `POSTAL_DELIVERY_STATUS_PIE_COLORS` aggiungere `'Consegnato a Domicilio': '#198754', 'Consegnato a Sportello': '#198754', 'Consegnato in Digitale': '#198754', 'Compiuta Giacenza': '#198754', 'Invio Rifiutato': '#198754', 'In giacenza': '#ffc107',`.

- [ ] **Step 2: Barra esito POSTAL**

Nel blocco `if (campaign.channelType === 'POSTAL' && postalStatusBreakdown) {` (≈ riga 17656) sostituire la condizione e le righe che costruiscono `segments` con:

```tsx
                    if (campaign.channelType === 'POSTAL' && (recipientsFilterOptions?.deliveryStatuses ?? []).length > 0) {
                      // Stato Documento = esito legale (conteggi dal backend, stesso valore del filtro).
                      segments = (recipientsFilterOptions?.deliveryStatuses ?? [])
                        .filter((o): o is { value: string; count: number } => typeof o !== 'string')
                        .sort((a, b) => (POSTAL_LEGAL_OUTCOME_RANK[a.value] ?? 9) - (POSTAL_LEGAL_OUTCOME_RANK[b.value] ?? 9))
                        .map((o) => {
                          const meta = POSTAL_LEGAL_OUTCOME_META[o.value];
                          return seg(o.value, meta?.label ?? o.value, o.count, meta?.tone ?? 'muted', 'delivery', o.value, meta?.color ?? stableColorForKey(o.value));
                        });
```

lasciando invariato il resto del blocco (nota "consegnate su Poste" con `posteDelivered`). Le costanti `POSTAL_RANK`/`POSTAL_TONE` diventano inutilizzate: rimuoverle se eslint le segnala.

- [ ] **Step 3: Filtro "Stato documento" POSTAL**

In `deliveryStatusOptions` (≈ riga 18033) sostituire la funzione etichetta con:

```tsx
                              (s) => s === PENDING_DELIVERY_STATUS_SENTINEL
                                ? (campaign.channelType === 'SEND' ? 'In attesa' : 'In corso')
                                : campaign.channelType === 'POSTAL'
                                  ? (POSTAL_LEGAL_OUTCOME_META[s]?.label ?? s)
                                  : ((campaign.channelType === 'SEND' ? SEND_STATUS_META[s]?.label : POSTAL_STATUS_META[s]?.label) ?? s),
```

- [ ] **Step 4: Grafico "Stato Documento"**

Nel blocco che costruisce `statusPieData` (≈ riga 18638) sostituire la sorgente dati per il grafico "Stato Documento" con i conteggi esito:

```tsx
                              const statusPieData = (recipientsFilterOptions?.deliveryStatuses ?? [])
                                .filter((o): o is { value: string; count: number } => typeof o !== 'string' && o.count > 0)
                                .map((o) => ({ name: POSTAL_LEGAL_OUTCOME_META[o.value]?.label ?? o.value, value: o.count, color: POSTAL_LEGAL_OUTCOME_META[o.value]?.color ?? stableColorForKey(o.value) }));
```

Leggere prima le 20 righe attorno a `statusPieData` e conservare la stessa forma degli oggetti che `renderDonutCard` si aspetta (nomi dei campi `name`/`value`/`color` o equivalenti usati lì). `postalStatusBreakdown` resta usato da "Andamento Invio POSTAL" e dal tasto "Verifica su Poste": non toccarli.

- [ ] **Step 5: Colonna "Stato Documento"**

Tipo riga di `recipientsPage` (≈ riga 2822): aggiungere `legalOutcome?: string | null; legalOutcomeReason?: string | null; legalOutcomeAt?: string | null;` all'oggetto item. Nelle due celle `<td className="small"><PostalStatusBadge status={r.postalStatus} /></td>` (≈ righe 18547 e 18555) sostituire con:

```tsx
<td className="small"><PostalLegalOutcomeBadge outcome={r.legalOutcome} reason={r.legalOutcomeReason} at={r.legalOutcomeAt} postalStatus={r.postalStatus} /></td>
```

L'header "Stato Documento" e l'ordinamento `postalStatus` restano come sono (il backend ordina già per esito sulle POSTAL).

- [ ] **Step 6: Verdetto dettaglio notifica**

In `journey.ts`, in `JourneyDetail` aggiungere `legalOutcome?: { outcome: string; reason: string | null; at: string | null } | null;`. In `computeVerdict`, subito dopo il ramo `if (last.status === 'failed') { … }`, inserire:

```ts
  // POSTAL: il verdetto segue l'esito legale calcolato dal backend (compiuta
  // giacenza e rifiuto valgono consegna, via PEC idem). In corso / non
  // classificato ricadono sulla logica GlobalCom/Poste sotto.
  const lo = d.campaign.channelType === 'POSTAL' ? d.legalOutcome : null;
  if (lo?.outcome === 'delivered') {
    const source = lo.reason === 'Verifica Poste' ? 'secondo Poste Italiane' : lo.reason === 'Via PEC' ? 'via PEC (domicilio digitale)' : 'secondo GlobalCom';
    return { headline: 'Consegnata', tone: 'ok', when: lo.at, source, note: lo.reason === 'Verifica Poste' || lo.reason === 'Via PEC' ? null : lo.reason, discrepancy: lo.reason === 'Verifica Poste' && last.postalStatus !== 'Consegnato' };
  }
  if (lo?.outcome === 'not_delivered') {
    return { headline: 'Non consegnata', tone: 'ko', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: lo.reason, discrepancy: false };
  }
  if (lo?.outcome === 'no_legal_value') {
    return { headline: 'Solo App IO', tone: 'warn', when: last.sentAt ?? last.createdAt, source: 'senza valore legale', note: null, discrepancy: false };
  }
  if (lo?.outcome === 'no_ar') {
    return { headline: 'Inviata senza AR', tone: 'neutral', when: last.sentAt ?? last.createdAt, source: 'nessun esito di consegna', note: null, discrepancy: false };
  }
```

`notifDetail` in `App.tsx` passa già l'intero oggetto a `computeVerdict`: aggiungere `legalOutcome?: { outcome: string; reason: string | null; at: string | null } | null;` al tipo di `notifDetail` (cercare `const [notifDetail, setNotifDetail] = useState<`) se tsc lo richiede.

- [ ] **Step 7: Type-check + lint**

Run:
```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
MSYS_NO_PATHCONV=1 docker compose exec -T -w /app/apps/frontend-admin frontend-admin node_modules/.bin/eslint src/App.tsx src/components/notification-detail/journey.ts
```
Expected: tsc pulito, eslint 0 errori.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx apps/frontend-admin/src/components/notification-detail/journey.ts
git commit -m "feat(admin): Stato Documento POSTAL come esito legale"
```

---

### Task 6: Verifica end-to-end in dev e note

**Files:**
- Modify: `docs/claude/postal-globalcom.md`

- [ ] **Step 1: Dati di prova POSTAL in dev**

Se in dev non esiste una campagna POSTAL con AR, crearne i dati via SQL su una campagna di test (dati fittizi, mai reali):

```bash
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -At -c "SELECT id, channel_type, channel_config->>'postalServiceType', channel_config->>'postalReturnReceipt' FROM campaigns WHERE channel_type = 'POSTAL' LIMIT 3;"
```

Se vuoto: duplicare dalla UI una campagna, impostarla POSTAL Raccomandata con AR, lanciarla non è necessario — basta inserire a mano 4 attempt POSTAL su 4 destinatari fittizi con `postal_status`/`postal_delivery_status` = (`NonConsegnato`,`Compiuta Giacenza`), (`NonConsegnato`,`Indirizzo errato o inesatto`), (`Errore`,NULL), (`Confermato`,`Accettato online`). Scrivere l'SQL in un file nella scratchpad, rileggerlo, poi eseguirlo con `docker exec -i comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db < file.sql`.

- [ ] **Step 2: Verifica in browser (Playwright MCP, login mock admin/admin)**

Aprire il dettaglio della campagna POSTAL e verificare:
- barra esito: segmenti Consegnato (1), Non consegnato (2: indirizzo errato + Errore), In corso (1);
- click su "Consegnato" → tabella filtrata alla sola compiuta giacenza, cella "Consegnato · Compiuta Giacenza · 08/09/2026" (data della fixture);
- filtro "Stato notifica" = Fallito → compare il destinatario in `Errore`;
- dettaglio notifica della compiuta giacenza: verdetto "Consegnata", fonte "secondo GlobalCom", nota "Compiuta Giacenza";
- download CSV "attuale": colonne Stato Documento / Motivo / Data Legale / Stato GlobalCom.

- [ ] **Step 3: Suite completa**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend backend node src/debug/postal-legal-outcome-parity.mjs
```
Expected: solo il fallimento baseline noto; tsc pulito; parity `OK`.

- [ ] **Step 4: Nota in docs/claude/postal-globalcom.md**

In fondo alla sezione tracking Poste aggiungere:

```markdown
**"Stato Documento" POSTAL = esito legale, derivato
(`campaigns/postal-legal-outcome.util.ts`).** Tabelle CONSEGNATO /
NON_CONSEGNATO dei valori reali di `StatoConsegna` (verificati in prod) usate
sia dalla regola TS sia dall'SQL generato: un nuovo valore GlobalCom va
aggiunto lì e basta (finché non c'è, cade in "In corso", mai in Consegnato).
Parità SQL/TS: `node src/debug/postal-legal-outcome-parity.mjs`. "Stato
notifica" Fallito per `Errore` GlobalCom è solo derivato (`recipient.status`
resta `sent`). `postal-status-breakdown` resta lo stato GlobalCom grezzo
(Andamento Invio, tasto Verifica su Poste).
```

- [ ] **Step 5: Commit**

```bash
git add docs/claude/postal-globalcom.md
git commit -m "docs(postal): note esito legale"
```

Pulire i dati di prova inseriti in dev solo se creati a mano su una campagna esistente non di test (per memoria utente: in dev locale non serve pulire i dati di prova creati per le verifiche).
