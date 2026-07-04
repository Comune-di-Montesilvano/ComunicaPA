# ComunicaPA Fase 3 — Motore di Smistamento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare BullMQ per code asincrone, ingestione CSV in streaming (no full in-memory), endpoint Campaign CRUD con lancio che accoda job, e servizio di timbro PDF con pdf-lib.

**Architecture:** CSV upload → multer disk storage → csv-parse streaming `for await` → batch upsert Recipient → `POST /campaigns/:id/launch` crea NotificationAttempt + `addBulk` su queue `notifications` → NotificationProcessor (stub, Fase 4 aggiunge strategy) aggiorna stati. PdfService espone `stampPdfBytes(Uint8Array)` (pura, testabile) e `stampWithProtocol(fileId)` (con I/O file su volume Docker).

**Tech Stack:** `@nestjs/bullmq ^10`, `bullmq ^5`, `csv-parse ^5`, `pdf-lib ^1.17`, multer (via `@nestjs/platform-express`), TypeORM 0.3, Redis 7, PostgreSQL 17.

## Global Constraints

- Nessun tool installato in locale — tutto gira in Docker
- pnpm v11: rebuild obbligatorio dopo modifica `package.json`: `docker compose down && docker volume rm comunicapa_backend_node_modules && docker compose up -d --build backend`
- TypeScript strict mode completo — nessun `any` esplicito
- CSV non allocato mai interamente in RAM: solo pipe stream (`createReadStream` → `csv-parse`)
- Test in Docker: `docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern <pattern> --forceExit`
- Restart (senza rebuild) sufficiente per modifiche a file `.ts` già montati: `docker compose restart backend`
- Working directory: `C:\Users\mirko.daddiego\Documents\comunicapa`
- Git: commit al termine di ogni task

---

## File Map

| File | Azione |
|------|--------|
| `packages/shared-types/src/index.ts` | MODIFY — aggiungi `NotificationJobData` |
| `apps/backend/package.json` | MODIFY — aggiungi `@nestjs/bullmq`, `bullmq`, `csv-parse`, `pdf-lib`, `@types/multer` |
| `apps/backend/src/queue/notification-job.types.ts` | CREATE — costanti coda e nome job |
| `apps/backend/src/queue/queue.module.ts` | CREATE — BullModule forRoot + registerQueue + processor |
| `apps/backend/src/queue/notification.processor.ts` | CREATE — @Processor stub |
| `apps/backend/src/queue/notification.processor.spec.ts` | CREATE — unit test |
| `apps/backend/src/campaigns/dto/create-campaign.dto.ts` | CREATE |
| `apps/backend/src/campaigns/campaigns.service.ts` | CREATE — findAll, findOne, create, uploadCsv, launch |
| `apps/backend/src/campaigns/campaigns.service.spec.ts` | CREATE — unit test CRUD |
| `apps/backend/src/campaigns/campaigns.controller.ts` | CREATE — REST endpoints |
| `apps/backend/src/campaigns/campaigns.module.ts` | CREATE |
| `apps/backend/src/pdf/pdf.service.ts` | CREATE — stampPdfBytes + stampWithProtocol |
| `apps/backend/src/pdf/pdf.service.spec.ts` | CREATE — unit test |
| `apps/backend/src/pdf/pdf.module.ts` | CREATE |
| `apps/backend/src/app.module.ts` | MODIFY — import QueueModule, CampaignsModule, PdfModule |
| `apps/backend/src/main.ts` | MODIFY — `mkdirSync` per directory upload temp |
| `docker-compose.yml` | MODIFY — volume `pdf_storage` + mount + env `PDF_STORAGE_PATH` |
| `.env.example` | MODIFY — aggiungi `PDF_STORAGE_PATH` |
| `.env` | MODIFY — aggiungi `PDF_STORAGE_PATH` |

---

### Task 1: Packages + Shared Types + BullMQ QueueModule

