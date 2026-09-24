# Verifica consegna POSTAL su tracking Poste — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per le notifiche POSTAL che GlobalCom dichiara `NonConsegnato`, interrogare ogni giorno (max 90 volte, più a richiesta) il tracking pubblico di Poste Italiane e, se Poste dice "consegnata", mostrare la notifica come "Consegnato (verifica Poste)" in breakdown, filtri, ricerca globale, CSV e dettaglio, senza toccare i dati GlobalCom.

**Architecture:** Nuovo modulo autonomo `channels/postal/poste-tracking/` con tabella `postal_poste_tracking` (una riga per attempt), client HTTP verso l'endpoint JSON di poste.it, servizio con cron giornaliero + run manuale per campagna/notifica, controller dedicato. Le letture in `CampaignsService` / `NotificationsSearchService` passano da un repository iniettato con `@Optional()` e da un unico util di "stato effettivo" (bucket sintetico `ConsegnatoVerificaPoste`).

**Tech Stack:** NestJS 12 ESM, TypeORM (Postgres), `@nestjs/schedule`, `fetch` nativo Node 22, Vitest (shim `jest` globale disponibile, nei file nuovi usare `vi`), React 19 (`apps/frontend-admin/src/App.tsx`, file unico ~18k righe: ancorarsi a testo, non a numeri di riga).

**Spec:** `docs/superpowers/specs/2026-09-24-postal-verifica-poste-design.md`

## Global Constraints

- Endpoint: `POST https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice`, body `{"tipoRichiedente":"WEB","codiceSpedizione":"<codice>","periodoRicerca":1}`.
- Codice tracciato = `notification_attempts.postal_acceptance_id`. Mai chiamate GlobalCom aggiuntive.
- Candidati: solo `channel_type='POSTAL'`, `postal_status='NonConsegnato'`, `postal_acceptance_id` non vuoto, solo ultimo attempt del destinatario.
- `MAX_POSTE_CHECKS = 90`; cron `0 4 * * *` timezone `Europe/Rome`; pausa 2000 ms tra chiamate; timeout HTTP 15000 ms; circuit breaker a 5 errori consecutivi.
- Errore rete/HTTP/body non JSON: non incrementa `check_count`. Controlli manuali: non incrementano `check_count` e non spostano `next_check_at`.
- Solo `esitoRicerca "3"` + `stato "5"` + nessun `flagRitorno` = `delivered`. `flagRitorno` (in testa o su un movimento) = `returned`, con precedenza su `stato "5"`. Tutto il resto = resta `pending`.
- Override valido solo se `postal_status = 'NonConsegnato'` **e** riga `status='delivered'`. Bucket: `ConsegnatoVerificaPoste`, etichetta `Consegnato (verifica Poste)`.
- Campi `postal_*` GlobalCom mai scritti da questo codice. `NotificationAttempt.status`/`Recipient.status` mai toccati.
- Setting `postalPosteTracking.enabled` (boolean, default `true`, nessun env). Spento: cron esce subito, endpoint manuali `409`.
- Colonne CSV aggiunte, in quest'ordine, dopo le colonne GlobalCom e prima di `Esito App IO`/`External ID`: `Verifica Poste`, `Data Consegna (Poste)`, `Ultimo Movimento Poste`, `Discrepanza GlobalCom/Poste`.
- Mai dati reali (nomi/CF/codici raccomandata reali) in test, fixture, commit: usare `RN000000000IT`, `ROSSI MARIO`, `RSSMRA80A01H501U`.
- Comandi test/tsc: sempre via `docker compose exec backend ...` / `docker compose exec frontend-admin ...` (vedi CLAUDE.md). Dopo modifiche a `apps/backend/src/` fare `docker compose restart backend` prima di verifiche runtime.
- Baseline suite: 1 fallimento noto (`app.controller.spec.ts` › `isLdapMock`). Criterio: failure set identico.

## Review Focus

1. **Endpoint Poste che cambia formato o blocca (403/HTML)** — nessuna riga deve finire `delivered`/`gave_up` per errore; il giro si ferma dopo 5 errori consecutivi. Test: Task 4 "circuit breaker" + Task 3 "body HTML → invalid_body".
2. **GlobalCom che esce da `NonConsegnato` dopo l'override** (riaccodamento/ricontrollo) — l'override deve sparire e il cron non deve più controllare la riga. Test: Task 5 `isPosteDeliveredOverride('Consegnato','delivered') === false` + Task 4 query candidati filtra `a.postal_status = 'NonConsegnato'`.
3. **Destinatario con più attempt POSTAL** (reinvio dopo un `NonConsegnato`) — solo l'ultimo attempt conta, sia nel backfill sia nello stato effettivo. Test: Task 4 backfill SQL contiene il `NOT EXISTS` su attempt più recente; Task 6 breakdown usa l'ultimo attempt.
4. **Doppio click sul tasto campagna / run lanciato mentre il cron gira** — secondo avvio stessa campagna `409`; cron e run manuale possono sovrapporsi solo con chiamate lente, mai righe corrotte (ogni `checkOne` salva la propria riga). Test: Task 4 "409 su run già in corso".
5. **Codice di accettazione non tracciabile su Poste** (`esitoRicerca "1"`, es. codici a 10 cifre) — deve restare `pending` fino al 90° controllo e poi `gave_up`, mai `returned`. Test: Task 2 "esitoRicerca 1 → pending" + Task 4 "90° controllo → gave_up".

---

## File Structure

Nuovi (backend, sotto `apps/backend/src/`):
- `entities/postal-poste-tracking.entity.ts` — entity `PostalPosteTracking`, tipi `PosteTrackingStatus`, `PosteTrackingMovement`.
- `database/migrations/1790100000000-CreatePostalPosteTracking.ts`
- `channels/postal/poste-tracking/poste-tracking-mapping.util.ts` (+ `.spec.ts`) — parsing ed esito, puri.
- `channels/postal/poste-tracking/poste-tracking-client.service.ts` (+ `.spec.ts`) — HTTP.
- `channels/postal/poste-tracking/poste-tracking-effective.util.ts` (+ `.spec.ts`) — bucket, predicato/SQL, etichette, DTO.
- `channels/postal/poste-tracking/poste-postal-tracking.service.ts` (+ `.spec.ts`) — ciclo di vita.
- `channels/postal/poste-tracking/poste-tracking.controller.ts` (+ `.spec.ts`)
- `channels/postal/poste-tracking/poste-tracking.module.ts`
- `campaigns/campaigns.service.poste-tracking.spec.ts`

Modificati:
- `database/database.module.ts`, `database/data-source.ts`, `app.module.ts`, `settings/settings.registry.ts`
- `campaigns/campaigns.module.ts`, `campaigns/campaigns.service.ts`, `campaigns/dto/campaign-stats.dto.ts`, `campaigns/postal-report-csv.util.ts` (+ spec)
- `notifications-search/notifications-search.module.ts`, `.service.ts`, `.controller.ts`, `dto/notification-detail.dto.ts` (+ spec)
- `apps/frontend-admin/src/App.tsx`
- `docs/claude/postal-globalcom.md`

---

### Task 1: Entity, migration, setting

**Files:**
- Create: `apps/backend/src/entities/postal-poste-tracking.entity.ts`
- Create: `apps/backend/src/database/migrations/1790100000000-CreatePostalPosteTracking.ts`
- Modify: `apps/backend/src/database/database.module.ts` (array `entities` e array `migrations` + import)
- Modify: `apps/backend/src/database/data-source.ts` (array `entities` + import)
- Modify: `apps/backend/src/settings/settings.registry.ts`

**Interfaces:**
- Produces: `PostalPosteTracking` (entity), `type PosteTrackingStatus = 'pending' | 'delivered' | 'returned' | 'gave_up'`, `interface PosteTrackingMovement { at: string; luogo: string; statoLavorazione: string; box: string; flagRitorno: boolean }`, setting key `'postalPosteTracking.enabled'`.

- [ ] **Step 1: Scrivere l'entity**

```ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { NotificationAttempt } from './notification-attempt.entity.js';

export type PosteTrackingStatus = 'pending' | 'delivered' | 'returned' | 'gave_up';

/** Movimento normalizzato dalla `listaMovimenti` di poste.it (dataOra epoch ms → ISO). */
export interface PosteTrackingMovement {
  at: string;
  luogo: string;
  statoLavorazione: string;
  box: string;
  flagRitorno: boolean;
}

/**
 * Verifica consegna su tracking Poste Italiane per un attempt POSTAL che
 * GlobalCom ha chiuso come `NonConsegnato` (GlobalCom smette di tracciare
 * al primo KO, Poste può consegnare giorni dopo). Una riga per attempt,
 * mai scritti i campi postal_* GlobalCom — vedi
 * docs/superpowers/specs/2026-09-24-postal-verifica-poste-design.md.
 */
@Entity('postal_poste_tracking')
@Index('IDX_postal_poste_tracking_status_next', ['status', 'nextCheckAt'])
export class PostalPosteTracking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'attempt_id', type: 'uuid', unique: true })
  attemptId!: string;

  @OneToOne(() => NotificationAttempt, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt?: NotificationAttempt;

  @Column({ name: 'tracking_code', type: 'varchar', length: 50 })
  trackingCode!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: PosteTrackingStatus;

  /** Solo controlli del cron con risposta valida: errori di rete e controlli manuali esclusi. */
  @Column({ name: 'check_count', type: 'int', default: 0 })
  checkCount!: number;

  @Column({ name: 'next_check_at', type: 'timestamptz', nullable: true })
  nextCheckAt!: Date | null;

  /** Aggiornato a OGNI tentativo, anche su errore (round-robin anti-starvation). */
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ name: 'poste_stato', type: 'varchar', length: 10, nullable: true })
  posteStato!: string | null;

  @Column({ name: 'poste_esito_ricerca', type: 'varchar', length: 10, nullable: true })
  posteEsitoRicerca!: string | null;

  @Column({ name: 'poste_product', type: 'varchar', length: 100, nullable: true })
  posteProduct!: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  movements!: PosteTrackingMovement[] | null;

  @Column({ name: 'last_response', type: 'jsonb', nullable: true })
  lastResponse!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
```

- [ ] **Step 2: Scrivere la migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePostalPosteTracking1790100000000 implements MigrationInterface {
    name = 'CreatePostalPosteTracking1790100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "postal_poste_tracking" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "attempt_id" uuid NOT NULL,
                "tracking_code" character varying(50) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'pending',
                "check_count" integer NOT NULL DEFAULT 0,
                "next_check_at" TIMESTAMP WITH TIME ZONE,
                "last_checked_at" TIMESTAMP WITH TIME ZONE,
                "last_error" character varying(500),
                "poste_stato" character varying(10),
                "poste_esito_ricerca" character varying(10),
                "poste_product" character varying(100),
                "delivered_at" TIMESTAMP WITH TIME ZONE,
                "movements" jsonb,
                "last_response" jsonb,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_postal_poste_tracking_attempt_id" UNIQUE ("attempt_id"),
                CONSTRAINT "PK_postal_poste_tracking" PRIMARY KEY ("id"),
                CONSTRAINT "FK_postal_poste_tracking_attempt" FOREIGN KEY ("attempt_id") REFERENCES "notification_attempts"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_postal_poste_tracking_status_next" ON "postal_poste_tracking" ("status", "next_check_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_postal_poste_tracking_status_next"`);
        await queryRunner.query(`DROP TABLE "postal_poste_tracking"`);
    }
}
```

- [ ] **Step 3: Registrare entity e migration**

In `database/database.module.ts`: aggiungere
```ts
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { CreatePostalPosteTracking1790100000000 } from './migrations/1790100000000-CreatePostalPosteTracking.js';
```
aggiungere `PostalPosteTracking` in coda all'array `entities` e `CreatePostalPosteTracking1790100000000` in coda all'array `migrations` (dopo `RemoveInipecSettings1790000000000`).

In `database/data-source.ts`: import `PostalPosteTracking` e aggiunta in coda all'array `entities`.

- [ ] **Step 4: Aggiungere il setting**

In `settings/settings.registry.ts`, subito dopo la riga `'inad.checkEnabled': { type: 'boolean', default: false },`:
```ts
  // Verifica consegna POSTAL su tracking pubblico Poste Italiane per gli
  // invii che GlobalCom chiude come NonConsegnato — kill-switch se
  // l'endpoint (non documentato) di poste.it cambia o va giù.
  'postalPosteTracking.enabled': { type: 'boolean', default: true },
