# Performance Dettaglio Campagna, Validazione CF App IO, Errori Raggruppati — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere veloce il dettaglio di una campagna App IO con decine di migliaia di destinatari (query N+1 su `getFailures`, eager-load completo su `findOne`), bloccare nel wizard le righe con CF non compatibile con App IO prima che vengano create, raggruppare i destinatari falliti per motivazione con retry bulk, e mostrare un grafico anche per campagne App IO senza co-consegna.

**Architecture:** Backend: riscrittura query su `CampaignsService` (TypeORM query builder, niente più N+1 e niente più eager-load completo su `findOne`), 4 nuovi/estesi endpoint su `CampaignsController`. Frontend: tabella destinatari e pannello errori passano da array in-memory a fetch paginati/raggruppati; validazione CSV wizard più stretta per App IO; nuova card grafico fallback.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 + Vite (frontend), Recharts (già presente).

## Global Constraints

- Tutti i comandi girano in Docker — niente Node/pnpm sull'host.
- Test backend SEMPRE con `--maxWorkers=2`.
- Type-check frontend con `tsc -p tsconfig.app.json --noEmit`, mai `tsc -b`.
- Baseline test: nessun fallimento noto — qualsiasi nuovo fallimento è una regressione.
- Nessuna modifica a `getChannelBreakdown`/`getDownloadCrossChannelStats` (restano invariati, gated su co-consegna).
- CSV export: usare sempre `escapeCsvField` con guardia anti formula-injection (pattern già stabilito in `never-downloaded-csv.util.ts`).
- Nessun nuovo importer/creator di campagne, wizard resta l'unico punto di creazione destinatari.

**Spec:** `docs/superpowers/specs/2026-07-08-perf-campagna-appio-design.md`

---

## Task 1: Util CSV condiviso (escapeCsvField)

**Files:**
- Create: `apps/backend/src/campaigns/csv.util.ts`
- Test: `apps/backend/src/campaigns/csv.util.spec.ts`
- Modify: `apps/backend/src/campaigns/never-downloaded-csv.util.ts`

**Interfaces:**
- Produces: `escapeCsvField(value: string): string` — usato da Task 6 (`download-report-csv.util.ts`) e da `never-downloaded-csv.util.ts`.

- [ ] **Step 1: Scrivi il test**

```typescript
// apps/backend/src/campaigns/csv.util.spec.ts
import { escapeCsvField } from './csv.util';

describe('escapeCsvField', () => {
  it('racchiude il valore tra virgolette ed esegue escaping delle virgolette interne', () => {
    expect(escapeCsvField('Mario "Rossi"')).toBe('"Mario ""Rossi"""');
  });

  it('antepone un apice ai valori che iniziano con = + - @ per prevenire formula injection', () => {
    expect(escapeCsvField('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
    expect(escapeCsvField('+1234')).toBe('"\'+1234"');
    expect(escapeCsvField('-1234')).toBe('"\'-1234"');
    expect(escapeCsvField('@cmd')).toBe('"\'@cmd"');
  });

  it('lascia invariati i valori normali', () => {
    expect(escapeCsvField('AAA1')).toBe('"AAA1"');
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest csv.util --maxWorkers=2`
Expected: FAIL con "Cannot find module './csv.util'"

- [ ] **Step 3: Estrai l'implementazione**

```typescript
// apps/backend/src/campaigns/csv.util.ts

/**
 * Previene CSV/formula injection: Excel interpreta come formula un campo il
 * cui contenuto (dopo aver rimosso le virgolette di CSV) inizia con = + - @.
 * Anteponendo un apice si forza Excel a trattarlo come testo.
 */
export function escapeCsvField(value: string): string {
  const sanitized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${sanitized.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 4: Aggiorna `never-downloaded-csv.util.ts` per riusare l'util condiviso**

Sostituisci in `apps/backend/src/campaigns/never-downloaded-csv.util.ts` la funzione locale `escapeCsvField` (righe 3-9) con:

```typescript
import type { NeverDownloadedRowDto } from './dto/global-stats.dto';
import { escapeCsvField } from './csv.util';
```

(rimuovi la vecchia dichiarazione di `escapeCsvField` dal file, il resto del file resta invariato)

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest csv.util never-downloaded-csv --maxWorkers=2`
Expected: PASS (3 + 3 test)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/csv.util.ts apps/backend/src/campaigns/csv.util.spec.ts apps/backend/src/campaigns/never-downloaded-csv.util.ts
git commit -m "refactor(backend): estrai escapeCsvField in util condiviso"
```

---

## Task 2: Fix N+1 su getFailures

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: firma di `getFailures` invariata (`getFailures(campaignId: string): Promise<FailureRowDto[]>`) — nessun impatto su Task 3/controller/frontend, cambia solo l'implementazione interna.

- [ ] **Step 1: Individua i test esistenti di getFailures**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "getFailures ritorna"`
Expected: PASS (baseline attuale, da non rompere)

- [ ] **Step 2: Aggiungi un test che verifica una sola query aggregata (nessun N+1)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, nel blocco `describe('CampaignsService.getFailures / retryRecipient', ...)`, subito dopo il test esistente `'getFailures ritorna solo i destinatari...'`:

```typescript
  it('getFailures usa una query aggregata invece di una findOne per destinatario (no N+1)', async () => {
    const qb: any = {};
    ['leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getRawMany = jest.fn().mockResolvedValue([
      {
        recipientId: 'r1',
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        errorMessage: 'timeout',
        attemptNumber: 2,
        lastAttemptAt: new Date('2026-07-01T10:00:00Z'),
        recipientCreatedAt: new Date('2026-06-30T09:00:00Z'),
      },
      {
        recipientId: 'r2',
        codiceFiscale: 'BBB2',
        fullName: null,
        errorMessage: null,
        attemptNumber: null,
        lastAttemptAt: null,
        recipientCreatedAt: new Date('2026-06-30T09:05:00Z'),
      },
    ]);
    mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const result = await service.getFailures('c1');

    expect(mockRecipientRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(mockAttemptRepo.find).not.toHaveBeenCalled();
    expect(result).toEqual([
      { recipientId: 'r1', codiceFiscale: 'AAA1', fullName: 'Mario Rossi', errorMessage: 'timeout', attemptNumber: 2, lastAttemptAt: '2026-07-01T10:00:00.000Z' },
      { recipientId: 'r2', codiceFiscale: 'BBB2', fullName: null, errorMessage: null, attemptNumber: 0, lastAttemptAt: '2026-06-30T09:05:00.000Z' },
    ]);
  });
```