**Files:**
- Modify: `packages/shared-types/src/index.ts`
- Modify: `apps/backend/package.json`
- Create: `apps/backend/src/queue/notification-job.types.ts`
- Create: `apps/backend/src/queue/queue.module.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Produces: `NOTIFICATION_QUEUE = 'notifications'`, `NOTIFICATION_JOB_SEND = 'send'`
- Produces: `NotificationJobData { campaignId, recipientId, attemptId, channel }` — usato da Task 2 (processor) e Task 3 (launch)
- Produces: `QueueModule` esportato con `BullModule` — importabile da `CampaignsModule`

- [ ] **Step 1: Aggiungi `NotificationJobData` a `packages/shared-types/src/index.ts`**

Appendi in fondo al file (dopo `CitizenTokenClaims`):

```typescript
export interface NotificationJobData {
  campaignId: string;
  recipientId: string;
  attemptId: string;
  channel: NotificationChannel;
}
```

- [ ] **Step 2: Aggiungi dipendenze a `apps/backend/package.json`**

Nel blocco `dependencies`, aggiungi dopo `"pg": "^8.0.0"`:

```json
"@nestjs/bullmq": "^10.0.0",
"bullmq": "^5.0.0",
"csv-parse": "^5.0.0",
"pdf-lib": "^1.17.0"
```

Nel blocco `devDependencies`, aggiungi dopo `"@types/node": "^22.0.0"`:

```json
"@types/multer": "^1.4.0"
```

- [ ] **Step 3: Crea `apps/backend/src/queue/notification-job.types.ts`**

```typescript
export const NOTIFICATION_QUEUE = 'notifications';
export const NOTIFICATION_JOB_SEND = 'send';
```

- [ ] **Step 4: Crea `apps/backend/src/queue/queue.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfiguration } from '../config/configuration';
import { NOTIFICATION_QUEUE } from './notification-job.types';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => {
        const redisUrl = new URL(config.get('redis.url', { infer: true }));
        return {
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port) || 6379,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign]),
  ],
  providers: [NotificationProcessor],
  exports: [BullModule],
})
export class QueueModule {}
```

- [ ] **Step 5: Crea `apps/backend/src/queue/notification.processor.ts`**

```typescript
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { NOTIFICATION_QUEUE } from './notification-job.types';

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { campaignId, attemptId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} channel=${channel}`);

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    try {
      // Fase 4: qui verranno chiamate le strategy di canale (SEND, Email, PEC, AppIO, Postal)
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.SUCCESS,
        sentAt: new Date(),
      });
      await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: msg,
      });
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      throw error;
    }
  }
}
```

- [ ] **Step 6: Aggiungi `QueueModule` a `apps/backend/src/app.module.ts`**

Aggiungi import in cima:
```typescript
import { QueueModule } from './queue/queue.module';
```

Aggiungi `QueueModule` nell'array `imports` del `@Module` (dopo `AuthModule`):
```typescript
imports: [
  ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
  DatabaseModule,
  AuthModule,
  QueueModule,
],
```

- [ ] **Step 7: Rebuild Docker e verifica avvio**

```powershell
docker compose down
docker volume rm comunicapa_backend_node_modules
docker compose up -d --build backend
Start-Sleep -Seconds 45
docker compose logs backend 2>&1 | Select-Object -Last 8
```

Expected: `Nest application successfully started` — nessun errore BullMQ/Redis.

- [ ] **Step 8: Commit**

```bash
git add packages/shared-types/src/index.ts apps/backend/package.json apps/backend/src/queue/ apps/backend/src/app.module.ts
git commit -m "feat(fase3): BullMQ QueueModule + NotificationProcessor stub + NotificationJobData"
```

---

### Task 2: NotificationProcessor — Unit Tests

**Files:**
- Create: `apps/backend/src/queue/notification.processor.spec.ts`

**Interfaces:**
- Consumes: `NotificationProcessor` (Task 1), `NotificationJobData`, `AttemptStatus`
- Produces: suite di test che verifica transizioni di stato attempt: QUEUED→PROCESSING→SUCCESS e QUEUED→PROCESSING→FAILED