```

- [ ] **Step 5: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verificare la migration su DB temporaneo**

```bash
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE poste_migration_test;"
docker compose exec backend sh -c 'DATABASE_URL="$(echo $DATABASE_URL | sed "s#/[^/]*\$#/poste_migration_test#")" node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts' 2>&1 | tail -5
docker exec comunicapa-postgres-1 psql -U comunicapa -d poste_migration_test -c "\d postal_poste_tracking"
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "DROP DATABASE poste_migration_test;"
```
Expected: migration `CreatePostalPosteTracking1790100000000` eseguita, tabella con constraint `UQ_`/`FK_` e indice. Se il runner CLI fallisce per motivi ESM/preesistenti non legati alla migration, verificare almeno che `docker compose restart backend` (dev, `synchronize`) crei la tabella: `docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "\d postal_poste_tracking"`, e riportarlo nel report.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/entities/postal-poste-tracking.entity.ts apps/backend/src/database/migrations/1790100000000-CreatePostalPosteTracking.ts apps/backend/src/database/database.module.ts apps/backend/src/database/data-source.ts apps/backend/src/settings/settings.registry.ts
git commit -m "feat(postal): tabella postal_poste_tracking e setting verifica Poste"
```

---

### Task 2: Mapping risposta Poste (funzioni pure)

**Files:**
- Create: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-mapping.util.ts`
- Test: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-mapping.util.spec.ts`

**Interfaces:**
- Consumes: `PosteTrackingMovement` (Task 1).
- Produces:
  - `class PosteTrackingError extends Error { readonly kind: 'network' | 'http' | 'invalid_body' }`
  - `interface PosteTrackingResponse { esitoRicerca: string; stato: string; flagRitorno: boolean; tipoProdotto: string | null; movements: PosteTrackingMovement[]; raw: Record<string, unknown> }`
  - `type PosteOutcome = 'delivered' | 'returned' | 'pending'`
  - `parsePosteResponse(body: unknown): PosteTrackingResponse` (lancia `PosteTrackingError('...', 'invalid_body')`)
  - `lastMovement(movements: PosteTrackingMovement[]): PosteTrackingMovement | null`
  - `mapPosteOutcome(r: PosteTrackingResponse): { outcome: PosteOutcome; deliveredAt: Date | null }`

- [ ] **Step 1: Scrivere i test**

```ts
import { describe, it, expect } from 'vitest';
import { parsePosteResponse, mapPosteOutcome, lastMovement, PosteTrackingError } from './poste-tracking-mapping.util.js';

const delivered = {
  idTracciatura: 'RN000000000IT',
  tipoProdotto: 'RACC. DA/PER ESTERO',
  esitoRicerca: '3',
  stato: '5',
  flagRitorno: false,
  listaMovimenti: [
    { dataOra: 1785393537000, statoLavorazione: 'a seguito di acquisto da poste.it', luogo: 'sito poste.it', flagRitorno: false, box: '2' },
    { dataOra: 1786508340000, statoLavorazione: 'in data', luogo: 'SVIZZERA', flagRitorno: false, box: '3' },
    { dataOra: 1788509160000, statoLavorazione: 'con successo in data', luogo: 'SVIZZERA', flagRitorno: false, box: '5' },
  ],
};

describe('parsePosteResponse', () => {
  it('normalizza movimenti (epoch ms → ISO) e conserva la risposta grezza', () => {
    const r = parsePosteResponse(delivered);
    expect(r.esitoRicerca).toBe('3');
    expect(r.stato).toBe('5');
    expect(r.tipoProdotto).toBe('RACC. DA/PER ESTERO');
    expect(r.movements).toHaveLength(3);
    expect(r.movements[2]).toEqual({ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false });
    expect(r.raw).toBe(delivered);
  });

  it('codice non trovato: nessun movimento', () => {
    const r = parsePosteResponse({ idTracciatura: 'X', esitoRicerca: '1', stato: '1' });
    expect(r.movements).toEqual([]);
    expect(r.flagRitorno).toBe(false);
  });

  it('body non oggetto o senza esitoRicerca → PosteTrackingError invalid_body', () => {
    for (const body of [null, 'html', 42, [], { foo: 1 }]) {
      expect(() => parsePosteResponse(body)).toThrow(PosteTrackingError);
    }
    try { parsePosteResponse('x'); } catch (e) { expect((e as PosteTrackingError).kind).toBe('invalid_body'); }
  });
});

describe('lastMovement', () => {
  it('prende il box più alto, a parità il più recente', () => {
    const m = parsePosteResponse(delivered).movements;
    expect(lastMovement(m)?.box).toBe('5');
    expect(lastMovement([])).toBeNull();
    const tie = [
      { at: '2026-01-01T00:00:00.000Z', luogo: 'A', statoLavorazione: '', box: '4', flagRitorno: false },
      { at: '2026-01-02T00:00:00.000Z', luogo: 'B', statoLavorazione: '', box: '4', flagRitorno: false },
    ];
    expect(lastMovement(tie)?.luogo).toBe('B');
  });
});

describe('mapPosteOutcome', () => {
  it('esito 3 + stato 5 senza ritorno → delivered con data ultimo movimento', () => {
    const { outcome, deliveredAt } = mapPosteOutcome(parsePosteResponse(delivered));
    expect(outcome).toBe('delivered');
    expect(deliveredAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
  });

  it('flagRitorno in testa → returned anche con stato 5', () => {
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, flagRitorno: true })).outcome).toBe('returned');
  });

  it('flagRitorno su un movimento → returned', () => {
    const body = { ...delivered, listaMovimenti: [...delivered.listaMovimenti, { dataOra: 1788600000000, statoLavorazione: 'x', luogo: 'Y', flagRitorno: true, box: '5' }] };
    expect(mapPosteOutcome(parsePosteResponse(body)).outcome).toBe('returned');
  });

  it('esitoRicerca 1 (non trovato) → pending', () => {
    expect(mapPosteOutcome(parsePosteResponse({ esitoRicerca: '1', stato: '1' }))).toEqual({ outcome: 'pending', deliveredAt: null });
  });

  it('stato intermedio o sconosciuto → pending', () => {
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, stato: '4' })).outcome).toBe('pending');
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, esitoRicerca: '2' })).outcome).toBe('pending');
  });
});
```

- [ ] **Step 2: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-mapping`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementare**

```ts
import type { PosteTrackingMovement } from '../../../entities/postal-poste-tracking.entity.js';

export class PosteTrackingError extends Error {
  constructor(message: string, readonly kind: 'network' | 'http' | 'invalid_body') {
    super(message);
    this.name = 'PosteTrackingError';
  }
}

export interface PosteTrackingResponse {
  esitoRicerca: string;
  stato: string;
  flagRitorno: boolean;
  tipoProdotto: string | null;
  movements: PosteTrackingMovement[];
  raw: Record<string, unknown>;
}

export type PosteOutcome = 'delivered' | 'returned' | 'pending';

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Risposta dell'endpoint JSON (non documentato) dietro "Cerca spedizioni"
 * di poste.it. Qualunque cosa che non sia un oggetto con `esitoRicerca` è
 * trattata come formato cambiato/pagina di errore → invalid_body (mai un
 * esito: il chiamante non consuma il controllo).
 */
export function parsePosteResponse(body: unknown): PosteTrackingResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('esitoRicerca' in body)) {
    throw new PosteTrackingError('Risposta Poste in formato inatteso', 'invalid_body');
  }
  const b = body as Record<string, unknown>;
  const lista = Array.isArray(b['listaMovimenti']) ? (b['listaMovimenti'] as Array<Record<string, unknown>>) : [];
  const movements: PosteTrackingMovement[] = lista.map((m) => {
    const ms = Number(m['dataOra']);
    return {
      at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '',
      luogo: str(m['luogo']),
      statoLavorazione: str(m['statoLavorazione']),
      box: str(m['box']),
      flagRitorno: m['flagRitorno'] === true,
    };
  });
  return {
    esitoRicerca: str(b['esitoRicerca']),
    stato: str(b['stato']),
    flagRitorno: b['flagRitorno'] === true,
    tipoProdotto: b['tipoProdotto'] ? str(b['tipoProdotto']) : null,
    movements,
    raw: b,
  };
}

/** Movimento con `box` (fase) più alto; a parità il più recente. */
export function lastMovement(movements: PosteTrackingMovement[]): PosteTrackingMovement | null {
  let best: PosteTrackingMovement | null = null;
  for (const m of movements) {
    if (!best) { best = m; continue; }
    const diff = (Number(m.box) || 0) - (Number(best.box) || 0);
    if (diff > 0 || (diff === 0 && m.at > best.at)) best = m;
  }
  return best;
}

/**
 * Mappatura prudente: solo `stato "5"` è verificato su un caso reale come
 * "consegnata". Il ritorno al mittente ha la precedenza (una consegna "con
 * successo" dopo il ritorno è al mittente, non al destinatario). Tutto il
 * resto resta pending, con risposta grezza salvata per allargare la
 * mappatura sui casi reali.
 */
export function mapPosteOutcome(r: PosteTrackingResponse): { outcome: PosteOutcome; deliveredAt: Date | null } {
  if (r.flagRitorno || r.movements.some((m) => m.flagRitorno)) return { outcome: 'returned', deliveredAt: null };
  if (r.esitoRicerca === '3' && r.stato === '5') {
    const last = lastMovement(r.movements);
    return { outcome: 'delivered', deliveredAt: last?.at ? new Date(last.at) : null };
  }
  return { outcome: 'pending', deliveredAt: null };
}
```

- [ ] **Step 4: Eseguire i test, devono passare**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-mapping`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/postal/poste-tracking/poste-tracking-mapping.util.ts apps/backend/src/channels/postal/poste-tracking/poste-tracking-mapping.util.spec.ts
git commit -m "feat(postal): parsing ed esito risposta tracking Poste"
```

---

### Task 3: Client HTTP Poste

**Files:**
- Create: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-client.service.ts`
- Test: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-client.service.spec.ts`

**Interfaces:**
- Consumes: `parsePosteResponse`, `PosteTrackingError`, `PosteTrackingResponse` (Task 2).
- Produces: `@Injectable() class PosteTrackingClient { track(code: string): Promise<PosteTrackingResponse> }`, `const POSTE_TRACKING_URL`.

- [ ] **Step 1: Scrivere i test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PosteTrackingClient, POSTE_TRACKING_URL } from './poste-tracking-client.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PosteTrackingClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST con il body atteso e risposta normalizzata', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ esitoRicerca: '3', stato: '5', listaMovimenti: [] }));
    const r = await new PosteTrackingClient().track('RN000000000IT');
    expect(r.stato).toBe('5');
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(POSTE_TRACKING_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ tipoRichiedente: 'WEB', codiceSpedizione: 'RN000000000IT', periodoRicerca: 1 });
    expect(init?.signal).toBeDefined();
  });

  it('errore di rete/timeout → kind network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'network' });
  });

  it('HTTP non 2xx → kind http', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'http' });
  });

  it('body HTML (200) → kind invalid_body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>blocked</html>', { status: 200 }));
    const err = await new PosteTrackingClient().track('X').catch((e) => e);
    expect(err).toBeInstanceOf(PosteTrackingError);
    expect(err.kind).toBe('invalid_body');
  });
});
```

