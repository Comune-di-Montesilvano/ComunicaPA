# Audit pipeline SEND: completamento campagna, dettaglio notifica, wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere 5 problemi collegati emersi da un audit della pipeline SEND: campagne SEND che restano `QUEUED` per sempre, dettaglio notifica che non mostra IUN/protocollo/stato SEND, UI che mostra un "messaggio" che SEND non usa, wizard che richiede un corpo messaggio inutile per SEND, e oggetto SEND mappabile per destinatario da colonna CSV.

**Architecture:** Backend: un nuovo `CampaignCompletionService` (repo puro, nessuna dipendenza da `CampaignsService`) condiviso tra `notification.processor.ts` (BullMQ, 4 canali) e `send-dispatch.service.ts` (demone SEND); un nuovo util puro `resolveSubjectTemplate()` condiviso tra invio reale e anteprima; DTO/mapper estesi per esporre campi già salvati in colonna. Frontend: rendering condizionale su `channelType === 'SEND'` nei punti già esistenti (nessuna nuova pagina), più un campo di mapping aggiuntivo nello Step 3 del wizard.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 (frontend-admin), Jest.

## Global Constraints

- Test suite backend: SEMPRE `--maxWorkers=2`.
- Baseline nota: 1 fallimento preesistente (`app.controller.spec.ts`, `isLdapMock`, dipende da `LDAP_HOST=mock` in `.env` dev) — non toccare, non è nostro.
- Mai `leftJoinAndSelect`+`orderBy`+`take` insieme su relazioni dichiarate per stringa (bug TypeORM 0.3.30 noto, vedi CLAUDE.md) — usare due query separate dove serve joinare `notification_attempts`.
- `send.{env}.group`/altre impostazioni SEND non toccate in questo piano.
- Report CSV finale (stato + data consegna) resta fuori scope — non toccare `send-status-sync.service.ts`.
- Ogni campo nuovo esposto ai canali non-SEND deve restare `null`/assente, nessun cambio di comportamento visivo per EMAIL/PEC/APP_IO/POSTAL.

---

### Task 1: `CampaignCompletionService` condiviso

**Files:**
- Create: `apps/backend/src/campaigns/campaign-completion.service.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts:1-40` (import + costruttore), `:239`, `:275` (chiamate), rimuovere `:278-296` (metodo privato spostato)
- Modify: `apps/backend/src/channels/channel.module.ts` (provider + export)
- Test: `apps/backend/src/campaigns/campaign-completion.service.spec.ts` (nuovo)
- Test: `apps/backend/src/queue/notification.processor.spec.ts:31-183` (adatta i mock)

**Interfaces:**
- Produces: `CampaignCompletionService.checkAndComplete(campaignId: string): Promise<void>` — se non restano destinatari `PENDING`/`QUEUED` per la campagna, la marca `COMPLETED` (`status`, `completedAt: new Date()`), altrimenti no-op. Usato da Task 2.

- [ ] **Step 1: Scrivere il test per il nuovo servizio**

Creare `apps/backend/src/campaigns/campaign-completion.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignCompletionService } from './campaign-completion.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';

describe('CampaignCompletionService', () => {
  let service: CampaignCompletionService;
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mockCampaignRepo = { createQueryBuilder: jest.fn(() => mockQb) };
  const mockRecipientRepo = { count: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    const module = await Test.createTestingModule({
      providers: [
        CampaignCompletionService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
      ],
    }).compile();
    service = module.get(CampaignCompletionService);
  });

  it('marca la campagna COMPLETED quando non restano destinatari PENDING/QUEUED', async () => {
    mockRecipientRepo.count.mockResolvedValueOnce(0);

    await service.checkAndComplete('camp-1');

    expect(mockRecipientRepo.count).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1', status: expect.anything() },
    });
    expect(mockCampaignRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignStatus.COMPLETED, completedAt: expect.any(Date) }),
    );
  });

  it('NON marca la campagna se restano destinatari da processare', async () => {
    mockRecipientRepo.count.mockResolvedValueOnce(3);

    await service.checkAndComplete('camp-1');

    expect(mockCampaignRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaign-completion.service --maxWorkers=2`
Expected: FAIL — `Cannot find module './campaign-completion.service'`

- [ ] **Step 3: Creare il servizio**

Creare `apps/backend/src/campaigns/campaign-completion.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';

/**
 * Estratto da notification.processor.ts (era privato lì, chiamato solo dal
 * flusso BullMQ) — condiviso anche da SendDispatchService, che dal refactor
 * "pipeline a demoni" non passa più da BullMQ per SEND e quindi non
 * chiamava mai questo check: le campagne SEND restavano QUEUED per sempre
 * anche a invio terminato per tutti i destinatari.
 */
@Injectable()
export class CampaignCompletionService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  /**
   * Se non restano destinatari PENDING/QUEUED per la campagna, la marca
   * COMPLETED. È l'unico punto che porta una campagna fuori da QUEUED, che
   * altrimenti resterebbe tale per sempre anche a invio terminato.
   */
  async checkAndComplete(campaignId: string): Promise<void> {
    const remaining = await this.recipientRepo.count({
      where: { campaignId, status: In([RecipientStatus.PENDING, RecipientStatus.QUEUED]) },
    });
    if (remaining > 0) return;

    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.COMPLETED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();
  }
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaign-completion.service --maxWorkers=2`
Expected: PASS (2/2)

- [ ] **Step 5: Wire nel `ChannelModule`**

In `apps/backend/src/channels/channel.module.ts`, aggiungere l'import:

```ts
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
```

Nell'array `providers`, aggiungere `CampaignCompletionService` (es. dopo `ProtocollazioneSyncService,`). Nell'array `exports`, cambiare:

```ts
  exports: [CHANNEL_STRATEGIES],
```

in:

```ts
  exports: [CHANNEL_STRATEGIES, CampaignCompletionService],
```

- [ ] **Step 6: `notification.processor.ts` usa il servizio condiviso**

In `apps/backend/src/queue/notification.processor.ts`, aggiungere l'import (vicino agli altri import da `../channels/`):

```ts
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
```

Nel costruttore (dopo `private readonly settings: AppSettingsService,` o dove più naturale tra i parametri esistenti), aggiungere:

```ts
    private readonly campaignCompletion: CampaignCompletionService,
```

Sostituire la riga `await this.checkAndCompleteCampaign(campaignId);` (appare due volte, righe ~239 e ~275) con:

```ts
      await this.campaignCompletion.checkAndComplete(campaignId);
```

(mantenendo l'indentazione originale di ciascuna occorrenza). Rimuovere interamente il metodo privato `checkAndCompleteCampaign` (il blocco commentato + il corpo, righe ~278-296 nel file originale).

Rimuovere l'import `CampaignStatus` da `../entities/campaign.entity` SOLO se non più usato altrove nel file dopo la rimozione (verificare con grep prima di toccarlo — `CampaignStatus` potrebbe essere usato anche altrove nel file). Non rimuovere `In` da `typeorm` se altrove nel file serve ancora (verificare con lo stesso grep).

- [ ] **Step 7: Adattare `notification.processor.spec.ts`**

In `apps/backend/src/queue/notification.processor.spec.ts`:

Aggiungere l'import:
```ts
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
```

Dopo la dichiarazione di `mockRecipientRepo` (riga ~46), aggiungere:
```ts
const mockCampaignCompletion = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };
```

Nell'array `providers` del `Test.createTestingModule` (dentro `beforeEach`), aggiungere:
```ts
        { provide: CampaignCompletionService, useValue: mockCampaignCompletion },
```

Nel blocco `beforeEach`, aggiungere `mockCampaignCompletion.checkAndComplete.mockClear();` vicino agli altri `.mockClear()`/reset (o si azzera già con `jest.clearAllMocks()` in cima al blocco — verificare che ci sia già, in caso non serve altro).

Sostituire il contenuto del blocco `describe('completamento campagna', ...)` (righe ~148-183) con:

```ts
  describe('completamento campagna', () => {
    it('chiama CampaignCompletionService dopo un invio riuscito', async () => {
      await processor.process(mockJob(baseData));

      expect(mockCampaignCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
    });

    it('chiama CampaignCompletionService anche quando l\'ultimo destinatario fallisce (strategy lancia)', async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP timeout'));

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP timeout');

      expect(mockCampaignCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
    });
  });
```

(I due test precedenti verificavano il comportamento interno di `checkAndCompleteCampaign` tramite `mockCampaignRepo.createQueryBuilder` — quella logica è ora coperta dai test del Task 1 Step 1 su `CampaignCompletionService` in isolamento; qui basta verificare che il processor lo chiami, con l'id campagna giusto, in entrambi gli esiti.)

- [ ] **Step 8: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor campaign-completion --maxWorkers=2`
Expected: PASS, tutti i test verdi

- [ ] **Step 9: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/campaigns/campaign-completion.service.ts apps/backend/src/campaigns/campaign-completion.service.spec.ts apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "refactor(backend): estrae CampaignCompletionService condiviso da notification.processor"
```

---

### Task 2: `SendDispatchService` completa la campagna

**Files:**
- Modify: `apps/backend/src/channels/send/send-dispatch.service.ts` (costruttore, `markSuccess`, `markFailed`)
- Test: `apps/backend/src/channels/send/send-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `CampaignCompletionService.checkAndComplete(campaignId: string): Promise<void>` (Task 1, già provider nello stesso `ChannelModule` — nessun export aggiuntivo necessario, `SendDispatchService` vive nello stesso modulo).

- [ ] **Step 1: Scrivere il test che deve fallire**

In `apps/backend/src/channels/send/send-dispatch.service.spec.ts`, aggiungere l'import in cima:

```ts
import { CampaignCompletionService } from '../../campaigns/campaign-completion.service';
```

Dopo la dichiarazione di `mockUpload` (riga ~44), aggiungere:

```ts
  const mockCompletion = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };
```

Nell'array `providers` del `Test.createTestingModule` (dentro `beforeEach`, dopo `{ provide: SendAttachmentUploadService, useValue: mockUpload },`), aggiungere:

```ts
        { provide: CampaignCompletionService, useValue: mockCompletion },
```

Nel blocco `beforeEach`, dopo `jest.clearAllMocks();`, aggiungere se non già coperto:
```ts
    mockCompletion.checkAndComplete.mockClear();
```

Alla fine del `describe('SendDispatchService', ...)`, aggiungere:

```ts
  it('chiama CampaignCompletionService dopo un invio riuscito', async () => {
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
  });

  it('chiama CampaignCompletionService anche quando l\'invio a PN fallisce', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'errore' });
    mockBatch([makeAttempt()]);

    await service.handleCron();

    expect(mockCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
  });
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send-dispatch.service -t "CampaignCompletionService" --maxWorkers=2`
Expected: FAIL — `mockCompletion.checkAndComplete` mai chiamato (0 chiamate)

- [ ] **Step 3: Wire nel servizio**

In `apps/backend/src/channels/send/send-dispatch.service.ts`, aggiungere l'import:

```ts
import { CampaignCompletionService } from '../../campaigns/campaign-completion.service';
```

Nel costruttore, aggiungere il parametro (dopo `private readonly attachmentUpload: SendAttachmentUploadService,`):

```ts
    private readonly campaignCompletion: CampaignCompletionService,
```

In `markSuccess()`, subito dopo la riga `await this.campaignRepo.increment({ id: campaign.id }, 'sentCount', 1);`, aggiungere:

```ts
    await this.campaignCompletion.checkAndComplete(campaign.id);
```

In `markFailed()`, subito dopo la riga `await this.campaignRepo.increment({ id: attempt.recipient.campaign.id }, 'failedCount', 1);`, aggiungere:

```ts
    await this.campaignCompletion.checkAndComplete(attempt.recipient.campaign.id);
```

(In entrambi i casi, se `result.affected` è 0 il metodo già ritorna prima — nessuna chiamata a `checkAndComplete` per un attempt non più `QUEUED`, comportamento coerente con l'early-return esistente.)

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-dispatch.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi (inclusi quelli preesistenti)

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/send/send-dispatch.service.ts apps/backend/src/channels/send/send-dispatch.service.spec.ts
git commit -m "fix(backend): SendDispatchService completa la campagna dopo invio/fallimento (bug: restava QUEUED)"
```

