# Pipeline a demoni per SEND — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disaccoppiare protocollazione, invio SEND e monitoraggio stato in tre demoni indipendenti (poll-based, no BullMQ per SEND), chiudendo strutturalmente il rischio di doppia protocollazione/doppio invio reale su redelivery.

**Architecture:** Due nuovi servizi `@Cron`-based (`ProtocollazioneSyncService` generico, `SendDispatchService` SEND-specifico) sostituiscono la logica sincrona oggi dentro `SendStrategy.send()`/job BullMQ. `NotificationAttempt` guadagna colonne `protocolNumber`/`protocolYear`/`protocolledAt` come stato di stadio persistito. `campaigns.service.ts` smette di accodare job BullMQ per SEND; `SendStatusSyncService` (demone 3, già esistente) resta invariato.

**Tech Stack:** NestJS 10, TypeORM, `@nestjs/schedule` (`@Cron`), Jest.

## Global Constraints

- Delimitatore placeholder template: `%%chiave%%` (non rilevante qui, nessun template toccato).
- Test backend: SEMPRE `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`.
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`; frontend-admin: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`.
- Migration generata/verificata su DB temporaneo (`CREATE DATABASE migration_gen` / `DROP DATABASE`), mai fidandosi dell'output grezzo del generatore per `ALTER TYPE`.
- BullMQ `jobId = attemptId` invariante: resta valido per gli altri 4 canali, non più applicabile a SEND dopo questo piano.
- Reverse proxy esterno: endpoint HTTP nuovi devono restare compatibili col pattern "200 con flag" per errori attesi (non introduciamo nuovi endpoint sincroni pesanti in questo piano — i demoni girano fuori dal ciclo richiesta/risposta).
- `paProtocolNumber` per SEND = `` `${protocolNumber}/${protocolYear}` `` (stesso formato già usato in `send.strategy.ts`).

---

## File Structure

- `apps/backend/src/entities/notification-attempt.entity.ts` — **modifica**: 3 nuove colonne.
- `apps/backend/src/database/migrations/1783800000000-AddProtocolColumns.ts` — **nuovo**.
- `apps/backend/src/database/database.module.ts` — **modifica**: registra la migration.
- `apps/backend/src/channels/send/name.util.ts` — **nuovo**: `splitFullName` estratta (condivisa tra i due demoni).
- `apps/backend/src/channels/protocollazione-sync.service.ts` — **nuovo**: demone 1, generico.
- `apps/backend/src/channels/protocollazione-sync.service.spec.ts` — **nuovo**.
- `apps/backend/src/channels/send/send-dispatch.service.ts` — **nuovo**: demone 2, SEND-specifico (logica payload/POST spostata da `send.strategy.ts`).
- `apps/backend/src/channels/send/send-dispatch.service.spec.ts` — **nuovo**.
- `apps/backend/src/channels/send/send.strategy.ts` + `send.strategy.spec.ts` — **eliminati** (logica assorbita da `send-dispatch.service.ts`).
- `apps/backend/src/channels/channel.module.ts` — **modifica**: rimuove `SendStrategy` da providers/`CHANNEL_STRATEGIES`, aggiunge `ProtocollazioneSyncService`/`SendDispatchService`.
- `apps/backend/src/campaigns/campaigns.service.ts` — **modifica**: branch SEND in `launch()`/`retryRecipient()`/`cancel()`.
- `apps/backend/src/campaigns/campaigns.service.spec.ts` — **modifica**: nuovi test branch SEND.
- `apps/backend/src/queue/notification-job.types.ts` — **modifica**: `CHANNEL_QUEUES` esclude SEND.
- `apps/backend/src/queue/channel-processors.ts` — **modifica**: rimuove `SendNotificationProcessor`.
- `apps/backend/src/queue/queue.module.ts` — **modifica**: rimuove provider/registrazione coda SEND.
- `apps/backend/src/queue/notification-queues.service.ts` + `.spec.ts` — **modifica**: rimuove injection coda SEND.
- `apps/backend/src/engines/engines.controller.ts` — **modifica**: nuovo endpoint stage-counts SEND.
- `apps/backend/src/engines/engines.controller.spec.ts` — **modifica**: test nuovo endpoint.
- `apps/frontend-admin/src/App.tsx` — **modifica**: tab Motori mostra contatori a stadi per SEND invece di job BullMQ.

---

### Task 1: Colonne di stadio protocollazione su `NotificationAttempt`

**Files:**
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts`
- Create: `apps/backend/src/database/migrations/1783800000000-AddProtocolColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `NotificationAttempt.protocolNumber: number | null`, `.protocolYear: number | null`, `.protocolledAt: Date | null` — usate da Task 2/3/4.

- [ ] **Step 1: Aggiungi le colonne all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, dopo il blocco `sendStatusUpdatedAt` (riga 53) e prima di `errorMessage` (riga 55):

```ts
  @Column({ type: 'int', name: 'protocol_number', nullable: true })
  protocolNumber!: number | null;

  @Column({ type: 'int', name: 'protocol_year', nullable: true })
  protocolYear!: number | null;

  @Column({ name: 'protocolled_at', type: 'timestamptz', nullable: true })
  protocolledAt!: Date | null;

```

- [ ] **Step 2: Genera/verifica la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddProtocolColumns -d src/database/data-source.ts
```

Verifica il file generato: deve contenere solo 3 `ADD COLUMN` (nessun rename/drop imprevisto). Se il generatore produce altro (es. tocca `iun`/`send_status` già esistenti), scrivi la migration a mano invece di fidarti dell'output — usa il contenuto dello Step 3 sottostante.

- [ ] **Step 3: Rinomina e normalizza il file generato**

Rinomina il file generato in `apps/backend/src/database/migrations/1783800000000-AddProtocolColumns.ts` con contenuto:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProtocolColumns1783800000000 implements MigrationInterface {
    name = 'AddProtocolColumns1783800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocol_number" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocol_year" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "protocolled_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocolled_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocol_year"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "protocol_number"`);
    }

}
```

- [ ] **Step 4: Pulisci il DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

- [ ] **Step 5: Registra la migration**

In `apps/backend/src/database/database.module.ts`:

```ts
import { AddSendStatusColumns1783700000000 } from './migrations/1783700000000-AddSendStatusColumns';
import { AddProtocolColumns1783800000000 } from './migrations/1783800000000-AddProtocolColumns';
```

E nell'array `migrations` (riga 37), aggiungi `AddProtocolColumns1783800000000` in coda dopo `AddSendStatusColumns1783700000000`.

- [ ] **Step 6: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/1783800000000-AddProtocolColumns.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiunge colonne protocolNumber/protocolYear/protocolledAt a NotificationAttempt"
```