- [ ] **Step 2: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-client`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementare**

```ts
import { Injectable } from '@nestjs/common';
import { parsePosteResponse, PosteTrackingError, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';

/**
 * Endpoint JSON pubblico (non documentato, nessuna autenticazione) usato
 * dalla pagina "Cerca spedizioni" di poste.it. Può cambiare senza
 * preavviso: ogni anomalia diventa PosteTrackingError, mai un esito.
 */
export const POSTE_TRACKING_URL = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const TIMEOUT_MS = 15_000;

@Injectable()
export class PosteTrackingClient {
  async track(code: string): Promise<PosteTrackingResponse> {
    let res: Response;
    try {
      res = await fetch(POSTE_TRACKING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'ComunicaPA/1.0 (verifica consegna raccomandate PA)',
        },
        body: JSON.stringify({ tipoRichiedente: 'WEB', codiceSpedizione: code, periodoRicerca: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PosteTrackingError(`Errore di rete verso Poste: ${err instanceof Error ? err.message : String(err)}`, 'network');
    }
    if (!res.ok) throw new PosteTrackingError(`HTTP ${res.status} da Poste`, 'http');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PosteTrackingError('Risposta Poste non JSON', 'invalid_body');
    }
    return parsePosteResponse(body);
  }
}
```

- [ ] **Step 4: Eseguire i test, devono passare**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-client`
Expected: PASS.

- [ ] **Step 5: Verifica dal vivo dal container backend (User-Agent identificativo)**

Chiedere all'utente un codice di accettazione reale (o usare uno già fornito in conversazione) — **mai scriverlo in file versionati**. Poi:
```bash
docker compose exec backend node -e "fetch('https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':'ComunicaPA/1.0 (verifica consegna raccomandate PA)'},body:JSON.stringify({tipoRichiedente:'WEB',codiceSpedizione:process.argv[1],periodoRicerca:1})}).then(async r=>console.log(r.status,(await r.text()).slice(0,300)))" <CODICE>
```
Expected: `200` e JSON con `esitoRicerca`. Se torna 403/HTML con questo User-Agent, **fermarsi e riportarlo all'utente** (non camuffare lo User-Agent da browser senza una sua decisione).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/poste-tracking/poste-tracking-client.service.ts apps/backend/src/channels/postal/poste-tracking/poste-tracking-client.service.spec.ts
git commit -m "feat(postal): client HTTP tracking Poste"
```

---

### Task 4: Servizio ciclo di vita (backfill, cron, manuale) + controller + modulo

**Files:**
- Create: `apps/backend/src/channels/postal/poste-tracking/poste-postal-tracking.service.ts`
- Create: `apps/backend/src/channels/postal/poste-tracking/poste-tracking.controller.ts`
- Create: `apps/backend/src/channels/postal/poste-tracking/poste-tracking.module.ts`
- Create (DTO usato dal controller): `apps/backend/src/channels/postal/poste-tracking/poste-tracking-effective.util.ts` — in questo task solo `PosteVerificationDto` e `toPosteVerificationDto`; il resto in Task 5.
- Modify: `apps/backend/src/app.module.ts`
- Test: `apps/backend/src/channels/postal/poste-tracking/poste-postal-tracking.service.spec.ts`, `poste-tracking.controller.spec.ts`

**Interfaces:**
- Consumes: `PostalPosteTracking` (Task 1), `PosteTrackingClient.track` (Task 3), `mapPosteOutcome` (Task 2), `AppSettingsService.get<boolean>('postalPosteTracking.enabled')`.
- Produces:
  - `const MAX_POSTE_CHECKS = 90` (esportata da `poste-postal-tracking.service.ts`)
  - `type CheckResult = PosteTrackingStatus | 'error'`
  - `interface PosteCampaignRunState { running: boolean; total: number; done: number; delivered: number; returned: number; errors: number; aborted: boolean; startedAt: string | null; finishedAt: string | null }`
  - `PostePostalTrackingService.backfill(campaignId?: string): Promise<number>`
  - `PostePostalTrackingService.checkOne(row: PostalPosteTracking, mode: 'cron' | 'manual'): Promise<CheckResult>`
  - `PostePostalTrackingService.handleCron(): Promise<void>`
  - `PostePostalTrackingService.checkRecipientNow(campaignId: string, recipientId: string): Promise<PostalPosteTracking>`
  - `PostePostalTrackingService.startCampaignRun(campaignId: string): Promise<{ total: number }>`
  - `PostePostalTrackingService.getCampaignRun(campaignId: string): PosteCampaignRunState`
  - `interface PosteVerificationDto { status: PosteTrackingStatus; trackingCode: string; checkCount: number; maxChecks: number; nextCheckAt: string | null; lastCheckedAt: string | null; lastError: string | null; deliveredAt: string | null; movements: PosteTrackingMovement[] }`
  - `toPosteVerificationDto(row: PostalPosteTracking): PosteVerificationDto`
  - Route: `POST admin/campaigns/:id/postal/poste-check` (202 `{ total }`), `GET admin/campaigns/:id/postal/poste-check` (`PosteCampaignRunState`), `POST admin/campaigns/:id/recipients/:recipientId/postal/poste-check` (200 `PosteVerificationDto`).

- [ ] **Step 1: Scrivere `toPosteVerificationDto` in `poste-tracking-effective.util.ts`**

```ts
import type { PostalPosteTracking, PosteTrackingMovement, PosteTrackingStatus } from '../../../entities/postal-poste-tracking.entity.js';

/** Allineato a MAX_POSTE_CHECKS del servizio (duplicato qui per evitare import circolare util → service). */
export const POSTE_MAX_CHECKS = 90;

export interface PosteVerificationDto {
  status: PosteTrackingStatus;
  trackingCode: string;
  checkCount: number;
  maxChecks: number;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  movements: PosteTrackingMovement[];
}

export function toPosteVerificationDto(row: PostalPosteTracking): PosteVerificationDto {
  return {
    status: row.status,
    trackingCode: row.trackingCode,
    checkCount: row.checkCount,
    maxChecks: POSTE_MAX_CHECKS,
    nextCheckAt: row.nextCheckAt ? row.nextCheckAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    movements: row.movements ?? [],
  };
}
```

- [ ] **Step 2: Scrivere i test del servizio**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { PostePostalTrackingService, MAX_POSTE_CHECKS } from './poste-postal-tracking.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';
import type { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';

const DELIVERED = { esitoRicerca: '3', stato: '5', flagRitorno: false, tipoProdotto: 'RACC', movements: [{ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false }], raw: {} };
const NOT_FOUND = { esitoRicerca: '1', stato: '1', flagRitorno: false, tipoProdotto: null, movements: [], raw: {} };

function row(partial: Partial<PostalPosteTracking> = {}): PostalPosteTracking {
  return { id: 't1', attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending', checkCount: 0, nextCheckAt: new Date(), lastCheckedAt: null, lastError: null, posteStato: null, posteEsitoRicerca: null, posteProduct: null, deliveredAt: null, movements: null, lastResponse: null, createdAt: new Date(), updatedAt: new Date(), ...partial } as PostalPosteTracking;
}

function makeQb(rows: PostalPosteTracking[]) {
  const qb: any = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'orderBy']) qb[m] = vi.fn().mockReturnValue(qb);
  qb.getMany = vi.fn().mockResolvedValue(rows);
  return qb;
}

describe('PostePostalTrackingService', () => {
  let service: PostePostalTrackingService;
  let repo: any;
  let attemptRepo: any;
  let recipientRepo: any;
  let client: { track: ReturnType<typeof vi.fn> };
  let settings: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = {
      query: vi.fn().mockResolvedValue([]),
      save: vi.fn(async (r) => r),
      create: vi.fn((r) => ({ ...row(), ...r })),
      findOneBy: vi.fn().mockResolvedValue(null),
      createQueryBuilder: vi.fn(),
    };
    attemptRepo = { findOne: vi.fn() };
    recipientRepo = { findOne: vi.fn() };
    client = { track: vi.fn() };
    settings = { get: vi.fn().mockResolvedValue(true) };
    service = new PostePostalTrackingService(repo, attemptRepo, recipientRepo, client as any, settings as any);
    (service as any).sleep = vi.fn().mockResolvedValue(undefined);
  });

  describe('backfill', () => {
    it('INSERT idempotente solo su ultimo attempt NonConsegnato con codice', async () => {
      repo.query.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
      expect(await service.backfill()).toBe(2);
      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('ON CONFLICT (attempt_id) DO NOTHING');
      expect(sql).toContain("na.postal_status = 'NonConsegnato'");
      expect(sql).toContain('newer.attempt_number > na.attempt_number');
      expect(repo.query.mock.calls[0][1]).toEqual([]);
    });

    it('ristretto alla campagna quando passato', async () => {
      await service.backfill('c1');
      expect(repo.query.mock.calls[0][0]).toContain('r.campaign_id = $1');
      expect(repo.query.mock.calls[0][1]).toEqual(['c1']);
    });
  });

  describe('checkOne (cron)', () => {
    it('delivered: finale, data consegna, check_count++', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row();
      expect(await service.checkOne(r, 'cron')).toBe('delivered');
      expect(r.status).toBe('delivered');
      expect(r.checkCount).toBe(1);
      expect(r.nextCheckAt).toBeNull();
      expect(r.deliveredAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
      expect(r.posteStato).toBe('5');
      expect(r.lastCheckedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalledWith(r);
    });

    it('pending: resta pending, prossimo controllo tra un giorno', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: 3 });
      const before = Date.now();
      expect(await service.checkOne(r, 'cron')).toBe('pending');
      expect(r.checkCount).toBe(4);
      expect(r.nextCheckAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    });

    it(`al ${MAX_POSTE_CHECKS}° controllo senza esito → gave_up`, async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: MAX_POSTE_CHECKS - 1 });
      expect(await service.checkOne(r, 'cron')).toBe('gave_up');
      expect(r.checkCount).toBe(MAX_POSTE_CHECKS);
      expect(r.nextCheckAt).toBeNull();
    });

    it('errore: non consuma controllo, aggiorna last_checked_at e last_error', async () => {
      client.track.mockRejectedValue(new PosteTrackingError('HTTP 503 da Poste', 'http'));
      const r = row({ checkCount: 5 });
      expect(await service.checkOne(r, 'cron')).toBe('error');
      expect(r.checkCount).toBe(5);
      expect(r.status).toBe('pending');
      expect(r.lastError).toBe('HTTP 503 da Poste');
      expect(r.lastCheckedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalledWith(r);
    });
  });

  describe('checkOne (manual)', () => {
    it('non incrementa check_count e non sposta next_check_at', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const next = new Date('2030-01-01T00:00:00Z');
      const r = row({ checkCount: 7, nextCheckAt: next });
      expect(await service.checkOne(r, 'manual')).toBe('pending');
      expect(r.checkCount).toBe(7);
      expect(r.nextCheckAt).toBe(next);
    });

    it('su gave_up senza esito resta gave_up', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ status: 'gave_up', checkCount: 90, nextCheckAt: null });
      expect(await service.checkOne(r, 'manual')).toBe('gave_up');
      expect(r.status).toBe('gave_up');
    });

    it('su gave_up con consegna → delivered', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row({ status: 'gave_up', checkCount: 90, nextCheckAt: null });
      expect(await service.checkOne(r, 'manual')).toBe('delivered');
    });
  });

  describe('handleCron', () => {
    it('kill-switch: nessuna chiamata se disattivato', async () => {
      settings.get.mockResolvedValue(false);
      await service.handleCron();
      expect(repo.query).not.toHaveBeenCalled();
      expect(client.track).not.toHaveBeenCalled();
    });

    it('backfill poi controllo sequenziale dei dovuti, solo NonConsegnato', async () => {
      const qb = makeQb([row({ id: 't1' }), row({ id: 't2' })]);
      repo.createQueryBuilder.mockReturnValue(qb);
      client.track.mockResolvedValue(NOT_FOUND);
      await service.handleCron();
      expect(repo.query).toHaveBeenCalledTimes(1);
      expect(client.track).toHaveBeenCalledTimes(2);
      const where = [qb.where, qb.andWhere].flatMap((f: any) => f.mock.calls.map((c: any[]) => c[0])).join(' ');
      expect(where).toContain("a.postal_status = 'NonConsegnato'");
      expect(where).toContain('t.next_check_at <= now()');
      expect((service as any).sleep).toHaveBeenCalledTimes(1);
    });

    it('circuit breaker: si ferma dopo 5 errori consecutivi', async () => {
      const rows = Array.from({ length: 8 }, (_, i) => row({ id: `t${i}` }));
      repo.createQueryBuilder.mockReturnValue(makeQb(rows));
      client.track.mockRejectedValue(new PosteTrackingError('HTTP 403 da Poste', 'http'));
      await service.handleCron();
      expect(client.track).toHaveBeenCalledTimes(5);
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
    });
  });

  describe('checkRecipientNow', () => {
    it('crea la riga al volo se manca e controlla subito', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'NonConsegnato', postalAcceptanceId: 'RN000000000IT' });
      client.track.mockResolvedValue(DELIVERED);
      const r = await service.checkRecipientNow('c1', 'r1');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending' }));
      expect(r.status).toBe('delivered');
      expect(r.checkCount).toBe(0);
    });

    it('400 se l\'ultimo attempt non è NonConsegnato e non ha riga', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'Consegnato', postalAcceptanceId: 'RN000000000IT' });
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 se disattivato', async () => {
      settings.get.mockResolvedValue(false);
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('run di campagna', () => {
    it('ignora next_check_at, include gave_up, stato run aggiornato', async () => {
      const qb = makeQb([row({ id: 't1' }), row({ id: 't2', status: 'gave_up', checkCount: 90, nextCheckAt: null })]);
      repo.createQueryBuilder.mockReturnValue(qb);
      client.track.mockResolvedValueOnce(DELIVERED).mockRejectedValueOnce(new PosteTrackingError('x', 'network'));
      expect(await service.startCampaignRun('c1')).toEqual({ total: 2 });
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
      const state = service.getCampaignRun('c1');
      expect(state).toMatchObject({ total: 2, done: 2, delivered: 1, errors: 1, aborted: false });
      expect(state.finishedAt).not.toBeNull();
      const where = [qb.where, qb.andWhere].flatMap((f: any) => f.mock.calls.map((c: any[]) => c[0])).join(' ');
      expect(where).not.toContain('next_check_at');
      expect(repo.query.mock.calls[0][1]).toEqual(['c1']);
    });

    it('409 se già in corso sulla stessa campagna', async () => {
      repo.createQueryBuilder.mockReturnValue(makeQb([row()]));
      let release!: () => void;
      client.track.mockReturnValue(new Promise((res) => { release = () => res(NOT_FOUND); }));
      await service.startCampaignRun('c1');
      await expect(service.startCampaignRun('c1')).rejects.toBeInstanceOf(ConflictException);
      release();
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
    });

    it('stato vuoto se mai lanciato', () => {
      expect(service.getCampaignRun('zzz')).toMatchObject({ running: false, total: 0, startedAt: null });
    });
  });
});
```

- [ ] **Step 3: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-postal-tracking`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: Implementare il servizio**

```ts
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
import { mapPosteOutcome } from './poste-tracking-mapping.util.js';
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
    const now = new Date();
    row.lastCheckedAt = now;
    let resp;
    try {
      resp = await this.client.track(row.trackingCode);
    } catch (err) {
      row.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (mode === 'cron') row.nextCheckAt = new Date(now.getTime() + DAY_MS);
      await this.repo.save(row);
      return 'error';
    }

    row.lastError = null;
    row.posteStato = resp.stato;
    row.posteEsitoRicerca = resp.esitoRicerca;
    row.posteProduct = resp.tipoProdotto;
    row.movements = resp.movements;
    row.lastResponse = resp.raw;
    const { outcome, deliveredAt } = mapPosteOutcome(resp);
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
```

- [ ] **Step 5: Eseguire i test del servizio, devono passare**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-postal-tracking`
Expected: PASS.

- [ ] **Step 6: Test del controller**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PosteTrackingController } from './poste-tracking.controller.js';

describe('PosteTrackingController', () => {
  it('delega al servizio e converte la riga in DTO', async () => {
    const svc = {
      startCampaignRun: vi.fn().mockResolvedValue({ total: 3 }),
      getCampaignRun: vi.fn().mockReturnValue({ running: true, total: 3, done: 1 }),
      checkRecipientNow: vi.fn().mockResolvedValue({ status: 'delivered', trackingCode: 'RN000000000IT', checkCount: 2, nextCheckAt: null, lastCheckedAt: new Date('2026-09-24T10:00:00Z'), lastError: null, deliveredAt: new Date('2026-09-04T08:06:00Z'), movements: [] }),
    };
    const ctrl = new PosteTrackingController(svc as any);
    expect(await ctrl.startCampaignRun('c1')).toEqual({ total: 3 });
    expect(ctrl.getCampaignRun('c1')).toMatchObject({ running: true });
    expect(await ctrl.checkRecipient('c1', 'r1')).toMatchObject({ status: 'delivered', maxChecks: 90, deliveredAt: '2026-09-04T08:06:00.000Z' });
    expect(svc.checkRecipientNow).toHaveBeenCalledWith('c1', 'r1');
  });
});
```

- [ ] **Step 7: Implementare controller e modulo**

`poste-tracking.controller.ts`:
```ts
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../../../auth/decorators/roles.decorator.js';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { toPosteVerificationDto } from './poste-tracking-effective.util.js';

/**
 * Endpoint manuali verifica Poste, sotto lo stesso prefisso delle route
 * campagna ma in un controller proprio: nessuna dipendenza nuova su
 * CampaignsController (e sulle sue spec). Sola lettura esterna → tutti gli
 * operatori, come "Ricontrolla stato GlobalCom".
 */
@Controller('admin/campaigns')
@Roles('user', 'admin')
export class PosteTrackingController {
  constructor(private readonly svc: PostePostalTrackingService) {}

  @Post(':id/postal/poste-check')
  @HttpCode(202)
  startCampaignRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.startCampaignRun(id);
  }

  @Get(':id/postal/poste-check')
  getCampaignRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCampaignRun(id);
  }

  @Post(':id/recipients/:recipientId/postal/poste-check')
  @HttpCode(200)
  async checkRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return toPosteVerificationDto(await this.svc.checkRecipientNow(id, recipientId));
  }
}
```

`poste-tracking.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';
import { NotificationAttempt } from '../../../entities/notification-attempt.entity.js';
import { Recipient } from '../../../entities/recipient.entity.js';
import { PosteTrackingClient } from './poste-tracking-client.service.js';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { PosteTrackingController } from './poste-tracking.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([PostalPosteTracking, NotificationAttempt, Recipient])],
  controllers: [PosteTrackingController],
  providers: [PosteTrackingClient, PostePostalTrackingService],
})
export class PosteTrackingModule {}
```

In `app.module.ts`: import `PosteTrackingModule` da `./channels/postal/poste-tracking/poste-tracking.module.js` e aggiungerlo all'array `imports` subito dopo `PostalAuthorizedUsersModule`.

- [ ] **Step 8: Test, type-check, avvio**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run poste-
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose restart backend && docker compose logs --tail 40 backend
```
Expected: test PASS, nessun errore tsc, log con `Mapped {/admin/campaigns/:id/postal/poste-check, POST}` e nessun errore DI.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/channels/postal/poste-tracking/ apps/backend/src/app.module.ts
git commit -m "feat(postal): cron e verifica manuale consegna su tracking Poste"
```

---

### Task 5: Util stato effettivo

**Files:**
- Modify: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-effective.util.ts`
- Test: `apps/backend/src/channels/postal/poste-tracking/poste-tracking-effective.util.spec.ts`

