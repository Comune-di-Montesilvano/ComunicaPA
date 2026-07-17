# INAD canale unico (fase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il domicilio digitale INAD diventa il canale di invio effettivo
quando trovato per un destinatario (override verso PEC), per ogni campagna
non-SEND, con un meccanismo ibrido extract-loop/bulk a seconda della
dimensione della campagna.

**Architecture:** `launch()` in `CampaignsService` guadagna uno step di
verifica INAD prima di produrre gli attempt: sotto soglia esegue un loop
`/extract` concorrente e procede subito; sopra soglia avvia una richiesta
bulk `/listDigitalAddress`, porta la campagna in un nuovo stato
`CHECKING_INAD` e delega il completamento a un nuovo demone `@Cron`
(`InadCheckSyncService`) che fa polling e richiama
`CampaignsService.finalizeInadCheck()` quando il risultato è disponibile.
La produzione di attempt+job (oggi inline in `launch()`) viene estratta in
un metodo privato riusabile da entrambi i percorsi.

**Tech Stack:** NestJS 10, TypeORM, `@nestjs/schedule` (`@Cron`), React 19,
`fetch` nativo.

## Global Constraints

- SEND è **sempre escluso**: nessun check INAD, nessuna modifica al suo
  flusso.
- Soglia: campagne con **meno di 100** destinatari usano il loop `/extract`
  (concorrenza 5-10); campagne con **100 o più** usano il bulk
  `/listDigitalAddress` (batch da max 1000 CF, più batch se la campagna è
  più grande).
- Nessun filtro sul formato CF: si interroga ogni destinatario con un CF
  valorizzato (persona fisica o P.IVA).
- Toggle globale `inad.checkEnabled` (boolean, default `false`) in
  Impostazioni: se disattivato, tutte le campagne procedono come oggi,
  nessun check.
- Override: domicilio INAD trovato diverso dall'indirizzo configurato →
  destinatario forzato a canale **PEC** (o solo cambio indirizzo se la
  campagna è già PEC). Mittente PEC: `channelConfig.pecReserveMailConfigId`
  (EMAIL/POSTAL/APP_IO) o il mittente PEC già configurato (canale PEC).
  Contenuto: `channelConfig.subject`/`body` esistenti — nessun campo
  contenuto separato.
- Colonna di audit `Recipient.inadCheck` (jsonb, nullable):
  `{ found: boolean, originalChannel: string | null, originalAddress: string | null, checkedAt: string }`,
  scritta per ogni destinatario controllato (anche se `found: false`).
- Blocco manuale su timeout bulk (default 2 ore): nessun fail-open
  automatico, solo intervento operatore (skip/retry).
- `cancel()` esteso per accettare anche `CHECKING_INAD` (nessun
  attempt/job esiste ancora in quello stato).
- `retryRecipient()`/`retryRecipientsBulk()` **non modificati**: durante
  `CHECKING_INAD` i destinatari sono `PENDING`, mai `FAILED`, quindi il
  guard esistente li esclude già implicitamente.
- Riferimento allo spec completo:
  `docs/superpowers/specs/2026-07-17-inad-canale-unico-design.md`.

---

### Task 1: Migrations — enum `checking_inad` + colonna `recipients.inad_check`

**Files:**
- Create: `apps/backend/src/database/migrations/1784800000000-AddCheckingInadStatus.ts`
- Create: `apps/backend/src/database/migrations/1784800000001-AddInadCheckColumn.ts`
- Modify: `apps/backend/src/database/database.module.ts` (registrare le due migration nell'array `migrations`)

**Interfaces:**
- Produces: colonna Postgres `recipients.inad_check` (jsonb, nullable) e
  valore enum `checking_inad` su `campaigns_status_enum`. Consumato da
  Task 2 (entity).

- [ ] **Step 1: Crea la migration per il nuovo valore enum**

`apps/backend/src/database/migrations/1784800000000-AddCheckingInadStatus.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCheckingInadStatus1784800000000 implements MigrationInterface {
    name = 'AddCheckingInadStatus1784800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."campaigns_status_enum" ADD VALUE 'checking_inad'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
    }
}
```

- [ ] **Step 2: Crea la migration per la colonna `inad_check`**

`apps/backend/src/database/migrations/1784800000001-AddInadCheckColumn.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInadCheckColumn1784800000001 implements MigrationInterface {
    name = 'AddInadCheckColumn1784800000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" ADD "inad_check" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "inad_check"`);
    }
}
```

- [ ] **Step 3: Registra entrambe le migration in `database.module.ts`**

Apri `apps/backend/src/database/database.module.ts`, trova l'array
`migrations: [...]` (usato da `migrationsRun`), aggiungi gli import e le
due classi in fondo all'array, nello stesso ordine dei timestamp:

```typescript
import { AddCheckingInadStatus1784800000000 } from './migrations/1784800000000-AddCheckingInadStatus';
import { AddInadCheckColumn1784800000001 } from './migrations/1784800000001-AddInadCheckColumn';
```

e nell'array `migrations`:

```typescript
    AddCheckingInadStatus1784800000000,
    AddInadCheckColumn1784800000001,
```

- [ ] **Step 4: Verifica su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_inad2;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_inad2" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

Expected: entrambe le migration eseguite senza errori (output include
`AddCheckingInadStatus1784800000000` e `AddInadCheckColumn1784800000001`).

```bash
docker compose exec postgres psql -U comunicapa -d migration_test_inad2 -c "\d recipients" | grep inad_check
docker compose exec postgres psql -U comunicapa -d migration_test_inad2 -c "SELECT enum_range(NULL::campaigns_status_enum)"
```

Expected: `inad_check` presente come `jsonb`, `checking_inad` presente
nell'enum range.

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_inad2;"
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/database/migrations/1784800000000-AddCheckingInadStatus.ts apps/backend/src/database/migrations/1784800000001-AddInadCheckColumn.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): migration stato CHECKING_INAD e colonna audit recipients.inad_check"
```

---

### Task 2: Entity + settings registry

**Files:**
- Modify: `apps/backend/src/entities/campaign.entity.ts`
- Modify: `apps/backend/src/entities/recipient.entity.ts`
- Modify: `apps/backend/src/settings/settings.registry.ts`

**Interfaces:**
- Consumes: colonne create in Task 1.
- Produces: `CampaignStatus.CHECKING_INAD`, `Recipient.inadCheck: { found: boolean; originalChannel: string | null; originalAddress: string | null; checkedAt: string } | null`, setting key `inad.checkEnabled: boolean`. Consumati da tutti i task successivi.

- [ ] **Step 1: Aggiungi `CHECKING_INAD` a `CampaignStatus`**

In `apps/backend/src/entities/campaign.entity.ts`, modifica l'enum:

```typescript
export enum CampaignStatus {
  DRAFT = 'draft',
  CHECKING_INAD = 'checking_inad',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}
```

- [ ] **Step 2: Aggiungi `inadCheck` a `Recipient`**

In `apps/backend/src/entities/recipient.entity.ts`, aggiungi dopo il
campo `extraData` (circa riga 43):

```typescript
  @Column({ type: 'jsonb', name: 'inad_check', nullable: true })
  inadCheck!: { found: boolean; originalChannel: string | null; originalAddress: string | null; checkedAt: string } | null;
```

- [ ] **Step 3: Aggiungi il setting `inad.checkEnabled`**

