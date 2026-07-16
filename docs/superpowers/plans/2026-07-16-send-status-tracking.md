# Tracking avanzamento SEND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Barra impilata stato SEND (11 stati PN) nel dettaglio campagna + 2 CSV dedicati (Attuale/Storico) con IUN, domicilio digitale, storico date per stato ed esito App IO, al posto del report generico "download".

**Architecture:** Il sync esistente (`send-status-sync.service.ts`) viene esteso per salvare, oltre allo stato corrente, lo storico completo (`notificationStatusHistory`) e il domicilio digitale (estratto da `timeline`) che PN restituisce già nella stessa risposta HTTP — nessuna chiamata aggiuntiva. Backend espone un endpoint di aggregazione per la barra e due endpoint CSV. Frontend aggiunge una barra a segmenti (riusa i colori/label già esistenti in `SEND_STATUS_META`) e due bottoni di export al posto di uno.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 (frontend-admin), Jest per i test backend.

## Global Constraints

- Delimitatore placeholder/template non pertinente qui (nessun template coinvolto).
- Test backend SEMPRE con `--maxWorkers=2` (limite RAM WSL2 documentato in CLAUDE.md).
- Nessuna nuova `<form>` annidata (non applicabile: nessun form qui).
- Query TypeORM: MAI `leftJoinAndSelect` + `orderBy` + `take` sulla stessa query (bug noto TypeORM 0.3.30) — usare due query separate come già fa `getRecipientStats`.
- Date CSV formattate `it-IT` / `Europe/Rome`, campi CSV sempre passati da `escapeCsvField` (previene formula injection).
- Migration DB: mai `synchronize` in prod, va scritta a mano e registrata in `database.module.ts`.

---

## File Structure

- **Modifica** `apps/backend/src/entities/notification-attempt.entity.ts` — 2 nuove colonne jsonb.
- **Crea** `apps/backend/src/database/migrations/1784500000000-AddSendStatusHistoryColumns.ts` — migration.
- **Modifica** `apps/backend/src/database/database.module.ts` — registra la migration.
- **Crea** `apps/backend/src/channels/send/send-status-history.util.ts` — parsing puro della risposta PN (history + domicilio digitale), testabile in isolamento.
- **Modifica** `apps/backend/src/channels/send/send-status-sync.service.ts` — usa il parsing util, salva le 2 colonne.
- **Crea** `apps/backend/src/campaigns/send-status-labels.util.ts` — label italiane stato/domicilio + elenco ordinato colonne storico (mirror di `SEND_STATUS_META` frontend).
- **Modifica** `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` — nuovi DTO (`SendStatusBreakdownDto`, `SendReportRowDto`, `SendReportDto`).
- **Crea** `apps/backend/src/campaigns/send-report-csv.util.ts` — 2 CSV builder (attuale/storico).
- **Modifica** `apps/backend/src/campaigns/campaigns.service.ts` — `getSendStatusBreakdown()` + `getSendReportRows()`.
- **Modifica** `apps/backend/src/campaigns/campaigns.controller.ts` — 3 nuovi endpoint.
- **Modifica** `apps/frontend-admin/src/App.tsx` — componente `SendStatusBar`, fetch breakdown, sostituzione blocco "Progressione SEND" solo per SEND, 2 bottoni export al posto di 1.

---

### Task 1: Migration + entity — colonne storico stato e domicilio digitale

**Files:**
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts:49-53`
- Create: `apps/backend/src/database/migrations/1784500000000-AddSendStatusHistoryColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts:24,43`

**Interfaces:**
- Produces: `NotificationAttempt.sendStatusHistory: Array<{ status: string; activeFrom: string }> | null`, `NotificationAttempt.sendDigitalDomicile: { type: string; address: string | null; source: string } | null` — usati da Task 3, 6, 7.

- [ ] **Step 1: Aggiungi le colonne all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, subito dopo il campo `sendStatusUpdatedAt` (riga 53), aggiungi:

```typescript
  @Column({ type: 'jsonb', name: 'send_status_history', nullable: true })
  sendStatusHistory!: Array<{ status: string; activeFrom: string }> | null;

  @Column({ type: 'jsonb', name: 'send_digital_domicile', nullable: true })
  sendDigitalDomicile!: { type: string; address: string | null; source: string } | null;
```

- [ ] **Step 2: Scrivi la migration**

Crea `apps/backend/src/database/migrations/1784500000000-AddSendStatusHistoryColumns.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSendStatusHistoryColumns1784500000000 implements MigrationInterface {
    name = 'AddSendStatusHistoryColumns1784500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_status_history" jsonb`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "send_digital_domicile" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_digital_domicile"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "send_status_history"`);
    }
}
```

- [ ] **Step 3: Registra la migration in `database.module.ts`**

Aggiungi l'import dopo la riga 29 (`SeedStandardTemplates1784400000000`):

```typescript
import { AddSendStatusHistoryColumns1784500000000 } from './migrations/1784500000000-AddSendStatusHistoryColumns';
```

E aggiungi `AddSendStatusHistoryColumns1784500000000` in fondo all'array `migrations:` alla riga 43.

- [ ] **Step 4: Verifica tsc**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Genera/verifica la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_send;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_send" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_send;"
```