**Interfaces:**
- Consumes: `lastMovement` (Task 2), `PosteVerificationDto`, `POSTE_MAX_CHECKS` (Task 4).
- Produces:
  - `const POSTE_DELIVERED_BUCKET = 'ConsegnatoVerificaPoste'`
  - `isPosteDeliveredOverride(postalStatus: string | null | undefined, posteStatus: string | null | undefined): boolean`
  - `posteDeliveredSql(alias: string): string` — frammento SQL booleano su un alias di `notification_attempts` che espone `id` e `postal_status`
  - `posteVerificationLabel(v: { status: string; checkCount: number } | null | undefined): string`
  - `formatLastMovement(movements: PosteTrackingMovement[] | null | undefined): string`

- [ ] **Step 1: Scrivere i test**

```ts
import { describe, it, expect } from 'vitest';
import { POSTE_DELIVERED_BUCKET, isPosteDeliveredOverride, posteDeliveredSql, posteVerificationLabel, formatLastMovement, toPosteVerificationDto } from './poste-tracking-effective.util.js';

describe('poste-tracking-effective', () => {
  it('override solo con GlobalCom NonConsegnato e Poste delivered', () => {
    expect(POSTE_DELIVERED_BUCKET).toBe('ConsegnatoVerificaPoste');
    expect(isPosteDeliveredOverride('NonConsegnato', 'delivered')).toBe(true);
    expect(isPosteDeliveredOverride('Consegnato', 'delivered')).toBe(false);
    expect(isPosteDeliveredOverride('NonConsegnato', 'returned')).toBe(false);
    expect(isPosteDeliveredOverride('NonConsegnato', null)).toBe(false);
  });

  it('SQL sull\'alias passato', () => {
    const sql = posteDeliveredSql('na');
    expect(sql).toContain("na.postal_status = 'NonConsegnato'");
    expect(sql).toContain('ppt.attempt_id = na.id');
    expect(sql).toContain("ppt.status = 'delivered'");
  });

  it('etichette CSV', () => {
    expect(posteVerificationLabel({ status: 'delivered', checkCount: 3 })).toBe('Consegnato');
    expect(posteVerificationLabel({ status: 'returned', checkCount: 3 })).toBe('Restituito al mittente');
    expect(posteVerificationLabel({ status: 'pending', checkCount: 12 })).toBe('In verifica (12/90)');
    expect(posteVerificationLabel({ status: 'gave_up', checkCount: 90 })).toBe('Verifica esaurita');
    expect(posteVerificationLabel(null)).toBe('');
  });

  it('ultimo movimento "luogo data" in ora italiana', () => {
    expect(formatLastMovement([
      { at: '2026-08-12T04:19:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'in data', box: '3', flagRitorno: false },
      { at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false },
    ])).toBe(`SVIZZERA ${new Date('2026-09-04T08:06:00.000Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
    expect(formatLastMovement([])).toBe('');
    expect(formatLastMovement(null)).toBe('');
  });

  it('DTO con date ISO e maxChecks', () => {
    const dto = toPosteVerificationDto({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, nextCheckAt: new Date('2026-09-25T02:00:00Z'), lastCheckedAt: null, lastError: null, deliveredAt: null, movements: null } as any);
    expect(dto).toEqual({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, maxChecks: 90, nextCheckAt: '2026-09-25T02:00:00.000Z', lastCheckedAt: null, lastError: null, deliveredAt: null, movements: [] });
  });
});
```

- [ ] **Step 2: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-effective`
Expected: FAIL (export mancanti).

- [ ] **Step 3: Implementare (aggiungere in coda al file creato in Task 4)**