In `apps/backend/src/settings/settings.registry.ts`, nel blocco commentato
INAD/INIPEC (circa riga 76), aggiungi:

```typescript
'inad.checkEnabled': { type: 'boolean', default: false },
```

- [ ] **Step 4: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore (verifica che nessun `switch`/oggetto esaustivo su
`CampaignStatus` in TypeScript diventi incompleto — se `tsc` segnala un
`switch` non esaustivo altrove nel backend, aggiungi un case per
`CHECKING_INAD` lì, riportandolo nel report).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/entities/campaign.entity.ts apps/backend/src/entities/recipient.entity.ts apps/backend/src/settings/settings.registry.ts
git commit -m "feat(backend): entity e setting per stato CHECKING_INAD e audit inadCheck"
```

---

### Task 3: `InadService` — metodi bulk

**Files:**
- Modify: `apps/backend/src/channels/inad/inad.service.ts`
- Test: `apps/backend/src/channels/inad/inad.service.spec.ts` (estendi quello esistente)

**Interfaces:**
- Consumes: `this.getVoucher('prod')` (esistente).
- Produces:
  ```ts
  interface InadBulkStartResult { id: string }
  type InadBulkState = 'PRESA_IN_CARICO' | 'IN_ELABORAZIONE' | 'DISPONIBILE';
  interface InadBulkResultItem { codiceFiscale: string; since: string; digitalAddress?: InadDigitalAddressElement[] }
  ```
  - `startBulkExtraction(codiciFiscali: string[], practicalReference: string): Promise<InadBulkStartResult>`
  - `getBulkState(id: string): Promise<InadBulkState>`
  - `getBulkResult(id: string): Promise<InadBulkResultItem[]>`

  Consumati da Task 6 (bulk path in `launch()`) e Task 8 (demone polling).

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi a `apps/backend/src/channels/inad/inad.service.spec.ts` (nello
stesso `describe('InadService.extractDigitalAddress', ...)` o in un nuovo
`describe` accanto, riusando lo stesso `mockFetch`/`mockPdndAuth`/
`mockSettings` già presenti nel file):

```ts
describe('InadService — metodi bulk', () => {
  it('startBulkExtraction invia POST /listDigitalAddress e ritorna l\'id dalla Location', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: (h: string) => (h === 'location' ? 'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/state/abc-123' : null) },
      text: () => Promise.resolve('{"state":"PRESA_IN_CARICO","id":"abc-123"}'),
    });

    const result = await service.startBulkExtraction(['CF1', 'CF2'], 'rif-test');

    expect(result).toEqual({ id: 'abc-123' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ codiciFiscali: ['CF1', 'CF2'], praticalReference: 'rif-test' });
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('startBulkExtraction lancia errore leggibile se manca la Location', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: () => Promise.resolve('{}'),
    });
    await expect(service.startBulkExtraction(['CF1'], 'rif')).rejects.toThrow(/INAD bulk fallito: nessun header Location/);
  });

  it('getBulkState ritorna lo stato dal body JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"state":"IN_ELABORAZIONE","message":"..."}'),
    });
    const state = await service.getBulkState('abc-123');
    expect(state).toBe('IN_ELABORAZIONE');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/state/abc-123');
  });

  it('getBulkState riconosce DISPONIBILE anche su risposta 303', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 303,
      text: () => Promise.resolve('{"state":"DISPONIBILE","message":"..."}'),
    });
    const state = await service.getBulkState('abc-123');
    expect(state).toBe('DISPONIBILE');
  });

  it('getBulkResult ritorna la lista dal body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"list":[{"codiceFiscale":"CF1","since":"2026-01-01T00:00:00Z","digitalAddress":[{"digitalAddress":"a@pec.it","usageInfo":{"motivation":"CESSAZIONE_VOLONTARIA","dateEndValidity":"2020-01-01T00:00:00Z"}}]},{"codiceFiscale":"CF2","since":"2026-01-01T00:00:00Z"}]}'),
    });
    const result = await service.getBulkResult('abc-123');
    expect(result).toHaveLength(2);
    expect(result[0].codiceFiscale).toBe('CF1');
    expect(result[0].digitalAddress?.[0].digitalAddress).toBe('a@pec.it');
    expect(result[1].digitalAddress).toBeUndefined();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/listDigitalAddress/response/abc-123');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest inad.service --maxWorkers=2
```

Expected: FAIL — `startBulkExtraction`/`getBulkState`/`getBulkResult` non sono funzioni.

- [ ] **Step 3: Implementa i tre metodi in `inad.service.ts`**

Aggiungi in cima al file, accanto a `InadExtractResult`:

```typescript
export type InadBulkState = 'PRESA_IN_CARICO' | 'IN_ELABORAZIONE' | 'DISPONIBILE';

export interface InadBulkResultItem {
  codiceFiscale: string;
  since: string;
  digitalAddress?: InadDigitalAddressElement[];
}
```

Aggiungi i tre metodi nella classe `InadService`, dopo `extractDigitalAddress`:

```typescript
  async startBulkExtraction(codiciFiscali: string[], practicalReference: string): Promise<{ id: string }> {
    const voucher = await this.getVoucher('prod');
    const response = await fetch(`${INAD_BASE_URL}/listDigitalAddress`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${voucher}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ codiciFiscali, praticalReference }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`INAD bulk fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`INAD bulk fallito: nessun header Location nella risposta — ${text.slice(0, 200)}`);
    }
    const id = location.split('/').pop()!;
    return { id };
  }

  async getBulkState(id: string): Promise<InadBulkState> {
    const voucher = await this.getVoucher('prod');
    const response = await fetch(`${INAD_BASE_URL}/listDigitalAddress/state/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${voucher}` },
    });
    const text = await response.text();
    if (!response.ok && response.status !== 303) {
      throw new Error(`INAD bulk state fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    let data: { state: InadBulkState };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta INAD bulk state non valida (non JSON): ${text.slice(0, 200)}`);
    }
    return data.state;
  }

  async getBulkResult(id: string): Promise<InadBulkResultItem[]> {
    const voucher = await this.getVoucher('prod');
    const response = await fetch(`${INAD_BASE_URL}/listDigitalAddress/response/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${voucher}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`INAD bulk result fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    let data: { list: InadBulkResultItem[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta INAD bulk result non valida (non JSON): ${text.slice(0, 200)}`);
    }
    return data.list;
  }
```

Nota: `getBulkState` accetta sia `response.ok` (200 con body `IN_ELABORAZIONE`/`PRESA_IN_CARICO`) sia `303` (che `fetch` di Node tratta come non-ok se non si segue il redirect manualmente — verifica durante l'implementazione se serve `redirect: 'manual'` nell'opzione fetch per leggere lo stato `303` senza che Node segua automaticamente il redirect; se necessario aggiungilo all'opzione fetch di `getBulkState`).

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest inad.service --maxWorkers=2
```

