# Download ricevute/documenti SEND (legal facts PN) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere all'operatore PA di vedere e scaricare, dal dettaglio destinatario di una campagna SEND, i documenti opponibili a terzi (legal facts) generati da PN — presa in carico, consegna digitale/cartacea, ricevuta PEC, mancata consegna, annullamento.

**Architecture:** Nuovo `SendLegalFactsService` (backend) chiama due API PN (elenco + download-metadata di un legal fact), esposto tramite due nuovi endpoint su `NotificationsSearchController` (stessa auth/guard del dettaglio destinatario esistente), consumato on-demand dal frontend admin nel modal "Dettaglio Notifica". Nessuna persistenza: fetch live ad ogni richiesta.

**Tech Stack:** NestJS 10 (backend), React 19 + Vite (frontend-admin), Jest (`--maxWorkers=2`), `fetch` nativo per le chiamate PN (stesso pattern di `send-status-sync.service.ts`).

## Global Constraints

- Auth verso PN: header `x-api-key` **e** `Authorization: Bearer <voucher PDND>` su ogni chiamata (nessuno dei due basta da solo).
- `baseUrl`/`apiKey`/`purposeId` da `AppSettingsService.get()` con chiavi `send.environment`, `send.{test|prod}.baseUrl`, `send.{test|prod}.apiKey`, `send.{test|prod}.purposeId` — stesso pattern di `SendStatusSyncService.getEnvAndBaseUrl()`.
- Endpoint di elenco/lista non deve mai lanciare eccezioni HTTP non-2xx per stati "previsti" (iun assente, notifica non trovata su PN, errore trasporto) — sempre 200 con lista vuota o flag, per il reverse proxy esterno di produzione che sostituisce il body delle risposte non-2xx (vedi CLAUDE.md, sezione "Reverse proxy esterno in produzione").
- Test backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza `--maxWorkers=2`, satura la RAM su WSL2).
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Type-check frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`.
- Commit dopo ogni task, messaggi in italiano coerenti con lo stile del repo (`git log` recente).

---

## Task 1: `SendLegalFactsService` — chiamate PN elenco/download legal facts

**Files:**
- Create: `apps/backend/src/channels/send/send-legal-facts.service.ts`
- Create: `apps/backend/src/channels/send/send-legal-facts.module.ts`
- Test: `apps/backend/src/channels/send/send-legal-facts.service.spec.ts`

**Interfaces:**
- Produce: `SendLegalFactItem { legalFactId: string; category: string }`, `SendLegalFactDownloadResult = { ready: true; filename: string; contentType: string; buffer: Buffer } | { ready: false; retryAfterSeconds?: number; error?: string }`, classe `SendLegalFactsService` con metodi `listLegalFacts(iun: string): Promise<SendLegalFactItem[]>` e `downloadLegalFact(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult>`, modulo `SendLegalFactsModule` che esporta `SendLegalFactsService` — usati dal Task 2.

- [ ] **Step 1: Scrivi il test che fallisce per `listLegalFacts`**

```typescript
// apps/backend/src/channels/send/send-legal-facts.service.spec.ts
import { Test } from '@nestjs/testing';
import { SendLegalFactsService } from './send-legal-facts.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.apiKey': 'apikey-abc',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('SendLegalFactsService', () => {
  let service: SendLegalFactsService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockSettings.get.mockClear();
    mockPdndAuth.getVoucher.mockClear();

    const module = await Test.createTestingModule({
      providers: [
        SendLegalFactsService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();

    service = module.get(SendLegalFactsService);
  });

  it('listLegalFacts: mappa la risposta PN in legalFactId/category', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { iun: 'IUN-1', legalFactsId: { key: 'safestorage://key1', category: 'SENDER_ACK' } },
            { iun: 'IUN-1', legalFactsId: { key: 'safestorage://key2', category: 'DIGITAL_DELIVERY' } },
          ]),
        ),
    });

    const result = await service.listLegalFacts('IUN-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery-push/v2.0/IUN-1/legal-facts',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(result).toEqual([
      { legalFactId: 'safestorage://key1', category: 'SENDER_ACK' },
      { legalFactId: 'safestorage://key2', category: 'DIGITAL_DELIVERY' },
    ]);
  });

  it('listLegalFacts: ritorna lista vuota se PN risponde errore', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') });

    const result = await service.listLegalFacts('IUN-2');

    expect(result).toEqual([]);
  });

  it('listLegalFacts: ritorna lista vuota su errore di trasporto', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await service.listLegalFacts('IUN-3');

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest send-legal-facts --maxWorkers=2`
Expected: FAIL — `Cannot find module './send-legal-facts.service'`

- [ ] **Step 3: Implementa `SendLegalFactsService` (parte elenco)**

```typescript
// apps/backend/src/channels/send/send-legal-facts.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

export interface SendLegalFactItem {
  legalFactId: string;
  category: string;
}

export type SendLegalFactDownloadResult =
  | { ready: true; filename: string; contentType: string; buffer: Buffer }
  | { ready: false; retryAfterSeconds?: number; error?: string };

@Injectable()
export class SendLegalFactsService {
  private readonly logger = new Logger(SendLegalFactsService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  private async getEnvAndBaseUrl(): Promise<{ envKey: 'test' | 'prod'; baseUrl: string; apiKey: string; purposeId: string }> {
    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const baseUrl = await this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey);
    const apiKey = await this.settings.get<string>(`send.${envKey}.apiKey` as SettingKey);
    const purposeId = await this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey);
    return { envKey, baseUrl, apiKey, purposeId };
  }

  async listLegalFacts(iun: string): Promise<SendLegalFactItem[]> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const res = await fetch(`${baseUrl}/delivery-push/v2.0/${iun}/legal-facts`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`Elenco documenti SEND IUN ${iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
        return [];
      }
      const data = JSON.parse(text) as Array<{ legalFactsId: { key: string; category: string } }>;
      return data.map((item) => ({ legalFactId: item.legalFactsId.key, category: item.legalFactsId.category }));
    } catch (err: any) {
      this.logger.warn(`Errore elenco documenti SEND IUN ${iun}: ${err.message}`);
      return [];
    }
  }

  async downloadLegalFact(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const metaRes = await fetch(`${baseUrl}/delivery-push/${iun}/download/legal-facts/${encodeURIComponent(legalFactId)}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const metaText = await metaRes.text();
      if (!metaRes.ok) {
        this.logger.warn(`Metadati download documento SEND IUN ${iun} legalFactId ${legalFactId} falliti: HTTP ${metaRes.status} — ${metaText.slice(0, 300)}`);
        return { ready: false, error: `Errore PN: HTTP ${metaRes.status}` };
      }
      const meta = JSON.parse(metaText) as { filename: string; url?: string; retryAfter?: number };
      if (!meta.url) {
        return { ready: false, retryAfterSeconds: meta.retryAfter };
      }
      const fileRes = await fetch(meta.url);
      if (!fileRes.ok) {
        return { ready: false, error: `Errore download file: HTTP ${fileRes.status}` };
      }
      const arrayBuffer = await fileRes.arrayBuffer();
      return {
        ready: true,
        filename: meta.filename,
        contentType: fileRes.headers.get('content-type') || 'application/octet-stream',
        buffer: Buffer.from(arrayBuffer),
      };
    } catch (err: any) {
      this.logger.warn(`Errore download documento SEND IUN ${iun} legalFactId ${legalFactId}: ${err.message}`);
      return { ready: false, error: err.message };
    }
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest send-legal-facts --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: Aggiungi i test per `downloadLegalFact` (pronto, retryAfter, errore)**

```typescript
// append a apps/backend/src/channels/send/send-legal-facts.service.spec.ts, dentro describe('SendLegalFactsService')

  it('downloadLegalFact: scarica il contenuto quando PN fornisce un url pronto', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ filename: 'attestazione.pdf', contentLength: 4, url: 'https://safestorage/x' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('%PDF').buffer),
      });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://send.test/delivery-push/IUN-1/download/legal-facts/key1',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey-abc', Authorization: 'Bearer voucher-abc' } }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://safestorage/x');
    expect(result).toEqual({ ready: true, filename: 'attestazione.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') });
  });

  it('downloadLegalFact: ritorna ready:false con retryAfterSeconds se il file non è pronto', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ filename: 'attestazione.pdf', contentLength: 0, retryAfter: 30 })),
    });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, retryAfterSeconds: 30 });
  });

  it('downloadLegalFact: ritorna ready:false con error se PN risponde errore', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

    const result = await service.downloadLegalFact('IUN-1', 'key1');

    expect(result).toEqual({ ready: false, error: 'Errore PN: HTTP 500' });
  });
```

- [ ] **Step 6: Esegui i test e verifica che passino tutti**

Run: `docker compose exec backend node_modules/.bin/jest send-legal-facts --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 7: Crea il modulo**

```typescript
// apps/backend/src/channels/send/send-legal-facts.module.ts
import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { SendLegalFactsService } from './send-legal-facts.service';

@Module({
  imports: [PdndModule],
  providers: [SendLegalFactsService],
  exports: [SendLegalFactsService],
})
export class SendLegalFactsModule {}
```

- [ ] **Step 8: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/channels/send/send-legal-facts.service.ts apps/backend/src/channels/send/send-legal-facts.module.ts apps/backend/src/channels/send/send-legal-facts.service.spec.ts
git commit -m "feat(backend): aggiungi SendLegalFactsService per elenco/download documenti PN"
```

---

## Task 2: Endpoint `notifications-search` per elenco/download legal facts

**Files:**
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.controller.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.module.ts`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Consuma: `SendLegalFactsService.listLegalFacts(iun)`, `SendLegalFactsService.downloadLegalFact(iun, legalFactId)`, `SendLegalFactItem`, `SendLegalFactDownloadResult` (Task 1).
- Produce: `NotificationsSearchService.getSendLegalFacts(recipientId: string): Promise<{ items: SendLegalFactItem[] }>`, `NotificationsSearchService.downloadSendLegalFact(recipientId: string, legalFactId: string): Promise<SendLegalFactDownloadResult>`; endpoint `GET admin/notifications-search/:recipientId/send-legal-facts` e `GET admin/notifications-search/:recipientId/send-legal-facts/:legalFactId/download` — usati dal Task 3.

- [ ] **Step 1: Scrivi i test che falliscono per i nuovi metodi di servizio**

```typescript
// append a apps/backend/src/notifications-search/notifications-search.service.spec.ts

describe('NotificationsSearchService.getSendLegalFacts / downloadSendLegalFact', () => {
  const recipientRepoMock = { createQueryBuilder: jest.fn(), findOne: jest.fn() };
  const attemptRepoMock = { find: jest.fn(), findOne: jest.fn() };
  const downloadEventRepoMock = { find: jest.fn() };
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn() };
  const sendLegalFactsMock = { listLegalFacts: jest.fn(), downloadLegalFact: jest.fn() };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: getRepositoryToken(DownloadEvent), useValue: downloadEventRepoMock },
        { provide: CampaignsService, useValue: campaignsServiceMock },
        { provide: SendLegalFactsService, useValue: sendLegalFactsMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('getSendLegalFacts: ritorna lista vuota se il destinatario non ha un attempt SEND con iun', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce(null);

    const result = await service.getSendLegalFacts('rec-1');

    expect(result).toEqual({ items: [] });
    expect(sendLegalFactsMock.listLegalFacts).not.toHaveBeenCalled();
  });

  it('getSendLegalFacts: chiama SendLegalFactsService.listLegalFacts con lo iun più recente', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce({ iun: 'IUN-1' });
    sendLegalFactsMock.listLegalFacts.mockResolvedValueOnce([{ legalFactId: 'key1', category: 'SENDER_ACK' }]);

    const result = await service.getSendLegalFacts('rec-1');

    expect(attemptRepoMock.findOne).toHaveBeenCalledWith({
      where: { recipientId: 'rec-1', channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    expect(sendLegalFactsMock.listLegalFacts).toHaveBeenCalledWith('IUN-1');
    expect(result).toEqual({ items: [{ legalFactId: 'key1', category: 'SENDER_ACK' }] });
  });

  it('downloadSendLegalFact: ritorna errore se il destinatario non ha un attempt SEND con iun', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce(null);

    const result = await service.downloadSendLegalFact('rec-1', 'key1');

    expect(result).toEqual({ ready: false, error: 'Nessun IUN disponibile per questo destinatario' });
    expect(sendLegalFactsMock.downloadLegalFact).not.toHaveBeenCalled();
  });

  it('downloadSendLegalFact: delega a SendLegalFactsService.downloadLegalFact', async () => {
    attemptRepoMock.findOne.mockResolvedValueOnce({ iun: 'IUN-1' });
    sendLegalFactsMock.downloadLegalFact.mockResolvedValueOnce({ ready: true, filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });

    const result = await service.downloadSendLegalFact('rec-1', 'key1');

    expect(sendLegalFactsMock.downloadLegalFact).toHaveBeenCalledWith('IUN-1', 'key1');
    expect(result).toEqual({ ready: true, filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });
  });
});
```

Aggiungi in cima al file l'import mancante:

```typescript
import { SendLegalFactsService } from '../channels/send/send-legal-facts.service';
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search.service --maxWorkers=2`
Expected: FAIL — `getSendLegalFacts is not a function` (o errore di risoluzione provider `SendLegalFactsService`)

- [ ] **Step 3: Implementa i metodi nel service**

Modifica `apps/backend/src/notifications-search/notifications-search.service.ts`:

```typescript
// aggiungi in cima, con gli altri import
import { SendLegalFactsService, type SendLegalFactItem, type SendLegalFactDownloadResult } from '../channels/send/send-legal-facts.service';
```

```typescript
// aggiungi al costruttore la nuova dipendenza
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly campaignsService: CampaignsService,
    private readonly sendLegalFacts: SendLegalFactsService,
  ) {}