```ts
import { lastMovement } from './poste-tracking-mapping.util.js';

/**
 * Bucket sintetico di stato consegna (stesso pattern di NonTracciato/
 * AppIoSostituito/DirottatoAPec): GlobalCom dice NonConsegnato, Poste dice
 * consegnato. Unico punto di verità per breakdown, filtri, ricerca e CSV.
 */
export const POSTE_DELIVERED_BUCKET = 'ConsegnatoVerificaPoste';

export function isPosteDeliveredOverride(postalStatus: string | null | undefined, posteStatus: string | null | undefined): boolean {
  return postalStatus === 'NonConsegnato' && posteStatus === 'delivered';
}

/** Stesso predicato in SQL, su un alias di notification_attempts che espone id e postal_status. */
export function posteDeliveredSql(alias: string): string {
  return `(${alias}.postal_status = 'NonConsegnato' AND EXISTS (SELECT 1 FROM postal_poste_tracking ppt WHERE ppt.attempt_id = ${alias}.id AND ppt.status = 'delivered'))`;
}

export function posteVerificationLabel(v: { status: string; checkCount: number } | null | undefined): string {
  if (!v) return '';
  switch (v.status) {
    case 'delivered': return 'Consegnato';
    case 'returned': return 'Restituito al mittente';
    case 'pending': return `In verifica (${v.checkCount}/${POSTE_MAX_CHECKS})`;
    case 'gave_up': return 'Verifica esaurita';
    default: return v.status;
  }
}

export function formatLastMovement(movements: PosteTrackingMovement[] | null | undefined): string {
  const last = lastMovement(movements ?? []);
  if (!last) return '';
  const when = last.at ? new Date(last.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
  return [last.luogo, when].filter(Boolean).join(' ');
}
```
Nota: `lastMovement` va importato in cima al file insieme agli altri import (spostare la riga `import` all'inizio).

- [ ] **Step 4: Eseguire i test, devono passare**

Run: `docker compose exec backend node_modules/.bin/vitest run poste-tracking-effective`
Expected: PASS (l'attesa sulla data è calcolata con la stessa chiamata `toLocaleString('it-IT', { timeZone: 'Europe/Rome' })` di `formatDate` in `postal-report-csv.util.ts`, quindi indipendente dall'ICU del container).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/postal/poste-tracking/poste-tracking-effective.util.ts apps/backend/src/channels/postal/poste-tracking/poste-tracking-effective.util.spec.ts
git commit -m "feat(postal): util stato effettivo Consegnato (verifica Poste)"
```

---

### Task 6: CampaignsService — breakdown, filtri, lista destinatari

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.module.ts` (forFeature)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (costruttore, `getPostalDeliveryStatusBreakdown`, `getRecipientFilterOptions`, `getRecipientStats`)
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (`RecipientStatDto`)
- Test: `apps/backend/src/campaigns/campaigns.service.poste-tracking.spec.ts`

**Interfaces:**
- Consumes: `PostalPosteTracking` (Task 1), `POSTE_DELIVERED_BUCKET`, `isPosteDeliveredOverride`, `posteDeliveredSql` (Task 5).
- Produces: `RecipientStatDto.posteVerificationStatus?: string | null`, `RecipientStatDto.posteDeliveredAt?: Date | null`; `private loadPosteTrackingByAttempt(attemptIds: string[]): Promise<Map<string, PostalPosteTracking>>` (usato anche in Task 7).

- [ ] **Step 1: Scrivere i test**

`campaigns.service.poste-tracking.spec.ts` — stesso setup di `campaigns.service.cost.spec.ts` (copiarne gli import e la lista `providers`), più il repository opzionale:

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignsService } from './campaigns.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { ConfigService } from '@nestjs/config';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { InadService } from '../channels/inad/inad.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { RegistroImpreseService } from '../channels/registro-imprese/registro-imprese.service.js';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';

function makeQb(result: { many?: any[]; count?: number; raw?: any[] } = {}) {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'leftJoin', 'groupBy', 'orderBy', 'addOrderBy', 'skip', 'take']) qb[m] = vi.fn().mockReturnValue(qb);
  qb.getManyAndCount = vi.fn().mockResolvedValue([result.many ?? [], result.count ?? 0]);
  qb.getRawMany = vi.fn().mockResolvedValue(result.raw ?? []);
  qb.getCount = vi.fn().mockResolvedValue(result.count ?? 0);
  return qb;
}

describe('CampaignsService - verifica Poste', () => {
  let service: CampaignsService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let downloadEventRepo: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: vi.fn().mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true } }) };
    recipientRepo = { find: vi.fn(), createQueryBuilder: vi.fn() };
    attemptRepo = { find: vi.fn() };
    posteRepo = { find: vi.fn().mockResolvedValue([]) };
    downloadEventRepo = { find: vi.fn().mockResolvedValue([]) };
    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: PostalAuthorizedUsersService, useValue: {} },
        { provide: SignatureVerificationBulkService, useValue: {} },
        { provide: SignatureVerificationService, useValue: {} },
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadEventRepo },
        { provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: vi.fn() } },
        { provide: ConfigService, useValue: {} },
        { provide: InadService, useValue: {} },
        { provide: PostalStatusSyncService, useValue: {} },
        { provide: RegistroImpreseService, useValue: {} },
        { provide: RegistroImpreseVerifyQueueService, useValue: {} },
      ],
    }).compile();
    service = module.get(CampaignsService);
  });

  it('breakdown: NonConsegnato + Poste delivered → bucket ConsegnatoVerificaPoste, usa solo l\'ultimo attempt', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: null }, { id: 'r2', inadCheck: null }]);
    attemptRepo.find.mockResolvedValue([
      { id: 'a1', recipientId: 'r1', attemptNumber: 1, status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' },
      { id: 'a2', recipientId: 'r2', attemptNumber: 1, status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' },
    ]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered' }]);
    const result = await service.getPostalDeliveryStatusBreakdown('c1');
    expect(result).toEqual(expect.arrayContaining([
      { status: 'ConsegnatoVerificaPoste', count: 1 },
      { status: 'Indirizzo errato o inesatto', count: 1 },
    ]));
  });

  it('breakdown: GlobalCom uscito da NonConsegnato → nessun override', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: null }]);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, status: 'success', postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato' }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered' }]);
    expect(await service.getPostalDeliveryStatusBreakdown('c1')).toEqual([{ status: 'Consegnato', count: 1 }]);
  });

  it('filtro lista: ramo dedicato per il bucket, generico esclude gli override', async () => {
    const qb = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'ConsegnatoVerificaPoste');
    const dedicated = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(dedicated).toContain("ppt.status = 'delivered'");

    const qb2 = makeQb();
    recipientRepo.createQueryBuilder.mockReturnValue(qb2);
    await service.getRecipientStats('c1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'Indirizzo errato o inesatto');
    const generic = qb2.andWhere.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => s.includes(':postalDeliveryStatus'));
    expect(generic).toContain("AND NOT (na.postal_status = 'NonConsegnato'");
  });

  it('lista: espone stato verifica Poste sull\'ultimo attempt POSTAL', async () => {
    const qb = makeQb({ many: [{ id: 'r1', downloadCount: 0 }], count: 1 });
    recipientRepo.createQueryBuilder.mockReturnValue(qb);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', postalStatus: 'NonConsegnato' }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered', deliveredAt: new Date('2026-09-04T08:06:00Z') }]);
    const page = await service.getRecipientStats('c1', 1, 50);
    expect(page.items[0]).toMatchObject({ posteVerificationStatus: 'delivered', posteDeliveredAt: new Date('2026-09-04T08:06:00Z') });
  });
});
```

- [ ] **Step 2: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.poste-tracking`
Expected: FAIL (bucket assente / campi assenti).

- [ ] **Step 3: Registrare il repository nel modulo campagne**

In `campaigns/campaigns.module.ts`: import `PostalPosteTracking` da `'../entities/postal-poste-tracking.entity.js'` e aggiungerlo a `TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, DownloadEvent, CampaignBulkRetryJob, PostalPosteTracking])`.

- [ ] **Step 4: Costruttore e helper in `campaigns.service.ts`**

Import in cima:
```ts
import { Optional } from '@nestjs/common';   // aggiungere a import esistente da '@nestjs/common'
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { POSTE_DELIVERED_BUCKET, isPosteDeliveredOverride, posteDeliveredSql } from '../channels/postal/poste-tracking/poste-tracking-effective.util.js';
```
Ultimo parametro del costruttore (dopo `signatureVerification`):
```ts
    // @Optional: le spec esistenti istanziano CampaignsService senza questo
    // repo — senza, le letture verifica Poste tornano vuote (nessun override).
    @Optional() @InjectRepository(PostalPosteTracking)
    private readonly posteTrackingRepo?: Repository<PostalPosteTracking>,
```
Metodo privato (vicino a `getPostalDeliveryStatusBreakdown`):
```ts
  /** Righe verifica Poste per attempt id — mappa vuota senza repo o senza id. */
  private async loadPosteTrackingByAttempt(attemptIds: string[]): Promise<Map<string, PostalPosteTracking>> {
    if (!this.posteTrackingRepo || attemptIds.length === 0) return new Map();
    const rows = (await this.posteTrackingRepo.find({ where: { attemptId: In(attemptIds) } })) ?? [];
    return new Map(rows.map((r) => [r.attemptId, r]));
  }
```

- [ ] **Step 5: `getPostalDeliveryStatusBreakdown`**

Nel `attemptRepo.find` aggiungere `id: true` alla `select`. Dopo il ciclo che popola `latestByRecipient`:
```ts
    const posteByAttempt = await this.loadPosteTrackingByAttempt([...latestByRecipient.values()].map((a) => a.id));
```
Nel calcolo di `key`, sostituire il ramo finale:
```ts
          : a.postalStatus === 'AppIoSostituito'
            ? 'AppIoSostituito'
            : isPosteDeliveredOverride(a.postalStatus, posteByAttempt.get(a.id)?.status)
              ? POSTE_DELIVERED_BUCKET
              : (a.postalDeliveryStatus ?? (arTracking ? null : 'NonTracciato'));
```

- [ ] **Step 6: `getRecipientFilterOptions` — query `postalDeliveryRows`**

Sostituire la query `postalDeliveryRows` con:
```ts
    // Bucket sintetico verifica Poste: stesso predicato di posteDeliveredSql,
    // così il conteggio del valore GlobalCom originale scala da solo.
    const postalDeliveryValueSql = `CASE WHEN ${posteDeliveredSql('la')} THEN '${POSTE_DELIVERED_BUCKET}' ELSE la.postal_delivery_status END`;
    const postalDeliveryRows = await this.recipientRepo
      .createQueryBuilder('r')
      .select(postalDeliveryValueSql, 'value')
      .addSelect('COUNT(r.id)', 'count')
      .leftJoin(
        `(SELECT DISTINCT ON (recipient_id) id, recipient_id, postal_status, postal_delivery_status
          FROM notification_attempts ORDER BY recipient_id, attempt_number DESC)`,
        'la',
        'la.recipient_id = r.id',
      )
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere('la.postal_delivery_status IS NOT NULL')
      .groupBy(postalDeliveryValueSql)
      .getRawMany<{ value: string; count: string }>();
```
Se qualche test esistente in `campaigns.service.spec.ts` asserisce la stringa `'la.postal_delivery_status'` nella `select`/`groupBy` di questa query, aggiornarne l'attesa a `postalDeliveryValueSql` (stessa semantica).

- [ ] **Step 7: `getRecipientStats` — filtro**

Subito prima dell'ultimo ramo `} else if (postalDeliveryStatus && postalDeliveryStatus !== 'DirottatoAPec') {` inserire:
```ts
    } else if (postalDeliveryStatus === POSTE_DELIVERED_BUCKET) {
      // Bucket sintetico verifica Poste — mai un postal_delivery_status reale.
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM notification_attempts na
          WHERE na.recipient_id = r.id
            AND na.attempt_number = (SELECT MAX(na2.attempt_number) FROM notification_attempts na2 WHERE na2.recipient_id = r.id)
            AND ${posteDeliveredSql('na')}
        )`,
      );
```
e nel ramo generico aggiungere dopo `AND na.postal_delivery_status = :postalDeliveryStatus`:
```sql
            AND NOT ${posteDeliveredSql('na')}
```
(la stringa del template diventa `AND na.postal_delivery_status = :postalDeliveryStatus\n            AND NOT ${posteDeliveredSql('na')}`).

- [ ] **Step 8: `getRecipientStats` — campi riga**

In `dto/campaign-stats.dto.ts`, `RecipientStatDto`, dopo `postalAcceptanceId?: string | null;`:
```ts
  /** Verifica consegna su tracking Poste (ultimo attempt POSTAL), vedi poste-tracking-effective.util.ts. */
  posteVerificationStatus?: string | null;
  posteDeliveredAt?: Date | null;