Expected: la migration `AddSendStatusHistoryColumns1784500000000` esegue senza errori.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/1784500000000-AddSendStatusHistoryColumns.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiungi colonne storico stato e domicilio digitale SEND"
```

---

### Task 2: Parsing puro risposta PN (storico stati + domicilio digitale)

**Files:**
- Create: `apps/backend/src/channels/send/send-status-history.util.ts`
- Test: `apps/backend/src/channels/send/send-status-history.util.spec.ts`

**Interfaces:**
- Consumes: nessuno (funzioni pure su JSON generico).
- Produces: `extractSendStatusHistory(data: unknown): Array<{ status: string; activeFrom: string }>`, `extractSendDigitalDomicile(data: unknown): { type: string; address: string | null; source: string } | null` — usati da Task 3.

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/channels/send/send-status-history.util.spec.ts`:

```typescript
import { extractSendStatusHistory, extractSendDigitalDomicile } from './send-status-history.util';

describe('extractSendStatusHistory', () => {
  it('mappa notificationStatusHistory in {status, activeFrom}', () => {
    const data = {
      notificationStatusHistory: [
        { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z', relatedTimelineElements: ['el-1'] },
        { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z', relatedTimelineElements: ['el-2'] },
      ],
    };
    expect(extractSendStatusHistory(data)).toEqual([
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ]);
  });

  it('ritorna array vuoto se notificationStatusHistory è assente', () => {
    expect(extractSendStatusHistory({})).toEqual([]);
  });
});

describe('extractSendDigitalDomicile', () => {
  it('estrae domicilio digitale da evento SEND_DIGITAL_DOMICILE', () => {
    const data = {
      timeline: [
        { category: 'PREPARE_DIGITAL_DOMICILE', details: {} },
        {
          category: 'SEND_DIGITAL_DOMICILE',
          details: {
            digitalAddress: { type: 'PEC', address: 'mario.rossi@pec.it' },
            digitalAddressSource: 'PLATFORM',
          },
        },
      ],
    };
    expect(extractSendDigitalDomicile(data)).toEqual({ type: 'PEC', address: 'mario.rossi@pec.it', source: 'PLATFORM' });
  });

  it('un evento SEND_ANALOG_DOMICILE successivo (fallback cartaceo) sovrascrive il digitale precedente', () => {
    const data = {
      timeline: [
        {
          category: 'SEND_DIGITAL_DOMICILE',
          details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' }, digitalAddressSource: 'PLATFORM' },
        },
        { category: 'SEND_ANALOG_DOMICILE', details: {} },
      ],
    };
    expect(extractSendDigitalDomicile(data)).toEqual({ type: 'CARTACEO', address: null, source: 'ANALOG' });
  });

  it('ritorna null se timeline è assente o senza eventi di domicilio', () => {
    expect(extractSendDigitalDomicile({})).toBeNull();
    expect(extractSendDigitalDomicile({ timeline: [{ category: 'SEND_DIGITAL_FEEDBACK', details: {} }] })).toBeNull();
  });
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send-status-history --maxWorkers=2`
Expected: FAIL con "Cannot find module './send-status-history.util'"

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/channels/send/send-status-history.util.ts`:

```typescript
export interface SendStatusHistoryEntry {
  status: string;
  activeFrom: string;
}

export interface SendDigitalDomicile {
  type: string;
  address: string | null;
  source: string;
}

/**
 * Copia diretta di notificationStatusHistory da PN (già completo e
 * ordinato cronologicamente) — nessun merge incrementale, overwrite
 * intero ad ogni poll.
 */
export function extractSendStatusHistory(data: unknown): SendStatusHistoryEntry[] {
  const history = (data as { notificationStatusHistory?: unknown })?.notificationStatusHistory;
  if (!Array.isArray(history)) return [];
  return history.map((h: any) => ({ status: h.status, activeFrom: h.activeFrom }));
}

/**
 * Estrae il domicilio digitale (o il fallback cartaceo) dall'evento più
 * recente della timeline: un SEND_ANALOG_DOMICILE successivo a un
 * SEND_DIGITAL_DOMICILE rappresenta un fallback cartaceo e vince, essendo
 * l'ultimo tentativo di recapito effettivamente scelto da PN.
 */
export function extractSendDigitalDomicile(data: unknown): SendDigitalDomicile | null {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return null;

  let result: SendDigitalDomicile | null = null;
  for (const el of timeline as any[]) {
    if (el?.category === 'SEND_DIGITAL_DOMICILE' && el?.details?.digitalAddress) {
      result = {
        type: el.details.digitalAddress.type ?? null,
        address: el.details.digitalAddress.address ?? null,
        source: el.details.digitalAddressSource ?? null,
      };
    } else if (el?.category === 'SEND_ANALOG_DOMICILE') {
      result = { type: 'CARTACEO', address: null, source: 'ANALOG' };
    }
  }
  return result;
}
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-status-history --maxWorkers=2`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/send/send-status-history.util.ts apps/backend/src/channels/send/send-status-history.util.spec.ts
git commit -m "feat(backend): parsing storico stato e domicilio digitale da risposta PN"
```

---

### Task 3: Estendi il sync per persistere storico e domicilio

**Files:**
- Modify: `apps/backend/src/channels/send/send-status-sync.service.ts:94-128`
- Test: `apps/backend/src/channels/send/send-status-sync.service.spec.ts:115-133`

