# Annulla Campagna Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere un'azione "Annulla Campagna" che rimuove dalla coda BullMQ solo i messaggi non ancora processati di una campagna `QUEUED`, senza toccare i destinatari già `SENT`/`FAILED`, e marca la campagna come stato terminale `CANCELLED`.

**Architecture:** I job BullMQ vengono accodati con `jobId` esplicito = `attemptId` (oggi auto-generato), così l'annullamento può recuperarli con lookup diretto (`queue.getJob(attemptId)`) invece di scansionare l'intera coda del canale. Tre nuovi valori enum (`CANCELLED` su campaign/recipient/attempt) via migration Postgres. Nuovo metodo `cancel()` in `CampaignsService`, nuovo endpoint `POST admin/campaigns/:id/cancel`, nuovo bottone in `App.tsx`.

**Tech Stack:** NestJS 10, TypeORM (Postgres), BullMQ (`@nestjs/bullmq`), Jest, React 19 (frontend-admin, TSX inline in `App.tsx`).

## Global Constraints

- Jest sempre con `--maxWorkers=2` (limite RAM WSL2): `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`.
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Type-check frontend-admin: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Migration DB generata/verificata su DB temporaneo (vedi CLAUDE.md sezione "Migration DB"), mai a mano senza verifica.
- Nomi migration: classe `<Nome><timestamp>`, file `<timestamp>-<Nome>.ts`, timestamp = epoch ms crescente rispetto all'ultima migration registrata (`1783358259000-FixRecipientAttemptJoin.ts`).
- Nessuna riga di codice va scritta senza il test che la richiede prima (TDD): scrivi il test, verificalo fallire, poi implementa.

---

### Task 1: Enum `CANCELLED` su Campaign/Recipient/NotificationAttempt + migration

**Files:**
- Modify: `apps/backend/src/entities/campaign.entity.ts`
- Modify: `apps/backend/src/entities/recipient.entity.ts`
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts`
- Create: `apps/backend/src/database/migrations/<timestamp>-AddCancelledStatus.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `CampaignStatus.CANCELLED = 'cancelled'`, `RecipientStatus.CANCELLED = 'cancelled'`, `AttemptStatus.CANCELLED = 'cancelled'` — usati da Task 4.

- [ ] **Step 1: Aggiungi il valore enum a `campaign.entity.ts`**

In `apps/backend/src/entities/campaign.entity.ts`, modifica l'enum:

```typescript
export enum CampaignStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}
```

- [ ] **Step 2: Aggiungi il valore enum a `recipient.entity.ts`**

In `apps/backend/src/entities/recipient.entity.ts`, modifica l'enum:

```typescript
export enum RecipientStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
}
```

- [ ] **Step 3: Aggiungi il valore enum a `notification-attempt.entity.ts`**

In `apps/backend/src/entities/notification-attempt.entity.ts`, modifica l'enum:

```typescript
export enum AttemptStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}
```

- [ ] **Step 4: Genera la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddCancelledStatus -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Il file generato conterrà 3 statement `ALTER TYPE ... ADD VALUE`. Verifica che il nome classe/`name` interno segua il pattern `AddCancelledStatus<timestamp>` (rinomina se `typeorm-ts-node-commonjs` genera un nome diverso, per coerenza con le migration esistenti).

- [ ] **Step 5: Verifica il contenuto della migration generata**

Deve contenere (nomi tipo esatti, da `1783023440824-InitialSchema.ts`):

```typescript
public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."campaigns_status_enum" ADD VALUE 'cancelled'`);
    await queryRunner.query(`ALTER TYPE "public"."recipients_status_enum" ADD VALUE 'cancelled'`);
    await queryRunner.query(`ALTER TYPE "public"."notification_attempts_status_enum" ADD VALUE 'cancelled'`);
}