---

### Task 2: `ProtocollazioneSyncService` — demone generico di protocollazione

**Files:**
- Create: `apps/backend/src/channels/send/name.util.ts`
- Create: `apps/backend/src/channels/protocollazione-sync.service.ts`
- Create: `apps/backend/src/channels/protocollazione-sync.service.spec.ts`

**Interfaces:**
- Consumes: `AttachmentService.generatePdfBuffer(recipient: Recipient, index = 0): Promise<Buffer>`; `ProtocolloService.protocolla({oggetto, destinatario:{codiceFiscale,nome,cognome,denominazione}, documentBuffer, documentFilename}): Promise<{numeroProtocollo:number, annoProtocollo:number, dataProtocollazione:string}>`; `NotificationAttempt.{protocolNumber,protocolYear,protocolledAt}` (Task 1).
- Produces: `splitFullName(fullName: string | null | undefined): {nome:string; cognome:string}` (esportata da `name.util.ts`, riusata in Task 3); `ProtocollazioneSyncService.handleCron(): Promise<void>` (pubblico, chiamato da `@Cron` e direttamente nei test).

- [ ] **Step 1: Estrai `splitFullName` in un util condiviso**

Crea `apps/backend/src/channels/send/name.util.ts`:

```ts
export function splitFullName(fullName: string | null | undefined): { nome: string; cognome: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nome: '', cognome: '' };
  if (parts.length === 1) return { nome: parts[0], cognome: '' };
  return { nome: parts.slice(0, -1).join(' '), cognome: parts[parts.length - 1] };
}
```

- [ ] **Step 2: Scrivi il test (fallirà: il servizio non esiste ancora)**

Crea `apps/backend/src/channels/protocollazione-sync.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProtocollazioneSyncService } from './protocollazione-sync.service';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';

describe('ProtocollazioneSyncService', () => {
  let service: ProtocollazioneSyncService;
  const mockQb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn(() => mockQb),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const mockProtocollo = { protocolla: jest.fn() };
  const mockAttachments = { generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);
    const module = await Test.createTestingModule({
      providers: [
        ProtocollazioneSyncService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();
    service = module.get(ProtocollazioneSyncService);
  });

  it('interroga attempt QUEUED non protocollati di campagne con protocolla=true', async () => {
    mockQb.getMany.mockResolvedValueOnce([]);
    await service.handleCron();
    expect(mockQb.where).toHaveBeenCalledWith('attempt.status = :status', { status: AttemptStatus.QUEUED });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.protocolled_at IS NULL');
    expect(mockQb.andWhere).toHaveBeenCalledWith("campaign.channel_config ->> 'protocolla' = 'true'");
  });

  it('protocolla un attempt e scrive protocolNumber/protocolYear/protocolledAt', async () => {
    const attempt: Partial<NotificationAttempt> = {
      id: 'att-1',
      recipient: {
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        campaign: { name: 'TARI', channelConfig: { subject: 'Avviso TARI' } },
      } as any,
    };
    mockQb.getMany.mockResolvedValueOnce([attempt]);
    mockProtocollo.protocolla.mockResolvedValueOnce({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '14/07/2026' });

    await service.handleCron();

    expect(mockProtocollo.protocolla).toHaveBeenCalledWith(expect.objectContaining({
      oggetto: 'Avviso TARI',
      destinatario: expect.objectContaining({ codiceFiscale: 'RSSMRA85M01H501Z', nome: 'Mario', cognome: 'Rossi' }),
    }));
    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'att-1',
      protocolNumber: 111,
      protocolYear: 2026,
      protocolledAt: expect.any(Date),
    }));
  });

  it('non interrompe il batch se un attempt fallisce la protocollazione', async () => {
    const attempt1: Partial<NotificationAttempt> = {
      id: 'att-1',
      recipient: { codiceFiscale: 'AAA', fullName: 'A B', campaign: { name: 'X', channelConfig: {} } } as any,
    };
    const attempt2: Partial<NotificationAttempt> = {
      id: 'att-2',
      recipient: { codiceFiscale: 'BBB', fullName: 'C D', campaign: { name: 'X', channelConfig: {} } } as any,
    };
    mockQb.getMany.mockResolvedValueOnce([attempt1, attempt2]);
    mockProtocollo.protocolla
      .mockRejectedValueOnce(new Error('SOAP timeout'))
      .mockResolvedValueOnce({ numeroProtocollo: 5, annoProtocollo: 2026, dataProtocollazione: '14/07/2026' });

    await service.handleCron();

    expect(mockProtocollo.protocolla).toHaveBeenCalledTimes(2);
    expect(mockAttemptRepo.save).toHaveBeenCalledTimes(1);
    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-2', protocolNumber: 5 }));
  });
});
```

- [ ] **Step 3: Esegui il test, verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest protocollazione-sync --maxWorkers=2
```

Atteso: FAIL — `Cannot find module './protocollazione-sync.service'`.

- [ ] **Step 4: Implementa `ProtocollazioneSyncService`**

Crea `apps/backend/src/channels/protocollazione-sync.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { splitFullName } from './send/name.util';

const BATCH_SIZE = 200;

/**
 * Demone generico (non SEND-specifico): protocolla qualunque NotificationAttempt
 * la cui campagna richiede protocollazione (channelConfig.protocolla=true),
 * a prescindere dal canale — pronto per altri canali futuri, non solo SEND.
 */
@Injectable()
export class ProtocollazioneSyncService {
  private readonly logger = new Logger(ProtocollazioneSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
  ) {}

