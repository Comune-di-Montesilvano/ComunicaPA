# Timeline perfezionamento SEND + filtri campagne/notifiche — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** conservare tutta la timeline PN depurata dalle PII e mostrare nel dettaglio notifica SEND una timeline orizzontale fino alla data di notifica per il destinatario. In più: filtri chiari per stato e autore e 20 elementi per pagina, sia nella lista campagne sia nella ricerca notifiche.

**Architecture:**
- Backend: `extractSendTimeline` passa da whitelist a denylist ricorsiva delle chiavi PII, con un backfill che si chiude da solo nel poll SEND.
- Una funzione pura backend `buildSendPerfection` calcola le tappe. Il dettaglio notifica la espone come `AttemptDetailDto.sendPerfection`.
- Il frontend admin si limita a disegnare. I filtri campagne restano lato client; la ricerca notifiche aggiunge `createdBy` lato server.

**Tech Stack:** NestJS 12 ESM, TypeORM/Postgres, Vitest, React 19 + Bootstrap (admin), tutto in Docker.

**Spec:** `docs/superpowers/specs/2026-11-06-timeline-perfezionamento-send-design.md`

## Global Constraints

- Mai PII reali in codice, test o commit. Fixture: `ROSSI MARIO`, `RSSMRA80A01H501U`, `ACME SRL`, indirizzi finti.
- Le chiavi PII tolte a qualunque profondità sono: `physicalAddress`, `digitalAddress`, `newAddress`, `normalizedAddress`, `oldAddress`, `address`, `at`, `municipality`, `municipalityDetails`, `zip`, `province`, `foreignState`, `taxId`, `denomination`, `recipient`, `recipientId`.
- Attenzione a `at`: va tolta **solo dentro `details`**. Il campo `at` dell'evento, cioè il timestamp, resta.
- Date delle tappe: stringhe `YYYY-MM-DD` nel calendario Europe/Rome. Giorni di calendario, senza slittamento per festivi.
- Regola delle 21:00: vale solo per la consegna digitale (+7). La soglia è esclusiva: dalle 21:00:01 in poi si conta dal giorno dopo.
- `CANCELLED` nello storico o in `sendStatus` → `sendPerfection = null`, nessuna timeline.
- Priorità della data finale:
  1. PN effettiva: `sendLegalDateOf(history)`, se manca `REFINEMENT.at`;
  2. PN programmata: ultimo `SCHEDULE_REFINEMENT.details.schedulingDate`;
  3. stima nostra;
  4. nessuna data.
- Testi della nota, esatti dallo spec (sezione "Nota sotto la timeline"):
  - `pn`: "Notificata per il destinatario il gg/mm/aaaa secondo SEND."
  - `pn_scheduled`: "Prevista da SEND per il gg/mm/aaaa, prima se il destinatario apre la notifica."
  - `estimate`: "Data stimata (art. 26, comma 9, D.L. 76/2020): si conferma con l'esito di SEND; prima se il destinatario apre la notifica."
  - `none`: "La data dipende dall'esito del recapito: la indicherà SEND."