- [ ] **Step 3: Esegui il nuovo test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "no N\+1"`
Expected: FAIL (`mockRecipientRepo.createQueryBuilder` non chiamato, l'implementazione attuale usa `find` + `attemptRepo.findOne`)

- [ ] **Step 4: Riscrivi `getFailures` in `campaigns.service.ts`**

Sostituisci il metodo `getFailures` esistente (righe 672-703) con:

```typescript
  async getFailures(campaignId: string): Promise<FailureRowDto[]> {
    // Query singola con subquery DISTINCT ON invece di una findOne per
    // destinatario: con decine di migliaia di FAILED la versione N+1
    // precedente rendeva il caricamento del dettaglio campagna impraticabile.
    const rows = await this.recipientRepo
      .createQueryBuilder('r')
      .leftJoin(
        `(SELECT DISTINCT ON (recipient_id) recipient_id, error_message, attempt_number, created_at
          FROM notification_attempts ORDER BY recipient_id, attempt_number DESC)`,
        'la',
        'la.recipient_id = r.id',
      )
      .select('r.id', 'recipientId')
      .addSelect('r.codiceFiscale', 'codiceFiscale')
      .addSelect('r.fullName', 'fullName')
      .addSelect('la.error_message', 'errorMessage')
      .addSelect('la.attempt_number', 'attemptNumber')
      .addSelect('la.created_at', 'lastAttemptAt')
      .addSelect('r.createdAt', 'recipientCreatedAt')
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere('r.status = :status', { status: RecipientStatus.FAILED })
      .orderBy('r.createdAt', 'DESC')
      .getRawMany<{
        recipientId: string;
        codiceFiscale: string;
        fullName: string | null;
        errorMessage: string | null;
        attemptNumber: number | null;
        lastAttemptAt: Date | null;
        recipientCreatedAt: Date;
      }>();

    return rows.map((r) => ({
      recipientId: r.recipientId,
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      errorMessage: r.errorMessage,
      attemptNumber: r.attemptNumber ?? 0,
      lastAttemptAt: (r.lastAttemptAt ?? r.recipientCreatedAt).toISOString(),
    }));
  }
```

Aggiungi il tipo `FailureRowDto` in `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (in fondo al file):

```typescript
export interface FailureRowDto {
  recipientId: string;
  codiceFiscale: string;
  fullName: string | null;
  errorMessage: string | null;
  attemptNumber: number;
  lastAttemptAt: string;
}
```

Aggiorna la firma del metodo per usare il tipo importato (import da aggiungere alla riga con `CampaignStatsDto, RecipientStatsPageDto, ...`):

```typescript
import type { CampaignStatsDto, RecipientStatsPageDto, ChannelBreakdownDto, DownloadCrossChannelStatsDto, FailureRowDto } from './dto/campaign-stats.dto';
```

- [ ] **Step 5: Esegui i test e verifica che passino, nessuna regressione**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getFailures`
Expected: PASS (entrambi i test esistenti + il nuovo)

- [ ] **Step 6: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Esegui l'intera suite backend**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts
git commit -m "fix(backend): elimina query N+1 in getFailures con subquery aggregata"
```

---

## Task 3: Errori raggruppati per motivazione + retry bulk

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `getFailures` (Task 2), `retryRecipient` (esistente, invariato).
- Produces: `CampaignsService.getFailuresByReason(campaignId): Promise<FailureGroupDto[]>`, `CampaignsService.retryRecipientsBulk(campaignId, recipientIds: string[]): Promise<{ requeued: number; failed: Array<{ recipientId: string; reason: string }> }>`, endpoint `GET :id/failures/by-reason`, endpoint `POST :id/recipients/retry-bulk`. Usati da Task 8 (frontend).

- [ ] **Step 1: Scrivi i test (falliscono: metodi non esistono)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dopo il blocco `describe('CampaignsService.getFailures / retryRecipient', ...)`:

Usa il `service` già istanziato dal `beforeEach` in cima al file (stesso pattern degli altri `describe` in questo file — non istanziare `CampaignsService` manualmente):

```typescript
describe('CampaignsService.getFailuresByReason', () => {
  it('raggruppa i destinatari falliti per errorMessage con conteggio decrescente', async () => {
    jest.spyOn(service, 'getFailures').mockResolvedValue([
      { recipientId: 'r1', codiceFiscale: 'AAA1', fullName: 'A', errorMessage: 'timeout', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r2', codiceFiscale: 'BBB2', fullName: 'B', errorMessage: 'timeout', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r3', codiceFiscale: 'CCC3', fullName: 'C', errorMessage: 'CF non valido', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r4', codiceFiscale: 'DDD4', fullName: 'D', errorMessage: null, attemptNumber: 0, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
    ]);

    const result = await service.getFailuresByReason('c1');

    expect(result).toEqual([
      { errorMessage: 'timeout', count: 2, recipientIds: ['r1', 'r2'] },
      { errorMessage: 'CF non valido', count: 1, recipientIds: ['r3'] },
      { errorMessage: 'Errore sconosciuto', count: 1, recipientIds: ['r4'] },
    ]);
  });
});

describe('CampaignsService.retryRecipientsBulk', () => {
  it('ritenta ogni destinatario e conta successi/fallimenti separatamente', async () => {
    jest
      .spyOn(service, 'retryRecipient')
      .mockResolvedValueOnce({ requeued: true, attemptId: 'a1' })
      .mockRejectedValueOnce(new Error('Solo i destinatari in stato FAILED possono essere rimessi in coda'))
      .mockResolvedValueOnce({ requeued: true, attemptId: 'a3' });

    const result = await service.retryRecipientsBulk('c1', ['r1', 'r2', 'r3']);

    expect(result).toEqual({
      requeued: 2,
      failed: [{ recipientId: 'r2', reason: 'Solo i destinatari in stato FAILED possono essere rimessi in coda' }],
    });
  });
});
```