  @Cron('*/2 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .leftJoinAndSelect('attempt.recipient', 'recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('attempt.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('attempt.protocolled_at IS NULL')
      .andWhere("campaign.channel_config ->> 'protocolla' = 'true'")
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    for (const attempt of attempts) {
      try {
        const recipient = attempt.recipient;
        const campaign = recipient.campaign;
        const cfg = campaign.channelConfig as Record<string, unknown>;
        const subject = (cfg['subject'] as string) ?? campaign.name;
        const { nome, cognome } = splitFullName(recipient.fullName);
        const buffer = await this.attachments.generatePdfBuffer(recipient, 0);
        const result = await this.protocollo.protocolla({
          oggetto: subject,
          destinatario: {
            codiceFiscale: recipient.codiceFiscale,
            nome,
            cognome,
            denominazione: recipient.fullName ?? recipient.codiceFiscale,
          },
          documentBuffer: buffer,
          documentFilename: `${recipient.codiceFiscale}.pdf`,
        });
        attempt.protocolNumber = result.numeroProtocollo;
        attempt.protocolYear = result.annoProtocollo;
        attempt.protocolledAt = new Date();
        await this.attemptRepo.save(attempt);
        this.logger.log(`Attempt ${attempt.id} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`);
      } catch (err: any) {
        this.logger.warn(`Protocollazione fallita per attempt ${attempt.id}: ${err.message}`);
        // Resta QUEUED con protocolledAt=null: ritentato al prossimo giro.
      }
    }
  }
}
```

- [ ] **Step 5: Esegui il test, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest protocollazione-sync --maxWorkers=2
```

Atteso: PASS, 3/3.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/send/name.util.ts apps/backend/src/channels/protocollazione-sync.service.ts apps/backend/src/channels/protocollazione-sync.service.spec.ts
git commit -m "feat(backend): demone generico ProtocollazioneSyncService"
```

---

### Task 3: `SendDispatchService` — demone di invio SEND, rimozione `SendStrategy`

**Files:**
- Create: `apps/backend/src/channels/send/send-dispatch.service.ts`
- Create: `apps/backend/src/channels/send/send-dispatch.service.spec.ts`
- Delete: `apps/backend/src/channels/send/send.strategy.ts`
- Delete: `apps/backend/src/channels/send/send.strategy.spec.ts`

**Interfaces:**
- Consumes: `splitFullName` (Task 2, `./name.util`); `resolveAttachmentsConfig(channelConfig): Array<{key,label}>` (`attachments/attachment.service.ts`); `AttachmentService.generatePdfBuffer`; `SendAttachmentUploadService.preloadAndUpload(baseUrl, voucher, buffer, contentType, preloadIdx): Promise<{key,versionToken,sha256Base64}>`; `resolvePaymentData(recipient, paymentConfig): ResolvedPaymentData | null` (`channels/payment-config.util.ts`); `PdndAuthService.getVoucher(env,purposeId)`; `NotificationAttempt.{protocolNumber,protocolYear}` (Task 1).
- Produces: `SendDispatchService.handleCron(): Promise<void>`.

- [ ] **Step 1: Scrivi il test (fallirà: il servizio non esiste ancora)**

Crea `apps/backend/src/channels/send/send-dispatch.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendDispatchService } from './send-dispatch.service';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { Campaign } from '../../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../../entities/recipient.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
  'send.senderTaxId': '01234567890',
  'brand.name': 'Comune di Prova',
};

describe('SendDispatchService', () => {
  let service: SendDispatchService;
  const mockQb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };
  const mockAttemptRepo = { createQueryBuilder: jest.fn(() => mockQb), save: jest.fn().mockResolvedValue(undefined) };
  const mockRecipientRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const mockCampaignRepo = { increment: jest.fn().mockResolvedValue(undefined) };
  const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
  const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
  const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
  const mockUpload = { preloadAndUpload: jest.fn(async (_b: string, _v: string, _buf: Buffer, _ct: string, idx: string) => ({ key: `key-${idx}`, versionToken: `vt-${idx}`, sha256Base64: 'abc123==' })) };

  function makeAttempt(overrides: Partial<NotificationAttempt> = {}): NotificationAttempt {
    return {
      id: 'att-1',
      protocolNumber: 111,
      protocolYear: 2026,
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        extraData: {},
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: { subject: 'Avviso TARI 2026', taxonomyCode: '010101P', physicalCommunicationType: 'AR_REGISTERED_LETTER' },
        } as Campaign,
      } as Recipient,
      ...overrides,
    } as NotificationAttempt;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockFetch.mockResolvedValue({ ok: true, status: 202, json: () => Promise.resolve({ notificationRequestId: 'req-001' }) });
    settingsValues['retention.maxDays'] = 90;
    const module = await Test.createTestingModule({
      providers: [
        SendDispatchService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: SendAttachmentUploadService, useValue: mockUpload },
      ],
    }).compile();
    service = module.get(SendDispatchService);
  });

  it('interroga attempt SEND protocollati non ancora inviati', async () => {
    mockQb.getMany.mockResolvedValueOnce([]);
    await service.handleCron();
    expect(mockQb.where).toHaveBeenCalledWith('attempt.channel_type = :ch', { ch: 'SEND' });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.status = :status', { status: AttemptStatus.QUEUED });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.protocolled_at IS NOT NULL');
    expect(mockQb.andWhere).toHaveBeenCalledWith("attempt.response_payload ->> 'notificationRequestId' IS NULL");
  });

  it('invia a PN, marca SUCCESS e incrementa sentCount', async () => {
    mockQb.getMany.mockResolvedValueOnce([makeAttempt()]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    expect(sendCall).toBeDefined();
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.paProtocolNumber).toBe('111/2026');
    expect(payload.idempotenceToken).toBe('att-1');

    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'att-1',
      status: AttemptStatus.SUCCESS,
      responsePayload: expect.objectContaining({ notificationRequestId: 'req-001' }),
    }));
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: RecipientStatus.SENT }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
  });

  it('marca FAILED e incrementa failedCount se PN risponde errore', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('{"errors":["bad"]}') });
    mockQb.getMany.mockResolvedValueOnce([makeAttempt()]);

    await service.handleCron();

    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-1', status: AttemptStatus.FAILED }));
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: RecipientStatus.FAILED }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
  });

  it('include payments nel destinatario se paymentConfig risolve dati validi', async () => {
    const attempt = makeAttempt({
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        extraData: { importo: '50', avviso: '999888777', cf_ente: '00223344556' },
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: {
            subject: 'Avviso',
            taxonomyCode: '010101P',
            paymentConfig: { enabled: true, amountColumn: 'importo', amountType: 'euro', noticeNumberColumn: 'avviso', payeeFiscalCodeType: 'column', payeeFiscalCodeColumn: 'cf_ente' },
          },
        } as Campaign,
      } as Recipient,
    });
    mockQb.getMany.mockResolvedValueOnce([attempt]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].payments).toEqual([
      { pagoPa: { noticeCode: '999888777', creditorTaxId: '00223344556', applyCost: true } },
    ]);
  });
});
```

- [ ] **Step 2: Esegui il test, verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest send-dispatch --maxWorkers=2
```