```
In `getRecipientStats`, subito prima di `for (const item of items) {` (quello che assegna `item.downloadCount`):
```ts
      const posteByAttempt = await this.loadPosteTrackingByAttempt(
        [...latestByRecipient.values()].filter((a) => a.channelType === 'POSTAL').map((a) => a.id),
      );
```
e dentro `if (latest) { ... }`, dopo `item.postalAcceptanceId = latest.postalAcceptanceId;`:
```ts
          const poste = posteByAttempt.get(latest.id);
          item.posteVerificationStatus = poste?.status ?? null;
          item.posteDeliveredAt = poste?.deliveredAt ?? null;
```

- [ ] **Step 9: Test mirati e suite campagne**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.poste-tracking
docker compose exec backend node_modules/.bin/vitest run campaigns/
docker compose exec backend node_modules/.bin/tsc --noEmit
```
Expected: PASS; suite `campaigns/` senza nuovi fallimenti.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.poste-tracking.spec.ts
git commit -m "feat(campaigns): bucket Consegnato (verifica Poste) in breakdown e filtri"
```

---

### Task 7: Report CSV postale

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (`PostalReportRowDto`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`getPostalReportRows`)
- Modify: `apps/backend/src/campaigns/postal-report-csv.util.ts`
- Test: `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`, `apps/backend/src/campaigns/campaigns.service.poste-tracking.spec.ts`

**Interfaces:**
- Consumes: `loadPosteTrackingByAttempt` (Task 6), `isPosteDeliveredOverride`, `posteVerificationLabel`, `formatLastMovement` (Task 5).
- Produces: `PostalReportRowDto.posteVerification: { status: string; checkCount: number; deliveredAt: string | null; lastMovement: string } | null`, `PostalReportRowDto.posteDiscrepancy: boolean`.

- [ ] **Step 1: Aggiornare/aggiungere i test CSV**

In `postal-report-csv.util.spec.ts`: aggiungere `posteVerification: null, posteDiscrepancy: false` alla riga di `baseReport`; aggiornare l'header atteso del primo test a:
```ts
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IDPRO";"Stato Documento";"Data Stato";"Stato Consegna Poste";"Codice Consegna";"Data Consegna Poste";"ID Accettazione Poste";"Codice Errore";"Descrizione Errore";"Verifica Poste";"Data Consegna (Poste)";"Ultimo Movimento Poste";"Discrepanza GlobalCom/Poste"');
```
Aggiornare allo stesso modo eventuali altre asserzioni di header esatto nel file (storico, Esito App IO, External ID: le 4 colonne nuove stanno prima di `Esito App IO`/`External ID`). Nuovi test:
```ts
describe('colonne verifica Poste', () => {
  const when = new Date('2026-09-04T08:06:00.000Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const discrepancyReport: PostalReportDto = {
    hasAppIoCoDelivery: true,
    hasExternalId: false,
    rows: [{
      ...baseReport.rows[0],
      postalStatus: 'NonConsegnato',
      postalDeliveryStatus: 'Indirizzo errato o inesatto',
      appIoOutcome: { success: true, error: null },
      posteVerification: { status: 'delivered', checkCount: 3, deliveredAt: '2026-09-04T08:06:00.000Z', lastMovement: `SVIZZERA ${when}` },
      posteDiscrepancy: true,
    }],
  };

  it('attuale: valori e posizione prima di Esito App IO', () => {
    const [header, line] = buildPostalReportAttualeCsv(discrepancyReport).split('\n');
    expect(header).toContain('"Discrepanza GlobalCom/Poste";"Esito App IO"');
    expect(line).toContain(`"Consegnato";"${when}";"SVIZZERA ${when}";"SI";"Consegnato"`);
  });

  it('storico: stesse colonne', () => {
    const [header, line] = buildPostalReportStoricoCsv(discrepancyReport).split('\n');
    expect(header).toContain('"Verifica Poste";"Data Consegna (Poste)";"Ultimo Movimento Poste";"Discrepanza GlobalCom/Poste"');
    expect(line).toContain('"SI"');
  });

  it('senza verifica: celle vuote, nessuna discrepanza', () => {
    const line = buildPostalReportAttualeCsv(baseReport).split('\n')[1]!;
    expect(line.endsWith('"";"";"";""')).toBe(true);
  });
});
```
(Se `escapeCsvField('')` non produce `""`, adeguare le attese al comportamento reale di `csv.util.ts`, verificandolo prima.)

In `campaigns.service.poste-tracking.spec.ts` aggiungere:
```ts
  it('report postale: verifica e discrepanza sull\'ultimo attempt', async () => {
    recipientRepo.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', extraData: {} }]);
    attemptRepo.find.mockResolvedValue([{ id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL', status: 'success', postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto', postalStatusHistory: [] }]);
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'delivered', checkCount: 3, deliveredAt: new Date('2026-09-04T08:06:00Z'), movements: [{ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false }] }]);
    const report = await service.getPostalReportRows('c1');
    expect(report.rows[0]).toMatchObject({
      posteDiscrepancy: true,
      posteVerification: { status: 'delivered', checkCount: 3, deliveredAt: '2026-09-04T08:06:00.000Z' },
    });
    expect(report.rows[0]!.posteVerification!.lastMovement).toContain('SVIZZERA');
  });
```

- [ ] **Step 2: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run postal-report-csv campaigns.service.poste-tracking`
Expected: FAIL.

- [ ] **Step 3: DTO**

In `PostalReportRowDto`, dopo `externalId: string | null;`:
```ts
  /** Verifica consegna su tracking Poste dell'ultimo attempt, null se nessuna riga. */
  posteVerification: { status: string; checkCount: number; deliveredAt: string | null; lastMovement: string } | null;
  /** GlobalCom NonConsegnato ma Poste consegnato (stesso criterio del bucket ConsegnatoVerificaPoste). */
  posteDiscrepancy: boolean;
```

- [ ] **Step 4: `getPostalReportRows`**

Import aggiuntivo in `campaigns.service.ts`: `posteVerificationLabel` non serve qui; serve `formatLastMovement` → aggiungerlo all'import da `poste-tracking-effective.util.js`. Dopo il ciclo che popola `latestByRecipient`/`firstByRecipient`:
```ts
    const posteByAttempt = await this.loadPosteTrackingByAttempt([...latestByRecipient.values()].map((a) => a.id));
```
Nel `return` di ogni riga, dopo `externalId: resolveExternalId(campaign, r),`:
```ts
        posteVerification: poste
          ? { status: poste.status, checkCount: poste.checkCount, deliveredAt: poste.deliveredAt ? poste.deliveredAt.toISOString() : null, lastMovement: formatLastMovement(poste.movements) }
          : null,
        posteDiscrepancy: isPosteDeliveredOverride(latest?.postalStatus, poste?.status),
```
con, prima del `return` della riga: `const poste = latest ? posteByAttempt.get(latest.id) : undefined;`

- [ ] **Step 5: CSV util**

In `postal-report-csv.util.ts` aggiungere import:
```ts
import { posteVerificationLabel } from '../channels/postal/poste-tracking/poste-tracking-effective.util.js';
```
Helper:
```ts
const POSTE_HEADERS = ['Verifica Poste', 'Data Consegna (Poste)', 'Ultimo Movimento Poste', 'Discrepanza GlobalCom/Poste'];

function posteFields(r: PostalReportRowDto): string[] {
  return [
    posteVerificationLabel(r.posteVerification),
    formatDate(r.posteVerification?.deliveredAt ?? undefined),
    r.posteVerification?.lastMovement ?? '',
    r.posteDiscrepancy ? 'SI' : '',
  ];
}
```
In entrambi i builder: `headers` = array esistente seguito da `...POSTE_HEADERS` (prima dei `push` condizionali di `Esito App IO`/`External ID`); `fields` = array esistente seguito da `...posteFields(r)` (prima dei `push` condizionali).

- [ ] **Step 6: Test**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run postal-report-csv campaigns.service.poste-tracking campaigns/
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```
Expected: PASS, nessun errore tsc (se altri spec costruiscono `PostalReportRowDto` a mano e ora falliscono il type-check per i campi obbligatori nuovi, aggiungere `posteVerification: null, posteDiscrepancy: false` in quelle fixture).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/
git commit -m "feat(campaigns): colonne verifica Poste nei report CSV postali"
```

---

### Task 8: Ricerca globale notifiche e dettaglio

**Files:**
- Modify: `apps/backend/src/notifications-search/notifications-search.module.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.controller.ts`
- Modify: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`, `notifications-search.controller.spec.ts`

**Interfaces:**
- Consumes: `PostalPosteTracking`, `posteDeliveredSql`, `toPosteVerificationDto`, `PosteVerificationDto` (Task 1/4/5).
- Produces: `SearchFilters.posteVerification?: 'delivered' | 'returned' | 'pending' | 'gave_up' | 'any'`; `SearchRowDto.posteVerificationStatus: string | null`; attempt nel dettaglio: `posteVerification?: PosteVerificationDto | null`; query param `posteVerification` su `GET admin/notifications-search`.

- [ ] **Step 1: Leggere come le spec esistenti costruiscono il servizio**

Run: `sed -n 1,80p apps/backend/src/notifications-search/notifications-search.service.spec.ts` e `grep -n "svc.search\|search(" apps/backend/src/notifications-search/notifications-search.controller.spec.ts`. Aggiungere i test nuovi riusando lo stesso setup, aggiungendo il provider `{ provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo }` con `posteRepo = { find: vi.fn().mockResolvedValue([]), query: vi.fn().mockResolvedValue([]) }`.

- [ ] **Step 2: Scrivere i test**

Nel service spec:
```ts
  it('filtro posteVerification=delivered usa il predicato di discrepanza sull\'ultimo attempt', async () => {
    // qb mock come negli altri test di search()
    await service.search({ posteVerification: 'delivered', page: 1, pageSize: 50 });
    const sql = qb.andWhere.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(sql).toContain("ppt.status = 'delivered'");
    expect(sql).toContain("na.postal_status = 'NonConsegnato'");
  });

  it('filtro posteVerification=pending filtra per stato riga', async () => {
    await service.search({ posteVerification: 'pending', page: 1, pageSize: 50 });
    const call = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('postal_poste_tracking ppt2'));
    expect(call[1]).toEqual({ pv: 'pending' });
  });

  it('righe risultato: posteVerificationStatus dall\'ultimo attempt, delivered senza NonConsegnato scartato', async () => {
    // qb.getManyAndCount → [[{ id: 'r1', campaignId: 'c1', campaign: { name: 'X', channelType: 'POSTAL' }, codiceFiscale: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', status: 'sent', createdAt: new Date() }, { id: 'r2', ...stessa forma }], 2]
    posteRepo.query.mockResolvedValue([
      { recipientId: 'r1', status: 'delivered', postalStatus: 'NonConsegnato' },
      { recipientId: 'r2', status: 'delivered', postalStatus: 'Consegnato' },
    ]);
    const { rows } = await service.search({ page: 1, pageSize: 50 });
    expect(rows.find((r) => r.recipientId === 'r1')!.posteVerificationStatus).toBe('delivered');
    expect(rows.find((r) => r.recipientId === 'r2')!.posteVerificationStatus).toBeNull();
  });

  it('dettaglio: posteVerification sugli attempt POSTAL con riga', async () => {
    // mock come i test getDetail esistenti, con attempts [{ id: 'a1', channelType: 'POSTAL', ... }]
    posteRepo.find.mockResolvedValue([{ attemptId: 'a1', status: 'pending', trackingCode: 'RN000000000IT', checkCount: 2, nextCheckAt: null, lastCheckedAt: null, lastError: null, deliveredAt: null, movements: [] }]);
    const detail = await service.getDetail('r1');
    expect(detail.attempts[0]).toMatchObject({ posteVerification: { status: 'pending', checkCount: 2, maxChecks: 90 } });
  });