- Page size: `CAMPAIGN_PAGE_SIZE = 20`, `SEARCH_PAGE_SIZE = 20`.
- Guida: ogni modifica visibile aggiorna `apps/frontend-admin/public/guida/guida.md` e la data `_Ultimo aggiornamento: 2026-11-06_`. Mai rinominare i titoli `###`.
- Comandi backend: `docker compose exec backend node_modules/.bin/vitest run <pattern>`. Dopo modifiche a `src/`, se il watch non le vede: `docker compose restart backend`.
- Test con date: lanciarli due volte, con `-T -e TZ=UTC` e con `-T -e TZ=Europe/Rome`.
- Commit: subject in inglese conventional, e in chiusura `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Chiave PII annidata in un array**, es. `details.attachments[].physicalAddress` o `details.recipient.taxId`: deve sparire. Test in Task 1.
2. **Timeline vecchia senza `details`**, terminale: va ripescata una volta e poi mai più, anche se PN restituisce una timeline vuota. Test in Task 2.
3. **Consegna digitale tra le 21:00 e mezzanotte UTC**: per esempio 2026-11-03T20:30:00Z, che sono le 21:30 a Roma ma resta lo stesso giorno in UTC. Il conteggio deve partire dal 04/11 in tutti e due i fusi del processo. Test in Task 3.
4. **Timeline con `null`/`undefined` o eventi senza `at` valido**: nessun crash, si tratta come percorso "in lavorazione". Test in Task 3.
5. **Notifica `VIEWED` prima della data programmata**: la data finale è quella di VIEWED, con `finalSource: 'pn'`. Test in Task 3.

---

### Task 1: denylist PII su `extractSendTimeline`

**Files:**
- Modify: `apps/backend/src/channels/send/send-status-history.util.ts:85-150`
- Test: `apps/backend/src/channels/send/send-status-history.util.spec.ts`
- Modify: `apps/frontend-admin/src/components/notification-detail/send-timeline.ts:5-16`, `apps/backend/src/notifications-search/dto/notification-detail.dto.ts` (campo `sendTimeline`)

**Interfaces:**
- Produces:
  - `SendTimelineEvent` gains `details?: Record<string, unknown>` in backend, frontend and DTO.
  - `export const SEND_TIMELINE_PII_KEYS: readonly string[]`
  - `export function stripSendPii(value: unknown): unknown`
  - `extractSendTimeline` keeps every category. Each event always has `details`, an object, possibly `{}`.

- [ ] **Step 1: Write failing tests** in `send-status-history.util.spec.ts`:
  - `keeps categories outside the old whitelist`: the input timeline has `SCHEDULE_REFINEMENT` with `details: { recIndex: 0, schedulingDate: '2026-11-23T10:00:00Z' }`. Expect one event `{ category: 'SCHEDULE_REFINEMENT', at, details: { recIndex: 0, schedulingDate: '2026-11-23T10:00:00Z' } }`.
  - `strips PII keys at any depth`: `details: { physicalAddress: { address: 'VIA ROMA 1', zip: '00100' }, digitalAddress: { type: 'PEC', address: 'rossi@pec.example' }, attachments: [{ documentType: 'AR', physicalAddress: { address: 'X' } }], recipient: { taxId: 'RSSMRA80A01H501U' }, analogCost: 900 }`. Expect `details` to equal `{ attachments: [{ documentType: 'AR' }], analogCost: 900 }`, `ev.channel === 'PEC'`, and `JSON.stringify(ev)` to contain neither `RSSMRA80A01H501U` nor `VIA ROMA` nor `rossi@pec`.
  - `keeps event timestamp at while stripping details.at`: `details: { at: 'VIA X' }` → `ev.at` stays the event timestamp and `details.at` is gone.
  - The existing tests on normalized fields (code, responseStatus, channel, registeredLetterCode...) must stay green unchanged. If one asserts `toEqual` on the whole event, update it by adding `details`.
  - Also add a property to `apps/backend/src/common/untrusted-input.fuzz.spec.ts`: for any fast-check object containing a key from `SEND_TIMELINE_PII_KEYS` at any depth, `stripSendPii` returns an object with no such key.

- [ ] **Step 2: Run** `docker compose exec backend node_modules/.bin/vitest run send-status-history untrusted-input` → FAIL (`stripSendPii` not exported, categories filtered).

- [ ] **Step 3: Implement.**
  - Remove the category filter in `extractSendTimeline`. Keep `SEND_TIMELINE_CATEGORIES` only if something else imports it; grep, and delete it if unused.
  - `stripSendPii` recurses into arrays and plain objects and drops the keys in `SEND_TIMELINE_PII_KEYS`. Normalized fields are extracted **before** stripping, as today.
  - Update the doc comment above `SendTimelineEvent`: "all PN facts, PII keys removed".
  - Add `details?: Record<string, unknown>` to the frontend type and to the DTO type.

- [ ] **Step 4: Run** the same command → PASS. Then `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit` → no errors.

- [ ] **Step 5: Commit** `feat(send): keep full PN timeline minus PII keys`.

### Task 2: backfill nel poll SEND

**Files:**
- Modify: `apps/backend/src/channels/send/send-status-sync.service.ts:95-140`
- Test: `apps/backend/src/channels/send/send-status-sync.service.spec.ts`

**Interfaces:**
- Consumes: from Task 1, `extractSendTimeline`, which always puts `details` on every event.
- Produces: `export const LEGACY_TIMELINE_SQL: string`, a predicate on alias `attempt`, exported for the test.

- [ ] **Step 1: Write failing tests:**
  - `LEGACY_TIMELINE_SQL` equals `"(jsonb_array_length(COALESCE(attempt.send_timeline, '[]'::jsonb)) > 0 AND NOT (attempt.send_timeline -> 0 ? 'details'))"`. Follow the mock style of the existing spec: assert that the string passed to `andWhere` contains `LEGACY_TIMELINE_SQL` inside the OR of the terminal condition.
  - `rewrites timeline when only details changed`: the attempt is terminal, `sendStatus: 'UNREACHABLE'`, and its stored timeline has no `details`. PN returns the same status and the same events with `details`. Expect `save` to be called with an attempt whose `sendTimeline[0].details` is defined.
  - If the existing suite has a Postgres test (`describe.skipIf(!process.env.DATABASE_URL)`), add a case there too: the predicate is false for `[]`, for `NULL` and for `[{"category":"X","at":"…","details":{}}]`, and true for `[{"category":"X","at":"…"}]`. Use a transaction with rollback, and never write to `comunicapa_db` outside the rollback.

- [ ] **Step 2: Run** `docker compose exec backend node_modules/.bin/vitest run send-status-sync` → FAIL.

- [ ] **Step 3: Implement.** Add `OR ${LEGACY_TIMELINE_SQL}` inside the parenthesis of the terminal condition in `updateStatuses`. The timeline comparison already uses `JSON.stringify`, so new `details` make it a change and it gets saved. An empty timeline is not "legacy", so there is no infinite loop. Add a comment saying it is a one-off backfill (spec Step 0) that closes itself once timelines have `details`.

- [ ] **Step 4: Run** the same command → PASS.

- [ ] **Step 5: Commit** `feat(send): one-off backfill of PN timeline details`.

### Task 3: `buildSendPerfection`

**Files:**
- Create: `apps/backend/src/campaigns/send-perfection.util.ts`
- Test: `apps/backend/src/campaigns/send-perfection.util.spec.ts`

**Interfaces:**
- Consumes: from `send-legal-date.util.ts`, `sendLegalDateOf` and `sendEntityLegalDateOf`; from Task 1, `SendTimelineEvent`, with `details`.
- Produces:

```ts
export type PerfectionStepState = 'done' | 'ko' | 'expected';
export interface PerfectionStep {
  key: 'entity' | 'delivering' | 'digital_delivered' | 'digital_failure' | 'analog_delivered' | 'deposited' | 'aar_refined' | 'viewed' | 'recipient';
  label: string;
  /** YYYY-MM-DD, Europe/Rome; null = data non ancora nota. */
  date: string | null;
  state: PerfectionStepState;
  /** Giorni dalla tappa precedente quando la data è calcolata per legge (7, 10, 15). */
  offsetDays?: number;
}
export type PerfectionFinalSource = 'pn' | 'pn_scheduled' | 'estimate' | 'none';
export interface SendPerfection {
  steps: PerfectionStep[];          // prima 'entity', ultima 'recipient'
  finalSource: PerfectionFinalSource;
  /** = steps[last].date */
  finalDate: string | null;
  /** YYYY-MM-DD Europe/Rome di `now`, per il marcatore "oggi". */
  today: string;
}
export function buildSendPerfection(
  sendStatus: string | null,
  history: Array<{ status: string; activeFrom: string }> | null | undefined,
  timeline: SendTimelineEvent[] | null | undefined,
  now: Date,
): SendPerfection | null;
```

Fixed labels:

| key | label |
|---|---|
| `entity` | "Notificata per l'ente" |
| `delivering` | "In consegna" |
| `digital_delivered` | "Consegnata al domicilio digitale" |
| `digital_failure` | "Avviso di mancato recapito depositato" |
| `analog_delivered` | "Avviso cartaceo consegnato" |
| `deposited` | "Avviso depositato su SEND" |
| `aar_refined` | "Avviso perfezionato" |
| `viewed` | "Visualizzata su SEND" |
| `recipient` | "Notificata per il destinatario" |

Choosing the path (first match wins):
1. **Irreperibile**: the history contains `UNREACHABLE`, or the timeline contains `COMPLETELY_UNREACHABLE`.
   - `deposited`: date = UNREACHABLE activeFrom, otherwise the event's `at`; state `ko`.
   - `aar_refined`: deposit +10, `offsetDays: 10`.
   - Estimate for `recipient`: `aar_refined` +10.
2. **Analog delivered**: `SEND_ANALOG_FEEDBACK` with `responseStatus: 'OK'`, or `ANALOG_SUCCESS_WORKFLOW`. Step `analog_delivered` done, no estimate.
3. **Digital failure**: `DIGITAL_FAILURE_WORKFLOW`. Step `digital_failure` done; estimate +15.
4. **Digital delivered**: `SEND_DIGITAL_FEEDBACK` with `responseStatus !== 'KO'`, or `DIGITAL_SUCCESS_WORKFLOW`. Step `digital_delivered` done; estimate +7, or +8 if the Rome time is past 21:00:00.
5. **Otherwise in lavorazione**: step `delivering` with the DELIVERING activeFrom as `done`, otherwise `date: null` and `expected`.

Then:
- If `VIEWED` is in the history, insert the `viewed` step (done) before `recipient`.
- Final date by the priority in Global Constraints. `recipient.state` is `done` only when `finalSource === 'pn'`; otherwise `expected`, with `date: null` when the source is `none`.
- State of intermediate steps: a step computed by law (`aar_refined`) is `done` only if `finalSource === 'pn'`, otherwise `expected`, even if its date is already past.
- `entity`: date from `sendEntityLegalDateOf`, `done`; if null, `expected` with `date: null`.

- [ ] **Step 1: Write failing tests**, `now = new Date('2026-11-06T10:00:00Z')`, ACCEPTED at `2026-10-15T09:00:00Z`:
  - `irreperibile senza SCHEDULE_REFINEMENT`: history ACCEPTED, DELIVERING, UNREACHABLE `2026-11-03T08:00:00Z`.
    - Expect keys `['entity','deposited','aar_refined','recipient']` and dates `['2026-10-15','2026-11-03','2026-11-13','2026-11-23']`.
    - Expect states `['done','ko','expected','expected']`, `finalSource: 'estimate'`, `today: '2026-11-06'`.
  - `irreperibile con SCHEDULE_REFINEMENT`: same history plus two SCHEDULE_REFINEMENT events (`details.schedulingDate` `2026-11-20T…` and a later `at` with `2026-11-24T10:00:00Z`). Expect `finalDate: '2026-11-24'` and `finalSource: 'pn_scheduled'`.
  - `irreperibile perfezionata`: also EFFECTIVE_DATE `2026-11-23T05:00:00Z`. Expect `finalSource: 'pn'`, `finalDate: '2026-11-23'` and `aar_refined.state === 'done'`.
  - `REFINEMENT senza EFFECTIVE_DATE in history`: REFINEMENT event `at: 2026-11-22T…` → `finalSource: 'pn'`.
  - `digitale consegnato alle 21:30 ora italiana`: SEND_DIGITAL_FEEDBACK OK `at: '2026-11-03T20:30:00Z'` → `digital_delivered.date '2026-11-03'`, `finalDate '2026-11-11'` (+8), `offsetDays: 7`.
  - `digitale consegnato alle 21:00:00 esatte`: `at: '2026-11-03T20:00:00Z'` → `finalDate '2026-11-10'`.
  - `digitale fallito`: DIGITAL_FAILURE_WORKFLOW `at: 2026-11-02T…` → `finalDate '2026-11-17'`, `offsetDays: 15`.
  - `cartaceo consegnato`: SEND_ANALOG_FEEDBACK OK → `finalSource: 'none'` and `recipient.date === null`.
  - `in lavorazione`: only ACCEPTED, DELIVERING → keys `['entity','delivering','recipient']` and `finalSource: 'none'`.
  - `VIEWED prima della data programmata`: irreperibile plus VIEWED `2026-11-05T…` plus SCHEDULE_REFINEMENT on 24/11 → `finalSource: 'pn'`, `finalDate '2026-11-05'`, `viewed` present.
  - `CANCELLED`: `sendStatus 'CANCELLED'` → `null`.
  - `input nulli`: `(null, null, null, now)` → not null, keys `['entity','delivering','recipient']`, no throw.
  - `evento senza at valido ignorato`: SEND_DIGITAL_FEEDBACK with `at: 'x'` → `delivering` path.

- [ ] **Step 2: Run** `docker compose exec -T -e TZ=UTC backend node_modules/.bin/vitest run send-perfection` → FAIL (module missing).

- [ ] **Step 3: Implement** in `send-perfection.util.ts`.
  - Rome date via `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })`.
  - Rome time via `formatToParts` with `hourCycle: 'h23'`.
  - Adding days on `YYYY-MM-DD` with `Date.UTC` arithmetic: never `setDate` on local time.

- [ ] **Step 4: Run** with `-e TZ=UTC` and with `-e TZ=Europe/Rome` → PASS both.

- [ ] **Step 5: Commit** `feat(send): compute SEND perfection timeline`.

### Task 4: esporre `sendPerfection` nel dettaglio notifica

**Files:**
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts:276-320` (map degli attempt)
- Modify: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts` (`AttemptDetailDto`)
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Consumes: from Task 3, `buildSendPerfection`, `SendPerfection`.
- Produces: `AttemptDetailDto.sendPerfection?: SendPerfection | null`. Non-null only for `channelType === 'SEND'`. Use `import type` in the DTO.

- [ ] **Step 1: Failing test** in the detail spec:
  - a SEND attempt with history ACCEPTED plus UNREACHABLE → `detail.attempts[0].sendPerfection.steps.at(-1).key === 'recipient'`;
  - an EMAIL attempt → `sendPerfection` null.
- [ ] **Step 2: Run** `docker compose exec backend node_modules/.bin/vitest run notifications-search.service` → FAIL.
- [ ] **Step 3: Implement.** In the map: `sendPerfection: a.channelType === 'SEND' ? buildSendPerfection(a.sendStatus, a.sendStatusHistory, a.sendTimeline, new Date()) : null`.
- [ ] **Step 4: Run** → PASS, then `tsc --noEmit` and `tsc -p tsconfig.spec.json --noEmit` clean.
- [ ] **Step 5: Commit** `feat(send): expose perfection timeline in notification detail`.

### Task 5: timeline orizzontale nel verdict + guida

**Files:**
- Create: `apps/frontend-admin/src/components/notification-detail/SendPerfectionTimeline.tsx`
- Modify: `apps/frontend-admin/src/components/notification-detail/NotificationJourney.tsx:31-75` (`NotificationVerdict`)
- Modify: `apps/frontend-admin/src/components/notification-detail/journey.ts` (tipo `JourneyAttempt` + nota ~356)
- Modify: `apps/frontend-admin/src/assets/css/notification-detail.css`
- Modify: `apps/frontend-admin/public/guida/guida.md` ("### Date di notifica e termini", riga 233+)

**Interfaces:**
- Consumes: from Task 4, the `sendPerfection` shape. Duplicate the type in `journey.ts` (`JourneyAttempt.sendPerfection?: …`), same pattern as the existing `SendTimelineEvent` duplicate.
- Produces: `export function SendPerfectionTimeline({ data }: { data: SendPerfection }): React.JSX.Element`.

- [ ] **Step 1: Component**, following mockup A from the spec:
  - `ol` laid out flex, a grey base line plus a green fill up to the position of `today`, interpolated between the dates of adjacent steps;
  - "oggi gg/mm" marker in amber;
  - date `gg/mm` in bold above the dot, label below; `recipient` label in bold;
  - for `expected` with a date, the suffix "(prevista)"; `offsetDays` → "(+N gg)";
  - classes `done`/`ko`/`expected` on the dot;
  - note below with the four exact texts from Global Constraints, date `gg/mm/aaaa`.
  - Under 576px the list goes vertical (`flex-direction: column`, no fill).
  - Classes `nd-perf-*` in `notification-detail.css`, colours from the existing palette (`nd-tone-*`).
- [ ] **Step 2: Mount it.** In `NotificationVerdict`, render `<SendPerfectionTimeline>` when the latest attempt (`latestAttempt(detail)`) has `sendPerfection`. Place it after headline and meta. "Nessuna consegna al destinatario" and the "Cosa fare" link stay.
- [ ] **Step 3: Correct `journey.ts` ~356.** Remove the note "…10 giorni dopo il deposito… (art. 26, comma 7…)". If `viaUnreachable` still needs a note, use: "Destinatario irreperibile: nessuna consegna. Date nella timeline qui sopra (art. 26, commi 7 e 9, D.L. 76/2020)."
- [ ] **Step 4: Guida.**
  - Fix the "Destinatario irreperibile" row of the table: "deposito dell'avviso su SEND, +10 giorni per il perfezionamento dell'avviso ([comma 7](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020-07-16;76~art26)), +10 giorni per il destinatario (comma 9, lett. b, n. 2); prima se accede a SEND".
  - Add a paragraph under the table: "Nel dettaglio di una notifica SEND una timeline mostra le tappe fino alla data di notifica per il destinatario: le date passate, quelle previste o stimate e la data di oggi. Vale sempre la data indicata da SEND quando arriva."
  - The date at the top stays 2026-11-06.
- [ ] **Step 5: Verify:**
  - `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` → clean;
  - `docker compose exec frontend-admin node scripts/check-guida.mjs` → OK.
  - Visual check in the browser (Playwright) on a SEND notification in dev, if the DB has one. Otherwise state that it was not verified live.
- [ ] **Step 6: Commit** `feat(admin): horizontal SEND perfection timeline`.

### Task 6: filtri lista campagne

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` — states near `:2319-2324`, `getFilteredCampaigns` `:8949-8990`, filter bar `:9834-9925`
- Modify: `apps/frontend-admin/public/guida/guida.md` ("### Seguire lo stato di una campagna", riga 108)