**Interfaces:**
- Consumes: `extractSendStatusHistory`, `extractSendDigitalDomicile` da Task 2; `NotificationAttempt.sendStatusHistory`/`sendDigitalDomicile` da Task 1.
- Produces: nessuna nuova interfaccia pubblica — comportamento interno del cron.

- [ ] **Step 1: Estendi il test esistente per verificare il nuovo salvataggio**

In `apps/backend/src/channels/send/send-status-sync.service.spec.ts`, sostituisci il test `'updateStatuses: aggiorna sendStatus da GET notifications/sent/{iun}'` (righe 115-133) con:

```typescript
  it('updateStatuses: aggiorna sendStatus, storico e domicilio digitale da GET notifications/sent/{iun}', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED' };
    const qb = makeQueryBuilder([attempt]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        notificationStatus: 'DELIVERED',
        notificationStatusHistory: [
          { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
          { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
        ],
        timeline: [
          { category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' }, digitalAddressSource: 'PLATFORM' } },
        ],
      })),
    });

    await service.updateStatuses();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.9/notifications/sent/IUN-123',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.sendStatus).toBe('DELIVERED');
    expect(attempt.sendStatusHistory).toEqual([
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ]);
    expect(attempt.sendDigitalDomicile).toEqual({ type: 'PEC', address: 'x@pec.it', source: 'PLATFORM' });
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
    expect(qb.orderBy).toHaveBeenCalledWith('attempt.created_at', 'ASC');
  });
```

- [ ] **Step 2: Esegui il test, verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest send-status-sync.service --maxWorkers=2`
Expected: FAIL su `attempt.sendStatusHistory` undefined (non ancora settato dal service).

- [ ] **Step 3: Implementa la modifica al service**

In `apps/backend/src/channels/send/send-status-sync.service.ts`, aggiungi l'import in cima al file (dopo la riga 8):

```typescript
import { extractSendStatusHistory, extractSendDigitalDomicile } from './send-status-history.util';
```

Sostituisci il blocco `updateStatuses()` (righe 94-128) con:

```typescript
  async updateStatuses(): Promise<void> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NOT NULL')
      .andWhere('(attempt.send_status IS NULL OR attempt.send_status NOT IN (:...terminal))', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${attempt.iun}`, {
          headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Aggiornamento stato SEND IUN ${attempt.iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationStatus: string };
        if (data.notificationStatus && data.notificationStatus !== attempt.sendStatus) {
          attempt.sendStatus = data.notificationStatus;
          attempt.sendStatusUpdatedAt = new Date();
          attempt.sendStatusHistory = extractSendStatusHistory(data);
          attempt.sendDigitalDomicile = extractSendDigitalDomicile(data);
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato SEND IUN ${attempt.iun}: ${err.message}`);
      }
    }
  }
```

- [ ] **Step 4: Esegui tutti i test del service, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-status-sync.service --maxWorkers=2`
Expected: PASS (tutti i test, incluso quello invariato `'non salva se lo stato non è cambiato'`)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/send/send-status-sync.service.ts apps/backend/src/channels/send/send-status-sync.service.spec.ts
git commit -m "feat(backend): persisti storico stato e domicilio digitale nel sync SEND"
```

---

### Task 4: Label italiane stato/domicilio + colonne storico

**Files:**
- Create: `apps/backend/src/campaigns/send-status-labels.util.ts`
- Test: `apps/backend/src/campaigns/send-status-labels.util.spec.ts`

**Interfaces:**
- Produces: `sendStatusLabel(status: string | null): string`, `digitalDomicileTypeLabel(type: string | null): string`, `SEND_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }>` — usati da Task 6 (CSV builder).

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/campaigns/send-status-labels.util.spec.ts`:

```typescript
import { sendStatusLabel, digitalDomicileTypeLabel, SEND_STATUS_HISTORY_COLUMNS } from './send-status-labels.util';

describe('sendStatusLabel', () => {
  it('traduce uno stato PN noto', () => {
    expect(sendStatusLabel('VIEWED')).toBe('Letta dal destinatario');
  });
  it('ritorna "In attesa accettazione" per null', () => {
    expect(sendStatusLabel(null)).toBe('In attesa accettazione');
  });
  it('ritorna il valore grezzo per uno stato non mappato', () => {
    expect(sendStatusLabel('NUOVO_STATO_MAI_VISTO')).toBe('NUOVO_STATO_MAI_VISTO');
  });
});

describe('digitalDomicileTypeLabel', () => {
  it('traduce PEC', () => {
    expect(digitalDomicileTypeLabel('PEC')).toBe('PEC');
  });
  it('traduce APPIO in "App IO"', () => {
    expect(digitalDomicileTypeLabel('APPIO')).toBe('App IO');
  });
  it('traduce CARTACEO in "Raccomandata cartacea"', () => {
    expect(digitalDomicileTypeLabel('CARTACEO')).toBe('Raccomandata cartacea');
  });
  it('ritorna stringa vuota per null', () => {
    expect(digitalDomicileTypeLabel(null)).toBe('');
  });
});

describe('SEND_STATUS_HISTORY_COLUMNS', () => {
  it('contiene 10 colonne, PAID escluso', () => {
    expect(SEND_STATUS_HISTORY_COLUMNS).toHaveLength(10);
    expect(SEND_STATUS_HISTORY_COLUMNS.find((c) => c.status === 'PAID')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send-status-labels --maxWorkers=2`