Atteso: FAIL — `Cannot find module './send-dispatch.service'`.

- [ ] **Step 3: Implementa `SendDispatchService`**

Crea `apps/backend/src/channels/send/send-dispatch.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { Campaign } from '../../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../../entities/recipient.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { AttachmentService, resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';
import { resolvePaymentData } from '../payment-config.util';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';

const BATCH_SIZE = 200;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

/**
 * Demone SEND-specifico: invia a PN gli attempt già protocollati (colonne
 * protocolNumber/protocolYear scritte da ProtocollazioneSyncService) e non
 * ancora inviati. Sostituisce la logica sincrona che era in SendStrategy.send()/
 * job BullMQ — SEND non passa più dalla coda BullMQ (vedi campaigns.service.ts).
 */
@Injectable()
export class SendDispatchService {
  private readonly logger = new Logger(SendDispatchService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly attachments: AttachmentService,
    private readonly attachmentUpload: SendAttachmentUploadService,
  ) {}

  @Cron('*/2 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .leftJoinAndSelect('attempt.recipient', 'recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('attempt.protocolled_at IS NOT NULL')
      .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NULL")
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    for (const attempt of attempts) {
      try {
        await this.dispatchOne(attempt);
      } catch (err: any) {
        this.logger.warn(`Invio SEND fallito per attempt ${attempt.id}: ${err.message}`);
        await this.markFailed(attempt, err.message);
      }
    }
  }

  private async dispatchOne(attempt: NotificationAttempt): Promise<void> {
    const recipient = attempt.recipient;
    const campaign = recipient.campaign;
    const cfg = campaign.channelConfig as Record<string, unknown>;

    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const baseUrl = await this.settings.get<string>(`${prefix}.baseUrl` as SettingKey);
    const purposeId = await this.settings.get<string>(`${prefix}.purposeId` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    const vars: Record<string, string> = { fullName: recipient.fullName ?? '', codiceFiscale: recipient.codiceFiscale };
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
    const paProtocolNumber = `${attempt.protocolNumber}/${attempt.protocolYear}`;

    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const docCount = Math.max(attachmentsConfig.length, 1);
    const documents: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < docCount; idx++) {
      const buffer = await this.attachments.generatePdfBuffer(recipient, idx);
      const uploaded = await this.attachmentUpload.preloadAndUpload(baseUrl, voucher, buffer, 'application/pdf', `doc-${idx}`);
      documents.push({
        ref: { key: uploaded.key, versionToken: uploaded.versionToken },
        title: subject,
        digests: { sha256: uploaded.sha256Base64 },
        contentType: 'application/pdf',
        docIdx: idx,
      });
    }

    const paymentConfig = cfg['paymentConfig'] as Record<string, unknown> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    const payments =
      resolvedPayment?.noticeCode && resolvedPayment.amountCents != null
        ? [{ pagoPa: { noticeCode: resolvedPayment.noticeCode, creditorTaxId: resolvedPayment.creditorTaxId, applyCost: true } }]
        : undefined;

    const senderTaxId = await this.settings.get<string>('send.senderTaxId' as SettingKey);
    const senderDenomination = await this.settings.get<string>('brand.name' as SettingKey);
    const taxonomyCode = cfg['taxonomyCode'] as string;
    const physicalCommunicationType = (cfg['physicalCommunicationType'] as string) || 'AR_REGISTERED_LETTER';

    const payload: Record<string, unknown> = {
      // Deterministico sull'attemptId: un retry del demone (crash, errore rete)
      // riusa lo stesso token, PN deduplica invece di creare una seconda
      // notifica legale. La protocollazione è già persistita PRIMA che questo
      // demone giri (vedi ProtocollazioneSyncService) — un retry non rifà mai
      // la protocollazione, chiude il rischio di doppio paProtocolNumber.
      idempotenceToken: attempt.id,
      paProtocolNumber,
      notificationFeePolicy: 'FLAT_RATE',
      physicalCommunicationType,
      senderDenomination,
      senderTaxId,
      taxonomyCode,
      subject,
      recipients: [{
        recipientType: 'PF',
        taxId: recipient.codiceFiscale,
        denomination: recipient.fullName ?? recipient.codiceFiscale,
        ...(payments ? { payments } : {}),
      }],
      documents,
    };

    const response = await fetch(`${baseUrl}/delivery/v2.6/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voucher}` },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SEND API error: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND accettata per attempt ${attempt.id}: notificationRequestId=${data.notificationRequestId}`);
    await this.markSuccess(attempt, campaign, { notificationRequestId: data.notificationRequestId });
  }

  private async markSuccess(attempt: NotificationAttempt, campaign: Campaign, responsePayload: Record<string, unknown>): Promise<void> {
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const attachmentExpiresAt = new Date(Date.now() + retentionDays * 86400 * 1000);

    attempt.status = AttemptStatus.SUCCESS;
    attempt.sentAt = new Date();
    attempt.responsePayload = responsePayload;
    await this.attemptRepo.save(attempt);
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.SENT, attachmentExpiresAt });
    await this.campaignRepo.increment({ id: campaign.id }, 'sentCount', 1);
  }

  private async markFailed(attempt: NotificationAttempt, message: string): Promise<void> {
    attempt.status = AttemptStatus.FAILED;
    attempt.errorMessage = message;
    await this.attemptRepo.save(attempt);
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.FAILED });
    await this.campaignRepo.increment({ id: attempt.recipient.campaign.id }, 'failedCount', 1);
  }
}
```

- [ ] **Step 4: Esegui il test, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest send-dispatch --maxWorkers=2
```

Atteso: PASS, 4/4.

- [ ] **Step 5: Rimuovi `SendStrategy` (logica assorbita)**

```bash
git rm apps/backend/src/channels/send/send.strategy.ts apps/backend/src/channels/send/send.strategy.spec.ts
```

- [ ] **Step 6: Aggiorna `channel.module.ts`**