Expected: PASS (9 test totali: 4 esistenti + 5 nuovi).

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/inad/inad.service.ts apps/backend/src/channels/inad/inad.service.spec.ts
git commit -m "feat(backend): metodi bulk INAD (startBulkExtraction/getBulkState/getBulkResult)"
```

---

### Task 4: `CampaignsService.launch()` — estrai `createAttemptsAndEnqueue` (refactor puro)

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `private async createAttemptsAndEnqueue(campaign: Campaign, recipients: Array<{ id: string }>, channelOverrides?: Map<string, string>): Promise<{ launched: number }>` — `channelOverrides` mappa `recipientId → channelType` per i destinatari con override INAD (vuota/assente in questo task, popolata nei Task 5/6). Consumato da Task 5 e Task 6.

Questo task **non cambia comportamento**: sposta il blocco di codice
esistente (righe 361-409 di `launch()`, produzione bulk di
`NotificationAttempt` + `addBulk` job + update stato recipient) in un
metodo privato, e `launch()` lo chiama con gli stessi argomenti di prima.
Nessun nuovo test di comportamento: i test esistenti di `launch()` devono
continuare a passare invariati — sono la prova di regressione.

- [ ] **Step 1: Esegui i test esistenti come baseline**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Annota il risultato (N/N passing) — deve restare identico dopo il refactor.

- [ ] **Step 2: Estrai il metodo privato**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci il
blocco di `launch()` che va da `// Bulk insert NotificationAttempts in
chunks di 500` fino a `return { launched: recipients.length, campaignId };`
(righe ~361-411) con:

```typescript
    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients);
    return { launched, campaignId };
  }

  private async createAttemptsAndEnqueue(
    campaign: Campaign,
    recipients: Array<{ id: string }>,
    channelOverrides?: Map<string, string>,
  ): Promise<{ launched: number }> {
    // Bulk insert NotificationAttempts in chunks di 500
    const CHUNK = 500;
    const attemptIds: string[] = [];
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const chunk = recipients.slice(i, i + CHUNK);
      const result = await this.attemptRepo
        .createQueryBuilder()
        .insert()
        .into(NotificationAttempt)
        .values(
          chunk.map((r) => ({
            recipientId: r.id,
            channelType: channelOverrides?.get(r.id) ?? campaign.channelType,
            status: AttemptStatus.QUEUED,
          })),
        )
        .returning('id')
        .execute();
      attemptIds.push(...(result.raw as Array<{ id: string }>).map((row) => row.id));
    }

    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo
    // grandi). SEND non ha una propria coda di invio (SendDispatchService resta
    // poll-based, vedi pipeline-demoni-send-design) ma la protocollazione
    // (sempre richiesta per SEND, enforced sopra) sì: motore dedicato con
    // coda/UI/log come gli altri canali.
    const JOB_CHUNK = 1000;
    const engineName = (campaign.channelType === 'SEND' || campaign.channelConfig?.['protocolla'] === true) ? 'PROTOCOLLAZIONE' : campaign.channelType;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
      await this.notificationQueues.addBulk(
        engineName,
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId: campaign.id,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: channelOverrides?.get(r.id) ?? campaign.channelType,
          },
          opts: { jobId: attemptIds[i + idx] },
        })),
      );
    }

    await this.recipientRepo.update(
      { campaignId: campaign.id, status: RecipientStatus.PENDING },
      { status: RecipientStatus.QUEUED },
    );

    return { launched: recipients.length };
  }
```

Nota: `engineName` con `channelOverrides` — per questo task `channelOverrides`
è sempre `undefined`/vuoto, quindi `engineName` resta identico a prima
(basato su `campaign.channelType`). Il caso in cui un singolo destinatario
ha `channelType` diverso dal canale di campagna (override INAD verso PEC
su una campagna EMAIL/POSTAL/APP_IO) verrà gestito nel Task 5/6 — per ora
non serve preoccuparsene, il codice qui è identico al comportamento
originale quando `channelOverrides` è vuoto.

- [ ] **Step 3: Esegui i test e verifica che passino identici alla baseline**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Expected: stesso numero di test passing della baseline (Step 1) — nessuna
regressione, nessun nuovo test.

- [ ] **Step 4: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts
git commit -m "refactor(backend): estrae createAttemptsAndEnqueue da launch() (nessun cambio di comportamento)"
```

---

### Task 5: Percorso extract-loop (campagne sotto soglia)

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.module.ts` (import `InadModule`, inietta `InadService`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `InadService.extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult>` (Task 1 di fase 1, già esistente); `createAttemptsAndEnqueue` (Task 4).
- Produces: `private async runInadExtractLoop(campaign: Campaign, recipients: Recipient[]): Promise<{ channelOverrides: Map<string, string> }>`. Consumato solo da `launch()` in questo task.

**Comportamento**: se `inad.checkEnabled === true`, `campaign.channelType !== 'SEND'`, e `recipients.length < 100`, `launch()` esegue il loop `/extract` (concorrenza 5) PRIMA di chiamare `createAttemptsAndEnqueue`, scrive `recipient.inadCheck` e `recipient.pec` per ogni destinatario, costruisce la mappa `channelOverrides` (solo per destinatari con canale forzato a PEC), poi chiama `createAttemptsAndEnqueue(campaign, recipients, channelOverrides)` come oggi.

- [ ] **Step 1: Inietta `InadService` in `CampaignsModule`**

In `apps/backend/src/campaigns/campaigns.module.ts`, aggiungi l'import:

```typescript
import { InadModule } from '../channels/inad/inad.module';
```

e aggiungi `InadModule` all'array `imports` (accanto a `QueueModule`,
`AuditLogsModule`).

- [ ] **Step 2: Inietta `InadService` in `CampaignsService`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi l'import:

```typescript
import { InadService } from '../channels/inad/inad.service';
```

Aggiungi il parametro al costruttore esistente:

```typescript
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly inadService: InadService,
  ) {}