**Interfaces:**
- New states: `campaignStatusFilter: string` (`''` = all) and `campaignAuthorFilter: string` (`''` = all, otherwise username `createdBy`).

- [ ] **Step 1: Text search** in `getFilteredCampaigns`: match only `name`, `description`, `id`. Remove `channelType`, `groupChannels` and `status`. Placeholder: "Cerca per nome o ID…".
- [ ] **Step 2: Filters.** `campaignStatusFilter` → `c.status === filter`, on the aggregated status. `campaignAuthorFilter` → `c.createdBy === filter`.
- [ ] **Step 3: UI.** Add two `form-select-sm` controls next to "Tipo campagna":
  - "Stato: tutti" plus the statuses present in `campaigns`, with `STATUS_META[s]?.label ?? s` as label;
  - "Autore: tutti" plus the distinct `createdBy` values, labelled `createdByDisplayName || createdBy` and sorted with `localeCompare`.

  Recompute the Bootstrap columns so everything fits on one row on `md` (search `col-md-3`, the four selects/dates `col-md-2`, Reset `col-md-1`). Every `onChange` → `setCampaignPage(1)`. Reset, and the condition that shows it, include the two new filters.
- [ ] **Step 4:** `CAMPAIGN_PAGE_SIZE = 20`.
- [ ] **Step 5: Guida.** Under "Seguire lo stato di una campagna": "L'elenco mostra 20 campagne per pagina. La casella di ricerca cerca per nome o ID; per stato, autore, tipo e date usa i filtri accanto."
- [ ] **Step 6: Verify** the frontend `tsc` and `check-guida` as in Task 5. Browser check: filtering by status and author changes the count, Reset clears everything.
- [ ] **Step 7: Commit** `feat(admin): status and author filters on campaign list`.