Sostituisci il contenuto di `apps/backend/src/channels/channel.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { PdfModule } from '../pdf/pdf.module';
import { PdndModule } from '../pdnd/pdnd.module';
import { ProtocolloModule } from '../protocollo/protocollo.module';
import { AttachmentModule } from '../attachments/attachment.module';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import type { IChannelStrategy } from './channel.interface';
import { CHANNEL_STRATEGIES } from './channel.interface';
import { EmailStrategy } from './email/email.strategy';
import { PecStrategy } from './pec/pec.strategy';
import { AppIoStrategy } from './app-io/app-io.strategy';
import { SendAttachmentUploadService } from './send/send-attachment-upload.service';
import { SendStatusSyncService } from './send/send-status-sync.service';
import { SendDispatchService } from './send/send-dispatch.service';
import { ProtocollazioneSyncService } from './protocollazione-sync.service';
import { PostalStrategy } from './postal/postal.strategy';

@Module({
  imports: [
    PdfModule,
    PdndModule,
    ProtocolloModule,
    AttachmentModule,
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
  ],
  providers: [
    EmailStrategy,
    PecStrategy,
    AppIoStrategy,
    PostalStrategy,
    SendAttachmentUploadService,
    SendStatusSyncService,
    SendDispatchService,
    ProtocollazioneSyncService,
    {
      provide: CHANNEL_STRATEGIES,
      useFactory: (
        email: EmailStrategy,
        pec: PecStrategy,
        appIo: AppIoStrategy,
        postal: PostalStrategy,
      ): Map<NotificationChannel, IChannelStrategy> => {
        const map = new Map<NotificationChannel, IChannelStrategy>();
        for (const s of [email, pec, appIo, postal]) {
          map.set(s.channel, s);
        }
        return map;
      },
      inject: [EmailStrategy, PecStrategy, AppIoStrategy, PostalStrategy],
    },
  ],
  exports: [CHANNEL_STRATEGIES],
})
export class ChannelModule {}
```

`CHANNEL_STRATEGIES` non ha più un'entry `SEND`: nessun consumer la cerca più per SEND dopo Task 5/6 (BullMQ smette di processare quel canale).

- [ ] **Step 7: Type-check e test completi backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Atteso: nessun nuovo fallimento oltre al baseline pulito (i test di `send.strategy.spec.ts` sono stati rimossi, non falliti).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/channels/send/send-dispatch.service.ts apps/backend/src/channels/send/send-dispatch.service.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): demone SendDispatchService, rimuove SendStrategy sincrona"
```

---

### Task 4: `campaigns.service.ts` — `launch()`/`retryRecipient()` saltano BullMQ per SEND

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`launch()` righe 333-350, `retryRecipient()` righe 803-805)
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: nessuna nuova — usa `campaign.channelType` già disponibile in entrambi i metodi.

- [ ] **Step 1: Scrivi il test per `launch()` (fallirà: branch non esiste)**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, subito dopo il test `'launch accoda i job BullMQ con jobId = attemptId'` (righe 183-204), aggiungi:

```ts
  it('launch NON accoda job BullMQ per campagne SEND (demoni pollano lo stato QUEUED)', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'SEND', channelConfig: { protocolla: true } });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
    });

    const result = await service.launch('c1');

    expect(mockQueue.addBulk).not.toHaveBeenCalled();
    expect(result).toEqual({ launched: 1, campaignId: 'c1' });
  });
```

- [ ] **Step 2: Esegui, verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "launch NON accoda"
```

Atteso: FAIL — `mockQueue.addBulk` risulta chiamato (il branch SEND non esiste ancora).

- [ ] **Step 3: Aggiungi il branch in `launch()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci il blocco righe 333-350:

```ts
    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo grandi)
    const JOB_CHUNK = 1000;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
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
    }
```

con:

```ts
    // SEND non passa da BullMQ: i demoni ProtocollazioneSyncService/SendDispatchService
    // pollano gli attempt QUEUED e li portano avanti a stadi (protocollato → inviato).
    if (campaign.channelType !== 'SEND') {
      // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo grandi)
      const JOB_CHUNK = 1000;
      for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
        const chunk = recipients.slice(i, i + JOB_CHUNK);
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
      }
    }
```

- [ ] **Step 4: Esegui, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "launch"
```

Atteso: PASS, tutti i test `launch`.

- [ ] **Step 5: Scrivi il test per `retryRecipient()` (fallirà)**

Subito dopo il test `'retryRecipient crea un nuovo attempt, riaccoda il job e decrementa failedCount'` (righe 998-1019), aggiungi:

```ts
  it('retryRecipient NON riaccoda job BullMQ per campagne SEND', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({ attemptNumber: 1 });
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: () => ({ into: () => ({ values: () => ({ returning: () => ({ execute: insertExec }) }) }) }),
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.retryRecipient('c1', 'r1');

    expect(queuesMock.addBulk).not.toHaveBeenCalled();
    expect(result).toEqual({ requeued: true, attemptId: 'attempt-2' });
  });
```