```

- [ ] **Step 3: Scrivi i test falliti per il metodo `runInadExtractLoop`**

Aggiungi a `campaigns.service.spec.ts` un nuovo `describe`, con un mock
`mockInadService = { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() }`
aggiunto al modulo di test (`{ provide: InadService, useValue: mockInadService }`):

```typescript
describe('launch — check INAD extract-loop (sotto soglia)', () => {
  beforeEach(() => {
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
    });
    mockInadService.extractDigitalAddress.mockReset();
    mockInadService.startBulkExtraction.mockReset();
  });

  it('override verso PEC un destinatario EMAIL con domicilio INAD trovato, sotto soglia', async () => {
    mockSettings.get.mockImplementation(async (key: string) => (key === 'inad.checkEnabled' ? true : null));
    const campaignEmail = { ...mockCampaign, id: 'c-inad-1', channelType: 'EMAIL', channelConfig: {} };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
    mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
      if (select?.includes('extraData')) return Promise.resolve([]);
      return Promise.resolve([
        { id: 'r1', codiceFiscale: 'CF1', pec: null },
        { id: 'r2', codiceFiscale: 'CF2', pec: null },
      ]);
    });
    mockInadService.extractDigitalAddress.mockImplementation(async (cf: string) => {
      if (cf === 'CF1') return { found: true, data: { codiceFiscale: 'CF1', since: '2026-01-01', digitalAddress: [{ digitalAddress: 'trovato@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01' } }] } };
      return { found: false };
    });

    const result = await service.launch('c-inad-1');

    expect(result.launched).toBe(2);
    expect(mockInadService.extractDigitalAddress).toHaveBeenCalledWith('CF1');
    expect(mockInadService.extractDigitalAddress).toHaveBeenCalledWith('CF2');
    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      { id: 'r1' },
      expect.objectContaining({ pec: 'trovato@pec.it', inadCheck: expect.objectContaining({ found: true }) }),
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      { id: 'r2' },
      expect.objectContaining({ inadCheck: expect.objectContaining({ found: false }) }),
    );
    expect(mockInadService.startBulkExtraction).not.toHaveBeenCalled();
  });

  it('non fa alcun check INAD se il toggle è disattivato', async () => {
    mockSettings.get.mockImplementation(async () => false);
    const campaignEmail = { ...mockCampaign, id: 'c-inad-2', channelType: 'EMAIL', channelConfig: {} };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
    mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
      if (select?.includes('extraData')) return Promise.resolve([]);
      return Promise.resolve([{ id: 'r1' }]);
    });

    await service.launch('c-inad-2');

    expect(mockInadService.extractDigitalAddress).not.toHaveBeenCalled();
  });

  it('non fa alcun check INAD per campagne SEND anche col toggle attivo', async () => {
    mockSettings.get.mockImplementation(async (key: string) => (key === 'inad.checkEnabled' ? true : (key === 'send.environment' ? undefined : null)));
    const campaignSend = { ...mockCampaign, id: 'c-inad-3', channelType: 'SEND', channelConfig: { protocolla: true, attachments: [{ key: 'a', label: 'A' }] } };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignSend);
    mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
      if (select?.includes('extraData')) return Promise.resolve([{ id: 'r1', codiceFiscale: 'CF1', extraData: { a: 'x.pdf' } }]);
      return Promise.resolve([{ id: 'r1' }]);
    });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['x.pdf'] as any);

    await service.launch('c-inad-3');

    expect(mockInadService.extractDigitalAddress).not.toHaveBeenCalled();
  });
});
```

Nota per l'implementatore: il terzo test copre il percorso SEND
riutilizzando i mock già esistenti nel file per gli allegati (vedi il
`describe('launch — validazione allegati bloccante', ...)` più sopra nello
stesso file per il pattern esatto di `fs.existsSync`/`fs.readdirSync`
mockati con `tmpDirRef`/`getUploadsDir` — se il campo `attachments`/mock
allegati non combacia esattamente, adattalo allo stesso pattern già usato
in quel `describe`, non inventarne uno nuovo).

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Expected: FAIL — nessun check INAD viene eseguito ancora.

- [ ] **Step 3: Implementa il metodo `runInadExtractLoop` e la chiamata da `launch()`**

Aggiungi in `campaigns.service.ts`, prima della chiamata a
`createAttemptsAndEnqueue` dentro `launch()` (subito dopo aver ottenuto
`recipients` con `select: ['id']`), il branching INAD. Sostituisci:

```typescript
    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients);
    return { launched, campaignId };
  }
```

con:

```typescript
    let channelOverrides: Map<string, string> | undefined;
    const inadCheckEnabled = campaign.channelType !== 'SEND' && (await this.settings.get<boolean>('inad.checkEnabled'));
    if (inadCheckEnabled) {
      if (recipients.length < INAD_BULK_THRESHOLD) {
        channelOverrides = await this.runInadExtractLoop(campaign, recipients);
      } else {
        await this.startInadBulkCheck(campaign, recipients);
        return { launched: 0, campaignId };
      }
    }

    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients, channelOverrides);
    return { launched, campaignId };
  }

  private async runInadExtractLoop(campaign: Campaign, recipients: Array<{ id: string }>): Promise<Map<string, string>> {
    const fullRecipients = await this.recipientRepo.find({
      where: { id: In(recipients.map((r) => r.id)) },
      select: ['id', 'codiceFiscale', 'pec', 'email'],
    });
    const channelOverrides = new Map<string, string>();
    const CONCURRENCY = 5;
    for (let i = 0; i < fullRecipients.length; i += CONCURRENCY) {
      const batch = fullRecipients.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (recipient) => {
          if (!recipient.codiceFiscale) return;
          let result: { found: boolean; data?: { digitalAddress: Array<{ digitalAddress: string }> } };
          try {
            result = await this.inadService.extractDigitalAddress(recipient.codiceFiscale);
          } catch (err) {
            this.logger.warn(`Check INAD fallito per destinatario ${recipient.id} (CF ${recipient.codiceFiscale}): ${err instanceof Error ? err.message : err}`);
            return;
          }
          const found = result.found && (result.data?.digitalAddress?.length ?? 0) > 0;
          const inadAddress = found ? result.data!.digitalAddress[0].digitalAddress : null;
          await this.recipientRepo.update(
            { id: recipient.id },
            {
              inadCheck: {
                found,
                originalChannel: campaign.channelType,
                originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
                checkedAt: new Date().toISOString(),
              },
              ...(found && inadAddress !== recipient.pec ? { pec: inadAddress } : {}),
            },
          );
          if (found && inadAddress !== recipient.pec) {
            channelOverrides.set(recipient.id, 'PEC');
          }
        }),
      );
    }
    return channelOverrides;
  }