Nota: `jest.spyOn(service, 'getFailures'/'retryRecipient')` funziona solo se questi metodi vengono chiamati come `this.getFailures(...)`/`this.retryRecipient(...)` dentro `getFailuresByReason`/`retryRecipientsBulk` (non come funzioni destrutturate) — verificare che l'implementazione in Step 4 usi `this.`.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "getFailuresByReason|retryRecipientsBulk"`
Expected: FAIL con "service.getFailuresByReason is not a function" / "service.retryRecipientsBulk is not a function"

- [ ] **Step 3: Aggiungi i DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, in fondo al file:

```typescript
export interface FailureGroupDto {
  errorMessage: string;
  count: number;
  recipientIds: string[];
}

export interface RetryBulkResultDto {
  requeued: number;
  failed: Array<{ recipientId: string; reason: string }>;
}
```

- [ ] **Step 4: Implementa i metodi nel service**

Aggiorna l'import dei tipi in `campaigns.service.ts`:

```typescript
import type { CampaignStatsDto, RecipientStatsPageDto, ChannelBreakdownDto, DownloadCrossChannelStatsDto, FailureRowDto, FailureGroupDto, RetryBulkResultDto } from './dto/campaign-stats.dto';
```

Aggiungi i due metodi subito dopo `getFailures` (Task 2), prima di `async retryRecipient`:

```typescript
  async getFailuresByReason(campaignId: string): Promise<FailureGroupDto[]> {
    const failures = await this.getFailures(campaignId);
    const groups = new Map<string, FailureGroupDto>();

    for (const f of failures) {
      const key = f.errorMessage ?? 'Errore sconosciuto';
      if (!groups.has(key)) groups.set(key, { errorMessage: key, count: 0, recipientIds: [] });
      const group = groups.get(key)!;
      group.count++;
      group.recipientIds.push(f.recipientId);
    }

    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }
```

Aggiungi subito dopo `retryRecipient` (esistente, invariato):

```typescript
  async retryRecipientsBulk(campaignId: string, recipientIds: string[]): Promise<RetryBulkResultDto> {
    let requeued = 0;
    const failed: Array<{ recipientId: string; reason: string }> = [];

    for (const recipientId of recipientIds) {
      try {
        await this.retryRecipient(campaignId, recipientId);
        requeued++;
      } catch (e) {
        failed.push({ recipientId, reason: e instanceof Error ? e.message : 'Errore sconosciuto' });
      }
    }

    return { requeued, failed };
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "getFailuresByReason|retryRecipientsBulk"`
Expected: PASS (2 test)

- [ ] **Step 6: Aggiungi gli endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi `Body` se non già importato (già presente, riga 3). Aggiungi dopo `getFailures` (riga ~347), prima di `retryRecipient`:

```typescript
  @Get(':id/failures/by-reason')
  getFailuresByReason(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailuresByReason(id);
  }
```

Aggiungi dopo `retryRecipient` (riga ~355), prima di `getRecipientStats`:

```typescript
  @Post(':id/recipients/retry-bulk')
  retryRecipientsBulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('recipientIds') recipientIds: string[],
  ) {
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      throw new BadRequestException('recipientIds deve essere un array non vuoto');
    }
    return this.campaignsService.retryRecipientsBulk(id, recipientIds);
  }
```

Nota: `:id/recipients/retry-bulk` (3 segmenti letterali) non collide con `:id/recipients/:recipientId/retry` (route diversa, `recipientId` è un parametro ma il segmento letterale finale è `retry` non `retry-bulk` — Nest instrada per match esatto dei segmenti letterali prima dei parametri, verificare comunque con Step 8).

- [ ] **Step 7: Scrivi test controller**

Aggiungi in `apps/backend/src/campaigns/campaigns.controller.spec.ts`, aggiungi ai mock del service (`mockService`) `getFailuresByReason: jest.fn()` e `retryRecipientsBulk: jest.fn()`, poi in fondo al file:

```typescript
  describe('getFailuresByReason', () => {
    it('chiama il service con l\'id campagna', async () => {
      mockService.getFailuresByReason = jest.fn().mockResolvedValue([]);
      await controller.getFailuresByReason('uuid-1');
      expect(mockService.getFailuresByReason).toHaveBeenCalledWith('uuid-1');
    });
  });

  describe('retryRecipientsBulk', () => {
    it('rifiuta un body senza recipientIds', () => {
      expect(() => controller.retryRecipientsBulk('uuid-1', undefined as any)).toThrow(BadRequestException);
    });

    it('rifiuta un array vuoto', () => {
      expect(() => controller.retryRecipientsBulk('uuid-1', [])).toThrow(BadRequestException);
    });

    it('chiama il service con id campagna e recipientIds', async () => {
      mockService.retryRecipientsBulk = jest.fn().mockResolvedValue({ requeued: 1, failed: [] });
      await controller.retryRecipientsBulk('uuid-1', ['r1']);
      expect(mockService.retryRecipientsBulk).toHaveBeenCalledWith('uuid-1', ['r1']);
    });
  });
```

- [ ] **Step 8: Esegui i test, type-check, suite intera**

Run: `docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): errori campagna raggruppati per motivazione con retry bulk"
```

---

## Task 4: Estendi getRecipientStats con status/contatti e ricerca

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Produces: `RecipientStatDto` esteso con `email`, `pec`, `status`; `getRecipientStats(campaignId, page, pageSize, search?)`. Usato da Task 8 (frontend, sostituisce `campaign.recipients` nella tabella).

- [ ] **Step 1: Aggiorna il DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, sostituisci `RecipientStatDto` (righe 10-18) con:

```typescript
export interface RecipientStatDto {
  id: string;
  fullName: string | null;
  codiceFiscale: string;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  firstDownloadedAt: Date | null;
  lastDownloadedAt: Date | null;
  attachmentDeletedAt: Date | null;
}
```

- [ ] **Step 2: Scrivi il test (fallisce: firma non aggiornata)**

Individua il test esistente `'getRecipientStats pagina i risultati'` (riga 237) in `campaigns.service.spec.ts` e sostituiscilo con:

```typescript
  it('getRecipientStats pagina i risultati e seleziona i nuovi campi', async () => {
    const qb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getManyAndCount = jest.fn().mockResolvedValue([
      [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'AAA1', email: null, pec: null, status: 'sent', downloadCount: 0, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
      1,
    ]);
    mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const page = await service.getRecipientStats('uuid-1', 1, 20);

    expect(mockRecipientRepo.createQueryBuilder).toHaveBeenCalledWith('r');
    expect(qb.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'uuid-1' });
    expect(qb.andWhere).not.toHaveBeenCalled();
    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(page).toEqual({ campaignId: 'uuid-1', page: 1, pageSize: 20, total: 1, items: expect.any(Array) });
  });

  it('getRecipientStats applica il filtro search su fullName o codiceFiscale', async () => {
    const qb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    await service.getRecipientStats('uuid-1', 1, 20, 'rossi');

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(r.fullName ILIKE :search OR r.codiceFiscale ILIKE :search)',
      { search: '%rossi%' },
    );
  });
```

Rimuovi (se presente) il vecchio mock `mockRecipientRepo.findAndCount` usato solo da questo test — resta usato altrove solo se referenziato da altri test (verificare con `grep -n "findAndCount" campaigns.service.spec.ts` prima di toccare il blocco `mockRecipientRepo` in cima al file: non rimuovere la proprietà dal mock stesso, resta innocua se non più chiamata).

- [ ] **Step 3: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getRecipientStats`
Expected: FAIL (implementazione attuale usa `findAndCount`, non `createQueryBuilder`)

- [ ] **Step 4: Riscrivi il metodo**

Sostituisci `getRecipientStats` (righe 745-758) con:

```typescript
  async getRecipientStats(campaignId: string, page: number, pageSize: number, search?: string): Promise<RecipientStatsPageDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const qb = this.recipientRepo
      .createQueryBuilder('r')
      .select([
        'r.id', 'r.fullName', 'r.codiceFiscale', 'r.email', 'r.pec', 'r.status',
        'r.downloadCount', 'r.firstDownloadedAt', 'r.lastDownloadedAt', 'r.attachmentDeletedAt',
      ])
      .where('r.campaignId = :campaignId', { campaignId });

    if (search && search.trim()) {
      qb.andWhere('(r.fullName ILIKE :search OR r.codiceFiscale ILIKE :search)', { search: `%${search.trim()}%` });
    }

    const [items, total] = await qb
      .orderBy('r.createdAt', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return { campaignId, page, pageSize, total, items };
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getRecipientStats`
Expected: PASS (2 test)

- [ ] **Step 6: Aggiorna il controller per accettare `search`**

In `apps/backend/src/campaigns/campaigns.controller.ts`, modifica `getRecipientStats` (righe 357-374):

```typescript
  @Get(':id/stats/recipients')
  getRecipientStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    const parsedPage = parseInt(page ?? '1', 10);
    const parsedPageSize = parseInt(pageSize ?? '50', 10);

    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('Il parametro page deve essere un numero intero maggiore o uguale a 1');
    }
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1) {
      throw new BadRequestException('Il parametro pageSize deve essere un numero intero maggiore o uguale a 1');
    }

    return this.campaignsService.getRecipientStats(id, parsedPage, parsedPageSize, search);
  }
```

- [ ] **Step 7: Aggiorna il test controller esistente per il parametro search**

In `apps/backend/src/campaigns/campaigns.controller.spec.ts`, il test `'passa page/pageSize di default'` (riga ~23) deve aspettarsi anche `undefined` per search:

```typescript
      await controller.getRecipientStats('uuid-1', undefined, undefined, undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50, undefined);
```

Aggiorna analogamente ogni altra chiamata a `controller.getRecipientStats(...)` nei test esistenti (righe ~28, ~33, ~38, ~43, ~48) aggiungendo `undefined` (o il valore search atteso) come quarto argomento, e i corrispondenti `toHaveBeenCalledWith` con il quinto argomento aggiunto.

- [ ] **Step 8: Esegui i test, type-check, suite intera**

Run: `docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): getRecipientStats con contatti/stato e filtro ricerca"
```

---

## Task 5: Export CSV "Report Download" lato backend

**Files:**
- Create: `apps/backend/src/campaigns/download-report-csv.util.ts`
- Test: `apps/backend/src/campaigns/download-report-csv.util.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `escapeCsvField` (Task 1).
- Produces: `buildDownloadReportCsv(rows: DownloadReportRowDto[]): string`, `CampaignsService.getDownloadReportRows(campaignId): Promise<DownloadReportRowDto[]>`, endpoint `GET :id/export-download-report.csv`. Sostituisce `handleExportDownloadReport` client-side in Task 9.

- [ ] **Step 1: Scrivi il test del builder CSV**

```typescript
// apps/backend/src/campaigns/download-report-csv.util.spec.ts
import { buildDownloadReportCsv } from './download-report-csv.util';

describe('buildDownloadReportCsv', () => {
  it('produce header e righe separate da ; con i campi attesi', () => {
    const csv = buildDownloadReportCsv([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        email: 'mario@example.com',
        pec: null,
        status: 'sent',
        downloadCount: 2,
        lastDownloadedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"Email";"PEC";"Stato Invio";"Download Effettuati";"Data Ultimo Download"');
    expect(lines[1]).toContain('"AAA1"');
    expect(lines[1]).toContain('"mario@example.com"');
    expect(lines[1]).toContain('"2"');
  });

  it('sostituisce campi null con stringa vuota', () => {
    const csv = buildDownloadReportCsv([
      { codiceFiscale: 'BBB2', fullName: null, email: null, pec: null, status: 'pending', downloadCount: 0, lastDownloadedAt: null },
    ]);
    const line = csv.split('\n')[1];
    expect(line).toBe('"BBB2";"";"";"";"pending";"0";""');
  });

  it('ritorna solo l\'header quando non ci sono righe', () => {
    expect(buildDownloadReportCsv([]).split('\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest download-report-csv --maxWorkers=2`
Expected: FAIL con "Cannot find module './download-report-csv.util'"

- [ ] **Step 3: Aggiungi il DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, in fondo al file:

```typescript
export interface DownloadReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
}
```

- [ ] **Step 4: Implementa il builder**