```

```typescript
// aggiungi come nuovi metodi della classe, dopo getDetail()
  async getSendLegalFacts(recipientId: string): Promise<{ items: SendLegalFactItem[] }> {
    const attempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    if (!attempt?.iun) return { items: [] };
    const items = await this.sendLegalFacts.listLegalFacts(attempt.iun);
    return { items };
  }

  async downloadSendLegalFact(recipientId: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    const attempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    if (!attempt?.iun) return { ready: false, error: 'Nessun IUN disponibile per questo destinatario' };
    return this.sendLegalFacts.downloadLegalFact(attempt.iun, legalFactId);
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search.service --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi quelli preesistenti)

- [ ] **Step 5: Aggiungi gli endpoint nel controller**

Sostituisci il contenuto di `apps/backend/src/notifications-search/notifications-search.controller.ts`:

```typescript
import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsSearchService } from './notifications-search.service';

@Controller('admin/notifications-search')
@Roles('user', 'admin')
export class NotificationsSearchController {
  constructor(private readonly svc: NotificationsSearchService) {}

  @Get()
  search(
    @Query('codiceFiscale') codiceFiscale?: string,
    @Query('campaignId') campaignId?: string,
    @Query('channelType') channelType?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    return this.svc.search({
      codiceFiscale,
      campaignId,
      channelType,
      status,
      dateFrom,
      dateTo,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50)),
    });
  }

  @Get(':recipientId')
  getDetail(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return this.svc.getDetail(recipientId);
  }

  @Get(':recipientId/send-legal-facts')
  getSendLegalFacts(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return this.svc.getSendLegalFacts(recipientId);
  }

  @Get(':recipientId/send-legal-facts/:legalFactId/download')
  async downloadSendLegalFact(
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Param('legalFactId') legalFactId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.svc.downloadSendLegalFact(recipientId, legalFactId);
    if (!result.ready) {
      res.status(200).json({ ready: false, retryAfterSeconds: result.retryAfterSeconds, error: result.error });
      return;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
    res.end(result.buffer);
  }
}
```