### Task 7: filtro autore ricerca notifiche

**Files:**
- Modify: `apps/backend/src/notifications-search/notifications-search.controller.ts:12-37`
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts:29-40, 76-117`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`, `notifications-search.controller.spec.ts`
- Modify: `apps/frontend-admin/src/App.tsx` — states `:1593-1601`, `runNotificationSearch` `:1851-1874`, form `:13120-13195`
- Modify: `apps/frontend-admin/public/guida/guida.md` ("### Cercare una singola notifica", riga 116)

**Interfaces:**
- `SearchFilters.createdBy?: string`, from query param `createdBy`.
- Frontend: new state `searchAuthor: string`; list `searchOperators: Array<{ username: string; displayName: string }>` from `GET ${ADMIN_API_BASE}/operators`.

- [ ] **Step 1: Failing tests:**
  - service: `search({ createdBy: 'mrossi', page: 1, pageSize: 20 }, admin)` calls `andWhere('campaign.createdBy = :createdBy', { createdBy: 'mrossi' })`; whitespace only → no `andWhere` for createdBy;
  - controller: `createdBy` is passed through; default `pageSize` is `'20'`.
- [ ] **Step 2: Run** `docker compose exec backend node_modules/.bin/vitest run notifications-search` → FAIL.
- [ ] **Step 3: Backend.** Trimmed filter. Controller: `@Query('createdBy')` and default `pageSize = '20'`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Frontend.**
  - `SEARCH_PAGE_SIZE = 20`.
  - Load the operators once when `view === 'notifiche-ricerca'`; on error, use an empty list.
  - Select "Autore", options "Tutti" plus `displayName || username`, placed between "Campagna" and "Canale".
  - `params.set('createdBy', …)` when set.
  - "Azzera" and the condition that shows it include `searchAuthor`.
- [ ] **Step 6: Guida.** Under "Cercare una singola notifica", mention the "Autore" filter (the operator who created the campaign) and the 20 results per page.
- [ ] **Step 7: Verify.** Backend: `tsc` (both configs). Frontend: `tsc` and `check-guida`. Full suite `vitest run`: same failure set as the baseline (only `app.controller.spec.ts` isLdapMock).
- [ ] **Step 8: Commit** `feat(search): author filter and 20 results per page`.