public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres non supporta la rimozione di un valore enum: down() è un no-op documentato.
}
```

Se `down()` risulta vuoto/mancante, aggiungilo a mano col commento sopra (Postgres non ha `DROP VALUE`, è comportamento noto e accettato nel progetto).

- [ ] **Step 6: Registra la migration in `database.module.ts`**

Aggiungi l'import (sostituisci `<timestamp>` col valore reale generato):

```typescript
import { AddCancelledStatus<timestamp> } from './migrations/<timestamp>-AddCancelledStatus';
```

E aggiungila in coda all'array `migrations`:

```typescript
migrations: [InitialSchema1783023440824, AddMailServerConfigs1783071728873, AddIoServiceConfigs1783092759564, AddTemplates1783109448492, FixRecipientCampaignJoin1783148719725, AddDownloadEvents1783200000000, FixRecipientAttemptJoin1783358259000, AddCancelledStatus<timestamp>],
```

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/entities/campaign.entity.ts apps/backend/src/entities/recipient.entity.ts apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/ apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiungi stato CANCELLED a campagne/destinatari/tentativi"
```

---

### Task 2: `NotificationQueuesService.getJob()` + `addBulk` con `jobId` esplicito

**Files:**
- Modify: `apps/backend/src/queue/notification-queues.service.ts`
- Modify: `apps/backend/src/queue/notification-queues.service.spec.ts`

**Interfaces:**
- Consumes: nessuna dipendenza da Task 1.
- Produces:
  - `addBulk(channel: NotificationChannel, jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>)` — firma estesa, usata da Task 3.
  - `getJob(channel: NotificationChannel, jobId: string): Promise<Job<NotificationJobData> | undefined>` — usata da Task 4.

- [ ] **Step 1: Scrivi il test fallente per `getJob`**

In `apps/backend/src/queue/notification-queues.service.spec.ts`, aggiungi un nuovo `describe` in fondo al file:

```typescript
describe('NotificationQueuesService.getJob', () => {
  it('recupera un job per id dalla coda del canale corretto', async () => {
    const mockJob = { id: 'attempt-123', remove: jest.fn() };
    const getJob = jest.fn().mockResolvedValue(mockJob);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJob } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.SEND), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJob('EMAIL', 'attempt-123');

    expect(getJob).toHaveBeenCalledWith('attempt-123');
    expect(result).toBe(mockJob);
  });

  it('ritorna undefined se il job non esiste piu (gia rimosso/completato)', async () => {
    const getJob = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJob } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.SEND), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJob('EMAIL', 'gone-123');

    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Esegui il test, verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest notification-queues.service --maxWorkers=2`
Expected: FAIL — `service.getJob is not a function`.

- [ ] **Step 3: Implementa `getJob` e la firma estesa di `addBulk`**

In `apps/backend/src/queue/notification-queues.service.ts`, sostituisci il metodo `addBulk` e aggiungi `getJob` subito dopo:

```typescript
  addBulk(
    channel: NotificationChannel,
    jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>,
  ) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJob(channel: NotificationChannel, jobId: string) {
    return this.getQueue(channel).getJob(jobId);
  }
```

- [ ] **Step 4: Esegui il test, verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest notification-queues.service --maxWorkers=2`
Expected: PASS, 3 test totali nel file (1 esistente `getJobsDetail` + 2 nuovi).

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/queue/notification-queues.service.ts apps/backend/src/queue/notification-queues.service.spec.ts
git commit -m "feat(backend): NotificationQueuesService.getJob + jobId esplicito in addBulk"
```

---

### Task 3: `launch()` e `retryRecipient()` accodano job con `jobId = attemptId`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:249-342` (`launch`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:469-504` (`retryRecipient`)
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `NotificationQueuesService.addBulk` con firma estesa da Task 2 (`opts?: { jobId?: string }`).
- Produces: ogni job BullMQ accodato da queste due funzioni ha `id === attemptId` — precondizione per `cancel()` in Task 4.

- [ ] **Step 1: Scrivi il test fallente per `launch()`**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, trova il test esistente di `launch` che verifica la chiamata a `addBulk` (cerca `mockQueue.addBulk` nel blocco `describe` di `launch`) e aggiungi/adatta l'assert per includere `opts.jobId`. Se non esiste un test dedicato al payload di `addBulk`, aggiungine uno nuovo:

```typescript
it('launch accoda i job BullMQ con jobId = attemptId', async () => {
  mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
  mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });
  mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
  mockAttemptRepo.createQueryBuilder.mockReturnValue({
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
  });

  await service.launch('c1');

  expect(mockQueue.addBulk).toHaveBeenCalledWith(
    mockCampaign.channelType,
    [
      expect.objectContaining({ opts: { jobId: 'att-1' } }),
      expect.objectContaining({ opts: { jobId: 'att-2' } }),
    ],
  );
});
```

- [ ] **Step 2: Esegui il test, verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "jobId = attemptId"`
Expected: FAIL — `opts` non presente nell'oggetto job passato a `addBulk`.

- [ ] **Step 3: Implementa in `launch()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, nel blocco che costruisce i job BullMQ (righe ~320-333), aggiungi `opts`:

```typescript
      await this.notificationQueues.addBulk(
        campaign.channelType,
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: campaign.channelType,
          },
          opts: { jobId: attemptIds[i + idx] },
        })),
      );
```

- [ ] **Step 4: Implementa in `retryRecipient()`**

Nello stesso file, righe ~499-501:

```typescript
    await this.notificationQueues.addBulk(campaign.channelType, [
      { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
    ]);
```

- [ ] **Step 5: Esegui tutti i test di `campaigns.service`, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, nessuna regressione sui test esistenti di `launch`/`retryRecipient`.

- [ ] **Step 6: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): launch/retryRecipient accodano job con jobId = attemptId"
```

---

### Task 4: `CampaignsService.cancel()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `CampaignStatus.CANCELLED`/`RecipientStatus.CANCELLED`/`AttemptStatus.CANCELLED` (Task 1), `NotificationQueuesService.getJob` (Task 2).
- Produces: `cancel(campaignId: string): Promise<{ cancelled: number; campaignId: string }>` — usato da Task 5 (controller).

- [ ] **Step 1: Aggiungi `getJob` al mock base di `NotificationQueuesService`**

Il `mockQueue` in cima a `apps/backend/src/campaigns/campaigns.service.spec.ts` (riga ~80, `const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined) };`) è tipizzato solo con `addBulk` — assegnargli `getJob` più avanti nei test fallirebbe la compilazione TS (proprietà non dichiarata sul tipo inferito). Modificalo per includere `getJob` fin da subito:

```typescript
  const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined), getJob: jest.fn() };
```

- [ ] **Step 2: Scrivi i test falliti per `cancel()`**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, aggiungi un nuovo blocco `describe`:

```typescript
describe('cancel', () => {
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  beforeEach(() => {
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockQb.execute.mockResolvedValue({ affected: 1 });
    mockQueue.getJob.mockReset();
  });

  it('lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.cancel('missing')).rejects.toThrow('Campaign missing not found');
  });

  it('lancia BadRequestException se la campagna non e QUEUED', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
    await expect(service.cancel('c1')).rejects.toThrow('Solo campagne in corso possono essere annullate');
  });

  it('rimuove i job in coda, marca CANCELLED recipient/attempt/campagna, salta i job gia attivi', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'EMAIL' });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
      { id: 'att-1', recipientId: 'r1' },
      { id: 'att-2', recipientId: 'r2' },
    ]);
    const removeOk = jest.fn().mockResolvedValue(undefined);
    const removeFails = jest.fn().mockRejectedValue(new Error('job is active'));
    mockQueue.getJob
      .mockResolvedValueOnce({ id: 'att-1', remove: removeOk })
      .mockResolvedValueOnce({ id: 'att-2', remove: removeFails });
    mockAttemptRepo.update = jest.fn().mockResolvedValue(undefined);
    mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.cancel('c1');

    expect(mockQueue.getJob).toHaveBeenNthCalledWith(1, 'EMAIL', 'att-1');
    expect(mockQueue.getJob).toHaveBeenNthCalledWith(2, 'EMAIL', 'att-2');
    expect(removeOk).toHaveBeenCalled();
    expect(removeFails).toHaveBeenCalled();
    expect(mockAttemptRepo.update).toHaveBeenCalledWith({ id: In(['att-1']) }, { status: AttemptStatus.CANCELLED });
    expect(mockRecipientRepo.update).toHaveBeenCalledWith({ id: In(['r1']) }, { status: RecipientStatus.CANCELLED });
    expect(mockQb.set).toHaveBeenCalledWith({ status: CampaignStatus.CANCELLED, completedAt: expect.any(Date) });
    expect(result).toEqual({ cancelled: 1, campaignId: 'c1' });
  });

  it('non aggiorna nulla se non ci sono destinatari in coda (nessun job da rimuovere)', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'EMAIL' });
    mockRecipientRepo.find.mockResolvedValueOnce([]);
    mockAttemptRepo.update = jest.fn().mockResolvedValue(undefined);
    mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.cancel('c1');

    expect(mockAttemptRepo.update).not.toHaveBeenCalled();
    expect(mockRecipientRepo.update).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: 0, campaignId: 'c1' });
  });
});
```