- [ ] **Step 6: Aggiorna il modulo per importare `SendLegalFactsModule`**

```typescript
// apps/backend/src/notifications-search/notifications-search.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SendLegalFactsModule } from '../channels/send/send-legal-facts.module';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, NotificationAttempt, DownloadEvent]), CampaignsModule, SendLegalFactsModule],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
```

- [ ] **Step 7: Type-check ed esegui l'intera suite backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessuna regressione (stesso failure set di baseline, cioè zero)

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/notifications-search/notifications-search.service.ts apps/backend/src/notifications-search/notifications-search.controller.ts apps/backend/src/notifications-search/notifications-search.module.ts
git commit -m "feat(backend): esponi endpoint elenco/download documenti SEND nel dettaglio destinatario"
```

---

## Task 3: UI frontend admin — sezione "Documenti disponibili (SEND)"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consuma: `GET ${ADMIN_API_BASE}/notifications-search/:recipientId/send-legal-facts` → `{ items: { legalFactId: string; category: string }[] }`; `GET ${ADMIN_API_BASE}/notifications-search/:recipientId/send-legal-facts/:legalFactId/download` → risposta binaria (successo, header `Content-Disposition`) oppure JSON `{ ready: false, retryAfterSeconds?, error? }` (Task 2). Usa `apiFetch` (helper già esistente in `App.tsx`, riga ~951) per l'`Authorization` header.

- [ ] **Step 1: Aggiungi la mappa etichette categoria, vicino a `SEND_STATUS_META` (riga ~77 di `App.tsx`)**

```typescript
// dopo la dichiarazione di SendStatusBadge (riga ~87)
const SEND_LEGAL_FACT_CATEGORY_LABELS: Record<string, string> = {
  SENDER_ACK: 'Presa in carico',
  DIGITAL_DELIVERY: 'Consegna digitale (PEC)',
  ANALOG_DELIVERY: 'Consegna cartacea (cartolina AR)',
  RECIPIENT_ACCESS: 'Accesso del destinatario',
  PEC_RECEIPT: 'Ricevuta PEC',
  ANALOG_FAILURE_DELIVERY: 'Mancata consegna cartacea',
  NOTIFICATION_CANCELLED: 'Notifica annullata',
};
```

- [ ] **Step 2: Aggiungi stato e funzioni di fetch/download, subito dopo `openNotificationDetail` (riga ~406 di `App.tsx`)**

Modifica la dichiarazione dello stato esistente (riga ~361), aggiungendo i tre nuovi `useState` subito dopo `notifDetailLoading`:

```typescript
  const [notifDetailLoading, setNotifDetailLoading] = useState(false);
  const [sendLegalFacts, setSendLegalFacts] = useState<{ legalFactId: string; category: string }[] | null>(null);
  const [sendLegalFactsLoading, setSendLegalFactsLoading] = useState(false);
  const [sendLegalFactRetry, setSendLegalFactRetry] = useState<Record<string, { retryAfterSeconds?: number; error?: string }>>({});