```

Aggiungi la costante in cima al file, accanto a `MAX_BULK_RETRY_SIZE`:

```typescript
const INAD_BULK_THRESHOLD = 100;
```

`startInadBulkCheck` è un placeholder per Task 6 — in questo task, crealo
come metodo privato minimo che lancia `Error('non ancora implementato')`
solo per far compilare (Task 6 lo sostituirà con l'implementazione reale):

```typescript
  private async startInadBulkCheck(_campaign: Campaign, _recipients: Array<{ id: string }>): Promise<void> {
    throw new Error('startInadBulkCheck non ancora implementato (Task 6)');
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Expected: PASS, incluso il nuovo `describe`, e la baseline del Task 4
resta verde (nessuna regressione — i test che non attivano il toggle
`inad.checkEnabled` restano identici perché `mockSettings.get` di default
risolve a `null`/falsy).

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): check INAD extract-loop per campagne sotto soglia (override verso PEC)"
```

---

### Task 6: Percorso bulk (campagne sopra soglia) + `finalizeInadCheck`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `InadService.startBulkExtraction`/`getBulkResult` (Task 3).
- Produces:
  - `private async startInadBulkCheck(campaign: Campaign, recipients: Array<{id:string}>): Promise<void>` (sostituisce il placeholder del Task 5) — chiama `inadService.startBulkExtraction`, salva `campaign.channelConfig.inadCheck = { mechanism: 'bulk', batches: [{ id, recipientIds, done: false }], requestedAt }`, imposta `campaign.status = CHECKING_INAD`.
  - `async finalizeInadCheck(campaignId: string): Promise<void>` (pubblico, usato da Task 8) — per ogni batch non ancora `done` in `channelConfig.inadCheck.batches`, controlla se pronto (il chiamante — il demone — verifica lo stato PRIMA di chiamare questo metodo, che assume tutti i batch passati siano già `DISPONIBILE`), applica i risultati (stesso `inadCheck`/override di `runInadExtractLoop`), poi chiama `createAttemptsAndEnqueue` e porta la campagna a `QUEUED`.

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi a `campaigns.service.spec.ts`:

```typescript
describe('launch — check INAD bulk (sopra soglia)', () => {
  beforeEach(() => {
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    mockInadService.startBulkExtraction.mockReset();
    mockInadService.getBulkResult.mockReset();
  });

  it('avvia il bulk e porta la campagna a CHECKING_INAD senza creare attempt', async () => {
    mockSettings.get.mockImplementation(async (key: string) => (key === 'inad.checkEnabled' ? true : null));
    const campaignEmail = { ...mockCampaign, id: 'c-bulk-1', channelType: 'EMAIL', channelConfig: {} };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
    const manyRecipients = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}` }));
    mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
      if (select?.includes('extraData')) return Promise.resolve([]);
      return Promise.resolve(manyRecipients);
    });
    mockInadService.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.launch('c-bulk-1');

    expect(result.launched).toBe(0);
    expect(mockInadService.startBulkExtraction).toHaveBeenCalledTimes(1);
    const [cfList] = mockInadService.startBulkExtraction.mock.calls[0];
    expect(cfList).toHaveLength(150);
    expect(mockCampaignRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.CHECKING_INAD }),
    );
    expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('finalizeInadCheck applica i risultati e lancia createAttemptsAndEnqueue', async () => {
    const campaignChecking = {
      ...mockCampaign,
      id: 'c-bulk-2',
      channelType: 'EMAIL',
      status: CampaignStatus.CHECKING_INAD,
      channelConfig: {
        inadCheck: {
          mechanism: 'bulk',
          batches: [{ id: 'batch-2', recipientIds: ['r1', 'r2'], done: false }],
          requestedAt: '2026-01-01T00:00:00Z',
        },
      },
    };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
    mockRecipientRepo.find.mockResolvedValue([
      { id: 'r1', codiceFiscale: 'CF1', pec: null, email: 'e1@x.it' },
      { id: 'r2', codiceFiscale: 'CF2', pec: null, email: 'e2@x.it' },
    ]);
    mockInadService.getBulkResult.mockResolvedValue([
      { codiceFiscale: 'CF1', since: '2026-01-01', digitalAddress: [{ digitalAddress: 'trovato@pec.it' }] },
      { codiceFiscale: 'CF2', since: '2026-01-01' },
    ]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
    });

    await service.finalizeInadCheck('c-bulk-2');

    expect(mockInadService.getBulkResult).toHaveBeenCalledWith('batch-2');
    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      { id: 'r1' },
      expect.objectContaining({ pec: 'trovato@pec.it' }),
    );
    expect(mockCampaignRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.QUEUED }),
    );
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Expected: FAIL — `startInadBulkCheck` lancia ancora l'errore placeholder,
`finalizeInadCheck` non esiste.

- [ ] **Step 3: Implementa `startInadBulkCheck` e `finalizeInadCheck`**

Sostituisci il metodo placeholder `startInadBulkCheck` del Task 5 con:

```typescript
  private async startInadBulkCheck(campaign: Campaign, recipients: Array<{ id: string }>): Promise<void> {
    const fullRecipients = await this.recipientRepo.find({
      where: { id: In(recipients.map((r) => r.id)) },
      select: ['id', 'codiceFiscale'],
    });
    const withCf = fullRecipients.filter((r) => r.codiceFiscale);

    const BATCH = 1000;
    const batches: Array<{ id: string; recipientIds: string[]; done: boolean }> = [];
    for (let i = 0; i < withCf.length; i += BATCH) {
      const chunk = withCf.slice(i, i + BATCH);
      const { id } = await this.inadService.startBulkExtraction(
        chunk.map((r) => r.codiceFiscale!),
        `comunicapa-campagna-${campaign.id}`,
      );
      batches.push({ id, recipientIds: chunk.map((r) => r.id), done: false });
    }

    campaign.status = CampaignStatus.CHECKING_INAD;
    campaign.channelConfig = {
      ...campaign.channelConfig,
      inadCheck: { mechanism: 'bulk', batches, requestedAt: new Date().toISOString() },
    };
    await this.campaignRepo.save(campaign);
  }

  async finalizeInadCheck(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign || campaign.status !== CampaignStatus.CHECKING_INAD) return;

    const inadCheck = campaign.channelConfig?.['inadCheck'] as
      | { mechanism: 'bulk'; batches: Array<{ id: string; recipientIds: string[]; done: boolean }>; requestedAt: string }
      | undefined;
    if (!inadCheck) return;

    const pendingBatches = inadCheck.batches.filter((b) => !b.done);
    const allRecipientIds: string[] = [];
    for (const batch of pendingBatches) {
      const result = await this.inadService.getBulkResult(batch.id);
      const resultByCf = new Map(result.map((r) => [r.codiceFiscale, r]));
      const batchRecipients = await this.recipientRepo.find({
        where: { id: In(batch.recipientIds) },
        select: ['id', 'codiceFiscale', 'pec', 'email'],
      });
      for (const recipient of batchRecipients) {
        const match = recipient.codiceFiscale ? resultByCf.get(recipient.codiceFiscale) : undefined;
        const found = !!match?.digitalAddress?.length;
        const inadAddress = found ? match!.digitalAddress![0].digitalAddress : null;
        await this.recipientRepo.update(
          { id: recipient.id },
          {
            inadCheck: {
              found,
              originalChannel: campaign.channelType,
              originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
              checkedAt: new Date().toISOString(),
            },
            ...(found && inadAddress !== recipient.pec ? { pec: inadAddress } : {}),
          },
        );
      }
      batch.done = true;
      allRecipientIds.push(...batch.recipientIds);
    }

    campaign.channelConfig = { ...campaign.channelConfig, inadCheck };
    await this.campaignRepo.save(campaign);

    if (inadCheck.batches.every((b) => b.done)) {
      const overriddenRecipients = await this.recipientRepo.find({
        where: { id: In(inadCheck.batches.flatMap((b) => b.recipientIds)), status: RecipientStatus.PENDING },
        select: ['id', 'pec', 'inadCheck'],
      });
      const channelOverrides = new Map<string, string>();
      for (const r of overriddenRecipients) {
        if (r.inadCheck?.found && campaign.channelType !== 'PEC') {
          channelOverrides.set(r.id, 'PEC');
        }
      }
      const allRecipients = await this.recipientRepo.find({
        where: { campaignId: campaign.id, status: RecipientStatus.PENDING },
        select: ['id'],
      });
      await this.createAttemptsAndEnqueue(campaign, allRecipients, channelOverrides);
      campaign.status = CampaignStatus.QUEUED;
      await this.campaignRepo.save(campaign);
    }
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Expected: PASS, tutti i `describe` INAD (Task 5 + Task 6) più la baseline
del Task 4 restano verdi.

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): check INAD bulk per campagne sopra soglia + finalizeInadCheck"
```

---

### Task 7: `cancel()` esteso a `CHECKING_INAD` + `skipInadCheck()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `createAttemptsAndEnqueue` (Task 4).
- Produces: `async skipInadCheck(campaignId: string): Promise<{ launched: number; campaignId: string }>` — bypassa il check INAD (usato dal bottone "Salta verifica" nel Task 9), transiziona `CHECKING_INAD → QUEUED` producendo gli attempt con i canali originali di campagna (nessun override). Consumato da Task 9.

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi a `campaigns.service.spec.ts`:

```typescript
describe('cancel — da CHECKING_INAD', () => {
  it('permette annullamento da CHECKING_INAD senza toccare job/attempt', async () => {
    const campaignChecking = { ...mockCampaign, id: 'c-cancel-inad', status: CampaignStatus.CHECKING_INAD };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
    mockRecipientRepo.find.mockResolvedValue([]);
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });

    const result = await service.cancel('c-cancel-inad');

    expect(result.campaignId).toBe('c-cancel-inad');
    expect(mockCampaignQb.set).toHaveBeenCalledWith(expect.objectContaining({ status: CampaignStatus.CANCELLED }));
  });
});

describe('skipInadCheck', () => {
  it('salta la verifica INAD e lancia con i canali originali', async () => {
    const campaignChecking = {
      ...mockCampaign,
      id: 'c-skip-1',
      channelType: 'EMAIL',
      status: CampaignStatus.CHECKING_INAD,
      channelConfig: {},
    };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
    mockRecipientRepo.find.mockResolvedValue([{ id: 'r1' }]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
    });

    const result = await service.skipInadCheck('c-skip-1');

    expect(result.launched).toBe(1);
    expect(mockCampaignRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: CampaignStatus.QUEUED }));
  });

  it('rifiuta se la campagna non è in CHECKING_INAD', async () => {
    const campaignQueued = { ...mockCampaign, id: 'c-skip-2', status: CampaignStatus.QUEUED };
    mockCampaignRepo.findOneBy.mockResolvedValue(campaignQueued);
    await expect(service.skipInadCheck('c-skip-2')).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

- [ ] **Step 3: Estendi `cancel()` e implementa `skipInadCheck()`**

In `cancel()`, modifica il guard esistente (circa riga 417):

```typescript
    if (campaign.status !== CampaignStatus.QUEUED && campaign.status !== CampaignStatus.CHECKING_INAD) {
      throw new BadRequestException('Solo campagne in corso o in verifica INAD possono essere annullate');
    }
```

Alla fine del metodo `cancel()`, la query di update finale (circa riga
533) filtra `.where('id = :id AND status = :queued', { queued:
CampaignStatus.QUEUED })` — estendila per accettare anche
`CHECKING_INAD`:

```typescript
  await this.campaignRepo
    .createQueryBuilder()
    .update()
    .set({ status: CampaignStatus.CANCELLED, completedAt: new Date() })
    .where('id = :id AND status IN (:...statuses)', { id: campaignId, statuses: [CampaignStatus.QUEUED, CampaignStatus.CHECKING_INAD] })
    .execute();
```

Il resto del corpo di `cancel()` (rimozione job, allegati, ecc.) resta
invariato — in `CHECKING_INAD` `queuedRecipients` sarà sempre vuoto
(nessun destinatario è mai passato a `QUEUED` prima di quel punto), quindi
quei rami non vengono eseguiti, coerente con la nota nello spec ("nessun
attempt/job esiste ancora in quello stato").

Aggiungi il nuovo metodo pubblico, vicino a `cancel()`:

```typescript
  async skipInadCheck(campaignId: string): Promise<{ launched: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.CHECKING_INAD) {
      throw new BadRequestException('Solo le campagne in verifica INAD possono saltare il controllo');
    }
    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });
    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients);
    campaign.status = CampaignStatus.QUEUED;
    await this.campaignRepo.save(campaign);
    return { launched, campaignId };
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): cancel() da CHECKING_INAD e skipInadCheck() per sblocco manuale"
```

---

### Task 8: Demone `InadCheckSyncService`

**Files:**
- Create: `apps/backend/src/campaigns/inad-check-sync.service.ts`
- Create: `apps/backend/src/campaigns/inad-check-sync.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.module.ts`

**Interfaces:**
- Consumes: `InadService.getBulkState(id)` (Task 3); `CampaignsService.finalizeInadCheck(campaignId)` (Task 6).
- Produces: nessuna nuova interfaccia consumata da altri task (ultimo tassello backend).

- [ ] **Step 1: Scrivi i test falliti**

`apps/backend/src/campaigns/inad-check-sync.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InadCheckSyncService } from './inad-check-sync.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { InadService } from '../channels/inad/inad.service';
import { CampaignsService } from './campaigns.service';