- [ ] **Step 1: Crea `apps/backend/src/queue/notification.processor.spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import type { NotificationJobData } from '@comunicapa/shared-types';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  const mockAttemptRepo = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockCampaignRepo = {
    increment: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
      ],
    }).compile();
    processor = module.get<NotificationProcessor>(NotificationProcessor);
    jest.clearAllMocks();
    mockAttemptRepo.update.mockResolvedValue(undefined);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  it('marks attempt PROCESSING then SUCCESS and increments sentCount', async () => {
    const jobData: NotificationJobData = {
      campaignId: 'c1',
      recipientId: 'r1',
      attemptId: 'a1',
      channel: 'EMAIL',
    };
    const job = { id: '1', data: jobData } as Job<NotificationJobData>;

    await processor.process(job);

    expect(mockAttemptRepo.update).toHaveBeenNthCalledWith(1, 'a1', {
      status: AttemptStatus.PROCESSING,
    });
    expect(mockAttemptRepo.update).toHaveBeenNthCalledWith(
      2,
      'a1',
      expect.objectContaining({ status: AttemptStatus.SUCCESS }),
    );
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'c1' }, 'sentCount', 1);
  });

  it('marks attempt FAILED on error, increments failedCount, re-throws', async () => {
    const jobData: NotificationJobData = {
      campaignId: 'c1',
      recipientId: 'r1',
      attemptId: 'a1',
      channel: 'PEC',
    };
    const job = { id: '2', data: jobData } as Job<NotificationJobData>;
    const networkError = new Error('network timeout');

    // Prima call (PROCESSING) ok, seconda call (SUCCESS) lancia → va nel catch
    mockAttemptRepo.update
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(networkError);

    await expect(processor.process(job)).rejects.toThrow('network timeout');

    // Terza call nel catch: FAILED
    expect(mockAttemptRepo.update).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ status: AttemptStatus.FAILED }),
    );
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'c1' }, 'failedCount', 1);
  });
});
```

- [ ] **Step 2: Restart container (nuovo file .ts non rilevato da chokidar su Windows)**

```powershell
docker compose restart backend
Start-Sleep -Seconds 25
```

- [ ] **Step 3: Esegui test**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern notification.processor --forceExit 2>&1
```

Expected output:
```
PASS src/queue/notification.processor.spec.ts
  NotificationProcessor
    ✓ is defined
    ✓ marks attempt PROCESSING then SUCCESS and increments sentCount
    ✓ marks attempt FAILED on error, increments failedCount, re-throws
Tests: 3 passed, 3 total
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/queue/notification.processor.spec.ts
git commit -m "test(fase3): unit test NotificationProcessor — transizioni stato attempt"
```

---

### Task 3: Campaign CRUD + CSV Upload + Launch

**Files:**
- Create: `apps/backend/src/campaigns/dto/create-campaign.dto.ts`
- Create: `apps/backend/src/campaigns/campaigns.service.ts`
- Create: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Create: `apps/backend/src/campaigns/campaigns.controller.ts`
- Create: `apps/backend/src/campaigns/campaigns.module.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Consumes: `Campaign`, `Recipient`, `NotificationAttempt` entities; `QueueModule` (Task 1); `NotificationJobData`
- Produces:
  - `GET /campaigns` → `Campaign[]`
  - `POST /campaigns` body `CreateCampaignDto` → `Campaign`
  - `GET /campaigns/:id` → `Campaign`
  - `POST /campaigns/:id/recipients/upload` multipart `file` → `{ imported: number, campaignId: string }`
  - `POST /campaigns/:id/launch` → `{ launched: number, campaignId: string }`

- [ ] **Step 1: Crea `apps/backend/src/campaigns/dto/create-campaign.dto.ts`**

```typescript
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { NotificationChannel } from '@comunicapa/shared-types';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsEnum(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  @IsObject()
  @IsOptional()
  channelConfig?: Record<string, unknown>;
}
```