Nota: il mock `mockAttemptRepo` in cima al file non ha `find`/`update` di default (solo `createQueryBuilder`) — verifica se serve aggiungerli all'oggetto base `mockAttemptRepo` (righe ~69-77) con default `find: jest.fn().mockResolvedValue([])` e `update: jest.fn().mockResolvedValue(undefined)`, per evitare `undefined is not a function` negli altri test che non li sovrascrivono.

- [ ] **Step 3: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "cancel"`
Expected: FAIL — `service.cancel is not a function`.

- [ ] **Step 4: Implementa `cancel()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi il metodo subito dopo `launch()` (dopo la riga 342, prima di `getStats`):

```typescript
  async cancel(campaignId: string): Promise<{ cancelled: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.QUEUED) {
      throw new BadRequestException('Solo campagne in corso possono essere annullate');
    }

    const queuedRecipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.QUEUED },
      select: ['id'],
    });

    let cancelled = 0;
    if (queuedRecipients.length > 0) {
      const recipientIds = queuedRecipients.map((r) => r.id);
      const liveAttempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), status: AttemptStatus.QUEUED },
      });

      const removedAttemptIds: string[] = [];
      const removedRecipientIds: string[] = [];
      for (const attempt of liveAttempts) {
        const job = await this.notificationQueues.getJob(campaign.channelType, attempt.id);
        if (!job) continue;
        try {
          await job.remove();
          removedAttemptIds.push(attempt.id);
          removedRecipientIds.push(attempt.recipientId);
        } catch (err) {
          this.logger.warn(
            `Job ${attempt.id} non rimosso (probabilmente in elaborazione): ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      if (removedAttemptIds.length > 0) {
        await this.attemptRepo.update({ id: In(removedAttemptIds) }, { status: AttemptStatus.CANCELLED });
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { status: RecipientStatus.CANCELLED });
      }
      cancelled = removedRecipientIds.length;
    }

    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.CANCELLED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();

    return { cancelled, campaignId };
  }
```

- [ ] **Step 5: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, tutti i test del file incluso il nuovo blocco `cancel`.

- [ ] **Step 6: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): CampaignsService.cancel annulla i soli messaggi in coda"
```

---

### Task 5: Endpoint `POST admin/campaigns/:id/cancel`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`

**Interfaces:**
- Consumes: `CampaignsService.cancel(campaignId: string)` (Task 4).
- Produces: `POST admin/campaigns/:id/cancel` → `{ cancelled: number; campaignId: string }`, usato dal frontend in Task 6.

- [ ] **Step 1: Aggiungi la route**

In `apps/backend/src/campaigns/campaigns.controller.ts`, subito dopo il metodo `launch` (righe 264-269):

```typescript
  @Post(':id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ cancelled: number; campaignId: string }> {
    return this.campaignsService.cancel(id);
  }
```