```typescript
// apps/backend/src/campaigns/download-report-csv.util.ts
import type { DownloadReportRowDto } from './dto/campaign-stats.dto';
import { escapeCsvField } from './csv.util';

export function buildDownloadReportCsv(rows: DownloadReportRowDto[]): string {
  const header = ['Codice Fiscale', 'Nominativo', 'Email', 'PEC', 'Stato Invio', 'Download Effettuati', 'Data Ultimo Download']
    .map(escapeCsvField)
    .join(';');

  const lines = rows.map((r) =>
    [
      r.codiceFiscale,
      r.fullName ?? '',
      r.email ?? '',
      r.pec ?? '',
      r.status,
      String(r.downloadCount),
      r.lastDownloadedAt ? new Date(r.lastDownloadedAt).toLocaleString('it-IT') : '',
    ]
      .map(escapeCsvField)
      .join(';'),
  );

  return [header, ...lines].join('\n');
}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest download-report-csv --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 6: Scrivi il test del metodo service**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dopo il blocco `describe('CampaignsService.getRecipientStats', ...)` (o vicino ad esso):

```typescript
describe('CampaignsService.getDownloadReportRows', () => {
  it('mappa i destinatari della campagna nel formato report', async () => {
    mockRecipientRepo.find = jest.fn().mockResolvedValueOnce([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        email: 'mario@example.com',
        pec: null,
        status: RecipientStatus.SENT,
        downloadCount: 1,
        lastDownloadedAt: new Date('2026-07-01T10:00:00Z'),
      },
    ]);

    const result = await service.getDownloadReportRows('c1');

    expect(mockRecipientRepo.find).toHaveBeenCalledWith({
      where: { campaignId: 'c1' },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt'],
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        email: 'mario@example.com',
        pec: null,
        status: 'sent',
        downloadCount: 1,
        lastDownloadedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
  });
});
```

- [ ] **Step 7: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getDownloadReportRows`
Expected: FAIL con "service.getDownloadReportRows is not a function"

- [ ] **Step 8: Implementa il metodo nel service**

Aggiorna l'import DTO in `campaigns.service.ts` aggiungendo `DownloadReportRowDto`. Aggiungi il metodo subito dopo `getRecipientStats` (Task 4):

```typescript
  async getDownloadReportRows(campaignId: string): Promise<DownloadReportRowDto[]> {
    const rows = await this.recipientRepo.find({
      where: { campaignId },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt'],
      order: { createdAt: 'ASC' },
    });

    return rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      email: r.email,
      pec: r.pec,
      status: r.status,
      downloadCount: r.downloadCount,
      lastDownloadedAt: r.lastDownloadedAt ? r.lastDownloadedAt.toISOString() : null,
    }));
  }
```

- [ ] **Step 9: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getDownloadReportRows`
Expected: PASS (1 test)

- [ ] **Step 10: Aggiungi l'endpoint controller CSV**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi l'import:

```typescript
import { buildDownloadReportCsv } from './download-report-csv.util';
```

Aggiungi l'endpoint dopo `getRecipientStats` (Task 4), prima di `@Delete(':id')`:

```typescript
  @Get(':id/export-download-report.csv')
  async exportDownloadReportCsv(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const rows = await this.campaignsService.getDownloadReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_download_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildDownloadReportCsv(rows));
  }
```

- [ ] **Step 11: Scrivi il test controller**

Aggiungi `getDownloadReportRows: jest.fn()` a `mockService` e, in fondo a `campaigns.controller.spec.ts`:

```typescript
  describe('exportDownloadReportCsv', () => {
    it('imposta gli header CSV e invia il body generato dal service', async () => {
      mockService.getDownloadReportRows = jest.fn().mockResolvedValue([
        { codiceFiscale: 'AAA1', fullName: null, email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null },
      ]);
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportDownloadReportCsv('uuid-1', res);

      expect(mockService.getDownloadReportRows).toHaveBeenCalledWith('uuid-1');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('AAA1'));
    });
  });
```

- [ ] **Step 12: Esegui i test, type-check, suite intera**

Run: `docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/campaigns/download-report-csv.util.ts apps/backend/src/campaigns/download-report-csv.util.spec.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): export CSV report download generato lato server"
```

---

## Task 6: Rimuovi eager-load di recipients/attempts da findOne

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Prerequisiti:** richiede che il frontend non dipenda più da `campaign.recipients` — esegui questo task **dopo** Task 9 (tabella paginata) e Task 10 (export CSV backend) lato frontend, non prima. Se eseguito con `subagent-driven-development`, questo task va schedulato per ultimo tra i task backend/frontend che toccano `campaign.recipients`.

**Interfaces:**
- Produces: `findOne` ritorna `Campaign` senza `recipients` popolato (relazione non più eager-loaded). Nessun impatto sulla firma pubblica (il campo `recipients` diventa semplicemente assente/vuoto nell'oggetto).

- [ ] **Step 1: Verifica che nessun altro consumer backend usi `campaign.recipients`**

Run: `docker compose exec backend grep -rn "campaign.recipients\|\.recipients\[" src/campaigns src/queue 2>/dev/null`
Expected: nessuna occorrenza che legga `campaign.recipients` dopo una chiamata a `findOne` (le query dirette su `recipientRepo` non sono affette)

- [ ] **Step 2: Modifica `findOne`**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci:

```typescript
  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOne({
      where: { id },
      relations: ['recipients', 'recipients.attempts'],
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }
```

con:

```typescript
  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }
```

- [ ] **Step 3: Aggiorna il test esistente di `findOne`**

Trova il test di `findOne` in `campaigns.service.spec.ts` che verifica la chiamata con `relations` e aggiornalo per verificare `findOneBy({ id: ... })` invece di `findOne({ where, relations })`.

- [ ] **Step 4: Esegui i test, type-check, suite intera**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t findOne`
Expected: PASS

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (se emergono errori di tipo su `campaign.recipients` altrove, sono consumer non ancora migrati — fermati e segnala, non forzare `as any`)

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "perf(backend): rimuovi eager-load di recipients/attempts dal dettaglio campagna"
```

---

## Task 7: Wizard — CF non conforme al pattern App IO scartato in validazione

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Nessuna nuova interfaccia esposta — modifica solo la logica interna di `handleWizValidation`.

- [ ] **Step 1: Individua la funzione**

Run: `docker compose exec frontend-admin grep -n "const handleWizValidation" src/App.tsx`
Expected: una corrispondenza (riga ~1939)

- [ ] **Step 2: Aggiungi il pattern CF reale e la nuova regola**

In `apps/frontend-admin/src/App.tsx`, dentro `handleWizValidation`, dopo la dichiarazione di `pivaRegex` (riga 1946):

```typescript
    const pivaRegex = /^\d{11}$/;
    // Pattern reale del Codice Fiscale (non un generico alfanumerico a 16
    // caratteri): App IO/PagoPA rifiuta con HTTP 400 qualunque valore che non
    // rispetti questo formato, incluse le Partite IVA — che il controllo
    // generico sotto accetta come alternativa valida per gli altri canali.
    const cfAppIoRegex = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/i;
```

Sostituisci il blocco di validazione CF (righe 2006-2023):

```typescript
      } else if (cfField && row[cfField]) {
        const valClean = row[cfField].trim().replace(/\s/g, '');
        const isCf = cfRegex.test(valClean);
        const isPiva = pivaRegex.test(valClean);
        if (!isCf && !isPiva) {
          if (isCfMandatory) {
            // Only block when CF/P.IVA is strictly required (App IO, SEND)
            errors.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], err: 'Codice Fiscale (16 caratteri) o P.IVA (11 cifre) non valida' });
            isRowValid = false;
          } else {
            // Warn only — include the row anyway
            warnings.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], warn: 'Formato non standard (atteso CF a 16 caratteri o P.IVA a 11 cifre) — il record verrà incluso' });
          }
        }
      } else if (isCfMandatory && !row[cfField]) {
```

con:

```typescript
      } else if (cfField && row[cfField]) {
        const valClean = row[cfField].trim().replace(/\s/g, '');
        const isCf = cfRegex.test(valClean);
        const isPiva = pivaRegex.test(valClean);
        if (wizAppIoInvolved && !cfAppIoRegex.test(valClean)) {
          // App IO accetta solo CF di persona fisica: una P.IVA (o qualunque
          // valore fuori pattern) qui va scartata subito, altrimenti l'errore
          // emerge solo alla spedizione reale (HTTP 400 da PagoPA) dopo aver
          // già consumato un tentativo.
          errors.push({ row: rowNum, field: 'Codice Fiscale (App IO)', val: row[cfField], err: 'Codice Fiscale non valido per App IO: richiesto un CF di persona fisica, non una Partita IVA o un valore fuori formato' });
          isRowValid = false;
        } else if (!isCf && !isPiva) {
          if (isCfMandatory) {
            // Only block when CF/P.IVA is strictly required (App IO, SEND)
            errors.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], err: 'Codice Fiscale (16 caratteri) o P.IVA (11 cifre) non valida' });
            isRowValid = false;
          } else {
            // Warn only — include the row anyway
            warnings.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], warn: 'Formato non standard (atteso CF a 16 caratteri o P.IVA a 11 cifre) — il record verrà incluso' });
          }
        }
      } else if (isCfMandatory && !row[cfField]) {
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica manuale in browser**

Apri `http://localhost:3000`, login `admin`/`admin`, wizard invio massivo, canale App IO, carica un CSV con una riga con Partita IVA (es. `02219870686`) al posto del CF → deve comparire come errore bloccante "Codice Fiscale non valido per App IO...", la riga non deve finire tra i `valid` (verificare che il contatore "righe verranno escluse" la includa).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): scarta nel wizard i CF non conformi al pattern App IO"
```

---

## Task 8: Tabella "Destinatari Caricati" paginata con ricerca

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET :id/stats/recipients?page&pageSize&search` (Task 4), `apiFetch` (esistente), `openNotificationDetail` (esistente).
- Produces: stato `recipientsPage` (dati pagina corrente), `recipientsSearch`, `recipientsPageNum`; funzione `fetchRecipientsPage(campaignId, page, search)`.

- [ ] **Step 1: Aggiungi stato dedicato**

Vicino alla dichiarazione di `campaignFailures` (App.tsx riga ~655), aggiungi:

```tsx
  const [recipientsPage, setRecipientsPage] = useState<{ page: number; pageSize: number; total: number; items: Array<{ id: string; fullName: string | null; codiceFiscale: string; email: string | null; pec: string | null; status: string; downloadCount: number }> } | null>(null);
  const [recipientsSearch, setRecipientsSearch] = useState('');
  const [recipientsPageNum, setRecipientsPageNum] = useState(1);
```

- [ ] **Step 2: Aggiungi la funzione di fetch**

Vicino a `fetchDownloadChannelStats` (App.tsx riga ~2504), aggiungi:

```tsx
  const RECIPIENTS_PAGE_SIZE = 50;

  const fetchRecipientsPage = async (campaignId: string, page: number, search: string) => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(RECIPIENTS_PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      const res = await apiFetch(`/campaigns/${campaignId}/stats/recipients?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setRecipientsPage(data);
    } catch {
      // Non bloccante: la tabella resta sullo stato precedente.
    }
  };
```

- [ ] **Step 3: Aggancia il fetch iniziale a `handleCampaignClick` e resetta lo stato**

Nel blocco `handleCampaignClick` (riga ~2437), aggiungi il reset e la prima chiamata:

```tsx
    setRecipientsPage(null);
    setRecipientsSearch('');
    setRecipientsPageNum(1);
    fetchRecipientsPage(id, 1, '');
```

- [ ] **Step 4: Aggiungi un `useEffect` per ricaricare su cambio pagina/ricerca (debounce sulla ricerca)**

Vicino agli altri `useEffect` del dettaglio campagna, aggiungi:

```tsx
  useEffect(() => {
    if (!selectedCampaignId || view !== 'campaign-detail') return;
    const handle = setTimeout(() => {
      fetchRecipientsPage(selectedCampaignId, recipientsPageNum, recipientsSearch);
    }, 300);
    return () => clearTimeout(handle);
  }, [selectedCampaignId, view, recipientsPageNum, recipientsSearch]);