- [ ] **Step 2: Crea `apps/backend/src/campaigns/campaigns.service.ts`**

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { parse } from 'csv-parse';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { NOTIFICATION_QUEUE, NOTIFICATION_JOB_SEND } from '../queue/notification-job.types';
import type { CreateCampaignDto } from './dto/create-campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationsQueue: Queue<NotificationJobData>,
  ) {}

  findAll(): Promise<Campaign[]> {
    return this.campaignRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  create(dto: CreateCampaignDto, createdBy: string): Promise<Campaign> {
    const campaign = this.campaignRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      channelType: dto.channelType,
      channelConfig: dto.channelConfig ?? {},
      status: CampaignStatus.DRAFT,
      createdBy,
    });
    return this.campaignRepo.save(campaign);
  }

  async uploadCsv(
    campaignId: string,
    filePath: string,
  ): Promise<{ imported: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Campaign must be in draft status to upload recipients');
    }

    let imported = 0;
    const batch: Partial<Recipient>[] = [];
    const BATCH_SIZE = 200;

    const parser = createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true }),
    );

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      const cf = String(row['codice_fiscale'] ?? '').toUpperCase().trim();
      if (!cf) continue;

      const extraData: Record<string, unknown> = { ...row };
      delete extraData['codice_fiscale'];
      delete extraData['email'];
      delete extraData['pec'];
      delete extraData['full_name'];

      batch.push({
        campaignId,
        codiceFiscale: cf,
        email: row['email']?.trim() || null,
        pec: row['pec']?.trim() || null,
        fullName: row['full_name']?.trim() || null,
        extraData,
        status: RecipientStatus.PENDING,
      });

      if (batch.length >= BATCH_SIZE) {
        await this.recipientRepo.save(batch.splice(0));
        imported += BATCH_SIZE;
      }
    }

    if (batch.length > 0) {
      await this.recipientRepo.save(batch);
      imported += batch.length;
    }

    await this.campaignRepo.update(campaignId, { totalRecipients: imported });
    await unlink(filePath).catch(() => undefined);

    return { imported, campaignId };
  }

  async launch(campaignId: string): Promise<{ launched: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Only draft campaigns can be launched');
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No pending recipients — upload a CSV first');
    }

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
            channelType: campaign.channelType,
            status: AttemptStatus.QUEUED,
          })),
        )
        .returning('id')
        .execute();
      attemptIds.push(...(result.raw as Array<{ id: string }>).map((row) => row.id));
    }

    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo grandi)
    const JOB_CHUNK = 1000;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
      await this.notificationsQueue.addBulk(
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: campaign.channelType,
          },
        })),
      );
    }

    await this.recipientRepo.update(
      { campaignId, status: RecipientStatus.PENDING },
      { status: RecipientStatus.QUEUED },
    );
    await this.campaignRepo.update(campaignId, { status: CampaignStatus.QUEUED });

    return { launched: recipients.length, campaignId };
  }
}
```

- [ ] **Step 3: Crea `apps/backend/src/campaigns/campaigns.service.spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { NOTIFICATION_QUEUE } from '../queue/notification-job.types';

const mockCampaign: Partial<Campaign> = {
  id: 'uuid-1',
  name: 'Test',
  description: null,
  channelType: 'EMAIL',
  channelConfig: {},
  status: CampaignStatus.DRAFT,
  createdBy: 'op1',
  totalRecipients: 0,
  sentCount: 0,
  failedCount: 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  completedAt: null,
  recipients: [],
};