describe('InadCheckSyncService', () => {
  let service: InadCheckSyncService;
  const mockCampaignRepo = { find: jest.fn() };
  const mockInadService = { getBulkState: jest.fn() };
  const mockCampaignsService = { finalizeInadCheck: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        InadCheckSyncService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: InadService, useValue: mockInadService },
        { provide: CampaignsService, useValue: mockCampaignsService },
      ],
    }).compile();
    service = module.get(InadCheckSyncService);
  });

  it('chiama finalizeInadCheck quando tutti i batch pending sono DISPONIBILE', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c1',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b1', done: false }, { id: 'b2', done: true }] } },
      },
    ]);
    mockInadService.getBulkState.mockResolvedValue('DISPONIBILE');

    await service.handleCron();

    expect(mockInadService.getBulkState).toHaveBeenCalledWith('b1');
    expect(mockCampaignsService.finalizeInadCheck).toHaveBeenCalledWith('c1');
  });

  it('non chiama finalizeInadCheck se un batch è ancora IN_ELABORAZIONE', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      {
        id: 'c2',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b1', done: false }] } },
      },
    ]);
    mockInadService.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('ignora campagne senza inadCheck bulk (es. extract-loop, o senza channelConfig)', async () => {
    mockCampaignRepo.find.mockResolvedValue([{ id: 'c3', status: CampaignStatus.CHECKING_INAD, channelConfig: {} }]);

    await service.handleCron();

    expect(mockInadService.getBulkState).not.toHaveBeenCalled();
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalled();
  });

  it('un errore su una campagna non blocca le altre nello stesso ciclo', async () => {
    mockCampaignRepo.find.mockResolvedValue([
      { id: 'c-err', status: CampaignStatus.CHECKING_INAD, channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b-err', done: false }] } } },
      { id: 'c-ok', status: CampaignStatus.CHECKING_INAD, channelConfig: { inadCheck: { mechanism: 'bulk', batches: [{ id: 'b-ok', done: false }] } } },
    ]);
    mockInadService.getBulkState.mockImplementation(async (id: string) => {
      if (id === 'b-err') throw new Error('errore rete');
      return 'DISPONIBILE';
    });

    await service.handleCron();

    expect(mockCampaignsService.finalizeInadCheck).toHaveBeenCalledWith('c-ok');
    expect(mockCampaignsService.finalizeInadCheck).not.toHaveBeenCalledWith('c-err');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest inad-check-sync --maxWorkers=2
```

Expected: FAIL — il file `inad-check-sync.service.ts` non esiste.

- [ ] **Step 3: Implementa il demone**

`apps/backend/src/campaigns/inad-check-sync.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { InadService } from '../channels/inad/inad.service';
import { CampaignsService } from './campaigns.service';

interface InadCheckBulkState {
  mechanism: 'bulk';
  batches: Array<{ id: string; recipientIds: string[]; done: boolean }>;
  requestedAt: string;
}

/**
 * Poll periodico dei batch bulk INAD (/listDigitalAddress) per le campagne
 * ferme in CHECKING_INAD — stesso pattern "demone" di SendStatusSyncService/
 * PostalStatusSyncService (nessuna coda BullMQ, solo Cron + repo diretti).
 */
@Injectable()
export class InadCheckSyncService {
  private readonly logger = new Logger(InadCheckSyncService.name);

  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly inadService: InadService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const campaigns = await this.campaignRepo.find({ where: { status: CampaignStatus.CHECKING_INAD } });

    for (const campaign of campaigns) {
      const inadCheck = campaign.channelConfig?.['inadCheck'] as InadCheckBulkState | undefined;
      if (!inadCheck || inadCheck.mechanism !== 'bulk') continue;

      const pendingBatches = inadCheck.batches.filter((b) => !b.done);
      if (pendingBatches.length === 0) continue;

      try {
        let allReady = true;
        for (const batch of pendingBatches) {
          const state = await this.inadService.getBulkState(batch.id);
          if (state !== 'DISPONIBILE') {
            allReady = false;
            break;
          }
        }
        if (allReady) {
          await this.campaignsService.finalizeInadCheck(campaign.id);
        }
      } catch (err) {
        this.logger.warn(`Errore verifica stato INAD bulk per campagna ${campaign.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
```

- [ ] **Step 4: Registra il demone in `CampaignsModule`**

In `apps/backend/src/campaigns/campaigns.module.ts`, aggiungi l'import:

```typescript
import { InadCheckSyncService } from './inad-check-sync.service';
```

e aggiungilo all'array `providers`, accanto a `RetentionCleanupService`.

Verifica inoltre che `@nestjs/schedule` sia già abilitato globalmente
(cerca `ScheduleModule.forRoot()` in `app.module.ts` — se già presente per
`SendStatusSyncService`/`PostalStatusSyncService`, non serve altro; se non
lo trovi, riportalo come concern nel report, non aggiungerlo tu stesso
senza prima verificare dove va importato).

- [ ] **Step 5: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest inad-check-sync campaigns.service --maxWorkers=2
```

Expected: PASS, tutti i test (nuovo file + `campaigns.service.spec.ts`
invariato).

- [ ] **Step 6: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/inad-check-sync.service.ts apps/backend/src/campaigns/inad-check-sync.service.spec.ts apps/backend/src/campaigns/campaigns.module.ts
git commit -m "feat(backend): demone InadCheckSyncService per polling batch bulk INAD"
```

---

### Task 9: Endpoint controller — retry/skip check INAD

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `CampaignsService.skipInadCheck(campaignId)` (Task 7); per "riprova", riusa `CampaignsService.launch(campaignId)`? No — una campagna in `CHECKING_INAD` non è `DRAFT`, quindi `launch()` la rifiuterebbe. "Riprova verifica" richiama semplicemente `finalizeInadCheck` a mano (utile se il demone non è ancora passato, o per forzare un nuovo tentativo di lettura stato) — espone `CampaignsService.finalizeInadCheck(campaignId)` (Task 6) via endpoint.
- Produces: `POST admin/campaigns/:id/inad-check/retry`, `POST admin/campaigns/:id/inad-check/skip`. Consumati dal Task 10 (frontend).

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi a `campaigns.controller.spec.ts`, nel `mockService` esistente
aggiungi `finalizeInadCheck: jest.fn().mockResolvedValue(undefined)` e
`skipInadCheck: jest.fn().mockResolvedValue({ launched: 3, campaignId: 'uuid-1' })`,
poi:

```typescript
describe('inad-check retry/skip', () => {
  it('retryInadCheck chiama finalizeInadCheck e logga audit', async () => {
    await controller.retryInadCheck('uuid-1', mockReq);
    expect(mockService.finalizeInadCheck).toHaveBeenCalledWith('uuid-1');
    expect(mockAuditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INAD_CHECK_RETRY', campaignId: 'uuid-1' }));
  });

  it('skipInadCheck chiama il servizio e logga audit', async () => {
    const result = await controller.skipInadCheck('uuid-1', mockReq);
    expect(result.launched).toBe(3);
    expect(mockService.skipInadCheck).toHaveBeenCalledWith('uuid-1');
    expect(mockAuditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INAD_CHECK_SKIP', campaignId: 'uuid-1' }));
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2
```

- [ ] **Step 3: Implementa i due endpoint**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi subito
dopo il metodo `cancel()` (circa riga 423):

```typescript
  @Post(':id/inad-check/retry')
  async retryInadCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ ok: true }> {
    await this.campaignsService.finalizeInadCheck(id);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: (await this.campaignsService.findOne(id).catch(() => null))?.name ?? null,
      operator: req.user.username,
      action: 'INAD_CHECK_RETRY',
      details: {},
    });
    return { ok: true };
  }

  @Post(':id/inad-check/skip')
  async skipInadCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ launched: number; campaignId: string }> {
    const result = await this.campaignsService.skipInadCheck(id);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: (await this.campaignsService.findOne(id).catch(() => null))?.name ?? null,
      operator: req.user.username,
      action: 'INAD_CHECK_SKIP',
      details: { launched: result.launched },
    });
    return result;
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2
```

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): endpoint retry/skip verifica INAD per campagne bloccate"
```

---

### Task 10: Frontend — toggle Impostazioni, wizard, dettaglio campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: setting `inad.checkEnabled` (Task 2, via il flusso generico esistente `GET/PUT admin/settings`, nessun endpoint dedicato); `POST admin/campaigns/:id/inad-check/retry`, `POST admin/campaigns/:id/inad-check/skip` (Task 9).
- Produces: nessuna nuova interfaccia consumata da altri task (ultimo task del piano).

Questo task copre 4 modifiche indipendenti nello stesso file, ognuna
verificabile a occhio in browser:

- [ ] **Step 1: Toggle `inad.checkEnabled` nel tab Impostazioni → INAD**

Nel tab INAD (`activeSettingsTab === 'inad'`, vedi fase 1), aggiungi UN
checkbox fuori dal `.map` per-ambiente (non è per-env, è globale), subito
sotto l'alert in cima:

```tsx
<div className="form-check form-switch mb-3">
  <input
    className="form-check-input"
    type="checkbox"
    role="switch"
    id="inad_check_enabled"
    checked={settInadCheckEnabled}
    onChange={(e) => setSettInadCheckEnabled(e.target.checked)}
  />
  <label className="form-check-label small fw-semibold" htmlFor="inad_check_enabled">
    Attiva verifica domicilio digitale INAD per le campagne (tranne SEND)
  </label>
</div>
```

Aggiungi lo stato `const [settInadCheckEnabled, setSettInadCheckEnabled] = useState(false);`
vicino agli altri stati INAD (riga ~938), popolalo nel caricamento
impostazioni esistente (`setSettInadCheckEnabled(Boolean(s['inad.checkEnabled']))`,
stesso punto di `setSettInadTestPurposeId` alla riga ~1118), e aggiungilo
all'oggetto `buildSettingsPayload`/payload di salvataggio esistente
(`'inad.checkEnabled': settInadCheckEnabled`, stesso punto delle altre
chiavi `inad.*` alla riga ~1800) — segui esattamente il pattern già usato
per `settInadTestPurposeId`/`inad.test.purposeId` in fase 1, stesso file,
non introdurre un meccanismo di salvataggio diverso.

- [ ] **Step 2: Selettore mittente PEC di riserva nel wizard, step 1**

Subito dopo il blocco esistente `{(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (...)}`
(mittente principale, `App.tsx:4823-4847`), aggiungi:

```tsx
{(wizChannel === 'EMAIL' || wizChannel === 'POSTAL' || wizChannel === 'APP_IO') && (
  <div className="mb-3">
    <label className="form-label small fw-bold">Mittente PEC di riserva (verifica INAD)</label>
    <select
      className="form-select form-select-sm"
      value={wizPecReserveMailConfigId}
      onChange={e => setWizPecReserveMailConfigId(e.target.value)}
    >
      <option value="">-- Nessuno --</option>
      {mailConfigs
        .filter(c => c.type === 'PEC' && c.active)
        .map(c => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.fromAddress})
          </option>
        ))}
    </select>
    <div className="form-text small text-muted">
      Usato solo se un destinatario risulta avere un domicilio digitale INAD attivo: l'invio a quel destinatario passa automaticamente su PEC.
    </div>
  </div>
)}
```

Aggiungi lo stato `const [wizPecReserveMailConfigId, setWizPecReserveMailConfigId] = useState('');`
vicino agli altri stati `wiz*` del wizard.

- [ ] **Step 3: Scrivi `pecReserveMailConfigId` in `channelConfig` (entrambi i punti)**

In `buildWizChannelConfigDraft` (App.tsx:3462), aggiungi dentro il corpo
della funzione:

```typescript
  if (wizPecReserveMailConfigId) cfg.pecReserveMailConfigId = wizPecReserveMailConfigId;
```

In `handleWizLaunch` (App.tsx:3474), aggiungi lo stesso, nello stesso
punto relativo (accanto a dove viene scritto `channelConfig.blockedChannels`):

```typescript
    if (wizPecReserveMailConfigId) {
      channelConfig.pecReserveMailConfigId = wizPecReserveMailConfigId;
    }
```

- [ ] **Step 4: Allarga la condizione del blocco template per POSTAL, step 4**

Il blocco "Carica da template" (App.tsx:5574) e le relative condizioni di
obbligatorietà nel bottone "Riepilogo" (App.tsx:5556-5565) trattano oggi
`(wizChannel === 'EMAIL' || wizChannel === 'PEC')` per il dropdown
template e `wizChannel !== 'SEND' && wizChannel !== 'POSTAL'` per
l'obbligatorietà del body. Modifica:
- Il dropdown "Carica da template" (riga 5574): aggiungi `|| wizChannel === 'POSTAL'`
  alla condizione, così anche POSTAL vede il selettore template MAIL
  esistente.
- La condizione disabled del bottone Riepilogo (riga 5561): rimuovi
  `wizChannel !== 'POSTAL'` dalla condizione che esenta POSTAL dal
  richiedere `wizBody` non vuoto — POSTAL ora richiede anch'esso un body
  non vuoto, SOLO SE il toggle `inad.checkEnabled` globale è attivo (leggi
  lo stato caricato da Impostazioni, non serve una nuova fetch: verifica
  se esiste già uno stato globale `globalSettings`/`appSettings` caricato
  all'avvio dell'app admin che esponga `inad.checkEnabled` — se sì, usalo;
  se non esiste un simile stato globale accessibile dal wizard, riporta
  questo come concern nel report invece di introdurre una fetch dedicata
  non prevista dal piano).

- [ ] **Step 5: Badge stato + bottoni retry/skip nel dettaglio campagna**

Aggiungi `checking_inad: { label: 'Verifica INAD', badge: 'bg-info' }` a
`STATUS_META` (App.tsx:41-53). Aggiungi `| 'checking_inad'` all'unione di
tipo `status` nell'interfaccia `Campaign` (App.tsx:361). Estendi la
condizione di polling (App.tsx:1037) per includere anche
`campaign.status === 'checking_inad'`.

Nella vista dettaglio campagna, dove oggi si trova il blocco condizionale
`{campaign.status === 'queued' && ( ... )}` (App.tsx:8569, es. bottone
"Annulla campagna"), aggiungi un blocco analogo:

```tsx
{campaign.status === 'checking_inad' && (
  <div className="alert alert-info d-flex justify-content-between align-items-center">
    <span>Verifica domicilio digitale INAD in corso…</span>
    <div>
      <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => handleRetryInadCheck(campaign.id)}>
        Riprova verifica
      </button>
      <button className="btn btn-sm btn-outline-warning me-2" onClick={() => handleSkipInadCheck(campaign.id)}>
        Salta verifica e procedi
      </button>
      <button className="btn btn-sm btn-outline-danger" onClick={() => handleCancelCampaign(campaign.id)}>
        Annulla campagna
      </button>
    </div>
  </div>
)}
```

Aggiungi i due nuovi handler vicino agli handler esistenti di gestione
campagna (`handleCancelCampaign` o equivalente — cercalo nel file e
replicane lo stile esatto: chiamata `apiFetch`, refresh dello stato
campagna dopo successo, gestione errore):

```typescript
const handleRetryInadCheck = async (campaignId: string) => {
  await apiFetch(`/campaigns/${campaignId}/inad-check/retry`, { method: 'POST' });
  await refreshCampaignDetail(campaignId);
};

const handleSkipInadCheck = async (campaignId: string) => {
  if (!confirm('Saltare la verifica INAD e procedere con i canali configurati?')) return;
  await apiFetch(`/campaigns/${campaignId}/inad-check/skip`, { method: 'POST' });
  await refreshCampaignDetail(campaignId);
};
```

Nota: `refreshCampaignDetail` è un nome indicativo — usa la funzione
esistente che il file già chiama dopo `handleCancelCampaign` per
ricaricare i dati campagna (cercala vicino a quell'handler, non
inventarne una nuova se una equivalente esiste già).

- [ ] **Step 6: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 7: Verifica manuale in browser**

1. Attiva `inad.checkEnabled` da Impostazioni → INAD, salva.
2. Crea una campagna EMAIL nel wizard con meno di 100 destinatari,
   verifica che compaia il selettore "Mittente PEC di riserva" allo step
   1 e che lo step 4 richieda comunque solo il body EMAIL esistente
   (nessun cambio visibile per EMAIL).
3. Crea una campagna POSTAL, verifica che allo step 4 compaia ora il
   blocco template (prima assente per POSTAL) e sia obbligatorio.
4. Lancia una campagna EMAIL piccola con un CF reale con domicilio INAD
   noto (es. quello di test usato in fase 1) tra i destinatari — verifica
   che il destinatario finisca overridden a PEC nel dettaglio campagna
   (richiede `inad.prod.purposeId` configurato in questo ambiente).
5. Lancia una campagna con 100+ destinatari, verifica che passi a stato
   "Verifica INAD" e che compaiano i bottoni "Riprova verifica"/"Salta
   verifica"/"Annulla campagna".

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): toggle INAD, mittente PEC di riserva nel wizard, gestione CHECKING_INAD in dettaglio campagna"
```

---

## Spec coverage check

- Meccanismo ibrido extract-loop (<100) / bulk (≥100) → Task 5, 6. ✓
- SEND sempre escluso → guardia esplicita in `launch()` (Task 5). ✓
- Toggle globale `inad.checkEnabled` → Task 2 (registry), Task 10 (UI). ✓
- Stato `CHECKING_INAD`, audit di tutti i metodi che mutano `CampaignStatus` → Task 1/2 (schema), Task 6 (bulk), Task 7 (`cancel()`/`skipInadCheck`) — `retryRecipient()`/`retryRecipientsBulk()`/`CampaignCompletionService` esplicitamente non modificati per le ragioni già verificate in fase di brainstorming. ✓
- Override canale/indirizzo verso PEC, colonna audit `inadCheck` → Task 5, 6. ✓
- Nessuna modifica alle Strategy esistenti → confermato, nessun task tocca `pec.strategy.ts`/`email.strategy.ts`. ✓
- Demone polling bulk, blocco manuale su timeout (nessun fail-open) → Task 8 (demone si limita a chiamare `finalizeInadCheck` solo su `DISPONIBILE`, nessuna logica di timeout/fail-open implementata — coerente con "nessun fail-open automatico" dello spec: un batch bloccato resta bloccato finché l'operatore non interviene con retry/skip). ✓
- Wizard: riuso template esistente, unico campo nuovo `pecReserveMailConfigId` → Task 10. ✓
- INIPEC, dashboard override, rate limiting quota giornaliera → esplicitamente fuori scope, nessun task. ✓