```
Completare i commenti `// qb mock ...` / `// mock come ...` copiando il setup dei test già presenti nel file per `search()`/`getDetail()` (stessa forma di mock, nessuna API inventata).

Nel controller spec:
```ts
  it('passa posteVerification solo se valore ammesso', () => {
    ctrl.search(undefined, undefined, undefined, undefined, undefined, undefined, undefined, '1', '50', 'delivered');
    expect(svc.search).toHaveBeenLastCalledWith(expect.objectContaining({ posteVerification: 'delivered' }));
    ctrl.search(undefined, undefined, undefined, undefined, undefined, undefined, undefined, '1', '50', 'DROP');
    expect(svc.search).toHaveBeenLastCalledWith(expect.objectContaining({ posteVerification: undefined }));
  });
```

- [ ] **Step 3: Eseguire i test, devono fallire**

Run: `docker compose exec backend node_modules/.bin/vitest run notifications-search`
Expected: FAIL sui test nuovi.

- [ ] **Step 4: Modulo e servizio**

`notifications-search.module.ts`: aggiungere `PostalPosteTracking` a `TypeOrmModule.forFeature([...])` (import da `'../entities/postal-poste-tracking.entity.js'`).

`notifications-search.service.ts`:
```ts
import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { posteDeliveredSql, toPosteVerificationDto } from '../channels/postal/poste-tracking/poste-tracking-effective.util.js';

export type PosteVerificationFilter = 'delivered' | 'returned' | 'pending' | 'gave_up' | 'any';
export const POSTE_VERIFICATION_FILTERS: readonly PosteVerificationFilter[] = ['delivered', 'returned', 'pending', 'gave_up', 'any'];
```
`SearchFilters`: aggiungere `posteVerification?: PosteVerificationFilter;`. `SearchRowDto`: aggiungere `posteVerificationStatus: string | null;`.

Costruttore, ultimo parametro:
```ts
    // @Optional: spec esistenti senza questo repo → nessuna info verifica Poste.
    @Optional() @InjectRepository(PostalPosteTracking)
    private readonly posteTrackingRepo?: Repository<PostalPosteTracking>,
```
In `search()`, dopo il filtro `dateTo`:
```ts
    if (filters.posteVerification) {
      const latestAttempt = 'na.attempt_number = (SELECT MAX(na2.attempt_number) FROM notification_attempts na2 WHERE na2.recipient_id = recipient.id)';
      if (filters.posteVerification === 'delivered') {
        // Discrepanza: stesso predicato del bucket ConsegnatoVerificaPoste.
        qb.andWhere(`EXISTS (SELECT 1 FROM notification_attempts na WHERE na.recipient_id = recipient.id AND ${latestAttempt} AND ${posteDeliveredSql('na')})`);
      } else {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM notification_attempts na JOIN postal_poste_tracking ppt2 ON ppt2.attempt_id = na.id WHERE na.recipient_id = recipient.id AND ${latestAttempt}${filters.posteVerification === 'any' ? '' : ' AND ppt2.status = :pv'})`,
          { pv: filters.posteVerification },
        );
      }
    }
```
Dopo `const [rows, total] = await qb.getManyAndCount();`:
```ts
    const posteByRecipient = await this.loadLatestPosteStatus(rows.map((r) => r.id));
```
e nel `rows.map`, aggiungere `posteVerificationStatus: posteByRecipient.get(r.id) ?? null,`.

Metodo privato:
```ts
  /** Stato verifica Poste dell'ultimo attempt per destinatario; delivered conta solo se GlobalCom è ancora NonConsegnato. */
  private async loadLatestPosteStatus(recipientIds: string[]): Promise<Map<string, string>> {
    if (!this.posteTrackingRepo || recipientIds.length === 0) return new Map();
    const rows: Array<{ recipientId: string; status: string | null; postalStatus: string | null }> = (await this.posteTrackingRepo.query(
      `SELECT DISTINCT ON (na.recipient_id) na.recipient_id AS "recipientId", ppt.status AS "status", na.postal_status AS "postalStatus"
       FROM notification_attempts na
       LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = na.id
       WHERE na.recipient_id = ANY($1::uuid[])
       ORDER BY na.recipient_id, na.attempt_number DESC`,
      [recipientIds],
    )) ?? [];
    const map = new Map<string, string>();
    for (const r of rows) {
      if (!r.status) continue;
      if (r.status === 'delivered' && r.postalStatus !== 'NonConsegnato') continue;
      map.set(r.recipientId, r.status);
    }
    return map;
  }
```
In `getDetail()`, dopo il caricamento di `attempts`:
```ts
    const posteRows = this.posteTrackingRepo
      ? ((await this.posteTrackingRepo.find({ where: { attemptId: In(attempts.filter((a) => a.channelType === 'POSTAL').map((a) => a.id)) } })) ?? [])
      : [];
    const posteByAttempt = new Map(posteRows.map((p) => [p.attemptId, p]));
```
e nell'oggetto attempt mappato, dopo `postalStatusHistory: a.postalStatusHistory ?? null,`:
```ts
            posteVerification: posteByAttempt.has(a.id) ? toPosteVerificationDto(posteByAttempt.get(a.id)!) : null,
```

`dto/notification-detail.dto.ts`: import `type PosteVerificationDto` da `'../../channels/postal/poste-tracking/poste-tracking-effective.util.js'` e aggiungere nel tipo attempt, dopo `postalStatusHistory`: `posteVerification?: PosteVerificationDto | null;`.

- [ ] **Step 5: Controller**

In `notifications-search.controller.ts` aggiungere parametro in coda a `search(...)`:
```ts
    @Query('posteVerification') posteVerification?: string,
```
e nell'oggetto passato a `this.svc.search`:
```ts
      posteVerification: POSTE_VERIFICATION_FILTERS.includes(posteVerification as PosteVerificationFilter) ? (posteVerification as PosteVerificationFilter) : undefined,
```
(import `POSTE_VERIFICATION_FILTERS, type PosteVerificationFilter` dal service).

- [ ] **Step 6: Test e type-check**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run notifications-search
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```
Expected: PASS, nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/notifications-search/
git commit -m "feat(search): filtro e dettaglio verifica Poste nella ricerca notifiche"
```

---

### Task 9: Frontend admin

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: bucket `ConsegnatoVerificaPoste` in `postal-delivery-status-breakdown` e `postalDeliveryStatuses` del filtro; campi `posteVerificationStatus`/`posteDeliveredAt` sulle righe destinatari; `posteVerification` sugli attempt del dettaglio; `posteVerificationStatus` sulle righe ricerca; endpoint di Task 4; setting `postalPosteTracking.enabled`.

Ancorarsi ai testi indicati (il file è ~18k righe, i numeri di riga cambiano).

- [ ] **Step 1: Registro stati**

In `POSTAL_DELIVERY_STATUS_META` (cercare `NonTracciato: { label: 'Non tracciato (nessuna AR)'`) aggiungere dopo `NonTracciato`:
```tsx
  ConsegnatoVerificaPoste: { label: 'Consegnato (verifica Poste)', badge: 'bg-success-subtle text-success-emphasis border border-success', icon: CheckCircle2 },
```
In `POSTAL_DELIVERY_STATUS_PIE_COLORS` (cercare `NonTracciato: '#adb5bd',`) aggiungere `ConsegnatoVerificaPoste: '#20c997',`.

Il filtro "Stato consegna" legge le opzioni dal backend: verificare con `grep -n "postalDeliveryStatuses" apps/frontend-admin/src/App.tsx` che l'etichetta dell'opzione passi da `POSTAL_DELIVERY_STATUS_META` (se usa un'altra mappa, aggiungere lì la stessa etichetta).

- [ ] **Step 2: Badge in tabella destinatari**

Subito dopo la funzione `PostalDeliveryStatusBadge` aggiungere:
```tsx
// GlobalCom NonConsegnato ma consegnato secondo il tracking Poste: badge
// dedicato con lo stato GlobalCom originale nel tooltip (la discrepanza
// resta visibile, vedi spec 2026-09-24-postal-verifica-poste-design.md).
function PostalDeliveryWithPosteBadge({ postalStatus, postalDeliveryStatus, postalDeliveryCode, posteVerificationStatus, posteDeliveredAt }: {
  postalStatus?: string | null;
  postalDeliveryStatus?: string | null;
  postalDeliveryCode?: number | null;
  posteVerificationStatus?: string | null;
  posteDeliveredAt?: string | null;
}): React.JSX.Element {
  if (postalStatus === 'NonConsegnato' && posteVerificationStatus === 'delivered') {
    const meta = POSTAL_DELIVERY_STATUS_META['ConsegnatoVerificaPoste']!;
    const Icon = meta.icon;
    const title = `GlobalCom: ${postalDeliveryStatus ?? 'Non consegnato'} — Poste: consegnato${posteDeliveredAt ? ` il ${new Date(posteDeliveredAt).toLocaleString('it-IT')}` : ''}`;
    return <span className={`badge ${meta.badge}`} title={title}><Icon className="me-1" size={14} />{meta.label}</span>;
  }
  return <PostalDeliveryStatusBadge status={postalDeliveryStatus} code={postalDeliveryCode} />;
}
```
Nel tipo di `recipientsPage` (cercare `const [recipientsPage, setRecipientsPage] = useState<`) aggiungere agli item: `posteVerificationStatus?: string | null; posteDeliveredAt?: string | null;`.
Sostituire le due occorrenze nella tabella destinatari
`<td className="small"><PostalDeliveryStatusBadge status={r.postalDeliveryStatus} code={r.postalDeliveryCode} /></td>` con
```tsx
<td className="small"><PostalDeliveryWithPosteBadge postalStatus={r.postalStatus} postalDeliveryStatus={r.postalDeliveryStatus} postalDeliveryCode={r.postalDeliveryCode} posteVerificationStatus={r.posteVerificationStatus} posteDeliveredAt={r.posteDeliveredAt} /></td>
```

- [ ] **Step 3: Dettaglio notifica — riquadro Verifica Poste**

Nel tipo `notifDetail` (cercare `attempts: Array<{ attemptNumber: number; status: string; channelType: string;`) aggiungere al tipo attempt:
```ts
posteVerification?: { status: 'pending' | 'delivered' | 'returned' | 'gave_up'; trackingCode: string; checkCount: number; maxChecks: number; nextCheckAt: string | null; lastCheckedAt: string | null; lastError: string | null; deliveredAt: string | null; movements: Array<{ at: string; luogo: string; statoLavorazione: string; box: string; flagRitorno: boolean }> } | null;
```
Stato accanto a `const [postalStatusRefreshing, setPostalStatusRefreshing] = useState(false);`:
```tsx
  const [posteChecking, setPosteChecking] = useState(false);
```
Handler accanto a `handleRefreshPostalStatus`:
```tsx
  const handlePosteCheckRecipient = async () => {
    if (!notifDetail) return;
    setPosteChecking(true);
    try {
      const res = await apiFetch(`/campaigns/${notifDetail.campaign.id}/recipients/${notifDetail.recipient.id}/postal/poste-check`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.message || 'Errore durante la verifica su Poste.');
        return;
      }
      await openNotificationDetail(notifDetail.recipient.id);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Errore durante la verifica su Poste.');
    } finally {
      setPosteChecking(false);
    }
  };
```
Nel dettaglio, subito dopo il blocco IIFE che rende il bottone `Ricontrolla stato GlobalCom` (chiusura `})()}` successiva al testo), aggiungere questo blocco (calcola da sé l'ultimo attempt POSTAL):
```tsx
{(() => {
  const lastPostal = [...notifDetail.attempts].filter(a => a.channelType === 'POSTAL').sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!lastPostal) return null;
  const pv = lastPostal.posteVerification;
  const canCheck = !!pv || (lastPostal.postalStatus === 'NonConsegnato' && !!lastPostal.postalAcceptanceId);
  if (!canCheck) return null;
  const statusLabel = !pv ? 'Non ancora verificata'
    : pv.status === 'delivered' ? `Consegnata${pv.deliveredAt ? ` il ${new Date(pv.deliveredAt).toLocaleString('it-IT')}` : ''}`
    : pv.status === 'returned' ? 'Restituita al mittente'
    : pv.status === 'gave_up' ? `Verifica esaurita (${pv.checkCount}/${pv.maxChecks})`
    : `In verifica (${pv.checkCount}/${pv.maxChecks})${pv.nextCheckAt ? ` — prossimo controllo ${new Date(pv.nextCheckAt).toLocaleString('it-IT')}` : ''}`;
  return (
    <div className="border rounded p-2 mt-2 small">
      <div className="d-flex align-items-center justify-content-between gap-2">
        <div>
          <span className="fw-semibold">Verifica Poste</span>{pv && <span className="text-muted ms-2">{pv.trackingCode}</span>}
          <div>{statusLabel}</div>
          {pv?.lastError && <div className="text-danger">Ultimo errore: {pv.lastError}</div>}
        </div>
        <button type="button" className="btn btn-sm btn-outline-secondary text-nowrap" disabled={posteChecking} onClick={handlePosteCheckRecipient}>
          {posteChecking ? <Loader2 className="icon-spin me-1" size={14} /> : <RefreshCw className="me-1" size={14} />}
          Verifica ora su Poste
        </button>
      </div>
      {pv && pv.movements.length > 0 && (
        <ul className="list-unstyled mb-0 mt-2">
          {pv.movements.map((m, i) => (
            <li key={i} className="text-muted">{m.at ? new Date(m.at).toLocaleString('it-IT') : '—'} · {m.luogo || '—'} · fase {m.box}{m.flagRitorno ? ' · ritorno al mittente' : ''}</li>
          ))}
        </ul>
      )}
    </div>
  );
})()}
```

- [ ] **Step 4: Tasto "Verifica su Poste" in campagna, con avanzamento**

Stato accanto a `const [postalErrorsResetting, setPostalErrorsResetting] = useState(false);`:
```tsx
  const [posteRun, setPosteRun] = useState<{ running: boolean; total: number; done: number; delivered: number; returned: number; errors: number; aborted: boolean } | null>(null);