Expected: FAIL con "Cannot find module './send-status-labels.util'"

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/campaigns/send-status-labels.util.ts`:

```typescript
/**
 * Mirror backend delle label italiane già in SEND_STATUS_META
 * (apps/frontend-admin/src/App.tsx) — stesse 10 chiavi (PAID escluso,
 * deprecato in NotificationStatusV26).
 */
const SEND_STATUS_LABELS: Record<string, string> = {
  IN_VALIDATION: 'In validazione',
  ACCEPTED: 'Accettata da SEND',
  REFUSED: 'Rifiutata',
  DELIVERING: 'In consegna',
  DELIVERED: 'Consegnata',
  VIEWED: 'Letta dal destinatario',
  EFFECTIVE_DATE: 'Perfezionata per decorrenza termini',
  UNREACHABLE: 'Destinatario irreperibile',
  CANCELLED: 'Annullata',
  RETURNED_TO_SENDER: 'Restituita al mittente',
};

export function sendStatusLabel(status: string | null): string {
  if (!status) return 'In attesa accettazione';
  return SEND_STATUS_LABELS[status] ?? status;
}

const DIGITAL_DOMICILE_TYPE_LABELS: Record<string, string> = {
  PEC: 'PEC',
  REM: 'REM',
  SERCQ: 'SERCQ',
  SMS: 'SMS',
  EMAIL: 'Email',
  APPIO: 'App IO',
  CARTACEO: 'Raccomandata cartacea',
};

export function digitalDomicileTypeLabel(type: string | null): string {
  if (!type) return '';
  return DIGITAL_DOMICILE_TYPE_LABELS[type] ?? type;
}

/** Ordine e intestazioni delle colonne data per il CSV "Storico" (PAID escluso, deprecato). */
export const SEND_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }> = [
  { status: 'IN_VALIDATION', header: 'Data In Validazione' },
  { status: 'ACCEPTED', header: 'Data Accettazione' },
  { status: 'REFUSED', header: 'Data Rifiuto' },
  { status: 'DELIVERING', header: 'Data In Consegna' },
  { status: 'DELIVERED', header: 'Data Consegna' },
  { status: 'VIEWED', header: 'Data Visualizzazione' },
  { status: 'EFFECTIVE_DATE', header: 'Data Perfezionamento' },
  { status: 'UNREACHABLE', header: 'Data Irreperibilità' },
  { status: 'CANCELLED', header: 'Data Annullamento' },
  { status: 'RETURNED_TO_SENDER', header: 'Data Restituzione al Mittente' },
];
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-status-labels --maxWorkers=2`
Expected: PASS (7 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/send-status-labels.util.ts apps/backend/src/campaigns/send-status-labels.util.spec.ts
git commit -m "feat(backend): label italiane stato SEND e domicilio digitale"
```

---

### Task 5: DTO backend per breakdown e report

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`

**Interfaces:**
- Produces: `SendStatusBreakdownDto`, `SendReportRowDto`, `SendReportDto` — usati da Task 6 (service) e Task 7 (CSV builder).

- [ ] **Step 1: Aggiungi i nuovi DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, aggiungi in fondo al file (dopo `DownloadReportRowDto`, riga 98):

```typescript

export interface SendStatusBreakdownDto {
  /** null = attempt non ancora sincronizzato/IUN non risolto ("In attesa"). */
  status: string | null;
  count: number;
}

export interface SendReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  iun: string | null;
  digitalDomicileType: string | null;
  digitalDomicileAddress: string | null;
  sendStatus: string | null;
  sendStatusHistory: Array<{ status: string; activeFrom: string }>;
  /** null se la campagna non ha co-consegna App IO configurata. */
  appIoOutcome: { success: boolean; error: string | null } | null;
}

export interface SendReportDto {
  /** Determina se i CSV builder devono includere la colonna "Esito App IO". */
  hasAppIoCoDelivery: boolean;
  rows: SendReportRowDto[];
}
```

- [ ] **Step 2: Verifica tsc**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (nessun consumatore ancora, solo tipi aggiunti).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts
git commit -m "feat(backend): DTO breakdown stato SEND e report CSV"
```

---

### Task 6: Service — breakdown e righe report

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `SendStatusBreakdownDto`, `SendReportDto`, `SendReportRowDto` (Task 5); `resolveSecondaryAppIoConfig` (già importato in `campaigns.service.ts:25`); `NotificationAttempt.sendStatusHistory`/`sendDigitalDomicile` (Task 1).
- Produces: `CampaignsService.getSendStatusBreakdown(campaignId: string): Promise<SendStatusBreakdownDto[]>`, `CampaignsService.getSendReportRows(campaignId: string): Promise<SendReportDto>` — usati da Task 8 (controller).

- [ ] **Step 1: Leggi il pattern esistente di test per il service**

Apri `apps/backend/src/campaigns/campaigns.service.spec.ts` e cerca un test esistente su `getRecipientStats` o `getChannelBreakdown` per copiare l'impostazione dei mock repo (`campaignRepo`, `recipientRepo`, `attemptRepo`) — usa lo stesso stile in questo task.