describe('CampaignsService', () => {
  let service: CampaignsService;

  const mockCampaignRepo = {
    find: jest.fn().mockResolvedValue([mockCampaign]),
    findOneBy: jest.fn().mockResolvedValue(mockCampaign),
    create: jest.fn().mockReturnValue(mockCampaign),
    save: jest.fn().mockResolvedValue(mockCampaign),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    }),
  };
  const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: mockQueue },
      ],
    }).compile();
    service = module.get<CampaignsService>(CampaignsService);
    jest.clearAllMocks();
    mockCampaignRepo.find.mockResolvedValue([mockCampaign]);
    mockCampaignRepo.findOneBy.mockResolvedValue(mockCampaign);
    mockCampaignRepo.create.mockReturnValue(mockCampaign);
    mockCampaignRepo.save.mockResolvedValue(mockCampaign);
    mockCampaignRepo.update.mockResolvedValue(undefined);
    mockRecipientRepo.find.mockResolvedValue([]);
  });

  it('findAll returns array', async () => {
    const result = await service.findAll();
    expect(result).toEqual([mockCampaign]);
    expect(mockCampaignRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('findOne returns campaign by id', async () => {
    const result = await service.findOne('uuid-1');
    expect(result).toEqual(mockCampaign);
  });

  it('findOne throws NotFoundException for unknown id', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.findOne('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('create saves and returns campaign with createdBy', async () => {
    const dto = { name: 'Test', channelType: 'EMAIL' as const };
    const result = await service.create(dto, 'op1');
    expect(result).toEqual(mockCampaign);
    expect(mockCampaignRepo.save).toHaveBeenCalled();
  });

  it('launch throws BadRequestException when no pending recipients', async () => {
    mockRecipientRepo.find.mockResolvedValueOnce([]);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws BadRequestException when campaign not in DRAFT', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      status: CampaignStatus.QUEUED,
    });
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 4: Crea `apps/backend/src/campaigns/campaigns.controller.ts`**

```typescript
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { Campaign } from '../entities/campaign.entity';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  findAll(): Promise<Campaign[]> {
    return this.campaignsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    return this.campaignsService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateCampaignDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<Campaign> {
    return this.campaignsService.create(dto, req.user.username);
  }

  @Post(':id/recipients/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: '/tmp/comunicapa-uploads',
        filename: (_req, file, cb) => {
          cb(null, `${Date.now()}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
        cb(null, ok);
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ imported: number; campaignId: string }> {
    return this.campaignsService.uploadCsv(id, file.path);
  }

  @Post(':id/launch')
  launch(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ launched: number; campaignId: string }> {
    return this.campaignsService.launch(id);
  }
}
```

- [ ] **Step 5: Crea `apps/backend/src/campaigns/campaigns.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { QueueModule } from '../queue/queue.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt]),
    QueueModule,
  ],
  providers: [CampaignsService],
  controllers: [CampaignsController],
})
export class CampaignsModule {}
```

- [ ] **Step 6: Aggiungi `mkdirSync` a `apps/backend/src/main.ts`**

Modifica `main.ts` aggiungendo l'import e la chiamata prima di `NestFactory.create`:

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  mkdirSync('/tmp/comunicapa-uploads', { recursive: true });

  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      process.env['ADMIN_ORIGIN'] ?? '',
      process.env['CITIZEN_ORIGIN'] ?? '',
    ].filter(Boolean),
    credentials: true,
  });

  const port = Number(process.env['PORT'] ?? 8080);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend running on http://0.0.0.0:${port}`);
}

void bootstrap();
```

- [ ] **Step 7: Aggiungi `CampaignsModule` a `apps/backend/src/app.module.ts`**

Aggiungi import:
```typescript
import { CampaignsModule } from './campaigns/campaigns.module';
```

Aggiungi nell'array `imports`:
```typescript
imports: [
  ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
  DatabaseModule,
  AuthModule,
  QueueModule,
  CampaignsModule,
],
```

- [ ] **Step 8: Restart container e run test**

```powershell
docker compose restart backend
Start-Sleep -Seconds 25
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern campaigns.service --forceExit 2>&1
```

Expected:
```
PASS src/campaigns/campaigns.service.spec.ts
  CampaignsService
    ✓ findAll returns array
    ✓ findOne returns campaign by id
    ✓ findOne throws NotFoundException for unknown id
    ✓ create saves and returns campaign with createdBy
    ✓ launch throws BadRequestException when no pending recipients
    ✓ launch throws BadRequestException when campaign not in DRAFT