- [ ] **Step 6: Esegui, verifica che fallisca, poi aggiungi il branch**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "retryRecipient NON riaccoda"
```

Atteso: FAIL. In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci righe 803-805:

```ts
    await this.notificationQueues.addBulk(campaign.channelType, [
      { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
    ]);
```

con:

```ts
    if (campaign.channelType !== 'SEND') {
      await this.notificationQueues.addBulk(campaign.channelType, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    }
```

- [ ] **Step 7: Esegui, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Atteso: PASS, nessuna regressione sul resto del file.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): launch()/retryRecipient() saltano BullMQ per campagne SEND"
```

---

### Task 5: `campaigns.service.ts` — `cancel()` con update diretto per SEND

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`cancel()`, righe 360-435)
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `AttemptStatus.QUEUED`/`CANCELLED`, `RecipientStatus.QUEUED`/`CANCELLED` (esistenti).

- [ ] **Step 1: Scrivi il test (fallirà: `cancel()` prova comunque a chiamare `getJob` anche per SEND)**

Nel blocco `describe` che contiene i test `cancel` (dopo il test `'non aggiorna nulla se non ci sono destinatari in coda'`, riga 812), aggiungi:

```ts
    it('per campagne SEND annulla via update diretto DB, senza toccare BullMQ', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'SEND' });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { id: 'att-1', recipientId: 'r1' },
        { id: 'att-2', recipientId: 'r2' },
      ]);
      mockAttemptRepo.update = jest.fn().mockResolvedValue(undefined);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

      const result = await service.cancel('c1');

      expect(mockQueue.getJob).not.toHaveBeenCalled();
      expect(mockAttemptRepo.update).toHaveBeenCalledWith(
        { id: In(['att-1', 'att-2']), status: AttemptStatus.QUEUED },
        { status: AttemptStatus.CANCELLED },
      );
      expect(mockRecipientRepo.update).toHaveBeenCalledWith({ id: In(['r1', 'r2']) }, { status: RecipientStatus.CANCELLED });
      expect(result).toEqual({ cancelled: 2, campaignId: 'c1' });
    });
```

- [ ] **Step 2: Esegui, verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "annulla via update diretto"
```

Atteso: FAIL — il codice attuale chiama comunque `getJob`/`job.remove()` anche per SEND.

- [ ] **Step 3: Aggiungi il branch in `cancel()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci il blocco righe 374-424:

```ts
    let cancelled = 0;
    if (queuedRecipients.length > 0) {
      const recipientIds = queuedRecipients.map((r) => r.id);
      const liveAttempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), status: AttemptStatus.QUEUED },
      });

      let removedAttemptIds: string[];
      let removedRecipientIds: string[];

      if (campaign.channelType === 'SEND') {
        // SEND non passa da BullMQ: annulla tutti gli attempt ancora QUEUED
        // (non protocollati, o protocollati ma non ancora inviati — in
        // entrambi i casi lo status resta QUEUED finché SendDispatchService
        // non lo marca SUCCESS/FAILED) con un update diretto su DB.
        removedAttemptIds = liveAttempts.map((a) => a.id);
        removedRecipientIds = liveAttempts.map((a) => a.recipientId);
        if (removedAttemptIds.length > 0) {
          await this.attemptRepo.update(
            { id: In(removedAttemptIds), status: AttemptStatus.QUEUED },
            { status: AttemptStatus.CANCELLED },
          );
        }
      } else {
        removedAttemptIds = [];
        removedRecipientIds = [];
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
        }
      }

      if (removedRecipientIds.length > 0) {
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { status: RecipientStatus.CANCELLED });

        // Il destinatario cancellato non riceverà mai la notifica: l'allegato
        // personalizzato non serve più (non c'è download da servire), elimina
        // subito invece di aspettare la scadenza retention.
        const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
        const totalSlots = Math.max(attachmentsConfig.length, 1);
        const dir = getUploadsDir(campaignId);
        for (const recipientId of removedRecipientIds) {
          const recipient = queuedById.get(recipientId);
          if (!recipient) continue;
          for (let index = 0; index < totalSlots; index++) {
            const filename = resolveCustomAttachmentFilename(
              { campaign, extraData: recipient.extraData } as unknown as Recipient,
              index,
            );
            if (!filename) continue;
            try {
              await unlink(join(dir, filename));
            } catch (err) {
              this.logger.warn(`Allegato già assente o non eliminabile: ${filename}`);
            }
          }
        }
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { attachmentDeletedAt: new Date() });
      }
      cancelled = removedRecipientIds.length;
    }
```

Nota: il blocco eliminazione allegati/`attachmentDeletedAt` resta invariato e condiviso da entrambi i branch — solo il modo di individuare `removedAttemptIds`/`removedRecipientIds` cambia.

- [ ] **Step 4: Esegui il test, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```

Atteso: PASS, nessuna regressione sui test `cancel` esistenti (canale EMAIL invariato).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): cancel() annulla campagne SEND con update diretto DB invece di BullMQ"
```

---

### Task 6: Rimozione coda BullMQ SEND

**Files:**
- Modify: `apps/backend/src/queue/notification-job.types.ts`
- Modify: `apps/backend/src/queue/channel-processors.ts`
- Modify: `apps/backend/src/queue/queue.module.ts`
- Modify: `apps/backend/src/queue/notification-queues.service.ts`
- Modify: `apps/backend/src/queue/notification-queues.service.spec.ts`

**Interfaces:**
- Produces: `CHANNEL_QUEUES: Record<Exclude<NotificationChannel,'SEND'>, string>` (4 canali); `ALL_CHANNELS` di conseguenza esclude SEND — consumato da `engines.controller.ts` (Task 7 lo estende con un endpoint SEND separato).

- [ ] **Step 1: Aggiorna `notification-job.types.ts`**

Sostituisci il contenuto:

```ts
import type { NotificationChannel } from '@comunicapa/shared-types';

export const NOTIFICATION_JOB_SEND = 'send';

/**
 * Una coda BullMQ dedicata per ogni canale, ECCETTO SEND: SEND non passa più
 * da BullMQ (vedi ProtocollazioneSyncService/SendDispatchService, entrambi
 * poll-based su NotificationAttempt) — vedi docs/superpowers/specs/2026-07-14-pipeline-demoni-send-design.md.
 */
export const CHANNEL_QUEUES: Record<Exclude<NotificationChannel, 'SEND'>, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  POSTAL: 'notifications-postal',
};

export const QUEUED_CHANNELS = Object.keys(CHANNEL_QUEUES) as Array<Exclude<NotificationChannel, 'SEND'>>;

export const THROTTLE_REDIS = 'THROTTLE_REDIS';
```

`ALL_CHANNELS` è rinominata `QUEUED_CHANNELS` per riflettere che non è più "tutti i canali" — Task 7 aggiorna i consumer.

- [ ] **Step 2: Rimuovi `SendNotificationProcessor`**

Sostituisci il contenuto di `apps/backend/src/queue/channel-processors.ts`:

```ts
import { Processor } from '@nestjs/bullmq';
import { CHANNEL_QUEUES } from './notification-job.types';
import { NotificationProcessor } from './notification.processor';

// Le sottoclassi NON dichiarano un costruttore: i metadati di iniezione
// (design:paramtypes e @Inject) vengono risolti risalendo la prototype chain
// fino a NotificationProcessor, che resta @Injectable().

@Processor(CHANNEL_QUEUES.EMAIL)
export class EmailNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.PEC)
export class PecNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.APP_IO)
export class AppIoNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.POSTAL)
export class PostalNotificationProcessor extends NotificationProcessor {}
```

- [ ] **Step 3: Aggiorna `queue.module.ts`**

Sostituisci il contenuto:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import type { AppConfiguration } from '../config/configuration';
import { CHANNEL_QUEUES, THROTTLE_REDIS } from './notification-job.types';
import {
  EmailNotificationProcessor,
  PecNotificationProcessor,
  AppIoNotificationProcessor,
  PostalNotificationProcessor,
} from './channel-processors';
import { NotificationQueuesService } from './notification-queues.service';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { ChannelModule } from '../channels/channel.module';

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
    BullModule.registerQueue(
      ...Object.values(CHANNEL_QUEUES).map((name) => ({ name })),
    ),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
  ],
  providers: [
    EmailNotificationProcessor,
    PecNotificationProcessor,
    AppIoNotificationProcessor,
    PostalNotificationProcessor,
    NotificationQueuesService,
    {
      provide: THROTTLE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) =>
        new Redis(config.get('redis.url', { infer: true }), { maxRetriesPerRequest: null }),
    },
  ],
  exports: [BullModule, NotificationQueuesService, THROTTLE_REDIS],
})
export class QueueModule {}
```

- [ ] **Step 4: Aggiorna `notification-queues.service.ts`**

Sostituisci il contenuto:

```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES } from './notification-job.types';