- [ ] **Step 2: Scrivi i test falliti**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```typescript
  describe('getSendStatusBreakdown', () => {
    it('conta i destinatari per ultimo sendStatus rilevato, un solo conteggio per destinatario', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
      recipientRepo.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      attemptRepo.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, sendStatus: 'ACCEPTED' },
        { recipientId: 'r1', attemptNumber: 2, sendStatus: 'DELIVERED' },
        { recipientId: 'r2', attemptNumber: 1, sendStatus: 'DELIVERED' },
      ]);

      const result = await service.getSendStatusBreakdown('c1');

      expect(result).toEqual(expect.arrayContaining([{ status: 'DELIVERED', count: 2 }]));
      expect(result).toHaveLength(1);
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepo.findOneBy.mockResolvedValue(null);
      await expect(service.getSendStatusBreakdown('missing')).rejects.toThrow('Campaign missing not found');
    });
  });

  describe('getSendReportRows', () => {
    it('proietta IUN, domicilio digitale e storico dall\'ultimo attempt per destinatario', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: {} });
      recipientRepo.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepo.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, iun: 'IUN-1', sendStatus: 'DELIVERED',
          sendStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' }],
          sendDigitalDomicile: { type: 'PEC', address: 'x@pec.it', source: 'PLATFORM' },
          responsePayload: {},
        },
      ]);

      const result = await service.getSendReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(false);
      expect(result.rows).toEqual([{
        codiceFiscale: 'RSSMRA80A01H501U',
        fullName: 'Mario Rossi',
        iun: 'IUN-1',
        digitalDomicileType: 'PEC',
        digitalDomicileAddress: 'x@pec.it',
        sendStatus: 'DELIVERED',
        sendStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' }],
        appIoOutcome: null,
      }]);
    });

    it('include appIoOutcome solo se la campagna ha co-consegna App IO configurata', async () => {
      campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel' }] } });
      recipientRepo.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepo.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, iun: 'IUN-1', sendStatus: 'DELIVERED',
          sendStatusHistory: [], sendDigitalDomicile: null,
          responsePayload: { appIo: { success: true } },
        },
      ]);

      const result = await service.getSendReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(true);
      expect(result.rows[0].appIoOutcome).toEqual({ success: true, error: null });
    });
  });
```

- [ ] **Step 3: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL con "service.getSendStatusBreakdown is not a function"

- [ ] **Step 4: Implementa i due metodi**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi subito dopo `getDownloadReportRows` (dopo la riga 1085, prima di `assertDraftForAttachments`):

```typescript
  async getSendStatusBreakdown(campaignId: string): Promise<SendStatusBreakdownDto[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return [];

    // Stesso pattern di getRecipientStats: due query separate invece di
    // leftJoinAndSelect (bug TypeORM con orderBy+take su relazione per
    // stringa), riduzione "ultimo attempt per destinatario" in JS.
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
      select: ['recipientId', 'attemptNumber', 'sendStatus'],
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
    }

    const counts = new Map<string | null, number>();
    for (const a of latestByRecipient.values()) {
      counts.set(a.sendStatus, (counts.get(a.sendStatus) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  async getSendReportRows(campaignId: string): Promise<SendReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, rows: [] };

    const recipientIds = recipients.map((r) => r.id);
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    const firstByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
      // Segnale App IO esiste solo sul primo tentativo (mai ritentato),
      // stesso vincolo già documentato in getChannelBreakdown().
      if (a.attemptNumber === 1) firstByRecipient.set(a.recipientId, a);
    }

    const hasAppIoCoDelivery = !!resolveSecondaryAppIoConfig(campaign.channelConfig);

    const rows: SendReportRowDto[] = recipients.map((r) => {
      const latest = latestByRecipient.get(r.id);
      const first = firstByRecipient.get(r.id);
      const appIo = hasAppIoCoDelivery
        ? ((first?.responsePayload as Record<string, unknown> | undefined)?.['appIo'] as { success?: boolean; error?: string } | undefined)
        : undefined;

      return {
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        iun: latest?.iun ?? null,
        digitalDomicileType: latest?.sendDigitalDomicile?.type ?? null,
        digitalDomicileAddress: latest?.sendDigitalDomicile?.address ?? null,
        sendStatus: latest?.sendStatus ?? null,
        sendStatusHistory: latest?.sendStatusHistory ?? [],
        appIoOutcome: appIo ? { success: !!appIo.success, error: appIo.error ?? null } : null,
      };
    });

    return { hasAppIoCoDelivery, rows };
  }
```

Aggiungi l'import dei nuovi DTO in cima al file, nella stessa riga/blocco che già importa `DownloadReportRowDto` da `./dto/campaign-stats.dto` (cerca `from './dto/campaign-stats.dto'` in cima al file e aggiungi `SendStatusBreakdownDto, SendReportDto, SendReportRowDto` all'elenco importato).

- [ ] **Step 5: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS (4 nuovi test + tutti i preesistenti)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): getSendStatusBreakdown e getSendReportRows"
```

---

### Task 7: CSV builder (Attuale/Storico)

**Files:**
- Create: `apps/backend/src/campaigns/send-report-csv.util.ts`
- Test: `apps/backend/src/campaigns/send-report-csv.util.spec.ts`

**Interfaces:**
- Consumes: `SendReportDto`, `SendReportRowDto` (Task 5); `sendStatusLabel`, `digitalDomicileTypeLabel`, `SEND_STATUS_HISTORY_COLUMNS` (Task 4); `escapeCsvField` (`apps/backend/src/campaigns/csv.util.ts:6`).
- Produces: `buildSendReportAttualeCsv(report: SendReportDto): string`, `buildSendReportStoricoCsv(report: SendReportDto): string` — usati da Task 8 (controller).

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/campaigns/send-report-csv.util.spec.ts`:

```typescript
import { buildSendReportAttualeCsv, buildSendReportStoricoCsv } from './send-report-csv.util';
import type { SendReportDto } from './dto/campaign-stats.dto';

const baseReport: SendReportDto = {
  hasAppIoCoDelivery: false,
  rows: [{
    codiceFiscale: 'RSSMRA80A01H501U',
    fullName: 'Mario Rossi',
    iun: 'IUN-1',
    digitalDomicileType: 'PEC',
    digitalDomicileAddress: 'mario@pec.it',
    sendStatus: 'DELIVERED',
    sendStatusHistory: [
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ],
    appIoOutcome: null,
  }],
};

describe('buildSendReportAttualeCsv', () => {
  it('include intestazioni e riga con stato/data correnti (ultimo elemento storico)', () => {
    const csv = buildSendReportAttualeCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IUN";"Tipo Domicilio Digitale";"Indirizzo Domicilio";"Stato";"Data Stato"');
    expect(lines[1]).toContain('"Consegnata"');
    expect(lines[1]).not.toContain('Esito App IO');
  });

  it('aggiunge la colonna Esito App IO solo se hasAppIoCoDelivery', () => {
    const report: SendReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: true, error: null } }],
    };
    const csv = buildSendReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Esito App IO"');
    expect(lines[1]).toContain('"Consegnato"');
  });

  it('mostra "Fallito: <errore>" per esito App IO negativo', () => {
    const report: SendReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: false, error: 'servizio non attivo' } }],
    };
    const csv = buildSendReportAttualeCsv(report);
    expect(csv.split('\n')[1]).toContain('Fallito: servizio non attivo');
  });
});

describe('buildSendReportStoricoCsv', () => {
  it('include una colonna data per ciascuno dei 10 stati, vuota se mai raggiunto', () => {
    const csv = buildSendReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Data Accettazione"');
    expect(lines[0]).toContain('"Data Restituzione al Mittente"');
    expect(lines[0].split(';')).toHaveLength(5 + 10);
    // REFUSED mai raggiunto in questo fixture: colonna vuota.
    const cells = lines[1].split(';');
    const refusedIndex = lines[0].split(';').findIndex((h) => h === '"Data Rifiuto"');
    expect(cells[refusedIndex]).toBe('""');
  });
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send-report-csv --maxWorkers=2`
Expected: FAIL con "Cannot find module './send-report-csv.util'"

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/campaigns/send-report-csv.util.ts`:

```typescript
import { escapeCsvField } from './csv.util';
import type { SendReportDto, SendReportRowDto } from './dto/campaign-stats.dto';
import { sendStatusLabel, digitalDomicileTypeLabel, SEND_STATUS_HISTORY_COLUMNS } from './send-status-labels.util';

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

function appIoOutcomeLabel(outcome: SendReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildSendReportAttualeCsv(report: SendReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio', 'Stato', 'Data Stato'];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    // sendStatusHistory è ordinato cronologicamente (copia diretta di
    // notificationStatusHistory da PN): l'ultimo elemento è lo stato corrente.
    const latestEntry = r.sendStatusHistory[r.sendStatusHistory.length - 1];
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.iun ?? '',
      digitalDomicileTypeLabel(r.digitalDomicileType),
      r.digitalDomicileAddress ?? '',
      sendStatusLabel(r.sendStatus),
      formatDate(latestEntry?.activeFrom),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildSendReportStoricoCsv(report: SendReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio',
    ...SEND_STATUS_HISTORY_COLUMNS.map((c) => c.header),
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    const historyByStatus = new Map(r.sendStatusHistory.map((h) => [h.status, h.activeFrom]));
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.iun ?? '',
      digitalDomicileTypeLabel(r.digitalDomicileType),
      r.digitalDomicileAddress ?? '',
      ...SEND_STATUS_HISTORY_COLUMNS.map((c) => formatDate(historyByStatus.get(c.status))),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-report-csv --maxWorkers=2`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/send-report-csv.util.ts apps/backend/src/campaigns/send-report-csv.util.spec.ts
git commit -m "feat(backend): CSV builder report SEND attuale/storico"
```

---

### Task 8: Endpoint controller

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `CampaignsService.getSendStatusBreakdown`, `CampaignsService.getSendReportRows` (Task 6); `buildSendReportAttualeCsv`, `buildSendReportStoricoCsv` (Task 7).
- Produces: `GET admin/campaigns/:id/send-status-breakdown`, `GET admin/campaigns/:id/export-send-report-attuale.csv`, `GET admin/campaigns/:id/export-send-report-storico.csv` — usati da Task 9/10 (frontend).

- [ ] **Step 1: Guarda il test esistente su `export-download-report.csv` per il pattern di test dei controller CSV**

Cerca in `apps/backend/src/campaigns/campaigns.controller.spec.ts` un test che chiama `exportDownloadReportCsv` per copiarne l'impostazione dei mock (`res.setHeader`, `res.send`).

- [ ] **Step 2: Scrivi i test falliti**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.controller.spec.ts`:

```typescript
  describe('send status endpoints', () => {
    it('getSendStatusBreakdown delega al service', async () => {
      campaignsService.getSendStatusBreakdown = jest.fn().mockResolvedValue([{ status: 'DELIVERED', count: 3 }]);
      const result = await controller.getSendStatusBreakdown('c1');
      expect(campaignsService.getSendStatusBreakdown).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ status: 'DELIVERED', count: 3 }]);
    });

    it('exportSendReportAttuale scrive CSV con header e content-disposition corretti', async () => {
      campaignsService.getSendReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportSendReportAttuale('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_send_attuale_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Codice Fiscale'));
    });

    it('exportSendReportStorico scrive CSV con header e content-disposition corretti', async () => {
      campaignsService.getSendReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportSendReportStorico('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_send_storico_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Data Accettazione'));
    });
  });
