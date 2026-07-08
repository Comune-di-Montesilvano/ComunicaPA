# Statistiche Download — Dettaglio Campagna e Vista Globale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere funzionante l'analisi "chi ha scaricato cosa su quale canale" — grafico incrocio canali nel dettaglio campagna, click destinatario → anteprima con storico download, e vista Statistiche globale (oggi mock) con dati reali, filtro data, trend, classifica campagne e lista "mai scaricato" esportabile.

**Architecture:** Backend: nuovi metodi su `CampaignsService` (query aggregate TypeORM su `Recipient`/`Campaign`/`DownloadEvent`) + 3 nuovi endpoint su `CampaignsController`. Frontend: riuso del componente modale già esistente (`notifDetail`) per l'anteprima; nuovi grafici Recharts nel dettaglio campagna e nella vista Statistiche, sostituendo l'SVG mock.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 + Vite (frontend), nuova dipendenza `recharts` per il frontend-admin.

## Global Constraints

- Tutti i comandi girano in Docker — niente Node/pnpm sull'host (vedi CLAUDE.md).
- Test backend SEMPRE con `--maxWorkers=2`.
- Type-check frontend con `tsc -p tsconfig.app.json --noEmit`, mai `tsc -b`.
- Nuove dipendenze pnpm richiedono il rituale completo: lockfile via container `node:22-alpine`, rebuild immagine, rimozione volume `node_modules` (nome verificato con `docker volume ls`).
- Baseline test: nessun fallimento noto — qualsiasi nuovo fallimento è una regressione, non baseline nota.
- `CITIZEN_PORTAL` è trattato come equivalente al canale primario nella metrica cross-channel (non un canale terzo).
- Filtro data per la vista globale applicato uniformemente su `campaign.createdAt` (non su `recipient.createdAt` né `downloadEvent.downloadedAt`) — semplificazione decisa in plan: tutte le metriche globali sono ancorate alla data di creazione della campagna.
- Nessuna modifica alla modale `notifDetail` esistente (già mostra `downloads[]`).
- Nessun nuovo importer/creator di campagne, nessuna modifica al frontend cittadino (fuori ambito, vedi spec).

**Spec:** `docs/superpowers/specs/2026-07-08-statistiche-download-design.md`

---

## Task 1: Helper puri per statistiche globali (global-stats.util.ts)

**Files:**
- Create: `apps/backend/src/campaigns/global-stats.util.ts`
- Test: `apps/backend/src/campaigns/global-stats.util.spec.ts`

**Interfaces:**
- Produces: `mergeMonthlyTrend(sentRows, downloadedRows): MonthlyTrendPoint[]`, `computeDownloadPercentage(downloaded: number, total: number): number`, `buildDateRangeWhere(alias: string, dateFrom?: string, dateTo?: string): { sql: string; params: Record<string, string> }` — usati da Task 3 e Task 4.

- [ ] **Step 1: Scrivi i test**

```typescript
// apps/backend/src/campaigns/global-stats.util.spec.ts
import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere } from './global-stats.util';

describe('mergeMonthlyTrend', () => {
  it('unisce mesi con invii e download coincidenti', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-06', sent: '50' }, { month: '2026-07', sent: '40' }],
      [{ month: '2026-06', downloaded: '30' }],
    );
    expect(result).toEqual([
      { month: '2026-06', sent: 50, downloaded: 30 },
      { month: '2026-07', sent: 40, downloaded: 0 },
    ]);
  });

  it('include un mese presente solo nei download (nessun invio quel mese)', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-06', sent: '10' }],
      [{ month: '2026-07', downloaded: '5' }],
    );
    expect(result).toEqual([
      { month: '2026-06', sent: 10, downloaded: 0 },
      { month: '2026-07', sent: 0, downloaded: 5 },
    ]);
  });

  it('ordina i mesi cronologicamente indipendentemente dall\'ordine di input', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-07', sent: '1' }, { month: '2026-06', sent: '2' }],
      [],
    );
    expect(result.map((r) => r.month)).toEqual(['2026-06', '2026-07']);
  });

  it('ritorna array vuoto con input vuoti', () => {
    expect(mergeMonthlyTrend([], [])).toEqual([]);
  });
});

describe('computeDownloadPercentage', () => {
  it('arrotonda la percentuale', () => {
    expect(computeDownloadPercentage(1, 3)).toBe(33);
  });

  it('ritorna 0 quando il totale è zero (nessuna divisione per zero)', () => {
    expect(computeDownloadPercentage(0, 0)).toBe(0);
  });
});

describe('buildDateRangeWhere', () => {
  it('ritorna 1=1 senza parametri quando nessuna data è fornita', () => {
    expect(buildDateRangeWhere('c')).toEqual({ sql: '1=1', params: {} });
  });

  it('applica solo dateFrom quando dateTo è assente', () => {
    expect(buildDateRangeWhere('c', '2026-06-01')).toEqual({
      sql: 'c.createdAt >= :dateFrom',
      params: { dateFrom: '2026-06-01' },
    });
  });

  it('applica solo dateTo quando dateFrom è assente', () => {
    expect(buildDateRangeWhere('c', undefined, '2026-07-08')).toEqual({
      sql: "c.createdAt < (:dateTo::date + interval '1 day')",
      params: { dateTo: '2026-07-08' },
    });
  });

  it('applica entrambi i filtri con AND', () => {
    expect(buildDateRangeWhere('c', '2026-06-01', '2026-07-08')).toEqual({
      sql: "c.createdAt >= :dateFrom AND c.createdAt < (:dateTo::date + interval '1 day')",
      params: { dateFrom: '2026-06-01', dateTo: '2026-07-08' },
    });
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest global-stats.util --maxWorkers=2`
Expected: FAIL con "Cannot find module './global-stats.util'"

- [ ] **Step 3: Scrivi l'implementazione**