type QueuedChannel = keyof typeof CHANNEL_QUEUES;

@Injectable()
export class NotificationQueuesService {
  private readonly queues: Map<QueuedChannel, Queue<NotificationJobData>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUES.EMAIL) emailQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.PEC) pecQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.APP_IO) appIoQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.POSTAL) postalQueue: Queue<NotificationJobData>,
  ) {
    this.queues = new Map([
      ['EMAIL', emailQueue],
      ['PEC', pecQueue],
      ['APP_IO', appIoQueue],
      ['POSTAL', postalQueue],
    ]);
  }

  getQueue(channel: QueuedChannel): Queue<NotificationJobData> {
    const queue = this.queues.get(channel);
    if (!queue) throw new Error(`Nessuna coda registrata per il canale ${channel}`);
    return queue;
  }

  addBulk(
    channel: QueuedChannel,
    jobs: Array<{ name: string; data: NotificationJobData; opts?: { jobId?: string } }>,
  ) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJob(channel: QueuedChannel, jobId: string) {
    return this.getQueue(channel).getJob(jobId);
  }

  getJobCounts(channel: QueuedChannel): Promise<Record<string, number>> {
    return this.getQueue(channel).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed') as Promise<Record<string, number>>;
  }

  isPaused(channel: QueuedChannel): Promise<boolean> {
    return this.getQueue(channel).isPaused();
  }

  pause(channel: QueuedChannel): Promise<void> {
    return this.getQueue(channel).pause();
  }

  resume(channel: QueuedChannel): Promise<void> {
    return this.getQueue(channel).resume();
  }

  async getJobsDetail(
    channel: QueuedChannel,
    status: 'failed' | 'completed' | 'active' | 'waiting' | 'delayed',
    limit = 50,
  ): Promise<Array<{
    jobId: string;
    campaignId: string;
    recipientId: string;
    attemptId: string;
    failedReason?: string;
    attemptsMade: number;
    timestamp: number;
    finishedOn?: number;
  }>> {
    const jobs = await this.getQueue(channel).getJobs([status], 0, limit - 1);
    return jobs.map((job) => ({
      jobId: String(job.id),
      campaignId: job.data.campaignId,
      recipientId: job.data.recipientId,
      attemptId: job.data.attemptId,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
    }));
  }

  async getJobLogs(channel: QueuedChannel, jobId: string): Promise<string[]> {
    const { logs } = await this.getQueue(channel).getJobLogs(jobId);
    return logs;
  }
}
```

`campaigns.service.ts` chiama `this.notificationQueues.addBulk(campaign.channelType, ...)`/`getJob(campaign.channelType, ...)` con `campaign.channelType: NotificationChannel` (include `'SEND'`) — ma dopo Task 4/5 questi punti sono già raggiunti solo per canali `!== 'SEND'`, quindi il tipo più stretto `QueuedChannel` è compatibile a runtime. TypeScript però non lo sa staticamente: verificalo al passo successivo.

- [ ] **Step 5: Type-check, correggi eventuali errori di narrowing**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Se `tsc` segnala che `campaign.channelType` (tipo `NotificationChannel`) non è assegnabile a `QueuedChannel` nei punti già guardati da `if (campaign.channelType !== 'SEND')` (Task 4) o nel branch `else` di `cancel()` (Task 5), applica un cast esplicito nel punto di chiamata — il branch runtime già garantisce l'esclusione di SEND:

In `campaigns.service.ts`, nei tre punti (`launch()`, `retryRecipient()`, `cancel()` branch else) dove si chiama `this.notificationQueues.addBulk(campaign.channelType, ...)` o `getJob(campaign.channelType, ...)`, cambia in `this.notificationQueues.addBulk(campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>, ...)` (stesso pattern per `getJob`). Importa `Exclude` non serve (è un utility type globale TS).

- [ ] **Step 6: Aggiorna `notification-queues.service.spec.ts`**

Rimuovi le 6 righe `{ provide: getQueueToken(CHANNEL_QUEUES.SEND), useValue: {} }` (righe 24, 58, 78 nel file originale — una per ciascuno dei 3 blocchi `TestingModule`).

- [ ] **Step 7: Aggiorna `engines.controller.ts` (import `ALL_CHANNELS` → `QUEUED_CHANNELS`)**

In `apps/backend/src/engines/engines.controller.ts`, sostituisci tutte le occorrenze di `ALL_CHANNELS` con `QUEUED_CHANNELS` (import riga 4 e usi righe 15/36/48/63/83). Questo endpoint (`GET admin/engines`) continua a funzionare invariato per i 4 canali rimasti — Task 7 aggiunge l'endpoint SEND separato, non modifica oltre questo rename.

- [ ] **Step 8: Esegui la suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Atteso: nessun nuovo fallimento rispetto al baseline.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/queue/notification-job.types.ts apps/backend/src/queue/channel-processors.ts apps/backend/src/queue/queue.module.ts apps/backend/src/queue/notification-queues.service.ts apps/backend/src/queue/notification-queues.service.spec.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/engines/engines.controller.ts
git commit -m "refactor(backend): rimuove coda BullMQ SEND, ALL_CHANNELS->QUEUED_CHANNELS"
```

---

### Task 7: Contatori a stadio SEND — endpoint backend + UI Motori

**Files:**
- Modify: `apps/backend/src/engines/engines.controller.ts`
- Modify: `apps/backend/src/engines/engines.controller.spec.ts`
- Modify: `apps/backend/src/engines/engines.module.ts`
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: `GET admin/engines/send/stage-counts` → `{ queued: number; protocollato: number; inviato: number; fallito: number }`.

- [ ] **Step 1: Scrivi il test del controller (fallirà: endpoint non esiste)**