Nessun `@Roles` override: eredita il default di classe (`user`, `admin`), stesso livello di `launch`.

- [ ] **Step 2: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Riavvia il backend e verifica manualmente con token debug**

```bash
docker compose restart backend
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

Poi (sostituendo `<TOKEN>` e un `<CAMPAIGN_ID>` con status `queued` reale nel DB dev):

```bash
curl -s -X POST http://localhost:8080/admin/campaigns/<CAMPAIGN_ID>/cancel -H "Authorization: Bearer <TOKEN>"
```

Expected: `{"cancelled":N,"campaignId":"<CAMPAIGN_ID>"}`, e in DB la campagna risulta `status = 'cancelled'`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts
git commit -m "feat(backend): endpoint POST admin/campaigns/:id/cancel"
```

---

### Task 6: Bottone "Annulla Campagna" in `App.tsx`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:145` (interface `Campaign`)
- Modify: `apps/frontend-admin/src/App.tsx:638` (stato `cancelling`)
- Modify: `apps/frontend-admin/src/App.tsx:2471-2493` (handler, subito dopo `handleLaunchCampaign`)
- Modify: `apps/frontend-admin/src/App.tsx:5506-5519` (bottone)

**Interfaces:**
- Consumes: `POST {ADMIN_API_BASE}/campaigns/:id/cancel` (Task 5), risposta `{ cancelled: number; campaignId: string }`.
- Produces: nessuna interfaccia consumata da altri task — ultimo task del piano.

- [ ] **Step 1: Estendi il tipo `status` di `Campaign`**

In `apps/frontend-admin/src/App.tsx:145`:

```typescript
  status: 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
```

- [ ] **Step 2: Aggiungi lo stato `cancelling`**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga `const [launching, setLaunching] = useState(false);` (riga 638):

```typescript
  const [cancelling, setCancelling] = useState(false);
```

- [ ] **Step 3: Aggiungi l'handler `handleCancelCampaign`**

Subito dopo la chiusura di `handleLaunchCampaign` (dopo riga 2493, prima del commento `// Render Guest Login View`):

```typescript
  const handleCancelCampaign = async () => {
    if (!campaign) return;
    if (!confirm(`Annullare la campagna "${campaign.name}"? I messaggi già inviati NON verranno toccati, ma quelli ancora in coda saranno eliminati e non potranno più essere inviati. L'operazione è irreversibile.`)) {
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/campaigns/${campaign.id}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Errore durante l\'annullamento della campagna');
      }
      const data = await res.json();
      alert(`Campagna annullata. Destinatari rimossi dalla coda: ${data.cancelled}.`);
      fetchCampaignDetail(campaign.id);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCancelling(false);
    }
  };
```

- [ ] **Step 4: Aggiungi il bottone**

In `apps/frontend-admin/src/App.tsx`, subito dopo il blocco del bottone "Lancia Campagna" (dopo riga 5518, prima del blocco `{campaign.totalRecipients === 0 && ...}` a riga 5520 — oppure dopo quello, l'ordine tra i due blocchi non è rilevante perché condizioni mutuamente esclusive su `status`):

```tsx
                          {campaign.status === 'queued' && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold"
                              disabled={cancelling}
                              onClick={handleCancelCampaign}
                            >
                              {cancelling ? (
                                <><i className="fas fa-spinner fa-spin me-2"></i>Annullamento in corso...</>
                              ) : (
                                <><i className="fas fa-ban me-2"></i>Annulla Campagna</>
                              )}
                            </button>
                          )}
```

- [ ] **Step 5: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

Con `docker compose up -d` attivo: apri `http://localhost:3000`, login `admin`/`admin` (LDAP mock dev), lancia una campagna con destinatari, apri il dettaglio campagna, verifica che compaia il bottone "Annulla Campagna" solo quando lo stato è "queued", clicca, conferma il dialog, verifica alert con conteggio e che lo stato/i contatori si aggiornino dopo il refresh.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): bottone Annulla Campagna nel dettaglio campagna"
```