Tests: 6 passed, 6 total
```

- [ ] **Step 9: Verifica avvio backend**

```powershell
docker compose logs backend 2>&1 | Select-Object -Last 6
```

Expected: route `GET /campaigns`, `POST /campaigns`, `GET /campaigns/:id`, `POST /campaigns/:id/recipients/upload`, `POST /campaigns/:id/launch` — tutte mappate.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/campaigns/ apps/backend/src/app.module.ts apps/backend/src/main.ts
git commit -m "feat(fase3): Campaign CRUD + CSV upload streaming + launch BullMQ"
```

---

### Task 4: E2E — Upload CSV + Launch + Verifica Processor

**Files:** nessuno — solo verifica in Docker

**Obiettivo:** validare il flusso completo: crea campagna → upload CSV → launch → processor elabora job.

- [ ] **Step 1: Genera JWT di test (dev)**

Il JWT_SECRET nel `.env` locale è `dev-secret-change-in-production`. Genera un token valido con Node:

```powershell
docker exec comunicapa-backend node -e @"
const crypto = require('crypto');
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({sub:'dev',username:'devuser',role:'admin',type:'operator',exp:9999999999})).toString('base64url');
const sig = crypto.createHmac('sha256','dev-secret-change-in-production').update(header+'.'+payload).digest('base64url');
console.log(header+'.'+payload+'.'+sig);
"@
```

Salva l'output come variabile:
```powershell
$TOKEN = "<output del comando sopra>"
```

- [ ] **Step 2: Crea campagna**

```powershell
$campaign = Invoke-RestMethod `
  -Uri http://localhost:8080/campaigns `
  -Method POST `
  -Headers @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" } `
  -Body '{"name":"TARI 2024","channelType":"EMAIL"}'
$campaignId = $campaign.id
Write-Host "Campaign ID: $campaignId  Status: $($campaign.status)"
```

Expected: `status: "draft"`, `id: "<uuid>"`

- [ ] **Step 3: Upload CSV**

Crea `test.csv` nella working directory:
```csv
codice_fiscale,email,pec,full_name
RSSMRA85M01H501Z,mario.rossi@example.com,,Mario Rossi
VRDLGI90F02H501Y,,luca.verdi@pec.it,Luca Verdi
BNCNTN70R01H501Q,antonio.bianchi@example.com,antonio.bianchi@pec.it,Antonio Bianchi
```

Copia nel container e fai upload:
```powershell
docker cp test.csv comunicapa-backend:/tmp/test.csv
$upload = docker exec comunicapa-backend sh -c "curl -s -X POST http://localhost:8080/campaigns/$campaignId/recipients/upload -H 'Authorization: Bearer $TOKEN' -F 'file=@/tmp/test.csv;type=text/csv'"
Write-Host $upload
```

Expected: `{"imported":3,"campaignId":"<uuid>"}`

- [ ] **Step 4: Verifica recipients nel DB**

```powershell
docker exec comunicapa-postgres psql -U comunicapa -d comunicapa_db -c "SELECT codice_fiscale, email, status FROM recipients WHERE campaign_id = '$campaignId';"
```

Expected: 3 righe con `status = pending`.

- [ ] **Step 5: Launch campagna**

```powershell
$launch = Invoke-RestMethod `
  -Uri "http://localhost:8080/campaigns/$campaignId/launch" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $TOKEN" }
Write-Host "Launched: $($launch.launched)"
```

Expected: `{"launched":3,"campaignId":"<uuid>"}`

- [ ] **Step 6: Verifica log processor**

```powershell
Start-Sleep -Seconds 3
docker compose logs backend 2>&1 | Select-String "Job|Processing|campaign="
```

Expected: 3 righe tipo `Job 1: campaign=<uuid> channel=EMAIL`