In `apps/backend/src/engines/engines.controller.spec.ts`, aggiungi (adattando l'header del file esistente — verifica gli import correnti prima di aggiungere):

```ts
  it('GET send/stage-counts ritorna i contatori per stadio SEND', async () => {
    mockAttemptRepo.count
      .mockResolvedValueOnce(3) // queued (non protocollato)
      .mockResolvedValueOnce(2) // protocollato non inviato
      .mockResolvedValueOnce(10) // inviato
      .mockResolvedValueOnce(1); // fallito

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ queued: 3, protocollato: 2, inviato: 10, fallito: 1 });
  });
```

Nel setup del `TestingModule` dello stesso file, aggiungi un mock repository `NotificationAttempt` iniettato via `getRepositoryToken(NotificationAttempt)`:

```ts
const mockAttemptRepo = { count: jest.fn() };
```

e registralo tra i provider del `TestingModule.createTestingModule({...})` insieme a `{ provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo }` (import `getRepositoryToken` da `@nestjs/typeorm`, `NotificationAttempt` da `../entities/notification-attempt.entity`).

- [ ] **Step 2: Esegui, verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2
```

Atteso: FAIL — `controller.sendStageCounts is not a function`.

- [ ] **Step 3: Implementa l'endpoint**

In `apps/backend/src/engines/engines.controller.ts`, aggiungi gli import in testa:

```ts
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
```

Estendi il costruttore:

```ts
  constructor(
    private readonly queues: NotificationQueuesService,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
  ) {}
```

Aggiungi il nuovo endpoint (dopo `list()`, prima di `pause()`):

```ts
  @Get('send/stage-counts')
  @Roles('admin', 'user')
  async sendStageCounts() {
    const [queued, protocollato, inviato, fallito] = await Promise.all([
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.QUEUED, protocolledAt: null } }),
      this.attemptRepo.createQueryBuilder('attempt')
        .where('attempt.channel_type = :ch', { ch: 'SEND' })
        .andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED })
        .andWhere('attempt.protocolled_at IS NOT NULL')
        .getCount(),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.SUCCESS } }),
      this.attemptRepo.count({ where: { channelType: 'SEND', status: AttemptStatus.FAILED } }),
    ]);
    return { queued, protocollato, inviato, fallito };
  }
```

`{ protocolledAt: null }` con `Repository.count`'s `FindOptionsWhere` genera `IS NULL` (comportamento standard TypeORM per valore `null`).

- [ ] **Step 4: Registra `NotificationAttempt` in `engines.module.ts`**

Sostituisci il contenuto di `apps/backend/src/engines/engines.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule, TypeOrmModule.forFeature([NotificationAttempt])],
  controllers: [EnginesController],
})
export class EnginesModule {}
```

- [ ] **Step 5: Esegui il test, verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2
```

Atteso: PASS.

- [ ] **Step 6: Adatta la UI Motori per SEND**

Apri `apps/frontend-admin/src/App.tsx` e individua il rendering della tab Motori (cerca il componente/blocco che mappa `engines` restituiti da `GET admin/engines` — uno per canale, con contatori BullMQ `waiting/active/completed/failed/delayed` e pulsanti pausa/riprendi). SEND non compare più in quell'elenco dopo Task 6 (rimosso da `QUEUED_CHANNELS`/`ALL_CHANNELS`): aggiungi una card separata, statica, per SEND che chiama `GET admin/engines/send/stage-counts` invece di iterare sulla lista `engines`.

Aggiungi uno state dedicato vicino allo state esistente dei motori (cerca `const [engines, setEngines]` o simile):

```tsx
const [sendStageCounts, setSendStageCounts] = useState<{ queued: number; protocollato: number; inviato: number; fallito: number } | null>(null);
```

Nella stessa funzione che oggi carica `GET admin/engines` (cerca `fetch(\`${ADMIN_API_BASE}/engines\`` o analogo), aggiungi il fetch parallelo:

```tsx
const stageRes = await fetch(`${ADMIN_API_BASE}/engines/send/stage-counts`, { headers: authHeaders() });
if (stageRes.ok) setSendStageCounts(await stageRes.json());
```

(riusa l'helper `authHeaders()`/pattern di auth già in uso dalle altre chiamate della stessa funzione — verifica il nome esatto nel file, i fetch esistenti nella stessa funzione usano lo stesso helper).

Nel JSX della tab Motori, dove oggi si mappano le card per canale (`engines.map(...)`), aggiungi dopo la mappa esistente una card statica per SEND:

```tsx
{sendStageCounts && (
  <div className="engine-card">
    <h3>SEND</h3>
    <p className="engine-note">Pipeline a stadi (nessuna coda BullMQ): protocollazione e invio girano come demoni schedulati.</p>
    <dl className="engine-counts">
      <dt>In coda (da protocollare)</dt><dd>{sendStageCounts.queued}</dd>
      <dt>Protocollato (da inviare)</dt><dd>{sendStageCounts.protocollato}</dd>
      <dt>Inviato</dt><dd>{sendStageCounts.inviato}</dd>
      <dt>Fallito</dt><dd>{sendStageCounts.fallito}</dd>
    </dl>
  </div>
)}
```

Usa le classi CSS già esistenti per le card motori nello stesso blocco (`engine-card`/equivalente — verifica il nome esatto delle classi usate dalle card generate da `engines.map(...)` nello stesso file e riusa quelle, non inventarne di nuove).

- [ ] **Step 7: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 8: Verifica manuale UI**

Avvia il dev server (già attivo via `docker compose up -d`), login admin, tab Motori: verifica che la card SEND mostri i 4 contatori (anche a zero su un ambiente senza campagne SEND lanciate) e che le altre 4 card canale funzionino come prima (pausa/riprendi/log invariati).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/engines/engines.controller.ts apps/backend/src/engines/engines.controller.spec.ts apps/backend/src/engines/engines.module.ts apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend-admin): contatori a stadio SEND nella tab Motori"
```

---

## Verifica finale (whole-branch)

- [ ] `docker compose exec backend node_modules/.bin/tsc --noEmit`
- [ ] `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
- [ ] `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` — failure set identico al baseline pulito
- [ ] Migration Task 1 verificata su DB temporaneo (già fatto nel task, riverificare in sequenza con le migration precedenti se il branch ha divergenze)
- [ ] Verifica manuale: lancio campagna SEND di test (ambiente collaudo/mock), osservare progressione negli attempt (`protocolled_at` popolato dal demone 1 entro 2 minuti, poi `response_payload.notificationRequestId` dal demone 2 entro altri 2 minuti), annullamento campagna SEND con attempt in stadio queued/protocollato, verifica card Motori SEND aggiornata.
- [ ] Nessun test contro PN reale (stesso limite dei sotto-progetti precedenti — nessuna credenziale di collaudo disponibile in questo ambiente).