```

Nota: adatta i nomi delle variabili mock (`controller`, `campaignsService`) a quelli già usati nel `beforeEach`/setup del file esistente.

- [ ] **Step 3: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2`
Expected: FAIL con "controller.getSendStatusBreakdown is not a function"

- [ ] **Step 4: Implementa i 3 endpoint**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi l'import (vicino alla riga 33):

```typescript
import { buildSendReportAttualeCsv, buildSendReportStoricoCsv } from './send-report-csv.util';
```

Aggiungi i 3 endpoint subito dopo `exportDownloadReportCsv` (dopo la riga 544):

```typescript
  @Get(':id/send-status-breakdown')
  getSendStatusBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getSendStatusBreakdown(id);
  }

  @Get(':id/export-send-report-attuale.csv')
  async exportSendReportAttuale(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getSendReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_send_attuale_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildSendReportAttualeCsv(report));
  }

  @Get(':id/export-send-report-storico.csv')
  async exportSendReportStorico(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getSendReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_send_storico_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildSendReportStoricoCsv(report));
  }
```

- [ ] **Step 5: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Esegui l'intera suite backend (nessuna regressione)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, stesso failure-set di prima (idealmente 0 failure)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): endpoint breakdown stato SEND e export CSV attuale/storico"
```

---

### Task 9: Frontend — riavvia backend, barra impilata stato SEND

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:87` (dopo `SendStatusBadge`), `:934-936` (nuovo state), `:3536-3573` (fetch), `:7861-7886` (sezione dettaglio)

**Interfaces:**
- Consumes: `SEND_STATUS_META` (`App.tsx:65-77`), endpoint `GET /campaigns/:id/send-status-breakdown` (Task 8).
- Produces: componente `SendStatusBar` — nessun altro task lo consuma (self-contained).

- [ ] **Step 1: Riavvia il backend per applicare le modifiche dei task precedenti**

Run: `docker compose restart backend`

Verifica che `dist/` sia aggiornato:
Run: `docker compose exec backend ls -la dist/campaigns/campaigns.controller.js dist/channels/send/send-status-sync.service.js`
Expected: timestamp recente (post-modifica).

- [ ] **Step 2: Aggiungi il componente `SendStatusBar`**

In `apps/frontend-admin/src/App.tsx`, subito dopo la chiusura di `SendStatusBadge` (dopo la riga 87), aggiungi:

```typescript
function SendStatusBar({ breakdown }: { breakdown: Array<{ status: string | null; count: number }> }): React.JSX.Element {
  const total = breakdown.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) {
    return <div className="text-muted small">Nessun destinatario ancora processato.</div>;
  }
  return (
    <div>
      <div className="d-flex rounded overflow-hidden" style={{ height: '20px' }}>
        {breakdown.map((b) => {
          const meta = b.status ? SEND_STATUS_META[b.status] : null;
          const pct = (b.count / total) * 100;
          const bgClass = (meta ? meta.badge.split(' ')[0] : 'bg-secondary');
          return (
            <div
              key={b.status ?? 'pending'}
              className={bgClass}
              style={{ width: `${pct}%` }}
              title={`${meta ? meta.label : 'In attesa'}: ${b.count} (${pct.toFixed(0)}%)`}
            ></div>
          );
        })}
      </div>
      <div className="d-flex flex-wrap gap-2 mt-2 small">
        {breakdown.map((b) => {
          const meta = b.status ? SEND_STATUS_META[b.status] : null;
          return (
            <span key={b.status ?? 'pending'} className="text-muted">
              <i className={`fas ${meta ? meta.icon : 'fa-hourglass-half'} me-1`}></i>
              {meta ? meta.label : 'In attesa'}: <strong>{b.count}</strong>
            </span>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Aggiungi state e fetch**

Subito dopo la riga 935 (`campaignSendStageCounts` state), aggiungi:

```typescript
  const [sendStatusBreakdown, setSendStatusBreakdown] = useState<Array<{ status: string | null; count: number }> | null>(null);
```

Nel blocco `handleCampaignClick` (righe 3536-3552), aggiungi il reset dopo `setCampaignSendStageCounts(null);` (riga 3542):

```typescript
    setSendStatusBreakdown(null);
```

E aggiungi la chiamata fetch dopo `fetchCampaignSendStageCounts(id);` (riga 3550):

```typescript
    fetchSendStatusBreakdown(id);
```

Subito dopo la funzione `fetchCampaignSendStageCounts` (dopo la riga 3573), aggiungi:

```typescript
  const fetchSendStatusBreakdown = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/send-status-breakdown`);
      if (!res.ok) return;
      setSendStatusBreakdown(await res.json());
    } catch {
      // Non bloccante: il dettaglio campagna resta usabile senza la barra.
    }
  };
```