```typescript
// apps/backend/src/campaigns/global-stats.util.ts

export interface MonthlySentRow {
  month: string;
  sent: string | number;
}

export interface MonthlyDownloadedRow {
  month: string;
  downloaded: string | number;
}

export interface MonthlyTrendPoint {
  month: string;
  sent: number;
  downloaded: number;
}

/**
 * Unisce due serie mensili (invii e download) in un'unica lista ordinata
 * cronologicamente, riempiendo con 0 i mesi presenti in una sola serie.
 */
export function mergeMonthlyTrend(
  sentRows: MonthlySentRow[],
  downloadedRows: MonthlyDownloadedRow[],
): MonthlyTrendPoint[] {
  const byMonth = new Map<string, MonthlyTrendPoint>();

  for (const row of sentRows) {
    byMonth.set(row.month, { month: row.month, sent: Number(row.sent), downloaded: 0 });
  }
  for (const row of downloadedRows) {
    const existing = byMonth.get(row.month);
    if (existing) {
      existing.downloaded = Number(row.downloaded);
    } else {
      byMonth.set(row.month, { month: row.month, sent: 0, downloaded: Number(row.downloaded) });
    }
  }

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export function computeDownloadPercentage(downloaded: number, total: number): number {
  return total > 0 ? Math.round((downloaded / total) * 100) : 0;
}

export interface DateRangeWhere {
  sql: string;
  params: Record<string, string>;
}

/**
 * Costruisce la clausola WHERE per il filtro data su un alias di query
 * builder TypeORM. Ritorna '1=1' (nessun filtro) quando dateFrom/dateTo
 * sono entrambi assenti, per poter sempre passare il risultato a
 * qb.where(...)/qb.andWhere(...) senza controlli condizionali sparsi.
 */
export function buildDateRangeWhere(alias: string, dateFrom?: string, dateTo?: string): DateRangeWhere {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (dateFrom) {
    clauses.push(`${alias}.createdAt >= :dateFrom`);
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    clauses.push(`${alias}.createdAt < (:dateTo::date + interval '1 day')`);
    params.dateTo = dateTo;
  }

  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest global-stats.util --maxWorkers=2`
Expected: PASS (9 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/global-stats.util.ts apps/backend/src/campaigns/global-stats.util.spec.ts
git commit -m "feat(backend): helper puri per aggregazione statistiche globali"
```

---

## Task 2: Cross-channel download stats per campagna

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `resolveSecondaryAppIoConfig` (già importato in campaigns.service.ts), `this.campaignRepo`, `this.recipientRepo`, `this.downloadEventRepo` (già iniettati nel costruttore).
- Produces: `CampaignsService.getDownloadCrossChannelStats(campaignId: string): Promise<DownloadCrossChannelStatsDto | null>`, endpoint `GET admin/campaigns/:id/download-cross-channel-stats` → `{ campaignId: string; stats: DownloadCrossChannelStatsDto | null }`. Usato da Task 7 (frontend).

- [ ] **Step 1: Scrivi i test (falliscono: metodo non esiste)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dopo il blocco `describe('getDownloadChannelStats', ...)` (circa riga 496, prima di `describe('remove', ...)`):

```typescript
  describe('getDownloadCrossChannelStats', () => {
    it('ritorna null se la campagna non ha co-consegna App IO configurata', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toBeNull();
      expect(mockRecipientRepo.find).not.toHaveBeenCalled();
    });

    it('ritorna tutti zero se la campagna non ha destinatari', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([]);

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toEqual({ primaryOnly: 0, appIoOnly: 0, both: 0, none: 0 });
    });

    it('classifica primario/appIo/entrambi/nessuno, trattando CITIZEN_PORTAL come primario', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelType: 'EMAIL',
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary' },
        { id: 'r-appio' },
        { id: 'r-both' },
        { id: 'r-citizen-portal' },
        { id: 'r-none' },
      ]);
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { recipientId: 'r-primary', channel: 'EMAIL' },
          { recipientId: 'r-appio', channel: 'APP_IO' },
          { recipientId: 'r-both', channel: 'EMAIL' },
          { recipientId: 'r-both', channel: 'APP_IO' },
          { recipientId: 'r-citizen-portal', channel: 'CITIZEN_PORTAL' },
        ]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toEqual({ primaryOnly: 2, appIoOnly: 1, both: 1, none: 1 });
    });
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getDownloadCrossChannelStats`
Expected: FAIL con "service.getDownloadCrossChannelStats is not a function"

- [ ] **Step 3: Aggiungi il DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, aggiungi in fondo al file:

```typescript
export interface DownloadCrossChannelStatsDto {
  primaryOnly: number;
  appIoOnly: number;
  both: number;
  none: number;
}
```

- [ ] **Step 4: Implementa il metodo nel service**

In `apps/backend/src/campaigns/campaigns.service.ts`:

Aggiorna l'import dei tipi (riga 27):

```typescript
import type { CampaignStatsDto, RecipientStatsPageDto, ChannelBreakdownDto, DownloadCrossChannelStatsDto } from './dto/campaign-stats.dto';
```

Aggiungi il metodo subito dopo `getDownloadChannelStats` (dopo la riga 487, prima di `async getFailures`):

```typescript
  /**
   * Incrocio canali di download per destinatario: su quale combinazione
   * (primario, App IO, entrambi, nessuno) ha scaricato ciascun destinatario.
   * CITIZEN_PORTAL è trattato come equivalente al canale primario (stesso
   * documento scaricato dal portale cittadino invece che dal link email/PEC),
   * non è una categoria terza per questa metrica — resta visibile
   * separatamente in getDownloadChannelStats(). Ritorna null se la campagna
   * non ha co-consegna App IO configurata, come getChannelBreakdown().
   */
  async getDownloadCrossChannelStats(campaignId: string): Promise<DownloadCrossChannelStatsDto | null> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    if (!resolveSecondaryAppIoConfig(campaign.channelConfig)) return null;

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id'] });
    const result: DownloadCrossChannelStatsDto = { primaryOnly: 0, appIoOnly: 0, both: 0, none: 0 };
    if (recipients.length === 0) return result;

    const rows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .select('de.recipientId', 'recipientId')
      .addSelect('de.channel', 'channel')
      .where('r.campaignId = :campaignId', { campaignId })
      .getRawMany<{ recipientId: string; channel: string }>();

    const channelsByRecipient = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!channelsByRecipient.has(row.recipientId)) channelsByRecipient.set(row.recipientId, new Set());
      channelsByRecipient.get(row.recipientId)!.add(row.channel);
    }

    for (const recipient of recipients) {
      const channels = channelsByRecipient.get(recipient.id);
      if (!channels || channels.size === 0) {
        result.none++;
        continue;
      }
      const hasAppIo = channels.has('APP_IO');
      const hasPrimary = channels.has(campaign.channelType) || channels.has('CITIZEN_PORTAL');
      if (hasAppIo && hasPrimary) result.both++;
      else if (hasAppIo) result.appIoOnly++;
      else if (hasPrimary) result.primaryOnly++;
      else result.none++;
    }

    return result;
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getDownloadCrossChannelStats`
Expected: PASS (3 test)

- [ ] **Step 6: Aggiungi l'endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi subito dopo `getDownloadChannelStats` (dopo riga 297, prima di `@Get(':id/failures')`):

```typescript
  @Get(':id/download-cross-channel-stats')
  async getDownloadCrossChannelStats(@Param('id', ParseUUIDPipe) id: string) {
    const stats = await this.campaignsService.getDownloadCrossChannelStats(id);
    return { campaignId: id, stats };
  }