---

### Task 3: Dettaglio notifica espone campi SEND

**Files:**
- Modify: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts:122-135`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Produces: `AttemptDetailDto` guadagna `iun: string | null`, `sendStatus: string | null`, `sendStatusUpdatedAt: string | null`, `protocolNumber: number | null`, `protocolYear: number | null`, `protocolledAt: string | null`. Consumato da Task 6 (frontend).

- [ ] **Step 1: Leggere il test esistente per `getDetail`**

Aprire `apps/backend/src/notifications-search/notifications-search.service.spec.ts`, blocco `describe('NotificationsSearchService.getDetail', ...)` (riga ~80), per capire il pattern dei mock attuali prima di estenderlo.

- [ ] **Step 2: Scrivere il test che deve fallire**

Nel blocco `describe('NotificationsSearchService.getDetail', ...)`, aggiungere:

```ts
  it('espone iun/protocollo/stato SEND quando presenti sull\'attempt', async () => {
    mockAttemptRepo.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'SEND',
        errorMessage: null,
        sentAt: new Date('2026-07-10T10:00:00Z'),
        createdAt: new Date('2026-07-10T09:00:00Z'),
        responsePayload: null,
        iun: 'ABCD-EFGH-ILMN-202607-X-1',
        sendStatus: 'ACCEPTED',
        sendStatusUpdatedAt: new Date('2026-07-11T08:00:00Z'),
        protocolNumber: 123,
        protocolYear: 2026,
        protocolledAt: new Date('2026-07-10T08:30:00Z'),
      },
    ]);

    const result = await service.getDetail('rec-1');

    expect(result.attempts[0]).toMatchObject({
      iun: 'ABCD-EFGH-ILMN-202607-X-1',
      sendStatus: 'ACCEPTED',
      sendStatusUpdatedAt: '2026-07-11T08:00:00.000Z',
      protocolNumber: 123,
      protocolYear: 2026,
      protocolledAt: '2026-07-10T08:30:00.000Z',
    });
  });

  it('espone i campi SEND come null per un attempt di un altro canale', async () => {
    mockAttemptRepo.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: new Date('2026-07-10T10:00:00Z'),
        createdAt: new Date('2026-07-10T09:00:00Z'),
        responsePayload: null,
        iun: null,
        sendStatus: null,
        sendStatusUpdatedAt: null,
        protocolNumber: null,
        protocolYear: null,
        protocolledAt: null,
      },
    ]);

    const result = await service.getDetail('rec-1');

    expect(result.attempts[0]).toMatchObject({
      iun: null,
      sendStatus: null,
      sendStatusUpdatedAt: null,
      protocolNumber: null,
      protocolYear: null,
      protocolledAt: null,
    });
  });
```

Verificare (leggendo il resto del file) i nomi esatti dei mock (`mockAttemptRepo`, `service`, come sono già usati negli altri test dello stesso blocco `getDetail`) e allineare i due test sopra a quei nomi se diversi.

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search.service -t "campi SEND" --maxWorkers=2`
Expected: FAIL — i campi attesi sono `undefined` nel risultato

- [ ] **Step 4: Aggiornare il DTO**

In `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`, sostituire:

```ts
export interface AttemptDetailDto {
  attemptNumber: number;
  status: string;
  channelType: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null };
}
```

con:

```ts
export interface AttemptDetailDto {
  attemptNumber: number;
  status: string;
  channelType: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null };
  iun: string | null;
  sendStatus: string | null;
  sendStatusUpdatedAt: string | null;
  protocolNumber: number | null;
  protocolYear: number | null;
  protocolledAt: string | null;
}
```

- [ ] **Step 5: Aggiornare il mapper**

In `apps/backend/src/notifications-search/notifications-search.service.ts`, dentro `getDetail()`, sostituire il blocco:

```ts
      attempts: attempts.map((a) => {
        const appIoPayload = a.responsePayload?.['appIo'] as { success?: boolean; error?: string } | undefined;
        return {
          attemptNumber: a.attemptNumber,
          status: a.status,
          channelType: a.channelType,
          errorMessage: a.errorMessage,
          sentAt: a.sentAt ? a.sentAt.toISOString() : null,
          createdAt: a.createdAt.toISOString(),
          appIo: appIoPayload
            ? { attempted: true as const, success: !!appIoPayload.success, error: appIoPayload.error ?? null }
            : { attempted: false as const },
        };
      }),
```

con:

```ts
      attempts: attempts.map((a) => {
        const appIoPayload = a.responsePayload?.['appIo'] as { success?: boolean; error?: string } | undefined;
        return {
          attemptNumber: a.attemptNumber,
          status: a.status,
          channelType: a.channelType,
          errorMessage: a.errorMessage,
          sentAt: a.sentAt ? a.sentAt.toISOString() : null,
          createdAt: a.createdAt.toISOString(),
          appIo: appIoPayload
            ? { attempted: true as const, success: !!appIoPayload.success, error: appIoPayload.error ?? null }
            : { attempted: false as const },
          iun: a.iun,
          sendStatus: a.sendStatus,
          sendStatusUpdatedAt: a.sendStatusUpdatedAt ? a.sendStatusUpdatedAt.toISOString() : null,
          protocolNumber: a.protocolNumber,
          protocolYear: a.protocolYear,
          protocolledAt: a.protocolledAt ? a.protocolledAt.toISOString() : null,
        };
      }),
```