```

- [ ] **Step 5: Sostituisci la tabella**

Individua il blocco che renderizza `campaign.recipients.map((r) => (...))` nella card "Destinatari Caricati" (`grep -n "campaign.recipients.map" src/App.tsx` per la riga esatta dopo i task precedenti). Sostituisci l'header della card (che oggi mostra `Destinatari Caricati ({campaign.recipients.length})`) e il corpo tabella con una versione basata su `recipientsPage`:

```tsx
                <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
                  <h3 className="h6 mb-0 fw-bold text-dark">
                    <i className="fas fa-users me-2 text-primary"></i>Destinatari Caricati ({recipientsPage?.total ?? 0})
                  </h3>
                  <input
                    type="text"
                    className="form-control form-control-sm"
                    style={{ maxWidth: 260 }}
                    placeholder="Cerca per nominativo o CF..."
                    value={recipientsSearch}
                    onChange={(e) => { setRecipientsSearch(e.target.value); setRecipientsPageNum(1); }}
                  />
                </div>
                <div className="card-body p-0">
                  {!recipientsPage || recipientsPage.items.length === 0 ? (
                    <div className="p-4 text-center text-muted">Nessun destinatario trovato</div>
                  ) : (
                    <>
                      <table className="table table-sm mb-0">
                        <thead>
                          <tr>
                            <th>CODICE FISCALE</th>
                            <th>NOMINATIVO</th>
                            <th>CONTATTI (EMAIL/PEC)</th>
                            <th>STATO NOTIFICA</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recipientsPage.items.map((r) => (
                            <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.id)}>
                              <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
                              <td>{r.fullName || '—'}</td>
                              <td>{r.email || r.pec || '—'}</td>
                              <td><span className={`badge bg-${r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'secondary'}`}>{r.status.toUpperCase()}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="d-flex justify-content-between align-items-center p-2 border-top">
                        <span className="text-muted small">
                          Pagina {recipientsPage.page} di {Math.max(1, Math.ceil(recipientsPage.total / recipientsPage.pageSize))}
                        </span>
                        <div className="btn-group btn-group-sm">
                          <button className="btn btn-outline-secondary" disabled={recipientsPageNum <= 1} onClick={() => setRecipientsPageNum((p) => p - 1)}>Precedente</button>
                          <button className="btn btn-outline-secondary" disabled={recipientsPageNum >= Math.ceil(recipientsPage.total / recipientsPage.pageSize)} onClick={() => setRecipientsPageNum((p) => p + 1)}>Successiva</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
```

Nota: adatta le classi esatte (`table-sm`, badge, ecc.) allo stile già presente nel blocco che stai sostituendo — l'obiettivo è mantenere l'aspetto visivo attuale, cambia solo la sorgente dati (da `campaign.recipients` in memoria a `recipientsPage` paginato) e l'aggiunta della barra di ricerca + controlli pagina.

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 7: Verifica manuale in browser**

Apri una campagna con molti destinatari: la tabella deve caricare velocemente (una pagina da 50), la ricerca per nominativo/CF deve filtrare dopo un breve debounce, i controlli Precedente/Successiva devono cambiare pagina, il click su una riga deve aprire l'anteprima notifica.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "perf(frontend-admin): tabella destinatari campagna paginata con ricerca"
```

---

## Task 9: Export "Report Download" verso l'endpoint backend

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET :id/export-download-report.csv` (Task 5), `apiFetch` (esistente).

- [ ] **Step 1: Sostituisci `handleExportDownloadReport`**

Sostituisci la funzione esistente (righe 1778-1814, costruzione CSV client-side da `campaign.recipients`) con:

```tsx
  const handleExportDownloadReport = async () => {
    if (!campaign) return;
    try {
      const res = await apiFetch(`/campaigns/${campaign.id}/export-download-report.csv`);
      if (!res.ok) {
        alert('Errore durante il download del report');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `report_download_campagna_${campaign.id.slice(0, 8)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download del report');
    }
  };
```

- [ ] **Step 2: Aggiorna la condizione che mostra il bottone**

Il bottone "Esporta Report Download" (riga ~5749) è oggi gated su `campaign.recipients && campaign.recipients.length > 0`. Con Task 6 `campaign.recipients` non è più popolato: sostituisci la condizione con `(campaign?.totalRecipients ?? 0) > 0` (campo aggregato già presente su `Campaign`, non richiede fetch aggiuntivo).

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica manuale in browser**

Click "Esporta Report Download" su una campagna con destinatari → deve scaricare un CSV non vuoto con le colonne Codice Fiscale/Nominativo/Email/PEC/Stato Invio/Download Effettuati/Data Ultimo Download.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "perf(frontend-admin): export report download generato lato server invece che da campaign.recipients"
```

---

## Task 10: Pannello errori raggruppato per motivazione con retry bulk

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET :id/failures/by-reason` (Task 3), `POST :id/recipients/retry-bulk` (Task 3), `apiFetch` (esistente).
- Produces: stato `failureGroups`, funzione `fetchFailureGroups(campaignId)`, `handleRetryGroup(group)`.

- [ ] **Step 1: Aggiungi stato**

Vicino a `campaignFailures` (riga ~655), aggiungi:

```tsx
  const [failureGroups, setFailureGroups] = useState<Array<{ errorMessage: string; count: number; recipientIds: string[] }>>([]);
  const [retryingGroup, setRetryingGroup] = useState<string | null>(null);
```

- [ ] **Step 2: Aggiungi fetch e handler retry**

Vicino a `fetchCampaignFailures` (riga ~860), aggiungi:

```tsx
  const fetchFailureGroups = async (campaignId: string) => {
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/failures/by-reason`);
      if (!res.ok) return;
      setFailureGroups(await res.json());
    } catch {
      // Non bloccante.
    }
  };

  const handleRetryGroup = async (group: { errorMessage: string; recipientIds: string[] }) => {
    if (!selectedCampaignId) return;
    if (!confirm(`Rimettere in coda ${group.recipientIds.length} destinatari con errore "${group.errorMessage}"?`)) return;
    setRetryingGroup(group.errorMessage);
    try {
      const res = await apiFetch(`/campaigns/${selectedCampaignId}/recipients/retry-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientIds: group.recipientIds }),
      });
      if (res.ok) {
        const result = await res.json();
        alert(`${result.requeued} destinatari rimessi in coda${result.failed.length > 0 ? `, ${result.failed.length} non ritentabili` : ''}`);
        await fetchFailureGroups(selectedCampaignId);
        await fetchCampaignDetail(selectedCampaignId);
      }
    } finally {
      setRetryingGroup(null);
    }
  };
```

- [ ] **Step 3: Aggancia il fetch a `handleCampaignClick`**

Aggiungi accanto a `fetchCampaignFailures(id)` (riga ~2487):

```tsx
    fetchFailureGroups(id);
```

E resetta lo stato insieme agli altri reset in cima alla funzione:

```tsx
    setFailureGroups([]);
```

- [ ] **Step 4: Sostituisci il rendering del pannello "Destinatari con Invio Fallito"**

Individua il blocco `{campaignFailures.length > 0 && (...)}` (riga ~5646) che renderizza la lista piatta `campaignFailures.map(f => (...))`. Sostituisci il corpo interno (mantenendo l'header della card) con un rendering per gruppo:

```tsx
                        {failureGroups.length > 0 && (
                          <div className="card shadow-sm mt-4 border-danger">
                            <div className="card-header bg-white py-3 border-bottom">
                              <h3 className="h6 mb-0 fw-bold text-danger">
                                <i className="fas fa-triangle-exclamation me-2"></i>
                                Destinatari con invio fallito ({campaignFailures.length}) — raggruppati per motivo
                              </h3>
                            </div>
                            <div className="card-body p-0">
                              <table className="table table-sm mb-0">
                                <thead>
                                  <tr>
                                    <th>MOTIVO ERRORE</th>
                                    <th className="text-end">DESTINATARI</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {failureGroups.map((g) => (
                                    <tr key={g.errorMessage}>
                                      <td style={{ maxWidth: 400 }} className="text-break">{g.errorMessage}</td>
                                      <td className="text-end fw-bold">{g.count}</td>
                                      <td className="text-end">
                                        <button
                                          className="btn btn-sm btn-outline-primary"
                                          disabled={retryingGroup === g.errorMessage}
                                          onClick={() => handleRetryGroup(g)}
                                        >
                                          {retryingGroup === g.errorMessage ? 'Rimetto in coda...' : 'Rimetti in coda tutti'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
```

Nota: `campaignFailures` resta popolato (Task 2 non ne cambia la firma) e continua a fornire il conteggio totale nell'header; solo il corpo tabella cambia sorgente/vista da lista piatta a gruppi.

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 6: Verifica manuale in browser**

Campagna con destinatari FAILED: il pannello deve mostrare gruppi per motivo errore con conteggio, click "Rimetti in coda tutti" su un gruppo deve chiedere conferma, rimettere in coda tutti i destinatari del gruppo e aggiornare sia i gruppi sia i contatori della campagna.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): errori campagna raggruppati per motivo con retry bulk"
```

---

## Task 11: Grafico fallback per campagne App IO senza co-consegna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `campaign.sentCount`, `campaign.failedCount`, `downloadByChannel` (tutti già disponibili nello stato esistente), `Pie`/`PieChart`/`Cell` (già importati da recharts, Task precedente di oggi).

- [ ] **Step 1: Individua il punto di inserimento**

La card "Download per Combinazione Canali" (`{downloadCrossChannel && (...)}`, App.tsx ~5814) è gated su co-consegna. Aggiungi subito dopo la sua chiusura un ramo alternativo per quando NON c'è co-consegna ma il canale primario è APP_IO:

- [ ] **Step 2: Aggiungi la card fallback**

```tsx
                    {!downloadCrossChannel && campaign.channelType === 'APP_IO' && (
                      <div className="card shadow-sm mt-4">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark">
                            <i className="fas fa-chart-pie me-2 text-primary"></i>Esito Invio e Download
                          </h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                              <Pie
                                data={[
                                  { label: 'Inviati con successo', value: campaign.sentCount },
                                  { label: 'Falliti', value: campaign.failedCount },
                                ]}
                                dataKey="value"
                                nameKey="label"
                                cx="50%"
                                cy="50%"
                                outerRadius={80}
                                label
                              >
                                <Cell fill="var(--bi-success, #198754)" />
                                <Cell fill="var(--bi-danger, #dc3545)" />
                              </Pie>
                              <Tooltip />
                              <Legend />
                            </PieChart>
                          </ResponsiveContainer>
                          {downloadByChannel && (
                            <table className="table table-sm mb-0 mt-2">
                              <tbody>
                                {Object.entries(downloadByChannel).map(([channel, count]) => (
                                  <tr key={channel}>
                                    <td>{channel}</td>
                                    <td className="text-end fw-bold">{count}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    )}
```

Nota: `campaign.sentCount`/`campaign.failedCount` sono i campi aggregati già presenti sull'oggetto `Campaign` (usati oggi nella sezione "Stato dell'Invio" in cima alla pagina) — nessun nuovo fetch necessario.

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica manuale in browser**

Apri la campagna App IO pura (senza co-consegna) usata come caso originale del problema: deve comparire la nuova card con il pie chart SENT/FAILED e la tabella download per canale sotto. Apri una campagna con co-consegna App IO configurata: deve continuare a comparire la card esistente "Download per Combinazione Canali", non questa nuova.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): grafico fallback esito/download per campagne App IO senza co-consegna"
```

---

## Task 12: Verifica finale end-to-end

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun fallimento rispetto alla baseline pulita

- [ ] **Step 2: Type-check completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 3: Verifica manuale sulla campagna reale del problema originale**

Apri la campagna "Acconto Tari 2026 APP IO" (20591 destinatari, 12940 FAILED) in browser:
- il dettaglio deve caricare in tempo ragionevole (non più tutti i 20591 recipients+attempts in un colpo)
- la tabella destinatari deve paginare e la ricerca per nominativo/CF deve funzionare
- il pannello errori deve mostrare i gruppi per motivo (incluso l'errore App IO 400 sul CF/P.IVA visto in origine, se ancora presente tra i FAILED storici)
- deve comparire il grafico fallback SENT/FAILED + download per canale
- l'export CSV deve scaricare correttamente

- [ ] **Step 4: Nessun commit aggiuntivo (task di sola verifica)**