```

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 8: Esegui l'intera suite backend (baseline invariata)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento rispetto alla baseline pulita

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): endpoint incrocio canali download per campagna"
```

---

## Task 3: Endpoint statistiche globali

**Files:**
- Create: `apps/backend/src/campaigns/dto/global-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `mergeMonthlyTrend`, `computeDownloadPercentage`, `buildDateRangeWhere` da Task 1 (`./global-stats.util`).
- Produces: `CampaignsService.getGlobalStats(dateFrom?: string, dateTo?: string): Promise<GlobalStatsDto>`, endpoint `GET admin/campaigns/stats/global?dateFrom&dateTo`. Usato da Task 8 (frontend).

- [ ] **Step 1: Crea il DTO**

```typescript
// apps/backend/src/campaigns/dto/global-stats.dto.ts

export interface GlobalStatsTotalsDto {
  totalRecipients: number;
  totalSent: number;
  totalFailed: number;
  totalDownloaded: number;
  downloadPercentage: number;
}

export interface MonthlyTrendPointDto {
  month: string;
  sent: number;
  downloaded: number;
}

export interface ChannelTotalDto {
  channel: string;
  sent: number;
}

export interface DownloadChannelTotalDto {
  channel: string;
  count: number;
}

export interface CampaignLeaderboardEntryDto {
  campaignId: string;
  campaignName: string;
  totalRecipients: number;
  downloadPercentage: number;
}