- [ ] **Step 6: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/notifications-search/dto/notification-detail.dto.ts apps/backend/src/notifications-search/notifications-search.service.ts apps/backend/src/notifications-search/notifications-search.service.spec.ts
git commit -m "fix(backend): dettaglio notifica espone iun/protocollo/stato SEND (dati già salvati, mai esposti)"
```

---

### Task 4: Tabella destinatari espone campi SEND

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:919-942` (`getRecipientStats`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `NotificationAttempt` (già importato in `campaigns.service.ts`).
- Produces: `RecipientStatDto` guadagna `iun?: string | null`, `sendStatus?: string | null`, `sendStatusUpdatedAt?: Date | null`, `protocolNumber?: number | null`, `protocolYear?: number | null` — presenti solo per campagne SEND. Consumato da Task 6 (frontend).

- [ ] **Step 1: Scrivere il test che deve fallire**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, cercare il `describe` esistente per `getRecipientStats` (se non esiste, crearne uno nuovo vicino ad altri test di `CampaignsService` che usano lo stesso pattern di mock repo — verificare come sono mockati `campaignRepo`/`recipientRepo`/`attemptRepo` nei test già presenti nel file per riusare esattamente lo stesso stile). Aggiungere:

```ts
describe('CampaignsService.getRecipientStats — colonne SEND', () => {
  it('include iun/protocollo/stato SEND per l\'ultimo attempt di ciascun destinatario', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-1', channelType: 'SEND' });
    const mockQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'RSSMRA85M01H501Z', email: null, pec: null, status: 'sent', downloadCount: 0, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
        1,
      ]),
    };
    mockRecipientRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockAttemptRepo.find.mockResolvedValueOnce([
      { recipientId: 'r1', attemptNumber: 1, iun: null, sendStatus: null, sendStatusUpdatedAt: null, protocolNumber: 55, protocolYear: 2026 },
      { recipientId: 'r1', attemptNumber: 2, iun: 'ABCD-1234', sendStatus: 'ACCEPTED', sendStatusUpdatedAt: new Date('2026-07-11T08:00:00Z'), protocolNumber: 56, protocolYear: 2026 },
    ]);

    const result = await service.getRecipientStats('camp-1', 1, 50);

    expect(result.items[0]).toMatchObject({
      id: 'r1',
      iun: 'ABCD-1234',
      sendStatus: 'ACCEPTED',
      protocolNumber: 56,
      protocolYear: 2026,
    });
  });

  it('non aggiunge campi SEND per campagne di altri canali', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-2', channelType: 'EMAIL' });
    const mockQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [{ id: 'r2', fullName: 'Luigi Bianchi', codiceFiscale: 'BNCLGU80A01H501Y', email: 'l@b.it', pec: null, status: 'sent', downloadCount: 1, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
        1,
      ]),
    };
    mockRecipientRepo.createQueryBuilder.mockReturnValue(mockQb);

    const result = await service.getRecipientStats('camp-2', 1, 50);

    expect(mockAttemptRepo.find).not.toHaveBeenCalled();
    expect(result.items[0].iun).toBeUndefined();
  });
});
```

Adattare i nomi dei mock (`mockCampaignRepo`, `mockRecipientRepo`, `mockAttemptRepo`, `service`) a quelli realmente usati nel resto del file — leggere l'inizio di `campaigns.service.spec.ts` prima di scrivere per allinearli esattamente (non indovinare i nomi).

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "colonne SEND" --maxWorkers=2`
Expected: FAIL — `result.items[0].iun` è `undefined` nel primo test (atteso `'ABCD-1234'`)

- [ ] **Step 3: Aggiornare il DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, sostituire:

```ts
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

con:

```ts
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
  /** Presenti solo per campagne SEND (join su ultimo NotificationAttempt). */
  iun?: string | null;
  sendStatus?: string | null;
  sendStatusUpdatedAt?: Date | null;
  protocolNumber?: number | null;
  protocolYear?: number | null;
}
```

- [ ] **Step 4: Aggiornare `getRecipientStats()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituire l'intero metodo (righe ~919-942):

```ts
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

con:

```ts
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

    if (campaign.channelType === 'SEND' && items.length > 0) {
      // Due query separate invece di leftJoinAndSelect: stesso motivo del
      // bug TypeORM documentato in protocollazione-sync.service.ts/
      // send-dispatch.service.ts (leftJoinAndSelect + orderBy + take su
      // relazione dichiarata per stringa). Qui il join sarebbe su una
      // relazione 1-a-molti (un destinatario può avere più attempt): il
      // riduttore "ultimo per destinatario" si fa in JS sul risultato,
      // batch piccolo (una pagina di destinatari), nessun impatto pratico.
      const recipientIds = items.map((r) => r.id);
      const attempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), channelType: 'SEND' },
      });
      const latestByRecipient = new Map<string, NotificationAttempt>();
      for (const a of attempts) {
        const current = latestByRecipient.get(a.recipientId);
        if (!current || a.attemptNumber > current.attemptNumber) {
          latestByRecipient.set(a.recipientId, a);
        }
      }
      for (const item of items) {
        const latest = latestByRecipient.get(item.id);
        if (latest) {
          item.iun = latest.iun;
          item.sendStatus = latest.sendStatus;
          item.sendStatusUpdatedAt = latest.sendStatusUpdatedAt;
          item.protocolNumber = latest.protocolNumber;
          item.protocolYear = latest.protocolYear;
        }
      }
    }

    return { campaignId, page, pageSize, total, items };
  }
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "colonne SEND" --maxWorkers=2`
Expected: PASS (2/2)

- [ ] **Step 6: Eseguire l'intera suite `campaigns.service` e verificare nessuna regressione**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "fix(backend): getRecipientStats espone iun/protocollo/stato SEND per l'ultimo attempt"
```

---

### Task 5: Oggetto SEND mappabile da colonna CSV (fallback al template)

**Files:**
- Create: `apps/backend/src/channels/subject-mapping.util.ts`
- Test: `apps/backend/src/channels/subject-mapping.util.spec.ts`
- Modify: `apps/backend/src/channels/send/send-dispatch.service.ts:118-120`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:123-133` (`renderMessageForRecipient`)
- Test: `apps/backend/src/channels/send/send-dispatch.service.spec.ts`

**Interfaces:**
- Produces: `resolveSubjectTemplate(campaign: { channelConfig: Record<string, unknown>; name: string }, recipient: { extraData: Record<string, unknown> }): string` — usato da `send-dispatch.service.ts` (invio reale) e `campaigns.service.ts#renderMessageForRecipient` (anteprima/dettaglio).

- [ ] **Step 1: Scrivere il test che deve fallire**

Creare `apps/backend/src/channels/subject-mapping.util.spec.ts`:

```ts
import { resolveSubjectTemplate } from './subject-mapping.util';

describe('resolveSubjectTemplate', () => {
  it('usa il valore per-destinatario quando csvMapping.subject è configurato e la cella non è vuota', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico', csvMapping: { subject: 'oggetto_riga' } } };
    const recipient = { extraData: { oggetto_riga: 'Avviso specifico riga 1' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Avviso specifico riga 1');
  });

  it('usa il fallback al template generico se la colonna è mappata ma la cella è vuota', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico', csvMapping: { subject: 'oggetto_riga' } } };
    const recipient = { extraData: { oggetto_riga: '' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Template generico');
  });

  it('usa il template generico se csvMapping.subject non è configurato', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico' } };
    const recipient = { extraData: { oggetto_riga: 'Ignorato' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Template generico');
  });

  it('usa campaign.name come ultimo fallback se non c\'è nemmeno il template generico', () => {
    const campaign = { name: 'TARI 2026', channelConfig: {} };
    const recipient = { extraData: {} };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('TARI 2026');
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest subject-mapping.util --maxWorkers=2`
Expected: FAIL — `Cannot find module './subject-mapping.util'`

- [ ] **Step 3: Creare l'util**

Creare `apps/backend/src/channels/subject-mapping.util.ts`:

```ts
/**
 * Oggetto per destinatario: se la campagna mappa una colonna CSV per
 * l'oggetto (channelConfig.csvMapping.subject) e la cella di quel
 * destinatario non è vuota, usa quel valore al posto del template generico
 * di campagna (es. tributi diversi nello stesso invio SEND). Pura, nessun
 * effetto se csvMapping.subject non è configurato — comportamento
 * invariato per gli altri canali, che non popolano mai quella chiave.
 */
export function resolveSubjectTemplate(
  campaign: { channelConfig: Record<string, unknown>; name: string },
  recipient: { extraData: Record<string, unknown> },
): string {
  const csvMapping = campaign.channelConfig['csvMapping'] as Record<string, unknown> | undefined;
  const subjectColumn = csvMapping?.['subject'] as string | undefined;
  const perRecipientSubject = subjectColumn ? (recipient.extraData[subjectColumn] as string | undefined) : undefined;
  if (perRecipientSubject && perRecipientSubject.trim()) return perRecipientSubject;
  return (campaign.channelConfig['subject'] as string) || campaign.name;
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest subject-mapping.util --maxWorkers=2`
Expected: PASS (4/4)

- [ ] **Step 5: Usare l'util in `send-dispatch.service.ts`**

In `apps/backend/src/channels/send/send-dispatch.service.ts`, aggiungere l'import:

```ts
import { resolveSubjectTemplate } from '../subject-mapping.util';
```

Sostituire la riga:
```ts
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
```
con:
```ts
    const subject = interpolate(resolveSubjectTemplate(campaign, recipient), vars);
```

- [ ] **Step 6: Aggiungere il test di integrazione in `send-dispatch.service.spec.ts`**

In `apps/backend/src/channels/send/send-dispatch.service.spec.ts`, aggiungere:

```ts
  it('usa l\'oggetto per-destinatario quando csvMapping.subject è configurato', async () => {
    const attempt = makeAttempt();
    (attempt.recipient as any).campaign.channelConfig.csvMapping = { subject: 'oggetto_custom' };
    (attempt.recipient as any).extraData = { oggetto_custom: 'Oggetto specifico per Mario' };
    mockBatch([attempt]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const body = JSON.parse(sendCall![1].body);
    expect(body.subject).toBe('Oggetto specifico per Mario');
    expect(body.documents[0].title).toBe('Oggetto specifico per Mario');
  });
```

Verificare (leggendo il resto del file, in particolare i test esistenti che ispezionano `body.subject`/`documents[0].title`) che i nomi dei campi nel payload combacino esattamente con quelli reali prodotti da `dispatchOne()` — allineare se necessario invece di indovinare.

- [ ] **Step 7: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-dispatch.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi (incluso quello nuovo)

- [ ] **Step 8: Usare l'util in `campaigns.service.ts#renderMessageForRecipient`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungere l'import:

```ts
import { resolveSubjectTemplate } from '../channels/subject-mapping.util';
```

Sostituire la riga (dentro `renderMessageForRecipient`):
```ts
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || campaign.name;
```
con:
```ts
    const subjectTemplate = resolveSubjectTemplate(campaign, recipient);
```

- [ ] **Step 9: Eseguire l'intera suite `campaigns.service` e verificare nessuna regressione**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, tutti i test del file verdi

- [ ] **Step 10: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/channels/subject-mapping.util.ts apps/backend/src/channels/subject-mapping.util.spec.ts apps/backend/src/channels/send/send-dispatch.service.ts apps/backend/src/channels/send/send-dispatch.service.spec.ts apps/backend/src/campaigns/campaigns.service.ts
git commit -m "feat(backend): oggetto SEND mappabile da colonna CSV con fallback al template generico"
```

---

### Task 6: Frontend — dettaglio campagna e modal Dettaglio Notifica

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:240-247` (interfaccia `Recipient.attempts`), `:6727-6732` (Testo Messaggio), `:4813-4844` (Storico Tentativi), `:4864-4874` (Anteprima), `:6912-6946` (tabella Destinatari)

**Interfaces:**
- Consumes: `AttemptDetailDto`/`RecipientStatDto` estesi (Task 3, Task 4) — i nuovi campi arrivano già dal backend, questo task è solo rendering condizionale.

- [ ] **Step 1: Estendere il tipo TypeScript locale `attempts`**

In `apps/frontend-admin/src/App.tsx`, righe 240-247, sostituire:

```ts
  attempts?: Array<{
    id: string;
    channelType: string;
    status: string;
    responsePayload?: any;
    errorMessage?: string | null;
    attemptNumber: number;
  }>;
```

con:

```ts
  attempts?: Array<{
    id: string;
    channelType: string;
    status: string;
    responsePayload?: any;
    errorMessage?: string | null;
    attemptNumber: number;
    iun?: string | null;
    sendStatus?: string | null;
    sendStatusUpdatedAt?: string | null;
    protocolNumber?: number | null;
    protocolYear?: number | null;
    protocolledAt?: string | null;
  }>;
```

- [ ] **Step 2: Trovare la dichiarazione TypeScript di `notifDetail`**

Cercare `const [notifDetail, setNotifDetail] = useState<{` (riga ~319) e leggere la sua shape completa (`attempts: Array<{...}>`) per capire dove aggiungere gli stessi campi — è una dichiarazione inline separata dall'interfaccia `Recipient` sopra, va estesa allo stesso modo (stessi 6 campi opzionali) per far compilare l'accesso `a.iun` etc nello Step 4 sotto.

- [ ] **Step 3: Nascondere "Testo Messaggio" per SEND**

In `apps/frontend-admin/src/App.tsx`, righe 6727-6732, sostituire:

```tsx
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Testo Messaggio</label>
                          <div className="p-2 bg-light border rounded small" style={{ whiteSpace: 'pre-wrap' }}>
                            {campaign.description}
                          </div>
                        </div>
```

con:

```tsx
                        {campaign.channelType !== 'SEND' && (
                          <div className="mb-3">
                            <label className="text-muted small fw-semibold block">Testo Messaggio</label>
                            <div className="p-2 bg-light border rounded small" style={{ whiteSpace: 'pre-wrap' }}>
                              {campaign.description}
                            </div>
                          </div>
                        )}
```

- [ ] **Step 4: Colonne SEND nello Storico Tentativi (modal Dettaglio Notifica)**

In `apps/frontend-admin/src/App.tsx`, righe 4813-4844, sostituire:

```tsx
                        <h6 className="fw-bold small">Storico Tentativi</h6>
                        <table className="table table-sm mb-4">
                          <thead>
                            <tr>
                              <th>#</th><th>Stato</th><th>Canale</th><th>Data</th><th>Errore</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notifDetail.attempts.map((a) => (
                              <React.Fragment key={a.attemptNumber}>
                                <tr>
                                  <td>{a.attemptNumber}</td>
                                  <td><StatusBadge status={a.status} /></td>
                                  <td className="small"><ChannelBadge channel={a.channelType} /></td>
                                  <td className="small text-muted">{new Date(a.createdAt).toLocaleString('it-IT')}</td>
                                  <td className="small text-danger">{a.errorMessage || '—'}</td>
                                </tr>
```

con:

```tsx
                        <h6 className="fw-bold small">Storico Tentativi</h6>
                        <table className="table table-sm mb-4">
                          <thead>
                            <tr>
                              <th>#</th><th>Stato</th><th>Canale</th><th>Data</th>
                              {notifDetail.campaign.channelType === 'SEND' && (
                                <><th>IUN</th><th>Protocollo</th><th>Stato SEND</th><th>Aggiornato il</th></>
                              )}
                              <th>Errore</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notifDetail.attempts.map((a) => (
                              <React.Fragment key={a.attemptNumber}>
                                <tr>
                                  <td>{a.attemptNumber}</td>
                                  <td><StatusBadge status={a.status} /></td>
                                  <td className="small"><ChannelBadge channel={a.channelType} /></td>
                                  <td className="small text-muted">{new Date(a.createdAt).toLocaleString('it-IT')}</td>
                                  {notifDetail.campaign.channelType === 'SEND' && (
                                    <>
                                      <td className="small fw-mono">{a.iun || '—'}</td>
                                      <td className="small">{a.protocolNumber ? `${a.protocolNumber}/${a.protocolYear}` : '—'}</td>
                                      <td className="small">{a.sendStatus || '—'}</td>
                                      <td className="small text-muted">{a.sendStatusUpdatedAt ? new Date(a.sendStatusUpdatedAt).toLocaleString('it-IT') : '—'}</td>
                                    </>
                                  )}
                                  <td className="small text-danger">{a.errorMessage || '—'}</td>
                                </tr>
```

Il resto del `.map` (righe successive, blocco `appIo`) resta invariato — non aggiungere celle extra a quella riga (co-consegna App IO), la tabella avrà celle vuote per le colonne SEND su quella riga specifica poiché `notifDetail.campaign.channelType !== 'APP_IO'` implica comunque il check `=== 'SEND'` sopra la gestisce già correttamente (il canale primario è SEND, quindi le colonne compaiono; la riga App IO extra semplicemente non popola quelle celle — verificare in Step 6 che non generi disallineamento colonne: se serve, aggiungere celle vuote `<td colSpan={4}></td>` nella riga App IO quando `notifDetail.campaign.channelType === 'SEND'`, ma è un caso raro/inesistente in pratica perché SEND non ha mai App IO come secondario in questo repo — verificare `secondaryChannels` prima di aggiungere codice per un caso che potrebbe non esistere).

- [ ] **Step 5: Anteprima solo Oggetto per SEND**

In `apps/frontend-admin/src/App.tsx`, righe 4864-4874, sostituire:

```tsx
                        <h6 className="fw-bold small">Anteprima Messaggio Inviato</h6>
                        <div className="mb-2 small text-muted"><strong>Oggetto:</strong> {notifDetail.preview.subject}</div>
                        {notifDetail.preview.bodyHtml ? (
                          <div className="bg-white border rounded overflow-hidden" style={{ padding: '4px' }} dangerouslySetInnerHTML={{ __html: notifDetail.preview.bodyHtml }} />
                        ) : notifDetail.preview.bodyMarkdown ? (
                          <div className="bg-white border rounded p-3" data-color-mode="light">
                            <MDEditor.Markdown source={notifDetail.preview.bodyMarkdown} />
                          </div>
                        ) : (
                          <div className="text-muted small">Nessuna anteprima disponibile.</div>
                        )}
```

con:

```tsx
                        <h6 className="fw-bold small">{notifDetail.campaign.channelType === 'SEND' ? 'Oggetto Inviato' : 'Anteprima Messaggio Inviato'}</h6>
                        <div className="mb-2 small text-muted"><strong>Oggetto:</strong> {notifDetail.preview.subject}</div>
                        {notifDetail.campaign.channelType !== 'SEND' && (
                          notifDetail.preview.bodyHtml ? (
                            <div className="bg-white border rounded overflow-hidden" style={{ padding: '4px' }} dangerouslySetInnerHTML={{ __html: notifDetail.preview.bodyHtml }} />
                          ) : notifDetail.preview.bodyMarkdown ? (
                            <div className="bg-white border rounded p-3" data-color-mode="light">
                              <MDEditor.Markdown source={notifDetail.preview.bodyMarkdown} />
                            </div>
                          ) : (
                            <div className="text-muted small">Nessuna anteprima disponibile.</div>
                          )
                        )}
```

- [ ] **Step 6: Colonne SEND nella tabella "Destinatari Caricati"**

In `apps/frontend-admin/src/App.tsx`, prima riga 6912-6946, aggiornare anche il tipo di stato `recipientsPage` (riga 700) aggiungendo gli stessi campi opzionali visti allo Step 1 (`iun?`, `sendStatus?`, `sendStatusUpdatedAt?`, `protocolNumber?`, `protocolYear?`) all'interno del tipo `items: Array<{...}>`.

Poi sostituire il blocco tabella:

```tsx
                              <table className="table table-striped table-hover align-middle mb-0" style={{ fontSize: '0.82rem' }}>
                                <thead className="table-light sticky-top">
                                  <tr>
                                    <th>Codice Fiscale</th>
                                    <th>Nominativo</th>
                                    <th>Contatti (Email/PEC)</th>
                                    <th>Stato Notifica</th>
                                    <th className="text-center">Download</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {recipientsPage.items.map((r) => (
                                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.id)}>
                                      <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
                                      <td>{r.fullName || <span className="text-muted">N/D</span>}</td>
                                      <td>
                                        <div className="small d-flex flex-column gap-1">
                                          {r.email && <div><i className="far fa-envelope me-1"></i> {r.email}</div>}
                                          {r.pec && <div className="text-primary"><i className="fas fa-envelope-open-text me-1"></i> {r.pec}</div>}
                                        </div>
                                      </td>
                                      <td><StatusBadge status={r.status} /></td>
                                      <td className="text-center fw-bold">
                                        {r.downloadCount ? (
                                          <span className="text-success">
                                            <i className="fas fa-arrow-down me-1"></i> {r.downloadCount}
                                          </span>
                                        ) : (
                                          <span className="text-muted">—</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
```

con:

```tsx
                              <table className="table table-striped table-hover align-middle mb-0" style={{ fontSize: '0.82rem' }}>
                                <thead className="table-light sticky-top">
                                  <tr>
                                    <th>Codice Fiscale</th>
                                    <th>Nominativo</th>
                                    <th>Contatti (Email/PEC)</th>
                                    <th>Stato Notifica</th>
                                    {campaign.channelType === 'SEND' ? (
                                      <><th>IUN</th><th>Protocollo</th><th>Stato SEND</th><th>Aggiornato il</th></>
                                    ) : (
                                      <th className="text-center">Download</th>
                                    )}
                                  </tr>
                                </thead>
                                <tbody>
                                  {recipientsPage.items.map((r) => (
                                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.id)}>
                                      <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
                                      <td>{r.fullName || <span className="text-muted">N/D</span>}</td>
                                      <td>
                                        <div className="small d-flex flex-column gap-1">
                                          {r.email && <div><i className="far fa-envelope me-1"></i> {r.email}</div>}
                                          {r.pec && <div className="text-primary"><i className="fas fa-envelope-open-text me-1"></i> {r.pec}</div>}
                                        </div>
                                      </td>
                                      <td><StatusBadge status={r.status} /></td>
                                      {campaign.channelType === 'SEND' ? (
                                        <>
                                          <td className="small fw-mono">{r.iun || '—'}</td>
                                          <td className="small">{r.protocolNumber ? `${r.protocolNumber}/${r.protocolYear}` : '—'}</td>
                                          <td className="small">{r.sendStatus || '—'}</td>
                                          <td className="small text-muted">{r.sendStatusUpdatedAt ? new Date(r.sendStatusUpdatedAt).toLocaleString('it-IT') : '—'}</td>
                                        </>
                                      ) : (
                                        <td className="text-center fw-bold">
                                          {r.downloadCount ? (
                                            <span className="text-success">
                                              <i className="fas fa-arrow-down me-1"></i> {r.downloadCount}
                                            </span>
                                          ) : (
                                            <span className="text-muted">—</span>
                                          )}
                                        </td>
                                      )}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
```

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (verificare in particolare che il tipo inline di `notifDetail` step 2 sia stato esteso correttamente — un errore qui è quasi sempre lì)

- [ ] **Step 8: Verifica manuale in browser**

Stack dev avviato, login admin/admin. Aprire una campagna SEND con almeno un destinatario inviato (es. quella menzionata dall'utente, "TEST pipeline demoni SEND"):
- Dettaglio campagna: nessun blocco "Testo Messaggio".
- Tabella "Destinatari Caricati": colonne IUN/Protocollo/Stato SEND/Aggiornato il al posto di Download.
- Click su una riga: modal con Storico Tentativi che mostra le stesse colonne SEND, Anteprima che mostra solo l'Oggetto (nessun corpo/markdown).
- Aprire una campagna EMAIL/PEC esistente: nessuna differenza rispetto a prima (Download resta, Anteprima mostra ancora il corpo).

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): dettaglio campagna/notifica mostra iun/protocollo/stato SEND, nasconde messaggio irrilevante"
```

---

### Task 7: Frontend — wizard Step 3/Step 4 per SEND

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:455-461` (`wizMapping`), `:3972-4040` circa (Step 3, nuovo select), `:4303-4360` circa (Step 4), `:519-561` (effetto anteprima)

**Interfaces:**
- Consumes: nessuna nuova interfaccia backend (Task 5 già gestisce il fallback server-side per l'invio reale; qui si aggiunge solo il campo di mapping lato UI + l'anteprima client-side coerente).

- [ ] **Step 1: Aggiungere `subject` a `wizMapping`**

In `apps/frontend-admin/src/App.tsx`, righe 455-461, sostituire:

```ts
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
  });
```

con:

```ts
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
    subject: '',
  });
```

- [ ] **Step 2: Select mapping "Oggetto" in Step 3 (solo SEND)**

In `apps/frontend-admin/src/App.tsx`, dentro `wizStep === 3`, dopo il blocco `<div className="col-md-6">` del campo PEC (righe ~4028-4036, prima della sua chiusura `</div>` di riga griglia o subito dopo, verificare l'indentazione esatta leggendo il file), aggiungere un nuovo blocco visibile solo per SEND:

```tsx
                    {wizChannel === 'SEND' && (
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted">Oggetto (per destinatario - Opzionale)</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizMapping.subject}
                          onChange={e => handleWizMappingChange('subject', e.target.value)}
                        >
                          <option value="">-- Usa template unico (Passo 4) --</option>
                          {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                        </select>
                        <div className="form-text small text-muted">Se una riga ha questa colonna vuota, viene usato l'Oggetto generico del Passo 4.</div>
                      </div>
                    )}
```

- [ ] **Step 3: Step 4 ridotto per SEND**

In `apps/frontend-admin/src/App.tsx`, dentro `wizStep === 4` (righe ~4303-4360), leggere il blocco completo attuale (titolo, campo Oggetto, `TemplateEditor`, warning `wizAppIoBodyLenInvalid`, bottoni Indietro/Avanti con `disabled`) prima di modificarlo, poi:

- Cambiare il titolo `<h4 className="h6 fw-bold text-dark mb-3">Passo 4: Scrittura Template & Jolly Fields</h4>` in un titolo condizionale:
  ```tsx
  <h4 className="h6 fw-bold text-dark mb-3">{wizChannel === 'SEND' ? 'Passo 4: Oggetto della Comunicazione' : 'Passo 4: Scrittura Template & Jolly Fields'}</h4>
  ```
- Avvolgere l'intero blocco "Corpo del Messaggio" (`<div className="mb-3">` contenente `<label>Corpo del Messaggio...` + `<TemplateEditor .../>` + il blocco `{wizAppIoBodyLenInvalid && (...)}`) in `{wizChannel !== 'SEND' && (...)}`.
- Cambiare il bottone "Avanti" (`disabled={!wizSubject || isWizBodyEmpty(wizBody) || wizAppIoBodyLenInvalid}`) in:
  ```tsx
  disabled={!wizSubject || (wizChannel !== 'SEND' && (isWizBodyEmpty(wizBody) || wizAppIoBodyLenInvalid))}
  ```

- [ ] **Step 4: Anteprima Step 4 usa l'oggetto per-riga (client-side)**

In `apps/frontend-admin/src/App.tsx`, dentro l'effetto di anteprima (righe ~519-561), sostituire la riga:

```ts
          subject: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoSubjectOverride : wizSubject)
            : wizSubject,
```

con:

```ts
          subject: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoSubjectOverride : wizSubject)
            : ((wizMapping.subject && row[wizMapping.subject]?.trim()) || wizSubject),
```

(Nessun cambio all'array delle dipendenze dell'`useEffect`: `wizMapping` è già incluso, `row` deriva da `wizValidRows[wizPreviewIndex]` già incluso tramite `wizValidRows`.)

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 6: Verifica manuale in browser**

Stack dev avviato. Wizard "Invio Massivo" → canale SEND:
- Step 3: compare il nuovo select "Oggetto (per destinatario)", opzionale, con le colonne CSV.
- Step 4: titolo "Oggetto della Comunicazione", nessun editor corpo messaggio, bottone Avanti abilitato col solo Oggetto compilato.
- Se in Step 3 si mappa una colonna oggetto con valori diversi per riga, l'anteprima Step 4 (cambiando riga con le frecce, se presenti) mostra l'oggetto specifico di quella riga, non sempre il template.
- Canale EMAIL/PEC/APP_IO/POSTAL: Step 3 nessun nuovo select, Step 4 invariato (editor corpo presente, validazione invariata).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): wizard SEND — step 4 ridotto a solo Oggetto, oggetto mappabile da CSV in step 3"
```

---

### Task 8: Verifica finale, backfill campagna bloccata

**Files:** nessuno (solo verifica/operatività)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, stesso failure-set della baseline (1 fallimento `app.controller.spec.ts`, `isLdapMock`, pre-esistente e non correlato).

- [ ] **Step 2: Type-check completo backend + frontend-admin**

Run:
```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore in entrambi.

- [ ] **Step 3: Riavviare il backend dev (gotcha bind-mount Windows)**

Run: `docker compose restart backend`

Verificare che `dist/` sia stato ricompilato più recente di `src/` per i file toccati:
```bash
docker compose exec backend ls -la dist/campaigns/campaign-completion.service.js src/campaigns/campaign-completion.service.ts
```
Expected: il file `dist/` esiste con timestamp recente (creato dal watch/restart), non un errore "No such file or directory".

- [ ] **Step 4: Backfill della campagna SEND già bloccata in QUEUED**

La campagna SEND locale menzionata dall'utente (già inviata, ferma in `QUEUED` da prima di questo fix) non si sblocca da sola: il fix previene il problema per i prossimi invii, non corregge lo stato già scritto in DB. Trovare il suo id ed eseguire manualmente il completamento via query diretta sul container postgres — nessun endpoint dedicato esiste per questo caso una-tantum, non serve crearne uno:

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "SELECT id, name, status FROM campaigns WHERE channel_type = 'SEND' AND status = 'queued';"
```

Per ciascun id trovato dove non restano destinatari `pending`/`queued` (verificare prima con una query sui `recipients` di quella campagna), aggiornare manualmente:
```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "UPDATE campaigns SET status = 'completed', completed_at = now() WHERE id = '<ID_CAMPAGNA>' AND status = 'queued';"
```

Verificare in UI (Impostazioni → dettaglio campagna) che lo stato sia ora "Completata".

- [ ] **Step 5: Verifica manuale end-to-end residua**

Se possibile (ambiente con credenziali SEND UAT valide), lanciare una piccola campagna SEND di test, attendere i cicli dei demoni (`ProtocollazioneSyncService` ogni 2 min, `SendDispatchService` ogni 2 min, `SendStatusSyncService` ogni 5 min) e osservare: la campagna passa a `COMPLETED` da sola dopo l'invio; il dettaglio notifica mostra IUN/protocollo/stato non appena disponibili; se è stata mappata una colonna oggetto in Step 3, l'oggetto realmente ricevuto da PN corrisponde al valore per-riga.