- [ ] **Step 4: Sostituisci il blocco "Progressione SEND" nel rendering**

Sostituisci il blocco alle righe 7861-7886 (che oggi condivide `campaignSendStageCounts` fra SEND e "protocolla generico") con due blocchi separati:

```typescript
                        {campaign.channelType === 'SEND' && sendStatusBreakdown && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-chart-bar me-1 text-primary"></i>Andamento Invio SEND
                            </h4>
                            <SendStatusBar breakdown={sendStatusBreakdown} />
                          </div>
                        )}

                        {campaign.channelType !== 'SEND' && campaign.channelConfig?.['protocolla'] === true && campaignSendStageCounts && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-stamp me-1 text-primary"></i>Stato Protocollazione
                            </h4>
                            <div className="d-flex gap-3 text-center small">
                              <div>
                                <div className="fw-bold text-secondary">{campaignSendStageCounts.queued}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>In attesa protocollo</div>
                              </div>
                              <div>
                                <div className="fw-bold text-info">{campaignSendStageCounts.protocollato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (in attesa invio)</div>
                              </div>
                              <div>
                                <div className="fw-bold text-success">{campaignSendStageCounts.inviato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                              </div>
                              <div>
                                <div className={`fw-bold ${campaignSendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{campaignSendStageCounts.fallito}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                              </div>
                            </div>
                          </div>
                        )}
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser**

Apri il portale admin (`http://localhost:3000`), vai su una campagna SEND esistente (o creane una), apri il dettaglio: verifica che compaia "Andamento Invio SEND" con la barra segmentata al posto di "Progressione SEND", e che una campagna con `protocolla: true` non-SEND mostri ancora "Stato Protocollazione" come prima.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): barra impilata stato SEND nel dettaglio campagna"
```

---

### Task 10: Frontend — 2 bottoni export (Attuale/Storico) per SEND

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:2739-2759` (nuova funzione export), `:8028-8032` (bottoni)

**Interfaces:**
- Consumes: endpoint `GET /campaigns/:id/export-send-report-attuale.csv`, `GET /campaigns/:id/export-send-report-storico.csv` (Task 8).

- [ ] **Step 1: Aggiungi `handleExportSendReport`**

Subito dopo la chiusura di `handleExportDownloadReport` (dopo la riga 2759), aggiungi:

```typescript
  const handleExportSendReport = async (variant: 'attuale' | 'storico') => {
    if (!campaign) return;
    try {
      const res = await apiFetch(`/campaigns/${campaign.id}/export-send-report-${variant}.csv`);
      if (!res.ok) {
        alert('Errore durante il download del report');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `report_send_${variant}_campagna_${campaign.id.slice(0, 8)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download del report');
    }
  };
```

- [ ] **Step 2: Sostituisci il bottone unico con la logica condizionale**

Sostituisci il blocco alle righe 8028-8032:

```typescript
                          {(campaign?.totalRecipients ?? 0) > 0 && (
                            <button className="btn btn-sm btn-outline-primary py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
```

con:

```typescript
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType !== 'SEND' && (
                            <button className="btn btn-sm btn-outline-primary py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType === 'SEND' && (
                            <div className="btn-group" role="group">
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('attuale')} title="Esporta stato attuale">
                                <i className="fas fa-file-excel me-1"></i> Attuale
                              </button>
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('storico')} title="Esporta storico completo">
                                <i className="fas fa-clock-rotate-left me-1"></i> Storico
                              </button>
                            </div>
                          )}
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Su una campagna SEND: verifica che appaiano i 2 bottoni "Attuale"/"Storico" (non più "Esporta Report Download"), che entrambi scarichino un CSV valido apribile (controllare le intestazioni colonne). Su una campagna EMAIL/PEC/APP_IO/POSTAL: verifica che il vecchio bottone "Esporta Report Download" sia ancora presente e funzionante (nessuna regressione per gli altri canali).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): export CSV SEND attuale/storico al posto del report generico"
```

---

## Self-Review

**Copertura spec:**
- Data model (2 colonne jsonb) → Task 1. ✅
- Parsing history/domicilio dalla stessa risposta PN → Task 2, 3. ✅
- Endpoint breakdown per barra → Task 6, 8. ✅
- Barra impilata frontend, sostituisce "Progressione SEND" → Task 9. ✅
- CSV "Attuale" (stato+data corrente+domicilio+IUN+Esito App IO condizionale) → Task 7, 8, 10. ✅
- CSV "Storico" (10 colonne data per stato) → Task 7, 8, 10. ✅
- Edge case IUN non risolto / REFUSED pre-IUN / campagna vuota / niente co-consegna App IO → coperti dai default (`?? null`, `?? []`, colonna omessa se `!hasAppIoCoDelivery`) e dai test Task 6/7. ✅
- Meccanismo stop-poll invariato (`TERMINAL_STATUSES`) → nessuna modifica, confermato in Task 3. ✅

**Placeholder scan:** nessun TBD/TODO, ogni step ha codice completo.

**Coerenza tipi:** `SendReportRowDto`/`SendReportDto` (Task 5) usati identici in Task 6 (service), Task 7 (CSV builder) e nei test — stessi nomi di campo (`sendStatusHistory`, `digitalDomicileType`, `appIoOutcome`) in tutti i task.