export interface GlobalStatsDto {
  totals: GlobalStatsTotalsDto;
  monthlyTrend: MonthlyTrendPointDto[];
  channelTotals: ChannelTotalDto[];
  downloadChannelTotals: DownloadChannelTotalDto[];
  campaignLeaderboard: CampaignLeaderboardEntryDto[];
  neverDownloadedCount: number;
}
```

- [ ] **Step 2: Scrivi il test (fallisce: metodo non esiste)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dopo il blocco `describe('getDownloadCrossChannelStats', ...)` aggiunto in Task 2:

```typescript
  describe('getGlobalStats', () => {
    function makeQb(terminal: { rawOne?: any; rawMany?: any[]; count?: number }) {
      const qb: any = {};
      ['select', 'addSelect', 'innerJoin', 'leftJoin', 'where', 'andWhere', 'groupBy', 'orderBy'].forEach((m) => {
        qb[m] = jest.fn().mockReturnValue(qb);
      });
      qb.getRawOne = jest.fn().mockResolvedValue(terminal.rawOne);
      qb.getRawMany = jest.fn().mockResolvedValue(terminal.rawMany ?? []);
      qb.getCount = jest.fn().mockResolvedValue(terminal.count ?? 0);
      return qb;
    }

    it('assembla il DTO combinando tutte le query aggregate nell\'ordine atteso', async () => {
      mockCampaignRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawOne: { totalRecipients: '100', totalSent: '90', totalFailed: '10' } }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', sent: '50' }, { month: '2026-07', sent: '40' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', sent: '90' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ campaignId: 'c1', campaignName: 'Tari', totalRecipients: '100', downloadedCount: '60' }] }));

      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 60 }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', downloaded: '30' }] }))
        .mockReturnValueOnce(makeQb({ count: 15 }));

      mockDownloadEventRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', count: '55' }] }));

      const result = await service.getGlobalStats('2026-06-01', '2026-07-08');

      expect(result.totals).toEqual({
        totalRecipients: 100,
        totalSent: 90,
        totalFailed: 10,
        totalDownloaded: 60,
        downloadPercentage: 60,
      });
      expect(result.monthlyTrend).toEqual([
        { month: '2026-06', sent: 50, downloaded: 30 },
        { month: '2026-07', sent: 40, downloaded: 0 },
      ]);
      expect(result.channelTotals).toEqual([{ channel: 'EMAIL', sent: 90 }]);
      expect(result.downloadChannelTotals).toEqual([{ channel: 'EMAIL', count: 55 }]);
      expect(result.campaignLeaderboard).toEqual([
        { campaignId: 'c1', campaignName: 'Tari', totalRecipients: 100, downloadPercentage: 60 },
      ]);
      expect(result.neverDownloadedCount).toBe(15);
    });

    it('ritorna totali a zero quando non ci sono campagne nel periodo', async () => {
      mockCampaignRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawOne: undefined }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));
      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 0 }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ count: 0 }));
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValueOnce(makeQb({ rawMany: [] }));

      const result = await service.getGlobalStats();

      expect(result.totals).toEqual({
        totalRecipients: 0,
        totalSent: 0,
        totalFailed: 0,
        totalDownloaded: 0,
        downloadPercentage: 0,
      });
      expect(result.monthlyTrend).toEqual([]);
      expect(result.campaignLeaderboard).toEqual([]);
    });
  });
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getGlobalStats`
Expected: FAIL con "service.getGlobalStats is not a function"

- [ ] **Step 4: Implementa il metodo nel service**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi l'import (dopo la riga con `DownloadCrossChannelStatsDto` da Task 2):

```typescript
import type { GlobalStatsDto } from './dto/global-stats.dto';
import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere } from './global-stats.util';
```

Aggiungi il metodo subito dopo `getDownloadCrossChannelStats` (aggiunto in Task 2), prima di `async getFailures`:

```typescript
  async getGlobalStats(dateFrom?: string, dateTo?: string): Promise<GlobalStatsDto> {
    const range = buildDateRangeWhere('c', dateFrom, dateTo);

    const totalsRow = await this.campaignRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.totalRecipients), 0)', 'totalRecipients')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'totalSent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'totalFailed')
      .where(range.sql, range.params)
      .getRawOne<{ totalRecipients: string; totalSent: string; totalFailed: string }>();

    const totalDownloaded = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount > 0')
      .andWhere(range.sql, range.params)
      .getCount();

    const sentTrendRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .groupBy("date_trunc('month', c.createdAt)")
      .orderBy("date_trunc('month', c.createdAt)", 'ASC')
      .getRawMany<{ month: string; sent: string }>();

    const downloadedTrendRows = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COUNT(*) FILTER (WHERE r.downloadCount > 0)', 'downloaded')
      .where(range.sql, range.params)
      .groupBy("date_trunc('month', c.createdAt)")
      .getRawMany<{ month: string; downloaded: string }>();

    const channelRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select('c.channelType', 'channel')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .groupBy('c.channelType')
      .getRawMany<{ channel: string; sent: string }>();

    const downloadChannelRows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .innerJoin('r.campaign', 'c')
      .select('de.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where(range.sql, range.params)
      .groupBy('de.channel')
      .getRawMany<{ channel: string; count: string }>();

    const leaderboardRows = await this.campaignRepo
      .createQueryBuilder('c')
      .leftJoin('c.recipients', 'r')
      .select('c.id', 'campaignId')
      .addSelect('c.name', 'campaignName')
      .addSelect('c.totalRecipients', 'totalRecipients')
      .addSelect('COUNT(*) FILTER (WHERE r.downloadCount > 0)', 'downloadedCount')
      .where('c.totalRecipients > 0')
      .andWhere(range.sql, range.params)
      .groupBy('c.id')
      .getRawMany<{ campaignId: string; campaignName: string; totalRecipients: string; downloadedCount: string }>();

    const neverDownloadedCount = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount = 0')
      .andWhere('r.status = :status', { status: RecipientStatus.SENT })
      .andWhere(range.sql, range.params)
      .getCount();

    const totalRecipients = Number(totalsRow?.totalRecipients ?? 0);
    const totalSent = Number(totalsRow?.totalSent ?? 0);
    const totalFailed = Number(totalsRow?.totalFailed ?? 0);

    return {
      totals: {
        totalRecipients,
        totalSent,
        totalFailed,
        totalDownloaded,
        downloadPercentage: computeDownloadPercentage(totalDownloaded, totalRecipients),
      },
      monthlyTrend: mergeMonthlyTrend(sentTrendRows, downloadedTrendRows),
      channelTotals: channelRows.map((r) => ({ channel: r.channel, sent: Number(r.sent) })),
      downloadChannelTotals: downloadChannelRows.map((r) => ({ channel: r.channel, count: Number(r.count) })),
      campaignLeaderboard: leaderboardRows
        .map((r) => ({
          campaignId: r.campaignId,
          campaignName: r.campaignName,
          totalRecipients: Number(r.totalRecipients),
          downloadPercentage: computeDownloadPercentage(Number(r.downloadedCount), Number(r.totalRecipients)),
        }))
        .sort((a, b) => b.downloadPercentage - a.downloadPercentage),
      neverDownloadedCount,
    };
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getGlobalStats`
Expected: PASS (2 test)

- [ ] **Step 6: Aggiungi l'endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi dopo l'endpoint `getDownloadCrossChannelStats` (Task 2), prima di `@Get(':id/failures')`:

```typescript
  @Get('stats/global')
  getGlobalStats(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.campaignsService.getGlobalStats(dateFrom, dateTo);
  }
```

Nota: la rotta è a 2 segmenti letterali (`stats/global`) e non collide con `@Get(':id')` (1 segmento) né con le altre rotte `:id/...` (segmento 2 letterale diverso).

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 8: Esegui l'intera suite backend**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/dto/global-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): endpoint statistiche globali multi-campagna"
```

---

## Task 4: Export CSV "mai scaricato"

**Files:**
- Create: `apps/backend/src/campaigns/never-downloaded-csv.util.ts`
- Test: `apps/backend/src/campaigns/never-downloaded-csv.util.spec.ts`
- Modify: `apps/backend/src/campaigns/dto/global-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `buildDateRangeWhere` da Task 1, `RecipientStatus` (già importato in campaigns.service.ts).
- Produces: `buildNeverDownloadedCsv(rows: NeverDownloadedRowDto[]): string`, `CampaignsService.getNeverDownloadedRecipients(dateFrom?, dateTo?): Promise<NeverDownloadedRowDto[]>`, endpoint `GET admin/campaigns/stats/global/never-downloaded.csv?dateFrom&dateTo`. Usato da Task 9 (frontend).

- [ ] **Step 1: Scrivi il test del builder CSV**

```typescript
// apps/backend/src/campaigns/never-downloaded-csv.util.spec.ts
import { buildNeverDownloadedCsv } from './never-downloaded-csv.util';

describe('buildNeverDownloadedCsv', () => {
  it('produce header e righe separate da ; con escaping delle virgolette', () => {
    const csv = buildNeverDownloadedCsv([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario "Rossi"',
        campaignName: 'Tari 2026',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"Campagna";"Canale";"Stato";"Data invio"');
    expect(lines[1]).toContain('"AAA1"');
    expect(lines[1]).toContain('"Mario ""Rossi"""');
  });

  it('sostituisce fullName null con stringa vuota', () => {
    const csv = buildNeverDownloadedCsv([
      { codiceFiscale: 'BBB2', fullName: null, campaignName: 'Tari', channelType: 'PEC', status: 'sent', createdAt: '2026-06-01T10:00:00.000Z' },
    ]);
    expect(csv.split('\n')[1]).toContain('"";"Tari"');
  });

  it('ritorna solo l\'header quando non ci sono righe', () => {
    const csv = buildNeverDownloadedCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest never-downloaded-csv --maxWorkers=2`
Expected: FAIL con "Cannot find module './never-downloaded-csv.util'"

- [ ] **Step 3: Aggiungi il DTO `NeverDownloadedRowDto`**

In `apps/backend/src/campaigns/dto/global-stats.dto.ts`, aggiungi in fondo al file:

```typescript
export interface NeverDownloadedRowDto {
  codiceFiscale: string;
  fullName: string | null;
  campaignName: string;
  channelType: string;
  status: string;
  createdAt: string;
}
```

- [ ] **Step 4: Implementa il builder CSV**

```typescript
// apps/backend/src/campaigns/never-downloaded-csv.util.ts
import type { NeverDownloadedRowDto } from './dto/global-stats.dto';

function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildNeverDownloadedCsv(rows: NeverDownloadedRowDto[]): string {
  const header = ['Codice Fiscale', 'Nominativo', 'Campagna', 'Canale', 'Stato', 'Data invio']
    .map(escapeCsvField)
    .join(';');

  const lines = rows.map((r) =>
    [
      r.codiceFiscale,
      r.fullName ?? '',
      r.campaignName,
      r.channelType,
      r.status,
      new Date(r.createdAt).toLocaleString('it-IT'),
    ]
      .map(escapeCsvField)
      .join(';'),
  );

  return [header, ...lines].join('\n');
}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest never-downloaded-csv --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 6: Scrivi il test del metodo service (fallisce: metodo non esiste)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dopo il blocco `describe('getGlobalStats', ...)` aggiunto in Task 3:

```typescript
  describe('getNeverDownloadedRecipients', () => {
    it('mappa i destinatari sent con downloadCount=0 nel periodo', async () => {
      const qb: any = {};
      ['innerJoinAndSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
        qb[m] = jest.fn().mockReturnValue(qb);
      });
      qb.getMany = jest.fn().mockResolvedValue([
        {
          codiceFiscale: 'AAA1',
          fullName: 'Mario Rossi',
          status: RecipientStatus.SENT,
          createdAt: new Date('2026-06-01T10:00:00Z'),
          campaign: { name: 'Tari 2026', channelType: 'EMAIL' },
        },
      ]);
      mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getNeverDownloadedRecipients('2026-06-01', '2026-07-08');

      expect(result).toEqual([
        {
          codiceFiscale: 'AAA1',
          fullName: 'Mario Rossi',
          campaignName: 'Tari 2026',
          channelType: 'EMAIL',
          status: 'sent',
          createdAt: '2026-06-01T10:00:00.000Z',
        },
      ]);
      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: RecipientStatus.SENT });
    });
  });
```

- [ ] **Step 7: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getNeverDownloadedRecipients`
Expected: FAIL con "service.getNeverDownloadedRecipients is not a function"

- [ ] **Step 8: Implementa il metodo nel service**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiorna l'import DTO (aggiunto in Task 3):

```typescript
import type { GlobalStatsDto, NeverDownloadedRowDto } from './dto/global-stats.dto';
```

Aggiungi il metodo subito dopo `getGlobalStats` (Task 3), prima di `async getFailures`:

```typescript
  async getNeverDownloadedRecipients(dateFrom?: string, dateTo?: string): Promise<NeverDownloadedRowDto[]> {
    const range = buildDateRangeWhere('c', dateFrom, dateTo);
    const rows = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.campaign', 'c')
      .where('r.downloadCount = 0')
      .andWhere('r.status = :status', { status: RecipientStatus.SENT })
      .andWhere(range.sql, range.params)
      .orderBy('r.createdAt', 'DESC')
      .getMany();

    return rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      campaignName: r.campaign.name,
      channelType: r.campaign.channelType,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }
```

- [ ] **Step 9: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t getNeverDownloadedRecipients`
Expected: PASS (1 test)

- [ ] **Step 10: Aggiungi l'endpoint controller CSV**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi `Res` all'import da `@nestjs/common` (riga 6, accanto a `Query`) e `type { Response } from 'express'` (accanto all'import esistente `import type { Request } from 'express';` riga 21):

```typescript
import type { Request, Response } from 'express';
```

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
```

Aggiungi l'import del builder CSV in cima al file:

```typescript
import { buildNeverDownloadedCsv } from './never-downloaded-csv.util';
```

Aggiungi l'endpoint dopo `getGlobalStats` (Task 3), prima di `@Get(':id/failures')`:

```typescript
  @Get('stats/global/never-downloaded.csv')
  async exportNeverDownloadedCsv(
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.campaignsService.getNeverDownloadedRecipients(dateFrom, dateTo);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mai_scaricato.csv"');
    res.send(buildNeverDownloadedCsv(rows));
  }
```

- [ ] **Step 11: Scrivi il test controller**

In `apps/backend/src/campaigns/campaigns.controller.spec.ts`, aggiungi `getNeverDownloadedRecipients: jest.fn()` a `mockService` (riga 8-13) e aggiungi in fondo al file, prima dell'ultima `});` di chiusura:

```typescript
  describe('exportNeverDownloadedCsv', () => {
    it('imposta gli header CSV e invia il body generato dal service', async () => {
      const rows = [
        { codiceFiscale: 'AAA1', fullName: null, campaignName: 'Tari', channelType: 'EMAIL', status: 'sent', createdAt: '2026-06-01T10:00:00.000Z' },
      ];
      mockService.getNeverDownloadedRecipients = jest.fn().mockResolvedValue(rows);
      const res = { setHeader: jest.fn(), send: jest.fn() } as any;

      await controller.exportNeverDownloadedCsv(undefined, undefined, res);

      expect(mockService.getNeverDownloadedRecipients).toHaveBeenCalledWith(undefined, undefined);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="mai_scaricato.csv"');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('AAA1'));
    });
  });
```

- [ ] **Step 12: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2 -t exportNeverDownloadedCsv`
Expected: PASS (1 test)

- [ ] **Step 13: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 14: Esegui l'intera suite backend**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun nuovo fallimento

- [ ] **Step 15: Commit**

```bash
git add apps/backend/src/campaigns/never-downloaded-csv.util.ts apps/backend/src/campaigns/never-downloaded-csv.util.spec.ts apps/backend/src/campaigns/dto/global-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): export CSV destinatari mai scaricato"
```

---

## Task 5: Dipendenza recharts nel frontend-admin

**Files:**
- Modify: `apps/frontend-admin/package.json`
- Modify: `pnpm-lock.yaml` (rigenerato dal container)

**Interfaces:**
- Produces: modulo `recharts` disponibile per import in `apps/frontend-admin/src/App.tsx` (Task 7, 8, 9).

- [ ] **Step 1: Aggiungi la dipendenza a package.json**

In `apps/frontend-admin/package.json`, nella sezione `dependencies` (dopo `"@uiw/react-md-editor": "^4.0.4",`):

```json
    "recharts": "^2.15.0",
```

- [ ] **Step 2: Rigenera il lockfile senza Node sull'host**

Run:
```bash
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
```
Expected: `pnpm-lock.yaml` modificato con la nuova entry `recharts`

- [ ] **Step 3: Rebuild dell'immagine frontend-admin**

Run: `docker compose build frontend-admin`
Expected: build completata senza errori

- [ ] **Step 4: Rimuovi il volume node_modules obsoleto e riavvia**

Verifica prima il nome esatto del volume:

Run: `docker volume ls | grep node_modules`
Expected: elenco include `comunicapa_admin_node_modules` (non `comunicapa_frontend-admin_node_modules`)

Run:
```bash
docker compose rm -sf frontend-admin
docker volume rm comunicapa_admin_node_modules
docker compose up -d frontend-admin
```

- [ ] **Step 5: Verifica che il modulo sia risolvibile e il dev server parta**

Run: `docker compose exec frontend-admin node -e "console.log(require.resolve('recharts'))"`
Expected: stampa un path dentro `node_modules/recharts`, nessun errore `Cannot find module`

Run: `docker compose logs frontend-admin --tail 20`
Expected: log Vite `ready in ... ms`, nessun errore di modulo mancante

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/package.json pnpm-lock.yaml
git commit -m "chore(frontend-admin): aggiungi dipendenza recharts per i grafici statistiche"
```

---

## Task 6: Click destinatario nel dettaglio campagna → anteprima notifica

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `openNotificationDetail(recipientId: string): Promise<void>` (già definita in App.tsx, riga ~273 — nessuna modifica).

- [ ] **Step 1: Individua la riga della tabella destinatari**

Run: `docker compose exec frontend-admin grep -n "campaign.recipients.map((r) => (" src/App.tsx`
Expected: una corrispondenza, dentro il blocco "Destinatari Caricati" del dettaglio campagna (`view === 'campaign-detail'`)

- [ ] **Step 2: Rendi la riga cliccabile**

In `apps/frontend-admin/src/App.tsx`, nel blocco `campaign.recipients.map((r) => (...))` della tabella "Destinatari Caricati" (dentro `view === 'campaign-detail'`, NON nella tabella di "Ricerca Notifiche" che usa già `onClick`), trova:

```tsx
                                {campaign.recipients.map((r) => (
                                  <tr key={r.id}>
                                    <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
```

Sostituisci con:

```tsx
                                {campaign.recipients.map((r) => (
                                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.id)}>
                                    <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica manuale in browser**

Apri `http://localhost:3000`, login (`admin`/`admin` in dev con `LDAP_HOST=mock`), vai su una campagna con destinatari, click su una riga della tabella "Destinatari Caricati" → deve aprirsi la stessa modale usata in "Ricerca Notifiche", con la sezione download (se presente) popolata.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): click destinatario in dettaglio campagna apre anteprima notifica"
```

---

## Task 7: Grafico incrocio canali nel dettaglio campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: endpoint `GET /campaigns/:id/download-cross-channel-stats` (Task 2), `apiFetch` (già definita), `handleCampaignClick` (già definita, riga ~2437).
- Produces: stato `downloadCrossChannel`, funzione `fetchDownloadCrossChannelStats(id: string)`.

- [ ] **Step 1: Importa i componenti Recharts necessari**

In `apps/frontend-admin/src/App.tsx`, riga 1-3 (import esistenti), aggiungi:

```tsx
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
```

- [ ] **Step 2: Aggiungi lo stato per il cross-channel**

Vicino alla dichiarazione di `downloadByChannel` (riga 642, blocco "Campaign detail state"):

```tsx
  const [downloadByChannel, setDownloadByChannel] = useState<Record<string, number> | null>(null);
  const [downloadCrossChannel, setDownloadCrossChannel] = useState<{ primaryOnly: number; appIoOnly: number; both: number; none: number } | null>(null);
```

- [ ] **Step 3: Aggiungi il fetch e agganciala a handleCampaignClick**

Subito dopo `fetchDownloadChannelStats` (riga ~2461-2470), aggiungi:

```tsx
  const fetchDownloadCrossChannelStats = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/download-cross-channel-stats`);
      if (!res.ok) return;
      const data = await res.json();
      setDownloadCrossChannel(data.stats);
    } catch {
      // Non bloccante.
    }
  };
```

In `handleCampaignClick` (riga 2437-2448), aggiungi il reset e la chiamata:

```tsx
  const handleCampaignClick = (id: string) => {
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setCampaignFailures([]);
    setChannelBreakdown(null);
    setDownloadByChannel(null);
    setDownloadCrossChannel(null);
    fetchCampaignDetail(id);
    fetchCampaignFailures(id);
    fetchChannelBreakdown(id);
    fetchDownloadChannelStats(id);
    fetchDownloadCrossChannelStats(id);
  };
```

- [ ] **Step 4: Aggiungi la card grafico dopo la tabella destinatari**

Individua la chiusura della card "Destinatari Caricati" nella colonna `col-lg-8` (subito prima della chiusura del div `col-lg-8` stesso, alla fine del blocco `view === 'campaign-detail'`).

Run: `docker compose exec frontend-admin grep -n "Nessun destinatario associato a questa campagna" src/App.tsx`

Individua le righe di chiusura successive (sequenza di `</div>` che chiude `card-body` → `card` → `col-lg-8` → `row` → `) : null}`). Inserisci la nuova card come fratello, subito dopo la chiusura della card "Destinatari Caricati" e prima della chiusura del div `col-lg-8`:

```tsx
                    {downloadCrossChannel && (
                      <div className="card shadow-sm mt-4">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark">
                            <i className="fas fa-chart-column me-2 text-primary"></i>Download per Combinazione Canali
                          </h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={220}>
                            <BarChart data={[
                              { label: 'Solo primario', value: downloadCrossChannel.primaryOnly },
                              { label: 'Solo App IO', value: downloadCrossChannel.appIoOnly },
                              { label: 'Entrambi', value: downloadCrossChannel.both },
                              { label: 'Nessuno', value: downloadCrossChannel.none },
                            ]}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis dataKey="label" fontSize={11} />
                              <YAxis allowDecimals={false} />
                              <Tooltip />
                              <Bar dataKey="value" fill="var(--bi-primary)" radius={[4, 4, 0, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                          <table className="table table-sm mb-0 mt-2">
                            <tbody>
                              {(() => {
                                const total = downloadCrossChannel.primaryOnly + downloadCrossChannel.appIoOnly + downloadCrossChannel.both + downloadCrossChannel.none;
                                const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '0%');
                                const rows: Array<[string, number]> = [
                                  ['Solo primario', downloadCrossChannel.primaryOnly],
                                  ['Solo App IO', downloadCrossChannel.appIoOnly],
                                  ['Entrambi', downloadCrossChannel.both],
                                  ['Nessuno', downloadCrossChannel.none],
                                ];
                                return rows.map(([label, value]) => (
                                  <tr key={label}>
                                    <td>{label}</td>
                                    <td className="text-end fw-bold">{value}</td>
                                    <td className="text-end text-muted">{pct(value)}</td>
                                  </tr>
                                ));
                              })()}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 6: Verifica manuale in browser**

Apri il dettaglio di una campagna con co-consegna App IO configurata e destinatari con download registrati → la card "Download per Combinazione Canali" appare con bar chart e tabella coerenti. Apri il dettaglio di una campagna EMAIL-only senza App IO → la card non appare (stesso comportamento di "Dettaglio Consegna Multicanale").

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): grafico incrocio canali download in dettaglio campagna"
```

---

## Task 8: Vista Statistiche globale — filtro data, KPI, trend, ripartizione canali

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: endpoint `GET /campaigns/stats/global?dateFrom&dateTo` (Task 3), `apiFetch`, `ApiAuthError` (già definite).
- Produces: stato `globalStats`, `statsDateFrom`, `statsDateTo`, funzione `fetchGlobalStats()`. Usati da Task 9.

- [ ] **Step 1: Aggiungi la costante colori per il pie chart**

Vicino a `EMPTY_MAIL_CONFIG` (riga ~205-209), aggiungi:

```tsx
const PIE_COLORS = ['var(--bi-primary)', 'var(--ms-purple-600)', 'var(--ms-gold-500)', 'var(--ms-green-600)', 'var(--ms-blue-600)'];
```

- [ ] **Step 2: Aggiungi lo stato per il filtro data e i dati globali**

Vicino al blocco "Campaign detail state" (dopo `downloadCrossChannel` aggiunto in Task 7), aggiungi:

```tsx
  const [statsDateFrom, setStatsDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [statsDateTo, setStatsDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [globalStats, setGlobalStats] = useState<{
    totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number };
    monthlyTrend: Array<{ month: string; sent: number; downloaded: number }>;
    channelTotals: Array<{ channel: string; sent: number }>;
    downloadChannelTotals: Array<{ channel: string; count: number }>;
    campaignLeaderboard: Array<{ campaignId: string; campaignName: string; totalRecipients: number; downloadPercentage: number }>;
    neverDownloadedCount: number;
  } | null>(null);
  const [globalStatsLoading, setGlobalStatsLoading] = useState(false);
```

- [ ] **Step 3: Aggiungi la funzione di fetch**

Subito dopo `fetchDownloadCrossChannelStats` (aggiunta in Task 7), aggiungi:

```tsx
  const fetchGlobalStats = async () => {
    setGlobalStatsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statsDateFrom) params.set('dateFrom', statsDateFrom);
      if (statsDateTo) params.set('dateTo', statsDateTo);
      const res = await apiFetch(`/campaigns/stats/global?${params.toString()}`);
      if (res.ok) setGlobalStats(await res.json());
    } catch (err) {
      if (!(err instanceof ApiAuthError)) throw err;
    } finally {
      setGlobalStatsLoading(false);
    }
  };
```

- [ ] **Step 4: Carica i dati all'ingresso nella vista**

Vicino all'effect esistente per `notifiche-ricerca` (riga 290-295), aggiungi un effect analogo:

```tsx
  useEffect(() => {
    if (view === 'statistiche' && token) {
      fetchGlobalStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
```

- [ ] **Step 5: Sostituisci il contenuto mock della vista Statistiche**

Individua il blocco `{view === 'statistiche' && (...)}` (righe 4051-4163) e sostituiscilo interamente con:

```tsx
          {view === 'statistiche' && (
            <div>
              <div className="card shadow-sm p-3 mb-3">
                <div className="row g-2 align-items-end">
                  <div className="col-md-3">
                    <label className="form-label small mb-1">Da</label>
                    <input type="date" className="form-control form-control-sm" value={statsDateFrom} onChange={e => setStatsDateFrom(e.target.value)} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label small mb-1">A</label>
                    <input type="date" className="form-control form-control-sm" value={statsDateTo} onChange={e => setStatsDateTo(e.target.value)} />
                  </div>
                  <div className="col-md-2">
                    <button className="btn btn-primary btn-sm w-100" onClick={fetchGlobalStats} disabled={globalStatsLoading}>
                      <i className="fas fa-filter me-1"></i>Applica
                    </button>
                  </div>
                </div>
              </div>

              {globalStatsLoading && !globalStats ? (
                <div className="text-center text-muted py-5">Caricamento statistiche…</div>
              ) : globalStats && (
                <>
                  <div className="row g-3 mb-4">
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Notifiche Totali</span>
                        <h3 className="h2 mb-0 fw-bold text-primary">{globalStats.totals.totalRecipients}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Invii Avvenuti (Successo)</span>
                        <h3 className="h2 mb-0 fw-bold text-success">{globalStats.totals.totalSent}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Fallimenti totali</span>
                        <h3 className="h2 mb-0 fw-bold text-danger">{globalStats.totals.totalFailed}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">% Download</span>
                        <h3 className="h2 mb-0 fw-bold text-warning">{globalStats.totals.downloadPercentage}%</h3>
                      </div>
                    </div>
                  </div>

                  <div className="row g-3">
                    <div className="col-md-8">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-line me-2 text-primary"></i>Andamento Invii e Download</h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={260}>
                            <LineChart data={globalStats.monthlyTrend}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis dataKey="month" fontSize={11} />
                              <YAxis allowDecimals={false} />
                              <Tooltip />
                              <Legend />
                              <Line type="monotone" dataKey="sent" name="Invii" stroke="var(--bi-primary)" strokeWidth={2} />
                              <Line type="monotone" dataKey="downloaded" name="Download" stroke="var(--ms-green-600)" strokeWidth={2} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>

                    <div className="col-md-4">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-pie me-2 text-primary"></i>Ripartizione Invii per Canale</h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                              <Pie data={globalStats.channelTotals} dataKey="sent" nameKey="channel" outerRadius={80} label>
                                {globalStats.channelTotals.map((entry, idx) => (
                                  <Cell key={entry.channel} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip />
                              <Legend />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
```

Nota: Task 9 estenderà il fragment `<>...</>` sopra aggiungendo classifica campagne e "mai scaricato" — non chiudere/riaprire il blocco, lascia il fragment come punto di innesto.

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 7: Verifica manuale in browser**

Vai su "Statistiche" nel menu → KPI, trend e ripartizione canali mostrano dati reali (non più mock). Cambia le date e clicca "Applica" → i dati si aggiornano.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): vista Statistiche globale con dati reali e filtro data"
```

---

## Task 9: Classifica campagne e "mai scaricato" nella vista Statistiche

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `globalStats.campaignLeaderboard`, `globalStats.neverDownloadedCount` (Task 8), `handleCampaignClick` (già definita), endpoint `GET /campaigns/stats/global/never-downloaded.csv` (Task 4).

- [ ] **Step 1: Aggiungi la funzione di export CSV**

Subito dopo `fetchGlobalStats` (aggiunta in Task 8), aggiungi:

```tsx
  const handleExportNeverDownloaded = async () => {
    const params = new URLSearchParams();
    if (statsDateFrom) params.set('dateFrom', statsDateFrom);
    if (statsDateTo) params.set('dateTo', statsDateTo);
    const res = await apiFetch(`/campaigns/stats/global/never-downloaded.csv?${params.toString()}`);
    if (!res.ok) {
      alert('Impossibile esportare il report.');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mai_scaricato.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
```

- [ ] **Step 2: Aggiungi i pannelli dentro il fragment della vista Statistiche**

Nel blocco `view === 'statistiche'` (Task 8), subito dopo la chiusura del `</div>` che chiude `<div className="row g-3">` (quello con trend + pie chart) e prima della chiusura `</>`  del fragment, aggiungi:

```tsx
                  <div className="row g-3 mt-1">
                    <div className="col-md-8">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-ranking-star me-2 text-primary"></i>Classifica Campagne per Tasso Download</h3>
                        </div>
                        <div className="card-body p-0">
                          <div className="table-responsive">
                            <table className="table table-sm mb-0">
                              <thead><tr><th>Campagna</th><th className="text-end">Destinatari</th><th className="text-end">% Download</th></tr></thead>
                              <tbody>
                                {globalStats.campaignLeaderboard.slice(0, 5).map(c => (
                                  <tr key={c.campaignId} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.campaignId)}>
                                    <td>{c.campaignName}</td>
                                    <td className="text-end">{c.totalRecipients}</td>
                                    <td className="text-end fw-bold text-success">{c.downloadPercentage}%</td>
                                  </tr>
                                ))}
                                {globalStats.campaignLeaderboard.length === 0 && (
                                  <tr><td colSpan={3} className="text-center text-muted py-3">Nessuna campagna nel periodo selezionato</td></tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                          {globalStats.campaignLeaderboard.length > 5 && (
                            <>
                              <div className="px-3 py-2 small text-muted border-top">Peggiori 5</div>
                              <div className="table-responsive">
                                <table className="table table-sm mb-0">
                                  <tbody>
                                    {globalStats.campaignLeaderboard.slice(-5).reverse().map(c => (
                                      <tr key={c.campaignId} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.campaignId)}>
                                        <td>{c.campaignName}</td>
                                        <td className="text-end">{c.totalRecipients}</td>
                                        <td className="text-end fw-bold text-danger">{c.downloadPercentage}%</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="col-md-4">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-triangle-exclamation me-2 text-warning"></i>Mai Scaricato</h3>
                        </div>
                        <div className="card-body text-center">
                          <h3 className="h2 fw-bold text-danger">{globalStats.neverDownloadedCount}</h3>
                          <p className="small text-muted">Destinatari con invio riuscito ma nessun download nel periodo selezionato.</p>
                          <button className="btn btn-outline-danger btn-sm" onClick={handleExportNeverDownloaded}>
                            <i className="fas fa-file-csv me-1"></i>Esporta CSV
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica manuale in browser**

Vai su "Statistiche" → classifica campagne mostra migliori/peggiori 5 per tasso download, click su una riga naviga al dettaglio campagna. Card "Mai Scaricato" mostra il conteggio; click su "Esporta CSV" scarica un file `mai_scaricato.csv` non vuoto (se ci sono destinatari sent con downloadCount=0 nel periodo).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): classifica campagne e export mai-scaricato in Statistiche"
```

---

## Verifica finale end-to-end

- [ ] Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` — Expected: PASS, nessuna regressione
- [ ] Run: `docker compose exec backend node_modules/.bin/tsc --noEmit` — Expected: nessun errore
- [ ] Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` — Expected: nessun errore
- [ ] Verifica manuale browser: dettaglio campagna con App IO → grafico cross-channel visibile e coerente coi numeri di "Dettaglio Consegna Multicanale"; click destinatario → modale con downloads; vista Statistiche → filtro data, trend, pie, classifica, export CSV tutti funzionanti con dati reali