- [ ] **Step 7: Verifica stati nel DB**

```powershell
docker exec comunicapa-postgres psql -U comunicapa -d comunicapa_db -c "SELECT status, COUNT(*) FROM notification_attempts GROUP BY status;"
docker exec comunicapa-postgres psql -U comunicapa -d comunicapa_db -c "SELECT sent_count, failed_count, status FROM campaigns WHERE id = '$campaignId';"
```

Expected: `notification_attempts.status = success` per 3 righe; `campaigns.sent_count = 3`, `status = queued`.

- [ ] **Step 8: Commit (no-op — solo verifica)**

Nessun file modificato in questo task. Se ci sono bugfix, committalì separatamente.

---

### Task 5: PDF Service + Volume Docker

**Files:**
- Create: `apps/backend/src/pdf/pdf.service.ts`
- Create: `apps/backend/src/pdf/pdf.service.spec.ts`
- Create: `apps/backend/src/pdf/pdf.module.ts`
- Modify: `apps/backend/src/app.module.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.env`

**Interfaces:**
- Produces:
  - `PdfService.stampPdfBytes(bytes: Uint8Array, stamp: string): Promise<Uint8Array>` — pura, no I/O
  - `PdfService.stampWithProtocol(fileId: string, stamp: string): Promise<string>` — legge/scrive `{PDF_STORAGE_PATH}/{fileId}.pdf`

- [ ] **Step 1: Aggiungi volume `pdf_storage` a `docker-compose.yml`**

Nel blocco `volumes:` in fondo al file, aggiungi:
```yaml
  pdf_storage:
```

Nel servizio `backend`, nel blocco `volumes:`, aggiungi:
```yaml
      - pdf_storage:/data/attachments
```

Nel blocco `environment:` del backend, aggiungi:
```yaml
      PDF_STORAGE_PATH: /data/attachments
```

- [ ] **Step 2: Aggiorna `.env.example` e `.env`**

In entrambi i file, aggiungi dopo `CITIZEN_ORIGIN`:
```dotenv
# ── PDF Storage ───────────────────────────────────────────────────────────────
PDF_STORAGE_PATH=/data/attachments
```

- [ ] **Step 3: Crea `apps/backend/src/pdf/pdf.service.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly storagePath = process.env['PDF_STORAGE_PATH'] ?? '/data/attachments';

  async stampPdfBytes(pdfBytes: Uint8Array, stamp: string): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { height } = firstPage.getSize();

    firstPage.drawText(stamp, {
      x: 50,
      y: height - 50,
      size: 10,
      font,
      color: rgb(0.2, 0.2, 0.6),
    });

    return pdfDoc.save();
  }

  async stampWithProtocol(fileId: string, stamp: string): Promise<string> {
    const inputPath = join(this.storagePath, `${fileId}.pdf`);
    const stampedId = `${fileId}_stamped_${Date.now()}`;
    const outputPath = join(this.storagePath, `${stampedId}.pdf`);

    const pdfBytes = await readFile(inputPath);
    const stamped = await this.stampPdfBytes(new Uint8Array(pdfBytes), stamp);

    await mkdir(this.storagePath, { recursive: true });
    await writeFile(outputPath, stamped);
    this.logger.log(`Stamped PDF: ${stampedId}`);
    return stampedId;
  }
}
```

- [ ] **Step 4: Crea `apps/backend/src/pdf/pdf.service.spec.ts`**

```typescript
import { PdfService } from './pdf.service';
import { PDFDocument } from 'pdf-lib';

describe('PdfService', () => {
  let service: PdfService;

  beforeEach(() => {
    service = new PdfService();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('stampPdfBytes returns valid Uint8Array larger than input', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'SEGNATURA/2024/0001');

    expect(stamped).toBeInstanceOf(Uint8Array);
    expect(stamped.length).toBeGreaterThan(bytes.length);
  });

  it('stampPdfBytes preserves page count on single-page PDF', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'TEST STAMP');
    const reloaded = await PDFDocument.load(stamped);

    expect(reloaded.getPageCount()).toBe(1);
  });

  it('stampPdfBytes preserves page count on multi-page PDF', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'PAGE 2 INTACT');
    const reloaded = await PDFDocument.load(stamped);

    expect(reloaded.getPageCount()).toBe(2);
  });
});
```