```
Handler accanto a `handleResetPostalErrorsForRecheck`:
```tsx
  const handlePosteCheckCampaign = async () => {
    if (!campaign) return;
    const campaignId = campaign.id;
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/postal/poste-check`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.message || 'Errore durante l\'avvio della verifica su Poste.');
        return;
      }
      const { total } = await res.json();
      if (total === 0) {
        alert('Nessuna notifica Non consegnata da verificare su Poste.');
        return;
      }
      setPosteRun({ running: true, total, done: 0, delivered: 0, returned: 0, errors: 0, aborted: false });
      const timer = setInterval(async () => {
        try {
          const r = await apiFetch(`/campaigns/${campaignId}/postal/poste-check`);
          if (!r.ok) return;
          const state = await r.json();
          setPosteRun(state);
          if (!state.running) {
            clearInterval(timer);
            alert(`Verifica su Poste completata: ${state.delivered} consegnate secondo Poste, ${state.returned} restituite, ${state.errors} errori${state.aborted ? ' (interrotta: troppi errori consecutivi da Poste)' : ''}.`);
            setPosteRun(null);
            fetchCampaignDetail(campaignId);
            fetchRecipientsPage(campaignId);
            fetchPostalDeliveryStatusBreakdown(campaignId);
          }
        } catch {
          // Tick saltato: riprova al prossimo.
        }
      }, 3000);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Errore durante l\'avvio della verifica su Poste.');
    }
  };
```
Se `fetchRecipientsFilterOptions` esiste (`grep -n "const fetchRecipientsFilterOptions" App.tsx`), chiamarlo anche nel ramo di fine run con `campaignId`.

Visibilità: il bottone appare solo se la campagna ha almeno una notifica `NonConsegnato`. Verificare con `grep -n "const \[postalStatusBreakdown" App.tsx` la forma dello stato (array `{ status, count }`) e usare:
```tsx
{(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType === 'POSTAL' && (postalStatusBreakdown ?? []).some(b => b.status === 'NonConsegnato' && b.count > 0) && (
  <button
    className="btn btn-sm d-inline-flex align-items-center text-nowrap btn-outline-success"
    disabled={!!posteRun?.running}
    onClick={handlePosteCheckCampaign}
    title="Controlla subito sul tracking di Poste Italiane le raccomandate che GlobalCom dà come Non consegnate (il postino può aver consegnato in un secondo passaggio). Lanciabile a qualsiasi ora, oltre al controllo automatico giornaliero."
  >
    {posteRun?.running ? <Loader2 className="icon-spin me-1" size={14} /> : <Truck className="me-1" size={14} />}
    {posteRun?.running ? `Verifica su Poste ${posteRun.done}/${posteRun.total}` : 'Verifica su Poste'}
  </button>
)}
```
inserito subito dopo il bottone `Riattiva errori GlobalCom` (cercare il testo) e prima del bottone di refresh.

- [ ] **Step 5: Ricerca globale — filtro e badge**

Stato accanto a `const [searchStatus, setSearchStatus] = useState('');`:
```tsx
  const [searchPosteVerification, setSearchPosteVerification] = useState('');
```
In `runNotificationSearch`, dopo `if (searchStatus) params.set('status', searchStatus);`:
```tsx
      if (searchPosteVerification) params.set('posteVerification', searchPosteVerification);
```
Dopo il `<select id="ns-status" ...>` e il suo contenitore (stessa struttura markup del filtro stato, copiare wrapper e label), aggiungere:
```tsx
<select id="ns-poste" className="form-select form-select-sm" value={searchPosteVerification} onChange={e => setSearchPosteVerification(e.target.value)}>
  <option value="">Verifica Poste: tutte</option>
  <option value="delivered">Consegnate secondo Poste (discrepanza GlobalCom)</option>
  <option value="returned">Restituite al mittente</option>
  <option value="pending">In verifica</option>
  <option value="gave_up">Verifica esaurita</option>
  <option value="any">Con qualunque verifica Poste</option>
</select>
```
con label `Verifica Poste` (`htmlFor="ns-poste"`). Nel tipo delle righe di `searchResults` aggiungere `posteVerificationStatus?: string | null;` e, nella cella dello stato di ogni riga (`searchResults.map(r => (` → cella che mostra `r.status`), aggiungere dopo il badge esistente:
```tsx
{r.posteVerificationStatus === 'delivered' && <span className="badge bg-success-subtle text-success-emphasis border border-success ms-1" title="GlobalCom: Non consegnato — Poste: consegnato">Consegnato (verifica Poste)</span>}
{r.posteVerificationStatus === 'returned' && <span className="badge bg-secondary-subtle text-secondary-emphasis border ms-1">Poste: restituita</span>}
{(r.posteVerificationStatus === 'pending' || r.posteVerificationStatus === 'gave_up') && <span className="badge bg-light text-dark border ms-1">{r.posteVerificationStatus === 'pending' ? 'Poste: in verifica' : 'Poste: verifica esaurita'}</span>}
```

- [ ] **Step 6: Impostazioni → Postalizzazione — toggle**

Stato accanto a `const [settInadCheckEnabled, setSettInadCheckEnabled] = useState(false);`:
```tsx
  const [settPostalPosteTrackingEnabled, setSettPostalPosteTrackingEnabled] = useState(true);
```
Nel caricamento settings, accanto a `setSettInadCheckEnabled(Boolean(s['inad.checkEnabled']));`:
```tsx
        setSettPostalPosteTrackingEnabled(s['postalPosteTracking.enabled'] !== false);
```
Nel payload di salvataggio, accanto a `'inad.checkEnabled': settInadCheckEnabled,`:
```tsx
    'postalPosteTracking.enabled': settPostalPosteTrackingEnabled,
```
In `renderPostalProvidersTab` (cercare `const renderPostalProvidersTab`), in cima al contenuto renderizzato, aggiungere:
```tsx
<div className="form-check form-switch mb-3">
  <input className="form-check-input" type="checkbox" role="switch" id="postal_poste_tracking_enabled"
    checked={settPostalPosteTrackingEnabled} onChange={(e) => setSettPostalPosteTrackingEnabled(e.target.checked)} />
  <label className="form-check-label small fw-semibold" htmlFor="postal_poste_tracking_enabled">
    Verifica consegna su tracking Poste Italiane per le raccomandate che GlobalCom dà come Non consegnate (controllo giornaliero, max 90 giorni)
  </label>
</div>
```
Verificare che il tab Postalizzazione abbia accesso al bottone "Salva Impostazioni" che invia quel payload (`grep -n "Salva Impostazioni" App.tsx`); se il bottone non è visibile su quel tab, riportarlo nel report invece di aggiungerne uno nuovo.

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): UI verifica consegna su tracking Poste"
```

---

### Task 10: Documentazione e verifica end-to-end in dev

**Files:**
- Modify: `docs/claude/postal-globalcom.md`

- [ ] **Step 1: Nota in `docs/claude/postal-globalcom.md`**

Aggiungere in coda:
```markdown
**Verifica consegna su tracking Poste (`channels/postal/poste-tracking/`)**:
GlobalCom smette di tracciare al primo `NonConsegnato` (es. "Indirizzo
errato o inesatto"), ma Poste può consegnare giorni dopo (caso reale
verificato: KO GlobalCom al 12/08, consegna Poste al 04/09). Cron giornaliero
04:00 + tasto campagna/notifica interrogano l'endpoint JSON pubblico e NON
documentato di "Cerca spedizioni" (`POST
https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice`, body
`{"tipoRichiedente":"WEB","codiceSpedizione":"<IDAccettazione>","periodoRicerca":1}`)
con `postal_acceptance_id`. Risultato in `postal_poste_tracking`, mai nei
campi `postal_*`. Solo `esitoRicerca "3"` + `stato "5"` senza `flagRitorno`
è mappato a consegnato (unico caso verificato); ogni altro valore resta
`pending` con risposta grezza in `last_response` — per allargare la
mappatura, leggere quelle righe reali prima di ipotizzare. Codici a 10 cifre
(vettori diversi da Poste) tornano `esitoRicerca "1"`: mai tracciabili,
finiscono `gave_up` dopo 90 giorni. `statoLavorazione` è un frammento
("in data"): l'etichetta completa la compone il frontend poste.it da
`box`. Kill-switch: `postalPosteTracking.enabled`. Endpoint che cambia →
circuit breaker (5 errori consecutivi), nessuna riga marcata finale per
errori.
```

- [ ] **Step 2: Suite completa e type-check**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: unico fallimento = baseline nota (`app.controller.spec.ts` › `isLdapMock`); tsc puliti.

- [ ] **Step 3: Verifica runtime in dev**

```bash
docker compose restart backend
docker compose ps
```
Poi, con il token admin dello snippet di CLAUDE.md, via `docker compose exec backend node -e "..."` con `fetch`:
1. `GET http://localhost:8080/admin/campaigns/<id campagna POSTAL dev>/postal/poste-check` → `{ running: false, total: 0, ... }`.
2. Se il DB dev ha un attempt `NonConsegnato` con `postal_acceptance_id`: `POST .../postal/poste-check` → `202 { total: N }`, poi GET ripetuti fino a `running: false`, poi `docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "select status, check_count, poste_stato, delivered_at, last_error from postal_poste_tracking;"`.
3. Se non ce n'è: creare una riga di test su un attempt POSTAL dev esistente **solo con consenso dell'utente** (è una modifica ai dati dev), impostandone `postal_status='NonConsegnato'` e un `postal_acceptance_id` reale fornito dall'utente in conversazione; mai committare il codice.
4. Aprire la campagna nel frontend (http://localhost:3000): bottone "Verifica su Poste", badge "Consegnato (verifica Poste)", filtro "Stato consegna", CSV attuale/storico con le 4 colonne, dettaglio notifica con riquadro Verifica Poste, ricerca globale con filtro "Verifica Poste".

- [ ] **Step 4: Commit**

```bash
git add docs/claude/postal-globalcom.md
git commit -m "docs(postal): note verifica consegna su tracking Poste"
```