```

Modifica `openNotificationDetail` per resettare lo stato dei documenti SEND ad ogni apertura:

```typescript
  const openNotificationDetail = async (recipientId: string) => {
    setNotifDetail(null);
    setSendLegalFacts(null);
    setSendLegalFactRetry({});
    setNotifDetailLoading(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/notifications-search/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        alert('Impossibile caricare il dettaglio della notifica.');
        return;
      }
      setNotifDetail(await res.json());
    } finally {
      setNotifDetailLoading(false);
    }
  };
```

Aggiungi le due nuove funzioni subito dopo `openNotificationDetail`:

```typescript
  const loadSendLegalFacts = async () => {
    if (!notifDetail) return;
    setSendLegalFactsLoading(true);
    try {
      const res = await apiFetch(`/notifications-search/${notifDetail.recipient.id}/send-legal-facts`);
      const data = await res.json();
      setSendLegalFacts(data.items || []);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Impossibile caricare i documenti SEND.');
    } finally {
      setSendLegalFactsLoading(false);
    }
  };

  const downloadSendLegalFact = async (legalFactId: string) => {
    if (!notifDetail) return;
    try {
      const res = await apiFetch(`/notifications-search/${notifDetail.recipient.id}/send-legal-facts/${encodeURIComponent(legalFactId)}/download`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        setSendLegalFactRetry((prev) => ({ ...prev, [legalFactId]: { retryAfterSeconds: data.retryAfterSeconds, error: data.error } }));
        return;
      }
      setSendLegalFactRetry((prev) => {
        const next = { ...prev };
        delete next[legalFactId];
        return next;
      });
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `documento-${legalFactId}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Errore durante il download del documento.');
    }
  };
```

`apiFetch` e `ApiAuthError` sono definiti più avanti nel componente (righe ~944-960): essendo funzioni interne alla stessa closure del componente funzionale, l'ordine di dichiarazione con `const` non è un problema a runtime purché le chiamate avvengano dopo il render iniziale (React invoca l'intero corpo del componente ad ogni render, tutte le `const` sono inizializzate prima che l'utente possa interagire con la UI).

- [ ] **Step 3: Inserisci il blocco UI nel modal, tra la tabella "Storico Tentativi" e la sezione "Download" (dopo la riga con `</div>` di chiusura di `table-responsive` a riga ~5020, prima di `{notifDetail.downloads.length > 0 && (` a riga ~5022)**

```tsx
                        {notifDetail.campaign.channelType === 'SEND' && (
                          <>
                            <h6 className="fw-bold small d-flex align-items-center justify-content-between">
                              Documenti disponibili (SEND)
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-primary"
                                onClick={loadSendLegalFacts}
                                disabled={sendLegalFactsLoading}
                              >
                                {sendLegalFactsLoading ? (
                                  <><i className="fas fa-spinner fa-spin me-1"></i>Caricamento...</>
                                ) : (
                                  <><i className="fas fa-rotate me-1"></i>Carica documenti</>
                                )}
                              </button>
                            </h6>
                            {sendLegalFacts !== null && (
                              sendLegalFacts.length === 0 ? (
                                <div className="text-muted small mb-4">Nessun documento disponibile al momento.</div>
                              ) : (
                                <div className="table-responsive">
                                  <table className="table table-sm mb-4">
                                    <thead><tr><th>Documento</th><th></th></tr></thead>
                                    <tbody>
                                      {sendLegalFacts.map((item) => (
                                        <tr key={item.legalFactId}>
                                          <td className="small">{SEND_LEGAL_FACT_CATEGORY_LABELS[item.category] ?? item.category}</td>
                                          <td className="small text-end">
                                            {sendLegalFactRetry[item.legalFactId] ? (
                                              <span className="text-muted">
                                                {sendLegalFactRetry[item.legalFactId].error
                                                  ? sendLegalFactRetry[item.legalFactId].error
                                                  : `Non ancora disponibile, riprova tra ${sendLegalFactRetry[item.legalFactId].retryAfterSeconds ?? '?'}s`}
                                              </span>
                                            ) : (
                                              <button
                                                type="button"
                                                className="btn btn-sm btn-outline-secondary"
                                                onClick={() => downloadSendLegalFact(item.legalFactId)}
                                              >
                                                <i className="fas fa-download me-1"></i>Scarica
                                              </button>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )
                            )}
                          </>
                        )}

```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 5: Verifica manuale in browser**

Prerequisiti: ambiente dev con `LDAP_HOST=mock` attivo, credenziali SEND test configurate in Impostazioni → SEND, almeno un destinatario di una campagna SEND con `iun` valorizzato (verificabile da tabella destinatari, colonna IUN).

1. `docker compose up -d --build backend frontend-admin` (se non già in esecuzione con le modifiche).
2. Login admin, vai su "Ricerca Notifiche", apri il dettaglio di un destinatario SEND con IUN.
3. Verifica comparsa sezione "Documenti disponibili (SEND)" con bottone "Carica documenti".
4. Click su "Carica documenti": verifica che compaia la lista (o il messaggio "Nessun documento disponibile al momento." se PN non ha ancora generato nulla per quello IUN).
5. Click su "Scarica" per un documento: verifica che il file venga scaricato dal browser, oppure — se PN risponde `retryAfter` — che compaia il messaggio "Non ancora disponibile, riprova tra Ns".
6. Verifica che un destinatario di una campagna non-SEND non mostri affatto la sezione.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): mostra e permette il download dei documenti SEND nel dettaglio destinatario"
```