- [ ] **Step 5: Crea `apps/backend/src/pdf/pdf.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';

@Module({
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
```

- [ ] **Step 6: Aggiungi `PdfModule` a `apps/backend/src/app.module.ts`**

Aggiungi import:
```typescript
import { PdfModule } from './pdf/pdf.module';
```

Aggiungi nell'array `imports`:
```typescript
imports: [
  ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
  DatabaseModule,
  AuthModule,
  QueueModule,
  CampaignsModule,
  PdfModule,
],
```

- [ ] **Step 7: Rebuild e run test PDF**

Rebuild necessario perché `docker-compose.yml` è cambiato (nuovo volume):
```powershell
docker compose down
docker volume rm comunicapa_backend_node_modules
docker compose up -d --build backend
Start-Sleep -Seconds 45
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern pdf.service --forceExit 2>&1
```

Expected:
```
PASS src/pdf/pdf.service.spec.ts
  PdfService
    ✓ is defined
    ✓ stampPdfBytes returns valid Uint8Array larger than input
    ✓ stampPdfBytes preserves page count on single-page PDF
    ✓ stampPdfBytes preserves page count on multi-page PDF
Tests: 4 passed, 4 total
```

- [ ] **Step 8: Verifica tutti i test insieme**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --forceExit 2>&1 | Select-Object -Last 15
```

Expected: tutti i test di Fase 2 + Fase 3 passano (≥ 13 test totali).

- [ ] **Step 9: Verifica avvio pulito**

```powershell
docker compose logs backend 2>&1 | Select-Object -Last 5
```

Expected: `Nest application successfully started`

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yml .env.example .env apps/backend/src/pdf/ apps/backend/src/app.module.ts
git commit -m "feat(fase3): PdfService (pdf-lib) stampPdfBytes + volume pdf_storage"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ BullMQ implementation → Task 1 (QueueModule + processor), Task 3 (launch con addBulk)
- ✅ CSV streaming parsing, no in-memory → Task 3 `uploadCsv()` con `createReadStream` + `csv-parse` `for await`
- ✅ Manipolazione base PDF con pdf-lib → Task 5 `stampPdfBytes` + `stampWithProtocol`

**2. Placeholder scan:** nessun "TBD", "TODO", "similar to Task N" trovato. Ogni step ha codice completo.

**3. Type consistency:**
- `NotificationJobData.channel: NotificationChannel` — definito in shared-types (Task 1), usato in processor (Task 1) e service launch (Task 3)
- `NOTIFICATION_QUEUE = 'notifications'` — stesso valore in `queue.module.ts`, `campaigns.service.ts`, `notification.processor.ts`, test spec
- `NOTIFICATION_JOB_SEND = 'send'` — usato in `campaigns.service.ts` launch, non verificato nel processor (il processor riceve tutti i job della queue `notifications` indipendentemente dal nome)
- `AttemptStatus.QUEUED/PROCESSING/SUCCESS/FAILED` — usati coerentemente tra entity, processor, service
- `RecipientStatus.PENDING/QUEUED` — `uploadCsv` crea con `PENDING`, `launch` filtra `PENDING` → aggiorna a `QUEUED`
- `CampaignStatus.DRAFT/QUEUED` — `create` usa `DRAFT`, `uploadCsv` e `launch` verificano `DRAFT`, `launch` aggiorna a `QUEUED`
- `getQueueToken(NOTIFICATION_QUEUE)` — usato nel test spec, corrisponde al token registrato da `@nestjs/bullmq` per `BullModule.registerQueue({ name: NOTIFICATION_QUEUE })`
