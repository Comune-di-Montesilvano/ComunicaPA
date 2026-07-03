# Fase 5 — Chiusura spedizione TARI 2026 via Email/PEC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere operativo l'invio massivo TARI 2026 via Email/PEC: N configurazioni server mail/PEC testabili con throttling, wizard corretto (CSV rimovibile, header toggle, mittente, co-delivery App IO a scelta), template con logo ente e footer portale, allegati ZIP con scarto dei non mappati, tab "Motori" con stato code e log.

**Architecture:** Nuova entity `MailServerConfig` (tabella `mail_server_configs`) con CRUD + test + attivazione; le strategie EMAIL/PEC risolvono la config da `campaign.channelConfig.mailConfigId` con fallback sulle chiavi legacy `smtp.*`/`pec.*`. **Un motore (coda BullMQ + worker) dedicato per ogni canale** (`notifications-email`, `notifications-pec`, `notifications-appio`, `notifications-send`, `notifications-postal`): il processor comune diventa classe base con 5 sottoclassi `@Processor`, e ogni motore è pausabile/riavviabile singolarmente (`queue.pause()`/`resume()`) come i daemon di GovPay-Interaction-Layer. Il processor applica throttling per-config (finestra Redis + `moveToDelayed`) e gestisce tre modalità App IO (`none`/`parallel`/`exclusive`). Frontend: wizard e impostazioni in `App.tsx` (monolite — si segue lo stile esistente), nuovo tab Motori ispirato alla dashboard cron di GovPay-Interaction-Layer.

**Tech Stack:** NestJS 10, TypeORM, BullMQ 5, ioredis, nodemailer, adm-zip (nuova dipendenza), React 19.

## Global Constraints

- Tutto gira in Docker: comandi test = `docker compose exec backend node_modules/.bin/jest <pattern> --maxWorkers=2` (SEMPRE `--maxWorkers=2`).
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`. Frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (MAI `tsc -b`).
- **Baseline test nota:** 7 test falliscono da prima (email.strategy, pec.strategy, notification.processor). Il criterio è "failure set identico o ridotto". I task 4-6 TOCCANO quei file: aggiornare gli spec corrispondenti è nel task, l'obiettivo è non introdurre NUOVI fallimenti.
- Hot-reload NestJS spesso non vede modifiche su bind mount Windows: dopo modifiche a `apps/backend/src/` fare `docker compose restart backend`.
- Nuova dipendenza backend (`adm-zip`, task 8): rebuild + rimozione volume node_modules obbligatori (procedura nel task).
- Migration prod: generata con DB temporaneo `migration_gen` (procedura nel task 1) e registrata nell'array `migrations` di `database.module.ts`.
- Il backend NON ha prefisso `/api`: route dirette `/mail-configs`, `/engines`. In dev il frontend chiama `http://localhost:8080` via `API_BASE`.
- `frontend-admin`: utility Bootstrap-like presenti in `no-bootstrap-compat.css` — usare le classi già usate nel file (`card`, `btn btn-sm`, `badge`, `form-control form-control-sm`).
- Commit frequenti, un commit per task. Messaggi in Conventional Commits.

## Interfacce condivise (contratto tra i task)

```ts
// Entity (task 1)
type MailServerType = 'EMAIL' | 'PEC';
class MailServerConfig {
  id: string; type: MailServerType; name: string;
  host: string; port: number; secure: boolean;
  authEnabled: boolean; username: string; passwordEnc: string;
  fromAddress: string;
  batchSize: number;            // invii per finestra, default 100
  batchIntervalSeconds: number; // durata finestra, default 60
  testedAt: Date | null; active: boolean;
  createdAt: Date; updatedAt: Date;
}

// Service (task 2)
interface ResolvedMailConfig {
  host: string; port: number; secure: boolean;
  authEnabled: boolean; username: string; password: string;
  fromAddress: string; batchSize: number; batchIntervalSeconds: number;
  configId: string | null; // null = fallback legacy smtp.*/pec.*
}
class MailConfigsService {
  listMasked(type?: MailServerType): Promise<MailConfigMaskedDto[]>;
  create(dto: CreateMailConfigDto): Promise<MailConfigMaskedDto>;
  update(id: string, dto: UpdateMailConfigDto): Promise<MailConfigMaskedDto>;
  remove(id: string): Promise<void>;
  test(id: string, to: string): Promise<{ success: true; message: string }>; // successo ⇒ testedAt=now, active=true
  setActive(id: string, active: boolean): Promise<MailConfigMaskedDto>;     // active=true richiede testedAt ≠ null
  resolveForSend(type: MailServerType, mailConfigId?: string): Promise<ResolvedMailConfig>;
}

// REST (task 3) — tutte sotto /mail-configs
// GET    /mail-configs?type=EMAIL|PEC     (roles: user, admin) → { configs: MailConfigMaskedDto[] }
// POST   /mail-configs                    (admin)
// PUT    /mail-configs/:id                (admin)
// DELETE /mail-configs/:id                (admin)
// POST   /mail-configs/:id/test  {to}     (admin)
// PATCH  /mail-configs/:id/active {active} (admin)

// Code per canale (task 5) — in notification-job.types.ts:
export const CHANNEL_QUEUES: Record<NotificationChannel, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  SEND: 'notifications-send',
  POSTAL: 'notifications-postal',
};
class NotificationQueuesService {
  getQueue(channel: NotificationChannel): Queue<NotificationJobData>;
  addBulk(channel: NotificationChannel, jobs: Array<{ name: string; data: NotificationJobData }>): Promise<unknown>;
  getJobCounts(channel: NotificationChannel): Promise<Record<string, number>>;
  isPaused(channel: NotificationChannel): Promise<boolean>;
  pause(channel: NotificationChannel): Promise<void>;
  resume(channel: NotificationChannel): Promise<void>;
}

// channelConfig campagna (task 7, 13) — nuove chiavi per EMAIL/PEC:
// { subject, body, allegatoKey, mailConfigId?: string,
//   appIo?: { mode: 'parallel' | 'exclusive', serviceId, serviceName, apiKey, baseUrl } }
// (mode assente/appIo assente = nessuna co-delivery; retrocompat: appIo senza mode = 'parallel')

// Template (task 7)
function wrapInHtmlLayout(bodyContent: string, brandName: string,
  options?: { logoUrl?: string | null; portalUrl?: string | null }): string;

// Allegati (task 8)
// POST /campaigns/:id/attachments → { uploaded: number; discarded: number; campaignId: string }

// Engines (task 14)
// GET /engines (admin) → { engines: [{ channel, configured: boolean, paused: boolean,
//               queue: {waiting,active,completed,failed,delayed},
//               configs: [{id,name,host,fromAddress,active,testedAt}],
//               attempts24h: { success: number; failed: number } }] }
// POST /engines/:channel/pause  (admin) → { channel, paused: true }
// POST /engines/:channel/resume (admin) → { channel, paused: false }
// GET /engines/:channel/attempts?limit=50 (admin) → { attempts: [{id, status, errorMessage, sentAt, createdAt, recipient: {codiceFiscale, email, pec, fullName}}] }
```

---

### Task 1: Entity `MailServerConfig` + migration

**Files:**
- Create: `apps/backend/src/entities/mail-server-config.entity.ts`
- Modify: `apps/backend/src/database/database.module.ts` (entities + migrations)
- Modify: `apps/backend/src/database/data-source.ts` (se elenca le entity esplicitamente, aggiungere la nuova; verificare aprendo il file)
- Create (generata): `apps/backend/src/database/migrations/<timestamp>-AddMailServerConfigs.ts`

**Interfaces:**
- Produces: entity `MailServerConfig` come da contratto in testa al piano.

- [ ] **Step 1: Scrivere l'entity**

```ts
// apps/backend/src/entities/mail-server-config.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MailServerType = 'EMAIL' | 'PEC';

@Entity('mail_server_configs')
export class MailServerConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 8 })
  type!: MailServerType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @Column({ type: 'int', default: 587 })
  port!: number;

  @Column({ type: 'boolean', default: false })
  secure!: boolean;

  /** false = server SMTP senza autenticazione (username/password ignorati). */
  @Column({ name: 'auth_enabled', type: 'boolean', default: true })
  authEnabled!: boolean;

  @Column({ type: 'varchar', length: 255, default: '' })
  username!: string;

  /** Password cifrata AES-256-GCM (stessa chiave derivata dei settings). */
  @Column({ name: 'password_enc', type: 'text', default: '' })
  passwordEnc!: string;

  @Column({ name: 'from_address', type: 'varchar', length: 255 })
  fromAddress!: string;

  /** Throttling: max invii per finestra. */
  @Column({ name: 'batch_size', type: 'int', default: 100 })
  batchSize!: number;

  /** Throttling: durata finestra in secondi. */
  @Column({ name: 'batch_interval_seconds', type: 'int', default: 60 })
  batchIntervalSeconds!: number;

  /** Data ultimo test riuscito. null = mai testata (non attivabile). */
  @Column({ name: 'tested_at', type: 'timestamptz', nullable: true })
  testedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
```

- [ ] **Step 2: Registrare l'entity in `database.module.ts`**

Aggiungere import e voce in `entities`:

```ts
import { MailServerConfig } from '../entities/mail-server-config.entity';
// ...
entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig],
```

Aprire `apps/backend/src/database/data-source.ts` e, se ha un array `entities` esplicito, aggiungere `MailServerConfig` anche lì.

- [ ] **Step 3: Riavviare il backend e verificare che synchronize crei la tabella**

```bash
docker compose restart backend
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d mail_server_configs"
```

Expected: descrizione tabella con colonne `id, type, name, host, port, secure, auth_enabled, username, password_enc, from_address, batch_size, batch_interval_seconds, tested_at, active, created_at, updated_at`.

- [ ] **Step 4: Generare la migration con DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddMailServerConfigs -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Expected: nuovo file `apps/backend/src/database/migrations/<timestamp>-AddMailServerConfigs.ts` con `CREATE TABLE "mail_server_configs"`.

- [ ] **Step 5: Registrare la migration in `database.module.ts`**

```ts
import { AddMailServerConfigs<timestamp> } from './migrations/<timestamp>-AddMailServerConfigs';
// ...
migrations: [InitialSchema1783023440824, AddMailServerConfigs<timestamp>],
```

(usare il timestamp reale generato).

- [ ] **Step 6: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/entities/mail-server-config.entity.ts apps/backend/src/database/
git commit -m "feat(backend): entity MailServerConfig con throttling e stato test"
```

---

### Task 2: `MailConfigsService` — CRUD, cifratura, test, risoluzione per invio

**Files:**
- Create: `apps/backend/src/mail-configs/mail-configs.service.ts`
- Create: `apps/backend/src/mail-configs/dto/mail-config.dto.ts`
- Create: `apps/backend/src/mail-configs/mail-configs.module.ts`
- Modify: `apps/backend/src/app.module.ts` (import del modulo)
- Test: `apps/backend/src/mail-configs/mail-configs.service.spec.ts`

**Interfaces:**
- Consumes: `MailServerConfig` (task 1); `encryptValue/decryptValue/deriveSettingsKey` da `../settings/settings-crypto`; `AppSettingsService` (globale) per fallback legacy; `MASKED_VALUE` da `../settings/settings.registry`.
- Produces: `MailConfigsService` con firma del contratto in testa; `MailConfigsModule` `@Global()`.

- [ ] **Step 1: Scrivere i DTO**

```ts
// apps/backend/src/mail-configs/dto/mail-config.dto.ts
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { MailServerType } from '../../entities/mail-server-config.entity';

export class CreateMailConfigDto {
  @IsIn(['EMAIL', 'PEC'])
  type!: MailServerType;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsBoolean()
  secure!: boolean;

  @IsBoolean()
  authEnabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsEmail()
  fromAddress!: string;

  @IsInt()
  @Min(1)
  batchSize!: number;

  @IsInt()
  @Min(1)
  batchIntervalSeconds!: number;
}

// Update: stessi campi ma tutti opzionali tranne type che NON è modificabile
export class UpdateMailConfigDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(255)
  host?: string;

  @IsOptional() @IsInt() @Min(1) @Max(65535)
  port?: number;

  @IsOptional() @IsBoolean()
  secure?: boolean;

  @IsOptional() @IsBoolean()
  authEnabled?: boolean;

  @IsOptional() @IsString() @MaxLength(255)
  username?: string;

  @IsOptional() @IsString()
  password?: string;

  @IsOptional() @IsEmail()
  fromAddress?: string;

  @IsOptional() @IsInt() @Min(1)
  batchSize?: number;

  @IsOptional() @IsInt() @Min(1)
  batchIntervalSeconds?: number;
}

export interface MailConfigMaskedDto {
  id: string;
  type: MailServerType;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string; // MASKED_VALUE se impostata, '' altrimenti
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  testedAt: string | null;
  active: boolean;
}
```

- [ ] **Step 2: Scrivere il test del service (failing)**

```ts
// apps/backend/src/mail-configs/mail-configs.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { MailConfigsService } from './mail-configs.service';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { MASKED_VALUE } from '../settings/settings.registry';

describe('MailConfigsService', () => {
  let service: MailConfigsService;
  const repo = {
    find: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn((e) => Promise.resolve({ id: 'gen-id', ...e })),
    create: jest.fn((e) => e),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
  };
  const appSettings = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MailConfigsService,
        { provide: getRepositoryToken(MailServerConfig), useValue: repo },
        { provide: AppSettingsService, useValue: appSettings },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-jwt-secret-for-crypto') },
        },
      ],
    }).compile();
    service = module.get(MailConfigsService);
  });

  it('create cifra la password e ritorna il DTO mascherato', async () => {
    const dto = {
      type: 'EMAIL' as const, name: 'SMTP Comune', host: 'smtp.example.org',
      port: 587, secure: false, authEnabled: true,
      username: 'noreply', password: 'segreta',
      fromAddress: 'noreply@example.org', batchSize: 100, batchIntervalSeconds: 60,
    };
    const result = await service.create(dto);
    // la password salvata NON è in chiaro
    const saved = repo.save.mock.calls[0][0];
    expect(saved.passwordEnc).not.toBe('segreta');
    expect(saved.passwordEnc.length).toBeGreaterThan(0);
    // il DTO risposto è mascherato
    expect(result.password).toBe(MASKED_VALUE);
    expect(result.active).toBe(false);
    expect(result.testedAt).toBeNull();
  });

  it('update con password mascherata non tocca quella salvata', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: 'u', passwordEnc: 'ENC-ORIGINALE',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: null, active: false,
    });
    await service.update('x', { password: MASKED_VALUE, name: 'nuovo' });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.passwordEnc).toBe('ENC-ORIGINALE');
    expect(saved.name).toBe('nuovo');
  });

  it('update di host/port/credenziali invalida il test (testedAt=null, active=false)', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: 'u', passwordEnc: 'E',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: new Date(), active: true,
    });
    await service.update('x', { host: 'nuovo-host' });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.testedAt).toBeNull();
    expect(saved.active).toBe(false);
  });

  it('setActive(true) fallisce se mai testata', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'x', testedAt: null, active: false });
    await expect(service.setActive('x', true)).rejects.toThrow(BadRequestException);
  });

  it('setActive(false) disattiva senza vincoli', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: '', passwordEnc: '', fromAddress: 'a@b.c',
      batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true,
    });
    const result = await service.setActive('x', false);
    expect(result.active).toBe(false);
  });

  it('resolveForSend usa la config indicata da mailConfigId', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'cfg1', type: 'EMAIL', name: 'a', host: 'smtp.x', port: 25, secure: false,
      authEnabled: false, username: '', passwordEnc: '', fromAddress: 'a@b.c',
      batchSize: 50, batchIntervalSeconds: 30, testedAt: new Date(), active: true,
    });
    const r = await service.resolveForSend('EMAIL', 'cfg1');
    expect(r.host).toBe('smtp.x');
    expect(r.authEnabled).toBe(false);
    expect(r.batchSize).toBe(50);
    expect(r.configId).toBe('cfg1');
  });

  it('resolveForSend senza id usa la prima config attiva del tipo', async () => {
    repo.findOneBy.mockResolvedValue(null);
    repo.find.mockResolvedValue([{
      id: 'cfg2', type: 'PEC', name: 'a', host: 'pec.x', port: 465, secure: true,
      authEnabled: true, username: 'u', passwordEnc: '', fromAddress: 'p@b.c',
      batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true,
    }]);
    const r = await service.resolveForSend('PEC');
    expect(r.host).toBe('pec.x');
    expect(r.configId).toBe('cfg2');
  });

  it('resolveForSend fallback legacy dai settings se nessuna config attiva', async () => {
    repo.findOneBy.mockResolvedValue(null);
    repo.find.mockResolvedValue([]);
    appSettings.get.mockImplementation((key: string) => {
      const map: Record<string, unknown> = {
        'smtp.host': 'legacy.smtp', 'smtp.port': 587, 'smtp.secure': false,
        'smtp.user': 'legacyuser', 'smtp.password': 'legacypass', 'smtp.from': 'legacy@x.it',
      };
      return Promise.resolve(map[key]);
    });
    const r = await service.resolveForSend('EMAIL');
    expect(r.host).toBe('legacy.smtp');
    expect(r.username).toBe('legacyuser');
    expect(r.authEnabled).toBe(true);
    expect(r.configId).toBeNull();
    expect(r.batchSize).toBe(100); // default throttling per legacy
  });
});
```

- [ ] **Step 2b: Eseguire il test — deve fallire**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.service --maxWorkers=2
```

Expected: FAIL — `Cannot find module './mail-configs.service'`.

- [ ] **Step 3: Implementare il service**

```ts
// apps/backend/src/mail-configs/mail-configs.service.ts
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailServerConfig, MailServerType } from '../entities/mail-server-config.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { MASKED_VALUE } from '../settings/settings.registry';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto';
import type { AppConfiguration } from '../config/configuration';
import type { CreateMailConfigDto, MailConfigMaskedDto, UpdateMailConfigDto } from './dto/mail-config.dto';

export interface ResolvedMailConfig {
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string;
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  configId: string | null;
}

/** Campi che, se modificati, invalidano l'esito del test precedente. */
const TEST_INVALIDATING_FIELDS: Array<keyof UpdateMailConfigDto> = [
  'host', 'port', 'secure', 'authEnabled', 'username', 'password', 'fromAddress',
];

@Injectable()
export class MailConfigsService {
  private readonly logger = new Logger(MailConfigsService.name);
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(MailServerConfig)
    private readonly repo: Repository<MailServerConfig>,
    private readonly appSettings: AppSettingsService,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  private toMasked(entity: MailServerConfig): MailConfigMaskedDto {
    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      authEnabled: entity.authEnabled,
      username: entity.username,
      password: entity.passwordEnc ? MASKED_VALUE : '',
      fromAddress: entity.fromAddress,
      batchSize: entity.batchSize,
      batchIntervalSeconds: entity.batchIntervalSeconds,
      testedAt: entity.testedAt ? entity.testedAt.toISOString() : null,
      active: entity.active,
    };
  }

  async listMasked(type?: MailServerType): Promise<MailConfigMaskedDto[]> {
    const rows = await this.repo.find({
      where: type ? { type } : {},
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toMasked(r));
  }

  async create(dto: CreateMailConfigDto): Promise<MailConfigMaskedDto> {
    const entity = this.repo.create({
      type: dto.type,
      name: dto.name,
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      authEnabled: dto.authEnabled,
      username: dto.username ?? '',
      passwordEnc: dto.password ? encryptValue(dto.password, this.cryptoKey) : '',
      fromAddress: dto.fromAddress,
      batchSize: dto.batchSize,
      batchIntervalSeconds: dto.batchIntervalSeconds,
      testedAt: null,
      active: false,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async update(id: string, dto: UpdateMailConfigDto): Promise<MailConfigMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);

    const invalidatesTest = TEST_INVALIDATING_FIELDS.some(
      (f) => dto[f] !== undefined && !(f === 'password' && dto.password === MASKED_VALUE),
    );

    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.host !== undefined) entity.host = dto.host;
    if (dto.port !== undefined) entity.port = dto.port;
    if (dto.secure !== undefined) entity.secure = dto.secure;
    if (dto.authEnabled !== undefined) entity.authEnabled = dto.authEnabled;
    if (dto.username !== undefined) entity.username = dto.username;
    if (dto.password !== undefined && dto.password !== MASKED_VALUE) {
      entity.passwordEnc = dto.password ? encryptValue(dto.password, this.cryptoKey) : '';
    }
    if (dto.fromAddress !== undefined) entity.fromAddress = dto.fromAddress;
    if (dto.batchSize !== undefined) entity.batchSize = dto.batchSize;
    if (dto.batchIntervalSeconds !== undefined) entity.batchIntervalSeconds = dto.batchIntervalSeconds;

    if (invalidatesTest) {
      entity.testedAt = null;
      entity.active = false;
    }

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException(`Configurazione ${id} non trovata`);
  }

  async setActive(id: string, active: boolean): Promise<MailConfigMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    if (active && !entity.testedAt) {
      throw new BadRequestException(
        'La configurazione non è mai stata testata con successo: eseguire prima il test.',
      );
    }
    entity.active = active;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  private decryptPassword(entity: MailServerConfig): string {
    if (!entity.passwordEnc) return '';
    try {
      return decryptValue(entity.passwordEnc, this.cryptoKey);
    } catch {
      this.logger.warn(`Password della config "${entity.name}" non decifrabile (JWT_SECRET cambiato?): reinserirla da UI.`);
      return '';
    }
  }

  async test(id: string, to: string): Promise<{ success: true; message: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    if (!to) throw new BadRequestException('Destinatario di test richiesto (campo "to")');

    const transporter = nodemailer.createTransport({
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      auth: entity.authEnabled && entity.username
        ? { user: entity.username, pass: this.decryptPassword(entity) }
        : undefined,
      tls: { rejectUnauthorized: false },
    });

    try {
      await transporter.sendMail({
        from: entity.fromAddress,
        to,
        subject: `ComunicaPA - Test configurazione ${entity.type} "${entity.name}"`,
        text: `Messaggio di test inviato da ComunicaPA per verificare la configurazione "${entity.name}" (${entity.host}:${entity.port}).`,
      });
    } catch (error: any) {
      this.logger.error(`Test ${entity.type} "${entity.name}" fallito: ${error.message}`);
      throw new BadRequestException(`Errore connessione: ${error.message}`);
    }

    entity.testedAt = new Date();
    entity.active = true;
    await this.repo.save(entity);
    return { success: true, message: 'Messaggio di test inviato: configurazione attivata.' };
  }

  async resolveForSend(type: MailServerType, mailConfigId?: string): Promise<ResolvedMailConfig> {
    if (mailConfigId) {
      const byId = await this.repo.findOneBy({ id: mailConfigId });
      if (byId && byId.type === type) {
        return this.toResolved(byId);
      }
      this.logger.warn(`mailConfigId ${mailConfigId} non trovato o tipo errato: fallback su config attiva ${type}`);
    }

    const actives = await this.repo.find({
      where: { type, active: true },
      order: { createdAt: 'ASC' },
    });
    if (actives.length > 0) {
      return this.toResolved(actives[0]);
    }

    // Fallback legacy: chiavi smtp.*/pec.* dei settings (installazioni pre-migrazione)
    const prefix = type === 'EMAIL' ? 'smtp' : 'pec';
    const username = (await this.appSettings.get<string>(`${prefix}.user` as never)) as unknown as string;
    return {
      host: (await this.appSettings.get<string>(`${prefix}.host` as never)) as unknown as string,
      port: (await this.appSettings.get<number>(`${prefix}.port` as never)) as unknown as number,
      secure: (await this.appSettings.get<boolean>(`${prefix}.secure` as never)) as unknown as boolean,
      authEnabled: !!username,
      username,
      password: (await this.appSettings.get<string>(`${prefix}.password` as never)) as unknown as string,
      fromAddress: (await this.appSettings.get<string>(`${prefix}.from` as never)) as unknown as string,
      batchSize: 100,
      batchIntervalSeconds: 60,
      configId: null,
    };
  }

  private toResolved(entity: MailServerConfig): ResolvedMailConfig {
    return {
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      authEnabled: entity.authEnabled,
      username: entity.username,
      password: this.decryptPassword(entity),
      fromAddress: entity.fromAddress,
      batchSize: entity.batchSize,
      batchIntervalSeconds: entity.batchIntervalSeconds,
      configId: entity.id,
    };
  }
}
```

Nota sui cast `as never`: le chiavi `smtp.*`/`pec.*` sono `SettingKey` valide del registry; il cast serve solo perché il template literal non è narrowabile. In alternativa tipizzare le sei chiavi esplicitamente:

```ts
const key = (suffix: string) => `${prefix}.${suffix}` as SettingKey;
```

usando `import type { SettingKey } from '../settings/settings.registry';` — preferire questa forma.

- [ ] **Step 4: Creare il modulo globale e registrarlo**

```ts
// apps/backend/src/mail-configs/mail-configs.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { MailConfigsService } from './mail-configs.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailServerConfig])],
  providers: [MailConfigsService],
  exports: [MailConfigsService],
})
export class MailConfigsModule {}
```

In `apps/backend/src/app.module.ts` aggiungere `MailConfigsModule` all'array `imports` (import da `./mail-configs/mail-configs.module`).

- [ ] **Step 5: Eseguire i test — devono passare**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.service --maxWorkers=2
```

Expected: PASS (8 test).

- [ ] **Step 6: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/mail-configs apps/backend/src/app.module.ts
git commit -m "feat(backend): MailConfigsService con cifratura, test-attivazione e fallback legacy"
```

---

### Task 3: `MailConfigsController` — REST

**Files:**
- Create: `apps/backend/src/mail-configs/mail-configs.controller.ts`
- Modify: `apps/backend/src/mail-configs/mail-configs.module.ts` (aggiungere controller)
- Test: `apps/backend/src/mail-configs/mail-configs.controller.spec.ts`

**Interfaces:**
- Consumes: `MailConfigsService` (task 2).
- Produces: route REST come da contratto (GET list per roles user+admin, mutazioni admin).

- [ ] **Step 1: Scrivere il test del controller (failing)**

```ts
// apps/backend/src/mail-configs/mail-configs.controller.spec.ts
import { Test } from '@nestjs/testing';
import { MailConfigsController } from './mail-configs.controller';
import { MailConfigsService } from './mail-configs.service';

describe('MailConfigsController', () => {
  let controller: MailConfigsController;
  const svc = {
    listMasked: jest.fn().mockResolvedValue([{ id: '1' }]),
    create: jest.fn().mockResolvedValue({ id: '2' }),
    update: jest.fn().mockResolvedValue({ id: '1' }),
    remove: jest.fn().mockResolvedValue(undefined),
    test: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    setActive: jest.fn().mockResolvedValue({ id: '1', active: false }),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [MailConfigsController],
      providers: [{ provide: MailConfigsService, useValue: svc }],
    }).compile();
    controller = module.get(MailConfigsController);
  });

  it('GET lista filtra per tipo', async () => {
    const res = await controller.list('EMAIL');
    expect(svc.listMasked).toHaveBeenCalledWith('EMAIL');
    expect(res).toEqual({ configs: [{ id: '1' }] });
  });

  it('POST /:id/test delega al service', async () => {
    const res = await controller.test('abc', { to: 'x@y.it' });
    expect(svc.test).toHaveBeenCalledWith('abc', 'x@y.it');
    expect(res.success).toBe(true);
  });

  it('PATCH /:id/active delega al service', async () => {
    await controller.setActive('abc', { active: false });
    expect(svc.setActive).toHaveBeenCalledWith('abc', false);
  });
});
```

Run: `docker compose exec backend node_modules/.bin/jest mail-configs.controller --maxWorkers=2` → Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementare il controller**

```ts
// apps/backend/src/mail-configs/mail-configs.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { MailConfigsService } from './mail-configs.service';
import { CreateMailConfigDto, UpdateMailConfigDto } from './dto/mail-config.dto';
import type { MailServerType } from '../entities/mail-server-config.entity';

@Controller('mail-configs')
export class MailConfigsController {
  constructor(private readonly svc: MailConfigsService) {}

  /** Lista mascherata: serve anche agli operatori (wizard: scelta mittente). */
  @Get()
  @Roles('user', 'admin')
  async list(@Query('type') type?: string) {
    if (type && type !== 'EMAIL' && type !== 'PEC') {
      throw new BadRequestException('type deve essere EMAIL o PEC');
    }
    return { configs: await this.svc.listMasked(type as MailServerType | undefined) };
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateMailConfigDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMailConfigDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: { to: string }) {
    return this.svc.test(id, body?.to ?? '');
  }

  @Patch(':id/active')
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() body: { active: boolean }) {
    if (typeof body?.active !== 'boolean') {
      throw new BadRequestException('Campo "active" booleano richiesto');
    }
    return this.svc.setActive(id, body.active);
  }
}
```

Registrare in `mail-configs.module.ts`: `controllers: [MailConfigsController]`.

- [ ] **Step 3: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs --maxWorkers=2
```

Expected: PASS (service + controller).

- [ ] **Step 4: Verifica end-to-end via curl (dev)**

```bash
TOKEN=$(docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))" | tr -d '\r')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/mail-configs
```

Expected: `{"configs":[]}`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/mail-configs
git commit -m "feat(backend): REST /mail-configs con test-attivazione e toggle"
```

---

### Task 4: Strategie EMAIL/PEC su configurazione dinamica

**Files:**
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Modify: `apps/backend/src/channels/channel.module.ts` (nessun import extra necessario: `MailConfigsModule` è `@Global`, verificare soltanto)
- Test: `apps/backend/src/channels/email/email.strategy.spec.ts`, `apps/backend/src/channels/pec/pec.strategy.spec.ts` (già in baseline FAIL — aggiornare il provider mock, senza obbligo di sistemare i fallimenti preesistenti)

**Interfaces:**
- Consumes: `MailConfigsService.resolveForSend(type, mailConfigId?)` (task 2).
- Produces: le strategie leggono `campaign.channelConfig.mailConfigId`; `from` = `fromAddress` della config risolta (il `from` in channelConfig resta come override legacy).

- [ ] **Step 1: Modificare `email.strategy.ts`**

Sostituire il blocco di lettura settings (righe 28-33) e la creazione transporter (righe 49-60) con:

```ts
// constructor: aggiungere il service
constructor(
  private readonly config: ConfigService<AppConfiguration, true>,
  private readonly settings: AppSettingsService,
  private readonly mailConfigs: MailConfigsService,
) {}
```

```ts
// dentro send(), al posto delle 6 get smtp.*:
const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
const smtp = await this.mailConfigs.resolveForSend('EMAIL', mailConfigId);
```

```ts
// transporter
const transporter = nodemailer.createTransport({
  host: smtp.host,
  port: smtp.port,
  secure: smtp.secure,
  auth: smtp.authEnabled && smtp.username
    ? { user: smtp.username, pass: smtp.password }
    : undefined,
  tls: {
    rejectUnauthorized: false,
  },
});

const info = (await transporter.sendMail({
  from: (campaign.channelConfig?.['from'] as string) || smtp.fromAddress,
  to: recipient.email,
  subject,
  text: bodyText,
  html: bodyHtml,
})) as any;
```

Import: `import { MailConfigsService } from '../../mail-configs/mail-configs.service';`

- [ ] **Step 2: Stessa modifica su `pec.strategy.ts`** con `resolveForSend('PEC', mailConfigId)`.

- [ ] **Step 3: Aggiornare gli spec delle strategie**

In `email.strategy.spec.ts` e `pec.strategy.spec.ts` aggiungere il provider mock al `Test.createTestingModule`:

```ts
{
  provide: MailConfigsService,
  useValue: {
    resolveForSend: jest.fn().mockResolvedValue({
      host: 'localhost', port: 587, secure: false,
      authEnabled: false, username: '', password: '',
      fromAddress: 'noreply@test.local', batchSize: 100,
      batchIntervalSeconds: 60, configId: null,
    }),
  },
},
```

- [ ] **Step 4: Eseguire i test e confrontare col baseline**

```bash
docker compose exec backend node_modules/.bin/jest "strategy" --maxWorkers=2
```

Expected: nessun NUOVO fallimento rispetto al baseline (i fallimenti preesistenti su template vecchi possono restare). Se l'aggiornamento del mock li fa passare, meglio.

- [ ] **Step 5: Verifica funzionale invio senza autenticazione**

Creare via curl una config EMAIL con `authEnabled: false` puntata a un SMTP di test (es. mailserver locale), testarla con `POST /mail-configs/:id/test`, poi invio singolo dalla UI. Expected: mail consegnata, nessun errore auth.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels
git commit -m "feat(backend): strategie EMAIL/PEC risolvono la config mittente da mailConfigId"
```

---

### Task 5: Un motore (coda + worker) dedicato per ogni canale

**Files:**
- Modify: `apps/backend/src/queue/notification-job.types.ts`
- Modify: `apps/backend/src/queue/queue.module.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts` (diventa classe base `@Injectable`, perde `@Processor`)
- Create: `apps/backend/src/queue/channel-processors.ts`
- Create: `apps/backend/src/queue/notification-queues.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (launch → coda del canale)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`, `apps/backend/src/queue/notification.processor.spec.ts` (solo aggiornamento provider/mock)

**Interfaces:**
- Consumes: `NOTIFICATION_JOB_SEND` esistente.
- Produces: `CHANNEL_QUEUES` e `NotificationQueuesService` come da contratto in testa al piano. La costante `NOTIFICATION_QUEUE = 'notifications'` viene RIMOSSA (i job eventualmente pendenti nella vecchia coda vanno persi: accettato, rilanciare le campagne in corso in dev).

- [ ] **Step 1: Definire le code per canale**

In `notification-job.types.ts`:

```ts
import type { NotificationChannel } from '@comunicapa/shared-types';

export const NOTIFICATION_JOB_SEND = 'send';

/** Una coda BullMQ dedicata per ogni canale: motori indipendenti, pausabili singolarmente. */
export const CHANNEL_QUEUES: Record<NotificationChannel, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  SEND: 'notifications-send',
  POSTAL: 'notifications-postal',
};

export const ALL_CHANNELS = Object.keys(CHANNEL_QUEUES) as NotificationChannel[];
```

(rimuovere `NOTIFICATION_QUEUE`).

- [ ] **Step 2: Trasformare il processor in classe base**

In `notification.processor.ts`: togliere `@Processor(NOTIFICATION_QUEUE)` e sostituirlo con `@Injectable()`. La classe resta concreta (NON `abstract`: lo spec esistente la istanzia via testing module) ma non viene più registrata come provider dell'app — lavorano solo le 5 sottoclassi. Nessun'altra modifica alla logica.

Creare `channel-processors.ts`:

```ts
// apps/backend/src/queue/channel-processors.ts
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

@Processor(CHANNEL_QUEUES.SEND)
export class SendNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.POSTAL)
export class PostalNotificationProcessor extends NotificationProcessor {}
```

- [ ] **Step 3: Service router delle code**

```ts
// apps/backend/src/queue/notification-queues.service.ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { NotificationChannel, NotificationJobData } from '@comunicapa/shared-types';
import { CHANNEL_QUEUES } from './notification-job.types';

@Injectable()
export class NotificationQueuesService {
  private readonly queues: Map<NotificationChannel, Queue<NotificationJobData>>;

  constructor(
    @InjectQueue(CHANNEL_QUEUES.EMAIL) emailQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.PEC) pecQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.APP_IO) appIoQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.SEND) sendQueue: Queue<NotificationJobData>,
    @InjectQueue(CHANNEL_QUEUES.POSTAL) postalQueue: Queue<NotificationJobData>,
  ) {
    this.queues = new Map([
      ['EMAIL', emailQueue],
      ['PEC', pecQueue],
      ['APP_IO', appIoQueue],
      ['SEND', sendQueue],
      ['POSTAL', postalQueue],
    ]);
  }

  getQueue(channel: NotificationChannel): Queue<NotificationJobData> {
    const queue = this.queues.get(channel);
    if (!queue) throw new Error(`Nessuna coda registrata per il canale ${channel}`);
    return queue;
  }

  addBulk(channel: NotificationChannel, jobs: Array<{ name: string; data: NotificationJobData }>) {
    return this.getQueue(channel).addBulk(jobs);
  }

  getJobCounts(channel: NotificationChannel): Promise<Record<string, number>> {
    return this.getQueue(channel).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed') as Promise<Record<string, number>>;
  }

  isPaused(channel: NotificationChannel): Promise<boolean> {
    return this.getQueue(channel).isPaused();
  }

  pause(channel: NotificationChannel): Promise<void> {
    return this.getQueue(channel).pause();
  }

  resume(channel: NotificationChannel): Promise<void> {
    return this.getQueue(channel).resume();
  }
}
```

- [ ] **Step 4: Aggiornare `queue.module.ts`**

```ts
BullModule.registerQueue(
  ...Object.values(CHANNEL_QUEUES).map((name) => ({ name })),
),
```

e nei providers sostituire `NotificationProcessor` con le 5 sottoclassi + `NotificationQueuesService`:

```ts
providers: [
  EmailNotificationProcessor,
  PecNotificationProcessor,
  AppIoNotificationProcessor,
  SendNotificationProcessor,
  PostalNotificationProcessor,
  NotificationQueuesService,
],
exports: [BullModule, NotificationQueuesService],
```

- [ ] **Step 5: `campaigns.service.ts` accoda sulla coda del canale**

Sostituire l'iniezione `@InjectQueue(NOTIFICATION_QUEUE) private readonly notificationsQueue: Queue<NotificationJobData>` con `private readonly notificationQueues: NotificationQueuesService` (import da `../queue/notification-queues.service`), e nel `launch()`:

```ts
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
  })),
);
```

- [ ] **Step 6: Aggiornare gli spec**

- `campaigns.service.spec.ts`: sostituire il provider `getQueueToken(NOTIFICATION_QUEUE)` con `{ provide: NotificationQueuesService, useValue: { addBulk: jest.fn() } }` e adattare le assert sull'accodamento (`expect(queuesMock.addBulk).toHaveBeenCalledWith('EMAIL', expect.any(Array))`).
- `notification.processor.spec.ts`: la classe base non è più `@Processor` ma il test la istanzia via testing module come prima — nessun cambio di token; verificare solo che compili.

- [ ] **Step 7: Eseguire i test e verificare l'avvio**

```bash
docker compose exec backend node_modules/.bin/jest "campaigns.service|notification.processor" --maxWorkers=2
docker compose restart backend && docker compose logs --tail=30 backend
```

Expected: nessun nuovo fallimento; nei log nessun errore di DI; lancio di una campagna EMAIL di prova accoda su `notifications-email` (verificabile con `docker compose exec redis redis-cli keys "bull:notifications-email:*"`).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/queue apps/backend/src/campaigns
git commit -m "feat(backend): coda e worker BullMQ dedicati per ogni canale di invio"
```

---

### Task 6: Throttling per configurazione nel processor

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Modify: `apps/backend/src/queue/queue.module.ts` (provider Redis)
- Test: `apps/backend/src/queue/notification.processor.spec.ts` (baseline FAIL: aggiungere i nuovi provider mock, non introdurre nuovi fallimenti)

**Interfaces:**
- Consumes: `MailConfigsService.resolveForSend` (task 2).
- Produces: token DI `THROTTLE_REDIS` (ioredis `Redis`); job EMAIL/PEC oltre soglia vengono rimandati alla finestra successiva con `job.moveToDelayed` + `DelayedError`.

- [ ] **Step 1: Provider Redis in `queue.module.ts`**

```ts
import Redis from 'ioredis';

export const THROTTLE_REDIS = 'THROTTLE_REDIS';

// aggiungere all'array providers del modulo (accanto ai 5 processor e a NotificationQueuesService):
{
  provide: THROTTLE_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfiguration, true>) =>
    new Redis(config.get('redis.url', { infer: true }), { maxRetriesPerRequest: null }),
},
```

(esportare la costante `THROTTLE_REDIS` dal modulo o da `notification-job.types.ts` — metterla in `notification-job.types.ts` per evitare import circolari).

- [ ] **Step 2: Logica di throttling nel processor**

In `notification.processor.ts`:

```ts
import { DelayedError } from 'bullmq';
import type Redis from 'ioredis';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { THROTTLE_REDIS } from './notification-job.types';

// constructor: aggiungere
@Inject(THROTTLE_REDIS) private readonly redis: Redis,
private readonly mailConfigs: MailConfigsService,
```

La firma di `process` diventa `async process(job: Job<NotificationJobData>, token?: string): Promise<void>`.

Subito DOPO il caricamento di `campaign` (riga ~51) e PRIMA di `attemptRepo.update(attemptId, PROCESSING)` — spostare quell'update dopo il throttle:

```ts
// Throttling per configurazione mittente (solo canali mail)
if (channel === 'EMAIL' || channel === 'PEC') {
  const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
  const resolved = await this.mailConfigs.resolveForSend(channel, mailConfigId);
  const windowMs = resolved.batchIntervalSeconds * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const throttleKey = `comunicapa:throttle:${channel}:${resolved.configId ?? 'legacy'}:${windowStart}`;

  const count = await this.redis.incr(throttleKey);
  if (count === 1) {
    await this.redis.pexpire(throttleKey, windowMs * 2);
  }
  if (count > resolved.batchSize) {
    // Batch pieno: rimanda il job all'inizio della finestra successiva.
    // Decrementa: questo job non consuma quota in questa finestra.
    await this.redis.decr(throttleKey);
    this.logger.log(
      `Throttle ${channel} (${resolved.configId ?? 'legacy'}): batch ${resolved.batchSize} pieno, job ${job.id} rimandato`,
    );
    await job.moveToDelayed(windowStart + windowMs, token);
    throw new DelayedError();
  }
}

await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });
```

ATTENZIONE: rimuovere il vecchio `await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });` che oggi sta PRIMA del caricamento del recipient (riga 41) — il caricamento recipient/campaign va fatto prima del throttle, quindi il nuovo ordine è: load recipient → load campaign → throttle → update PROCESSING → strategy lookup → invio.

`DelayedError` deve propagarsi intatta: BullMQ la riconosce e NON conta il job come fallito. Non catturarla nei try/catch del processor.

- [ ] **Step 3: Aggiornare `notification.processor.spec.ts`**

Aggiungere ai provider del testing module:

```ts
{ provide: THROTTLE_REDIS, useValue: { incr: jest.fn().mockResolvedValue(1), decr: jest.fn(), pexpire: jest.fn() } },
{
  provide: MailConfigsService,
  useValue: {
    resolveForSend: jest.fn().mockResolvedValue({
      host: 'h', port: 587, secure: false, authEnabled: false, username: '',
      password: '', fromAddress: 'n@t.it', batchSize: 100,
      batchIntervalSeconds: 60, configId: null,
    }),
  },
},
```

Aggiungere un test nuovo:

```ts
it('rimanda il job con DelayedError quando il batch è pieno', async () => {
  // mock redis.incr oltre soglia
  redisMock.incr.mockResolvedValue(101);
  const job = {
    id: '1', attemptsMade: 0, token: 'tok',
    data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'a1', channel: 'EMAIL' },
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  } as any;
  // recipientRepo/campaignRepo mock devono risolvere entità valide (riusare i mock esistenti dello spec)
  await expect(processor.process(job, 'tok')).rejects.toThrow(DelayedError);
  expect(job.moveToDelayed).toHaveBeenCalled();
  expect(redisMock.decr).toHaveBeenCalled();
});
```

- [ ] **Step 4: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2
```

Expected: il nuovo test PASSA; i fallimenti preesistenti dello spec non aumentano.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/queue
git commit -m "feat(backend): throttling invii per config mittente (batch su finestra Redis)"
```

---

### Task 7: Modalità App IO (`none`/`parallel`/`exclusive`) nel processor

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Test: `apps/backend/src/queue/notification.processor.spec.ts`

**Interfaces:**
- Consumes: `campaign.channelConfig.appIo` con nuovo campo `mode`.
- Produces: comportamento — `parallel`: come oggi (co-delivery al primo tentativo); `exclusive`: se il CF ha profilo App IO attivo, invia SOLO App IO e salta il canale primario; retrocompat: `appIo` presente senza `mode` = `parallel`; `appIo` assente = nessuna co-delivery.

- [ ] **Step 1: Estrarre helper `sendAppIoMessage`**

Nel processor, estrarre l'attuale corpo dell'invio App IO (righe 82-125) in:

```ts
private async sendAppIoMessage(
  campaign: Campaign,
  recipient: Recipient,
  appIoConfig: { apiKey: string; baseUrl: string },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const processedSubject = processTemplate(
      (campaign.channelConfig?.['subject'] as string) || campaign.name,
      recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix,
    );
    const processedMarkdown = processTemplate(
      (campaign.channelConfig?.['body'] as string) || '',
      recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix,
    );

    const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
      body: JSON.stringify({
        fiscal_code: recipient.codiceFiscale,
        content: { subject: processedSubject, markdown: processedMarkdown },
      }),
    });

    if (!appIoRes.ok) {
      return { success: false, error: `App IO status: ${appIoRes.status}` };
    }
    const appIoData = (await appIoRes.json()) as { id: string };
    return { success: true, messageId: appIoData.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
```

- [ ] **Step 2: Ristrutturare `process()` attorno alle modalità**

Dopo il blocco throttling/PROCESSING del task 5, sostituire i blocchi 1-2 attuali con:

```ts
const appIoConfig = campaign.channelConfig?.['appIo'] as
  | { mode?: 'parallel' | 'exclusive'; apiKey?: string; baseUrl?: string }
  | undefined;
// Retrocompat: config appIo presente senza mode = parallel
const appIoMode: 'none' | 'parallel' | 'exclusive' =
  appIoConfig?.apiKey ? (appIoConfig.mode ?? 'parallel') : 'none';
const isMailChannel = channel === 'EMAIL' || channel === 'PEC';

const responsePayload: Record<string, any> = {};
let appIoLinkDelivered = false;
let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
let primaryError: Error | undefined;
let skipPrimary = false;

// Modalità ESCLUSIVA: se il destinatario ha App IO, si invia SOLO lì.
if (appIoMode === 'exclusive' && isMailChannel && job.attemptsMade === 0) {
  const hasAppIo = await this.checkAppIoProfile(
    appIoConfig!.baseUrl!, appIoConfig!.apiKey!, recipient.codiceFiscale,
  );
  if (hasAppIo) {
    const appIoResult = await this.sendAppIoMessage(campaign, recipient, appIoConfig as { apiKey: string; baseUrl: string });
    responsePayload.appIo = appIoResult;
    if (appIoResult.success) {
      skipPrimary = true;
      appIoLinkDelivered = true;
      responsePayload.messageId = appIoResult.messageId;
      responsePayload.deliveredVia = 'APP_IO';
      this.logger.log(`Consegna esclusiva App IO per CF ${recipient.codiceFiscale}: canale ${channel} saltato`);
    }
    // App IO fallita ⇒ si prosegue col canale primario (fallback)
  }
}

// 1. Invio canale primario (saltato solo in esclusiva riuscita)
if (!skipPrimary) {
  try {
    primaryResult = await strategy.send(recipient, campaign);
  } catch (err: any) {
    primaryError = err instanceof Error ? err : new Error(String(err));
  }
  Object.assign(responsePayload, primaryResult?.responsePayload || {});
  responsePayload.messageId = primaryResult?.messageId;

  // 2. Co-delivery PARALLELA (comportamento attuale, solo primo tentativo)
  if (appIoMode === 'parallel' && isMailChannel && job.attemptsMade === 0) {
    const hasAppIo = await this.checkAppIoProfile(
      appIoConfig!.baseUrl!, appIoConfig!.apiKey!, recipient.codiceFiscale,
    );
    if (hasAppIo) {
      this.logger.log(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
      const appIoResult = await this.sendAppIoMessage(campaign, recipient, appIoConfig as { apiKey: string; baseUrl: string });
      responsePayload.appIo = appIoResult;
      if (appIoResult.success) appIoLinkDelivered = true;
    }
  }
}
```

Il blocco 3 (esiti) resta invariato: in esclusiva riuscita `primaryError` è `undefined` → percorso SUCCESS.

Nota `strategy`: il lookup `this.strategies.get(channel)` può restare dov'è (prima del blocco); il throw per strategy mancante resta invariato.

- [ ] **Step 3: Test nuovi nello spec**

```ts
it('exclusive: se il CF ha App IO invia solo App IO e non chiama la strategy', async () => {
  // campaignRepo mock: channelConfig.appIo = { mode: 'exclusive', apiKey: 'k', baseUrl: 'http://io' }
  // mock globale fetch: /profiles → { sender_allowed: true }; /messages → { id: 'io-1' }
  await processor.process(jobMock, 'tok');
  expect(strategyMock.send).not.toHaveBeenCalled();
  // attemptRepo.update chiamato con SUCCESS e responsePayload.deliveredVia === 'APP_IO'
});

it('exclusive: se il CF NON ha App IO usa il canale primario', async () => {
  // /profiles → { sender_allowed: false }
  await processor.process(jobMock, 'tok');
  expect(strategyMock.send).toHaveBeenCalled();
});

it('appIo assente: nessuna chiamata a fetch App IO', async () => {
  await processor.process(jobMock, 'tok');
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/profiles'), expect.anything());
});
```

(adattare ai mock esistenti dello spec; `global.fetch = jest.fn()` come pattern).

- [ ] **Step 4: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2
```

Expected: i 3 test nuovi passano, nessun nuovo fallimento.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/queue
git commit -m "feat(backend): modalità App IO none/parallel/exclusive nel processor"
```

---

### Task 8: Template HTML — logo ente e footer col portale pubblico

**Files:**
- Modify: `apps/backend/src/channels/template.helper.ts`
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Test: `apps/backend/src/channels/template.helper.spec.ts`

**Interfaces:**
- Consumes: settings `brand.logo`, `system.publicUrl`, `system.citizenPublicUrl`.
- Produces: `wrapInHtmlLayout(bodyContent, brandName, options?: { logoUrl?: string | null; portalUrl?: string | null })`.

- [ ] **Step 1: Test failing su `template.helper.spec.ts`** (aggiungere in coda al describe esistente)

```ts
describe('wrapInHtmlLayout con logo e portale', () => {
  it('inserisce il logo quando logoUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { logoUrl: 'https://ente.it/api/branding/logo' });
    expect(html).toContain('<img src="https://ente.it/api/branding/logo"');
    expect(html).toContain('alt="Comune Test"');
  });

  it('non inserisce img senza logoUrl', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('<img');
  });

  it('inserisce il link al portale nel footer quando portalUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { portalUrl: 'https://portale.ente.it' });
    expect(html).toContain('href="https://portale.ente.it"');
    expect(html).toContain('Portale del Cittadino');
  });

  it('senza portalUrl il footer resta quello standard', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('Portale del Cittadino');
  });
});
```

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2` → Expected: FAIL (4 nuovi test).

- [ ] **Step 2: Implementare**

Sostituire `wrapInHtmlLayout` in `template.helper.ts`:

```ts
export interface HtmlLayoutOptions {
  /** URL assoluto del logo ente (già risolto dal chiamante). */
  logoUrl?: string | null;
  /** URL del portale pubblico cittadini per il footer. */
  portalUrl?: string | null;
}

/**
 * Wraps body content in a standard styled HTML template mimicking the GovPay brand design.
 */
export function wrapInHtmlLayout(
  bodyContent: string,
  brandName: string,
  options: HtmlLayoutOptions = {},
): string {
  // Convert newlines to HTML line breaks
  const formattedContent = bodyContent.replace(/\n/g, '<br />');

  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" alt="${brandName}" style="max-height: 48px; max-width: 180px; vertical-align: middle; margin-right: 12px;" />`
    : '';

  const portalHtml = options.portalUrl
    ? `<br />Consulta le tue comunicazioni sul <a href="${options.portalUrl}" style="color: #0066cc; font-weight: bold;">Portale del Cittadino</a>.`
    : '';

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
  <div style="background-color: #0066cc; padding: 24px; color: white; display: flex; align-items: center; justify-content: space-between;">
    <div style="font-size: 1.25rem; font-weight: bold; letter-spacing: -0.025em;">${logoHtml}${brandName}</div>
    <div style="font-size: 0.875rem; opacity: 0.9; font-weight: 500;">ComunicaPA</div>
  </div>
  <div style="padding: 32px 24px; color: #1a202c; line-height: 1.6; font-size: 0.95rem; background-color: #ffffff;">
    ${formattedContent}
  </div>
  <div style="background-color: #f7fafc; padding: 20px 24px; font-size: 0.775rem; color: #718096; text-align: center; border-top: 1px solid #edf2f7;">
    Questa è una comunicazione ufficiale inviata da <strong>ComunicaPA</strong> per conto di <strong>${brandName}</strong>.<br />
    Si prega di non rispondere direttamente a questa e-mail.${portalHtml}
  </div>
</div>
  `;
}
```

- [ ] **Step 3: Passare le opzioni dalle strategie**

In `email.strategy.ts` e `pec.strategy.ts`, dopo la lettura di `publicApiUrl`:

```ts
const brandLogo = await this.settings.get<string>('brand.logo');
const logoUrl = brandLogo
  ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`)
  : null;
const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;
// ...
const bodyHtml = wrapInHtmlLayout(bodyText, brandName, { logoUrl, portalUrl });
```

- [ ] **Step 4: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2
```

Expected: PASS (test preesistenti + 4 nuovi).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels
git commit -m "feat(backend): logo ente e link portale cittadino nel layout email/PEC"
```

---

### Task 9: Allegati — supporto ZIP e scarto dei file non mappati

**Files:**
- Modify: `apps/backend/package.json` (dipendenza `adm-zip` + `@types/adm-zip`)
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (fileFilter + risposta)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (nuovo metodo `finalizeAttachments`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts` (aggiungere describe)

**Interfaces:**
- Consumes: `resolveCustomAttachmentFilename` da `../attachments/attachment.service`; `getUploadsDir` da `../attachments/attachment-paths`.
- Produces: `POST /campaigns/:id/attachments` → `{ uploaded, discarded, campaignId }`; `CampaignsService.finalizeAttachments(campaignId: string, files: Express.Multer.File[]): Promise<{ uploaded: number; discarded: number }>`.

- [ ] **Step 1: Aggiungere la dipendenza (procedura obbligatoria pnpm/Docker)**

Aggiungere in `apps/backend/package.json`: `"adm-zip": "^0.5.16"` in `dependencies`, `"@types/adm-zip": "^0.5.5"` in `devDependencies`. Poi:

```bash
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build backend
docker compose rm -sf backend && docker volume rm comunicapa_backend_node_modules && docker compose up -d backend
```

Verifica: `docker compose exec backend node -e "require('adm-zip'); console.log('ok')"` → Expected: `ok`.

- [ ] **Step 2: Test failing su `finalizeAttachments`** (in `campaigns.service.spec.ts`, nuovo describe; usare directory temporanea)

```ts
import * as fs from 'fs';
import { join } from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

describe('finalizeAttachments', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-att-'));
    // Il service usa getUploadsDir(campaignId): mockare il modulo attachment-paths
    // In testa al file spec (fuori dal describe):
    // jest.mock('../attachments/attachment-paths', () => ({
    //   getUploadsDir: jest.fn(() => tmpDirRef.dir),
    // }));
    // con const tmpDirRef = { dir: '' } aggiornato qui: tmpDirRef.dir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('estrae i PDF da uno zip e rimuove lo zip', async () => {
    const zip = new AdmZip();
    zip.addFile('avviso_A.pdf', Buffer.from('%PDF-1.4 A'));
    zip.addFile('cartella/avviso_B.pdf', Buffer.from('%PDF-1.4 B'));
    zip.addFile('leggimi.txt', Buffer.from('ignorami'));
    const zipPath = join(tmpDir, 'lotto.zip');
    zip.writeZip(zipPath);

    // recipients: extraData con allegato mappato per entrambi
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
    recipientRepoMock.find.mockResolvedValue([
      { extraData: { allegato: 'avviso_A.pdf' } },
      { extraData: { allegato: 'avviso_B.pdf' } },
    ]);

    const result = await service.finalizeAttachments('c1', [
      { path: zipPath, originalname: 'lotto.zip' } as any,
    ]);

    expect(fs.existsSync(join(tmpDir, 'avviso_A.pdf'))).toBe(true);
    expect(fs.existsSync(join(tmpDir, 'avviso_B.pdf'))).toBe(true); // appiattito, niente sottocartelle
    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.existsSync(join(tmpDir, 'leggimi.txt'))).toBe(false);
    expect(result.uploaded).toBe(2);
    expect(result.discarded).toBe(0);
  });

  it('scarta i PDF non referenziati da alcun destinatario', async () => {
    for (const name of ['ok1.pdf', 'ok2.pdf', 'orfano1.pdf', 'orfano2.pdf']) {
      fs.writeFileSync(join(tmpDir, name), '%PDF');
    }
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
    recipientRepoMock.find.mockResolvedValue([
      { extraData: { allegato: 'ok1.pdf' } },
      { extraData: { allegato: 'ok2.pdf' } },
    ]);

    const result = await service.finalizeAttachments('c1', []);

    expect(result.uploaded).toBe(2);
    expect(result.discarded).toBe(2);
    expect(fs.existsSync(join(tmpDir, 'orfano1.pdf'))).toBe(false);
    expect(fs.existsSync(join(tmpDir, 'ok1.pdf'))).toBe(true);
  });

  it('se nessun destinatario referenzia allegati NON scarta nulla (safety)', async () => {
    fs.writeFileSync(join(tmpDir, 'x.pdf'), '%PDF');
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: {} });
    recipientRepoMock.find.mockResolvedValue([{ extraData: { nota: 'senza pdf' } }]);

    const result = await service.finalizeAttachments('c1', []);
    expect(result.discarded).toBe(0);
    expect(fs.existsSync(join(tmpDir, 'x.pdf'))).toBe(true);
  });
});
```

(adattare i nomi dei mock repo a quelli già presenti nello spec; il mock di `attachment-paths` va dichiarato a livello modulo con `jest.mock`).

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2` → Expected: FAIL (`finalizeAttachments is not a function`).

- [ ] **Step 3: Implementare `finalizeAttachments` in `campaigns.service.ts`**

```ts
import * as fs from 'fs';
import { basename, join } from 'path';
import AdmZip from 'adm-zip';
import { getUploadsDir } from '../attachments/attachment-paths';
import { resolveCustomAttachmentFilename } from '../attachments/attachment.service';

// metodo nuovo nella classe:
/**
 * Post-processing degli allegati caricati:
 * 1. estrae i PDF dagli eventuali .zip (appiattendo i path) e rimuove gli zip;
 * 2. elimina i PDF non referenziati da alcun destinatario (extraData/allegatoKey).
 * Safety: se NESSUN destinatario referenzia un allegato, non scarta nulla
 * (evita di svuotare la cartella in flussi senza mappatura allegato).
 */
async finalizeAttachments(
  campaignId: string,
  files: Express.Multer.File[],
): Promise<{ uploaded: number; discarded: number }> {
  const dir = getUploadsDir(campaignId);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Estrazione ZIP
  for (const file of files) {
    if (!file.originalname.toLowerCase().endsWith('.zip')) continue;
    const zip = new AdmZip(file.path);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = basename(entry.entryName); // neutralizza path traversal
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      fs.writeFileSync(join(dir, name), entry.getData());
    }
    fs.unlinkSync(file.path);
  }

  // 2. Set dei filename referenziati dai destinatari
  const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
  if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
  const recipients = await this.recipientRepo.find({
    where: { campaignId },
    select: ['extraData'],
  });
  const referenced = new Set<string>();
  for (const r of recipients) {
    const filename = resolveCustomAttachmentFilename({
      campaign,
      extraData: r.extraData,
    } as unknown as Recipient);
    if (filename) referenced.add(filename);
  }

  // 3. Scarto dei non referenziati (solo se c'è almeno un riferimento)
  let discarded = 0;
  const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (referenced.size > 0) {
    for (const f of present) {
      if (!referenced.has(f)) {
        fs.unlinkSync(join(dir, f));
        discarded++;
      }
    }
  }

  const uploaded = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  return { uploaded, discarded };
}
```

- [ ] **Step 4: Aggiornare il controller**

In `campaigns.controller.ts`, nel `FilesInterceptor` di `uploadAttachments`:

```ts
fileFilter: (_req, file, cb) => {
  const name = file.originalname.toLowerCase();
  const ok =
    file.mimetype === 'application/pdf' || name.endsWith('.pdf') ||
    file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || name.endsWith('.zip');
  cb(null, ok);
},
```

E il corpo dell'handler dopo `assertDraftForAttachments`:

```ts
const result = await this.campaignsService.finalizeAttachments(id, files ?? []);
return {
  uploaded: result.uploaded,
  discarded: result.discarded,
  campaignId: id,
};
```

- [ ] **Step 5: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2
```

Expected: i 3 test nuovi passano, nessun nuovo fallimento nella suite campaigns.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml apps/backend/src/campaigns
git commit -m "feat(backend): allegati zip estratti e scarto dei PDF non mappati"
```

---

### Task 10: UI Impostazioni — gestione N configurazioni Mail/PEC

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: REST `/mail-configs` (task 3).
- Produces: stato React `mailConfigs: MailConfigItem[]` + funzione `fetchMailConfigs()` riusati dal task 12 (wizard).

- [ ] **Step 1: Tipo e stato**

Vicino agli altri tipi in testa a `App.tsx` (dopo `IoService`):

```ts
type MailConfigItem = {
  id: string;
  type: 'EMAIL' | 'PEC';
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string;
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  testedAt: string | null;
  active: boolean;
};

const EMPTY_MAIL_CONFIG: Omit<MailConfigItem, 'id' | 'testedAt' | 'active'> = {
  type: 'EMAIL', name: '', host: '', port: 587, secure: false,
  authEnabled: true, username: '', password: '', fromAddress: '',
  batchSize: 100, batchIntervalSeconds: 60,
};
```

Stati nel componente `App` (vicino agli stati settings, ~riga 230):

```ts
// Configurazioni mail/PEC multiple (tabella mail_server_configs)
const [mailConfigs, setMailConfigs] = useState<MailConfigItem[]>([]);
const [editingMailConfig, setEditingMailConfig] = useState<(Partial<MailConfigItem> & { type: 'EMAIL' | 'PEC' }) | null>(null);
const [mailConfigTestTo, setMailConfigTestTo] = useState('');
const [mailConfigBusyId, setMailConfigBusyId] = useState<string | null>(null);
const [mailConfigMsg, setMailConfigMsg] = useState<{ text: string; error: boolean } | null>(null);
```

- [ ] **Step 2: Funzioni fetch/salva/test/toggle/elimina** (vicino a `handleTestSmtp`)

```ts
const fetchMailConfigs = async () => {
  try {
    const res = await fetch(`${API_BASE}/mail-configs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const d = (await res.json()) as { configs: MailConfigItem[] };
      setMailConfigs(d.configs);
    }
  } catch { /* rete assente: lista vuota */ }
};

const saveMailConfig = async () => {
  if (!editingMailConfig) return;
  const isNew = !editingMailConfig.id;
  const url = isNew ? `${API_BASE}/mail-configs` : `${API_BASE}/mail-configs/${editingMailConfig.id}`;
  const body: Record<string, unknown> = {
    name: editingMailConfig.name,
    host: editingMailConfig.host,
    port: Number(editingMailConfig.port) || 587,
    secure: !!editingMailConfig.secure,
    authEnabled: !!editingMailConfig.authEnabled,
    username: editingMailConfig.username ?? '',
    password: editingMailConfig.password ?? '',
    fromAddress: editingMailConfig.fromAddress,
    batchSize: Number(editingMailConfig.batchSize) || 100,
    batchIntervalSeconds: Number(editingMailConfig.batchIntervalSeconds) || 60,
  };
  if (isNew) body['type'] = editingMailConfig.type;
  const res = await fetch(url, {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    setEditingMailConfig(null);
    setMailConfigMsg({ text: 'Configurazione salvata. Eseguire il test per attivarla.', error: false });
    fetchMailConfigs();
  } else {
    const err = (await res.json()) as { message?: string | string[] };
    setMailConfigMsg({ text: `Errore: ${Array.isArray(err.message) ? err.message.join('; ') : err.message ?? res.status}`, error: true });
  }
  setTimeout(() => setMailConfigMsg(null), 4000);
};

const deleteMailConfig = async (id: string) => {
  if (!confirm('Eliminare questa configurazione?')) return;
  await fetch(`${API_BASE}/mail-configs/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  fetchMailConfigs();
};

const testMailConfig = async (id: string) => {
  if (!mailConfigTestTo) {
    setMailConfigMsg({ text: 'Inserire un destinatario per il test.', error: true });
    setTimeout(() => setMailConfigMsg(null), 3000);
    return;
  }
  setMailConfigBusyId(id);
  try {
    const res = await fetch(`${API_BASE}/mail-configs/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: mailConfigTestTo }),
    });
    const d = (await res.json()) as { message?: string };
    setMailConfigMsg({ text: d.message ?? (res.ok ? 'Test riuscito.' : 'Test fallito.'), error: !res.ok });
  } catch {
    setMailConfigMsg({ text: 'Errore di rete durante il test.', error: true });
  }
  setMailConfigBusyId(null);
  fetchMailConfigs();
  setTimeout(() => setMailConfigMsg(null), 5000);
};

const toggleMailConfig = async (id: string, active: boolean) => {
  const res = await fetch(`${API_BASE}/mail-configs/${id}/active`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { message?: string };
    setMailConfigMsg({ text: err.message ?? 'Operazione non riuscita.', error: true });
    setTimeout(() => setMailConfigMsg(null), 4000);
  }
  fetchMailConfigs();
};
```

Caricare la lista al login: nell'`useEffect` che carica `/settings` (riga ~334) aggiungere `fetchMailConfigs();` come prima istruzione dopo il guard `if (!token) return;`.

- [ ] **Step 3: Sostituire il contenuto dei tab `smtp` e `pec`**

Il contenuto attuale dei blocchi `{activeSettingsTab === 'smtp' && (...)}` (righe ~2732-2824) e `{activeSettingsTab === 'pec' && (...)}` (righe ~2825-2918) va sostituito con un renderer comune. Aggiungere una funzione di render nel componente:

```tsx
const renderMailConfigsTab = (type: 'EMAIL' | 'PEC') => {
  const items = mailConfigs.filter(c => c.type === type);
  const label = type === 'EMAIL' ? 'SMTP' : 'PEC';
  return (
    <div>
      {mailConfigMsg && (
        <div className={`alert ${mailConfigMsg.error ? 'alert-danger' : 'alert-success'} py-2 small`}>
          {mailConfigMsg.text}
        </div>
      )}

      <div className="d-flex justify-content-between align-items-center mb-3">
        <div className="small text-muted">
          Configura uno o più server {label}. Un metodo è utilizzabile nel wizard solo se
          <strong> testato con successo</strong> (il test lo attiva automaticamente).
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setEditingMailConfig({ ...EMPTY_MAIL_CONFIG, type })}
        >
          <i className="fas fa-plus me-1"></i> Nuova configurazione
        </button>
      </div>

      <div className="mb-3 d-flex align-items-center gap-2">
        <label className="form-label small fw-bold mb-0">Destinatario e-mail di test:</label>
        <input
          type="email"
          className="form-control form-control-sm"
          style={{ maxWidth: '280px' }}
          placeholder="tuo@indirizzo.it"
          value={mailConfigTestTo}
          onChange={e => setMailConfigTestTo(e.target.value)}
        />
      </div>

      {items.length === 0 && !editingMailConfig && (
        <div className="alert alert-warning small">
          Nessuna configurazione {label}: il canale {type} non sarà disponibile nel wizard.
        </div>
      )}

      {items.map(cfg => (
        <div key={cfg.id} className="card mb-2">
          <div className="card-body py-2 d-flex align-items-center gap-3 flex-wrap">
            <div className="flex-grow-1">
              <div className="fw-bold small">
                {cfg.name}{' '}
                {cfg.active
                  ? <span className="badge bg-success">ATTIVA</span>
                  : cfg.testedAt
                    ? <span className="badge bg-secondary">DISATTIVATA</span>
                    : <span className="badge bg-warning text-dark">DA TESTARE</span>}
              </div>
              <div className="small text-muted">
                {cfg.host}:{cfg.port} — mittente {cfg.fromAddress} —{' '}
                {cfg.authEnabled ? `auth: ${cfg.username}` : 'senza autenticazione'} —{' '}
                max {cfg.batchSize} invii / {cfg.batchIntervalSeconds}s
                {cfg.testedAt && <> — testata il {new Date(cfg.testedAt).toLocaleString('it-IT')}</>}
              </div>
            </div>
            <div className="d-flex gap-1">
              <button type="button" className="btn btn-sm btn-outline-success"
                disabled={mailConfigBusyId === cfg.id}
                onClick={() => testMailConfig(cfg.id)}>
                {mailConfigBusyId === cfg.id
                  ? <i className="fas fa-spinner fa-spin"></i>
                  : <><i className="fas fa-vial me-1"></i>Test</>}
              </button>
              {cfg.testedAt && (
                <button type="button" className="btn btn-sm btn-outline-secondary"
                  onClick={() => toggleMailConfig(cfg.id, !cfg.active)}>
                  {cfg.active ? 'Disattiva' : 'Riattiva'}
                </button>
              )}
              <button type="button" className="btn btn-sm btn-outline-primary"
                onClick={() => setEditingMailConfig({ ...cfg })}>
                <i className="fas fa-pen"></i>
              </button>
              <button type="button" className="btn btn-sm btn-outline-danger"
                onClick={() => deleteMailConfig(cfg.id)}>
                <i className="fas fa-trash"></i>
              </button>
            </div>
          </div>
        </div>
      ))}

      {editingMailConfig && editingMailConfig.type === type && (
        <div className="card border-primary mt-3">
          <div className="card-header bg-white py-2 small fw-bold">
            {editingMailConfig.id ? 'Modifica configurazione' : `Nuova configurazione ${label}`}
          </div>
          <div className="card-body">
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label small fw-bold">Nome identificativo *</label>
                <input type="text" className="form-control form-control-sm"
                  placeholder={`Es: ${label} Comune principale`}
                  value={editingMailConfig.name ?? ''}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, name: e.target.value }))} />
              </div>
              <div className="col-md-6">
                <label className="form-label small fw-bold">Indirizzo mittente (From) *</label>
                <input type="email" className="form-control form-control-sm"
                  value={editingMailConfig.fromAddress ?? ''}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, fromAddress: e.target.value }))} />
              </div>
              <div className="col-md-5">
                <label className="form-label small fw-bold">Host *</label>
                <input type="text" className="form-control form-control-sm"
                  value={editingMailConfig.host ?? ''}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, host: e.target.value }))} />
              </div>
              <div className="col-md-3">
                <label className="form-label small fw-bold">Porta *</label>
                <input type="number" className="form-control form-control-sm"
                  value={editingMailConfig.port ?? 587}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, port: Number(e.target.value) }))} />
              </div>
              <div className="col-md-4 d-flex align-items-end gap-3">
                <div className="form-check">
                  <input type="checkbox" className="form-check-input" id={`cfg-secure-${type}`}
                    checked={!!editingMailConfig.secure}
                    onChange={e => setEditingMailConfig(p => ({ ...p!, secure: e.target.checked }))} />
                  <label className="form-check-label small" htmlFor={`cfg-secure-${type}`}>TLS implicito (465)</label>
                </div>
                <div className="form-check">
                  <input type="checkbox" className="form-check-input" id={`cfg-auth-${type}`}
                    checked={!!editingMailConfig.authEnabled}
                    onChange={e => setEditingMailConfig(p => ({ ...p!, authEnabled: e.target.checked }))} />
                  <label className="form-check-label small" htmlFor={`cfg-auth-${type}`}>Richiede autenticazione</label>
                </div>
              </div>
              {editingMailConfig.authEnabled && (
                <>
                  <div className="col-md-6">
                    <label className="form-label small fw-bold">Username</label>
                    <input type="text" className="form-control form-control-sm"
                      value={editingMailConfig.username ?? ''}
                      onChange={e => setEditingMailConfig(p => ({ ...p!, username: e.target.value }))} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label small fw-bold">Password</label>
                    <input type="password" className="form-control form-control-sm"
                      value={editingMailConfig.password ?? ''}
                      onChange={e => setEditingMailConfig(p => ({ ...p!, password: e.target.value }))} />
                  </div>
                </>
              )}
              <div className="col-md-6">
                <label className="form-label small fw-bold">Invii per batch (throttling)</label>
                <input type="number" min={1} className="form-control form-control-sm"
                  value={editingMailConfig.batchSize ?? 100}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, batchSize: Number(e.target.value) }))} />
                <div className="form-text small">Default 100. Max messaggi inviati per finestra.</div>
              </div>
              <div className="col-md-6">
                <label className="form-label small fw-bold">Intervallo batch (secondi)</label>
                <input type="number" min={1} className="form-control form-control-sm"
                  value={editingMailConfig.batchIntervalSeconds ?? 60}
                  onChange={e => setEditingMailConfig(p => ({ ...p!, batchIntervalSeconds: Number(e.target.value) }))} />
                <div className="form-text small">Default 60. Durata della finestra di invio.</div>
              </div>
            </div>
            <div className="mt-3 d-flex gap-2">
              <button type="button" className="btn btn-sm btn-primary"
                disabled={!editingMailConfig.name || !editingMailConfig.host || !editingMailConfig.fromAddress}
                onClick={saveMailConfig}>
                <i className="fas fa-save me-1"></i> Salva configurazione
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary"
                onClick={() => setEditingMailConfig(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
```

Poi i due tab diventano:

```tsx
{activeSettingsTab === 'smtp' && renderMailConfigsTab('EMAIL')}
{activeSettingsTab === 'pec' && renderMailConfigsTab('PEC')}
```

IMPORTANTE: i vecchi form smtp/pec dentro `<form onSubmit={handleSaveSettings}>` vanno rimossi, MA il renderer nuovo contiene solo `<button type="button">` quindi può restare dentro il form senza submit accidentali. Rimuovere anche le chiavi `smtp.*` e `pec.*` dal body di `handleSaveSettings` (righe 718-729): le config legacy restano come fallback in sola lettura backend, non più editabili da UI. Gli stati `settSmtp*`/`settPec*` e `handleTestSmtp`/`handleTestPec` diventano inutilizzati: eliminarli (stati righe 211-231, funzioni 777-837) e togliere i riferimenti residui (`settSmtpFrom`/`settSmtpHost`/`settPecFrom`/`settPecHost` usati in `handleWizLaunch` — verranno rimossi dal task 13; se il task 13 non è ancora fatto, sostituirli temporaneamente con stringhe vuote per compilare).

- [ ] **Step 4: Type-check e verifica manuale**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: exit 0. Poi in browser (http://localhost:3000, admin/admin): Impostazioni → Mail Server: creare config, testarla (badge ATTIVA), disattivarla, riattivarla, eliminarla.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): gestione multipla configurazioni SMTP/PEC con test e throttling"
```

---

### Task 11: UI Wizard — fix caricamento CSV (rimozione file, toggle header)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: funzioni module-level `parseWizCsvText(text, hasHeaders)` e `guessWizMapping(headers)`; stati `wizCsvRawText`, `wizCsvInputKey`.

- [ ] **Step 1: Estrarre il parsing in funzioni module-level**

Sopra `export function App()` aggiungere (il codice è l'attuale corpo di `handleWizCsvChange`, righe 890-960, estratto):

```ts
function parseWizCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === ',' || char === ';') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result.map(col => col.replace(/^"(.*)"$/, '$1'));
}

function parseWizCsvText(text: string, hasHeaders: boolean): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  if (hasHeaders) {
    const headers = parseWizCsvLine(lines[0]);
    const rows = lines.slice(1).map(line => {
      const cols = parseWizCsvLine(line);
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => { obj[h] = cols[idx] || ''; });
      return obj;
    });
    return { headers, rows };
  }

  const firstLineCols = parseWizCsvLine(lines[0]);
  const headers = firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
  const rows = lines.map(line => {
    const cols = parseWizCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] || ''; });
    return obj;
  });
  return { headers, rows };
}

function guessWizMapping(headers: string[]) {
  const newMapping = {
    codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', allegato1: '',
  };
  headers.forEach(h => {
    const hLower = h.toLowerCase().replace(/[\s_-]/g, '');
    if (hLower === 'cf' || hLower === 'codicefiscale') newMapping.codice_fiscale = h;
    else if (hLower === 'cognome' || hLower === 'nominativo' || hLower === 'fullname' || hLower === 'nomecompleto' || hLower === 'nome') {
      if (!newMapping.full_name) newMapping.full_name = h;
      else newMapping.full_name_2 = h;
    }
    else if (hLower === 'email' || hLower === 'mail') newMapping.email = h;
    else if (hLower === 'pec') newMapping.pec = h;
    else if (hLower === 'allegato1' || hLower === 'documento' || hLower === 'avviso' || hLower === 'pdf') newMapping.allegato1 = h;
  });
  return newMapping;
}
```

- [ ] **Step 2: Nuovi stati e handler**

Accanto a `wizCsvFile` (riga ~177):

```ts
const [wizCsvRawText, setWizCsvRawText] = useState('');
const [wizCsvInputKey, setWizCsvInputKey] = useState(0); // forza il remount dell'input file
```

Sostituire `handleWizCsvChange` (righe 877-964) con:

```ts
const applyWizCsvText = (text: string, hasHeaders: boolean) => {
  const { headers, rows } = parseWizCsvText(text, hasHeaders);
  setWizCsvHeaders(headers);
  setWizCsvRows(rows);
  setWizMapping(guessWizMapping(headers));
  setWizValidationErrors([]);
  setWizValidRows([]);
};

const handleWizCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setWizCsvFile(file);
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target?.result as string;
    if (!text) return;
    setWizCsvRawText(text);
    applyWizCsvText(text, wizCsvHasHeaders);
  };
  reader.readAsText(file);
};

const handleWizCsvHeadersToggle = (hasHeaders: boolean) => {
  setWizCsvHasHeaders(hasHeaders);
  // Fix: ri-parsa il file già caricato con la nuova impostazione, senza obbligare al ricaricamento
  if (wizCsvRawText) {
    applyWizCsvText(wizCsvRawText, hasHeaders);
  }
};

const handleWizCsvRemove = () => {
  setWizCsvFile(null);
  setWizCsvRawText('');
  setWizCsvHeaders([]);
  setWizCsvRows([]);
  setWizValidationErrors([]);
  setWizValidRows([]);
  setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', allegato1: '' });
  setWizCsvInputKey(k => k + 1); // svuota il valore dell'input file
};
```

- [ ] **Step 3: Aggiornare lo Step 2 del wizard (JSX, righe ~2054-2107)**

- All'`<input type="file" accept=".csv" ...>` aggiungere `key={wizCsvInputKey}`.
- Checkbox header: sostituire l'`onChange` attuale (che azzera il file) con `onChange={e => handleWizCsvHeadersToggle(e.target.checked)}`.
- Al badge del file caricato affiancare il bottone di rimozione:

```tsx
{wizCsvFile && (
  <div className="mt-3 d-flex align-items-center justify-content-center gap-2">
    <span className="badge bg-success p-2">
      <i className="fas fa-check-circle me-1"></i> {wizCsvFile.name} ({wizCsvRows.length} righe rilevate)
    </span>
    <button type="button" className="btn btn-sm btn-outline-danger" onClick={handleWizCsvRemove}>
      <i className="fas fa-trash me-1"></i> Rimuovi file
    </button>
  </div>
)}
```

- In `handleWizLaunch`, nel blocco di reset finale (righe ~1206-1225), aggiungere `setWizCsvRawText(''); setWizCsvInputKey(k => k + 1);`.

- [ ] **Step 4: Type-check e verifica manuale**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

In browser: caricare CSV con header → togliere la spunta header → verificare che le colonne diventino `Colonna 1..N` e la prima riga diventi un record; rimettere la spunta → header di nuovo usati; "Rimuovi file" → si può ricaricare lo stesso file (l'input è svuotato).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(admin): wizard CSV rimovibile e re-parse al toggle header"
```

---

### Task 12: UI Wizard Step 1 — modalità App IO, scelta mittente, canali bloccati

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `mailConfigs` + `fetchMailConfigs()` (task 10).
- Produces: stati `wizAppIoMode: 'none' | 'parallel' | 'exclusive'` e `wizMailConfigId: string`, consumati dal task 13.

- [ ] **Step 1: Stati**

Accanto agli stati wizard (riga ~176):

```ts
const [wizAppIoMode, setWizAppIoMode] = useState<'none' | 'parallel' | 'exclusive'>('none');
const [wizMailConfigId, setWizMailConfigId] = useState('');
```

- [ ] **Step 2: Config attive per canale + auto-selezione**

Dentro il componente, prima del JSX del wizard:

```ts
const activeMailConfigsForChannel = (ch: 'EMAIL' | 'PEC') =>
  mailConfigs.filter(c => c.type === ch && c.active);

// Auto-selezione mittente: se una sola config attiva, sceglila; se quella scelta non è più valida, resetta
useEffect(() => {
  if (wizChannel !== 'EMAIL' && wizChannel !== 'PEC') { setWizMailConfigId(''); return; }
  const actives = activeMailConfigsForChannel(wizChannel);
  if (actives.length === 1) {
    setWizMailConfigId(actives[0].id);
  } else if (!actives.some(c => c.id === wizMailConfigId)) {
    setWizMailConfigId('');
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [wizChannel, mailConfigs]);
```

Aggiornare la lista config quando si entra nel wizard: nel bottone "Crea Nuova Campagna (Wizard)" (riga ~1899) aggiungere `fetchMailConfigs();` prima di `setView('invio-massivo-wizard')`.

- [ ] **Step 3: Select canale con opzioni disabilitate**

Nel select del canale (righe ~2009-2019):

```tsx
<select
  className="form-select form-select-sm"
  value={wizChannel}
  onChange={(e: any) => setWizChannel(e.target.value)}
>
  <option value="EMAIL" disabled={activeMailConfigsForChannel('EMAIL').length === 0}>
    EMAIL{activeMailConfigsForChannel('EMAIL').length === 0 ? ' — nessuna configurazione testata' : ''}
  </option>
  <option value="PEC" disabled={activeMailConfigsForChannel('PEC').length === 0}>
    PEC (Posta Elettronica Certificata){activeMailConfigsForChannel('PEC').length === 0 ? ' — nessuna configurazione testata' : ''}
  </option>
  <option value="APP_IO">APP IO (PagoPA)</option>
  <option value="SEND">SEND</option>
  <option value="POSTAL">POSTAL</option>
</select>
```

- [ ] **Step 4: Select mittente (solo se >1 config attiva) e select modalità App IO**

Dopo il blocco del select canale, prima del blocco `wizChannel === 'APP_IO'` (riga ~2022), aggiungere:

```tsx
{(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
  <>
    {activeMailConfigsForChannel(wizChannel).length > 1 && (
      <div className="mb-3">
        <label className="form-label small fw-bold">Mittente *</label>
        <select
          className="form-select form-select-sm"
          value={wizMailConfigId}
          onChange={e => setWizMailConfigId(e.target.value)}
          required
        >
          <option value="">-- Seleziona configurazione mittente --</option>
          {activeMailConfigsForChannel(wizChannel).map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.fromAddress})</option>
          ))}
        </select>
      </div>
    )}
    {activeMailConfigsForChannel(wizChannel).length === 1 && (
      <div className="mb-3 small text-muted">
        <i className="fas fa-paper-plane me-1"></i>
        Mittente: <strong>{activeMailConfigsForChannel(wizChannel)[0].name}</strong>{' '}
        ({activeMailConfigsForChannel(wizChannel)[0].fromAddress})
      </div>
    )}

    <div className="mb-3">
      <label className="form-label small fw-bold">Co-delivery App IO</label>
      <select
        className="form-select form-select-sm"
        value={wizAppIoMode}
        onChange={(e: any) => setWizAppIoMode(e.target.value)}
      >
        <option value="none">No, solo canale principale (default)</option>
        <option value="parallel">Sì, invia anche su App IO (in parallelo)</option>
        <option value="exclusive">Sì, e se il destinatario ha App IO salta il canale principale</option>
      </select>
      {wizAppIoMode !== 'none' && (
        <div className="form-text small">
          Richiede la colonna Codice Fiscale mappata al passo 3 e un servizio App IO configurato.
        </div>
      )}
    </div>
  </>
)}
```

- [ ] **Step 5: Guardia sul bottone Avanti dello step 1** (riga ~2042)

```tsx
disabled={
  !wizName ||
  (wizChannel === 'APP_IO' && !wizAppIoServiceId) ||
  ((wizChannel === 'EMAIL' || wizChannel === 'PEC') && !wizMailConfigId)
}
```

- [ ] **Step 6: Validazione step 3 — CF obbligatorio se co-delivery attiva**

In `handleWizValidation` (riga ~984) cambiare:

```ts
const isCfMandatory = wizChannel === 'APP_IO' || wizChannel === 'SEND' || wizAppIoMode !== 'none';
```

E in caso di CF non mappato con co-delivery, l'errore riga già esistente («La colonna Codice Fiscale / P.IVA deve essere mappata») copre il caso.

Aggiornare anche l'etichetta del campo CF nello step 3 (riga ~2116):

```tsx
<label className="form-label small fw-bold">Codice Fiscale { (wizChannel === 'APP_IO' || wizChannel === 'SEND' || wizAppIoMode !== 'none') ? '*' : '(Consigliato)' }</label>
```

- [ ] **Step 7: Riepilogo step 5 — mostrare la modalità reale** (righe ~2397-2401)

Sostituire il blocco `{wizMapping.codice_fiscale && (...)}` con:

```tsx
{wizAppIoMode !== 'none' && (
  <div className="mb-2 text-success">
    <i className="fas fa-mobile-alt me-1"></i>
    {wizAppIoMode === 'parallel'
      ? 'Co-delivery App IO attiva (invio parallelo per gli utenti con App IO)'
      : 'Consegna esclusiva App IO attiva (gli utenti con App IO NON riceveranno il canale principale)'}
  </div>
)}
```

Reset a fine lancio (blocco reset in `handleWizLaunch`): aggiungere `setWizAppIoMode('none'); setWizMailConfigId('');`.

- [ ] **Step 8: Type-check, verifica manuale, commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Verifica in browser: senza config attive EMAIL/PEC le opzioni sono disabilitate; con 1 config non appare la select; con 2 appare; select co-delivery presente con default "No".

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): wizard step 1 con scelta mittente, co-delivery App IO e canali bloccati"
```

---

### Task 13: UI Wizard — launch con nuovo channelConfig e report allegati scartati

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (funzione `handleWizLaunch`, righe ~1081-1235; input allegati step 5, riga ~2426)

**Interfaces:**
- Consumes: `wizMailConfigId`, `wizAppIoMode` (task 12); risposta `{ uploaded, discarded }` (task 9).
- Produces: `channelConfig` conforme al contratto del piano.

- [ ] **Step 1: Nuovo blocco channelConfig per EMAIL/PEC**

In `handleWizLaunch` sostituire il ramo `wizChannel === 'EMAIL' || wizChannel === 'PEC'` (righe 1098-1122) con:

```ts
} else if (wizChannel === 'EMAIL' || wizChannel === 'PEC') {
  channelConfig = {
    subject: wizSubject,
    body: wizBody,
    allegatoKey: wizMapping.allegato1,
    mailConfigId: wizMailConfigId,
  };

  if (wizAppIoMode !== 'none' && wizMapping.codice_fiscale) {
    const defaultSvc = ioServices.find(s => s.is_default) || ioServices[0];
    if (defaultSvc) {
      channelConfig.appIo = {
        mode: wizAppIoMode,
        serviceId: defaultSvc.id_service,
        serviceName: defaultSvc.nome,
        apiKey: defaultSvc.api_key_primaria,
        baseUrl: settIoUrl,
      };
    }
  }
}
```

(le chiavi `from`, `smtpServer`, `pecServer` spariscono: il backend risolve tutto da `mailConfigId`).

- [ ] **Step 2: Input allegati accetta anche zip** (riga ~2427)

```tsx
<input
  type="file"
  accept=".pdf,.zip"
  multiple
  className="form-control form-control-sm"
  onChange={e => setWizPdfFiles(Array.from(e.target.files || []))}
/>
```

Aggiornare i testi del riquadro: «Seleziona i file PDF degli avvisi individuali oppure un archivio ZIP che li contiene. I file non citati nella colonna allegato del CSV verranno scartati automaticamente.»

- [ ] **Step 3: Mostrare l'esito dello scarto**

Nel blocco upload allegati di `handleWizLaunch` (righe ~1182-1195):

```ts
let attachmentSummary = '';
if (wizPdfFiles && wizPdfFiles.length > 0) {
  const attachFormData = new FormData();
  wizPdfFiles.forEach(file => {
    attachFormData.append('files', file);
  });
  const attachRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/attachments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: attachFormData,
  });
  if (!attachRes.ok) {
    throw new Error('Errore durante il caricamento dei file degli allegati.');
  }
  const attachData = (await attachRes.json()) as { uploaded: number; discarded: number };
  attachmentSummary = `\nAllegati: ${attachData.uploaded} associati` +
    (attachData.discarded > 0 ? `, ${attachData.discarded} scartati perché non mappati nel CSV.` : '.');
}
```

E nell'alert finale (riga ~1229):

```ts
alert(`Campagna creata e avviata con successo! I messaggi sono in coda.${attachmentSummary}`);
```

- [ ] **Step 4: Type-check, verifica end-to-end, commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Verifica end-to-end in dev: campagna EMAIL con 2 destinatari, 1 allegato mappato, upload di 10 PDF → alert riporta «1 associati, 9 scartati»; mail ricevuta con logo e footer portale; co-delivery come selezionato.

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): launch wizard con mailConfigId, modalità App IO e report allegati scartati"
```

---

### Task 14: Backend — endpoint `/engines` (stato motori, pause/resume, log)

**Files:**
- Create: `apps/backend/src/engines/engines.controller.ts`
- Create: `apps/backend/src/engines/engines.module.ts`
- Modify: `apps/backend/src/app.module.ts` (import)
- Test: `apps/backend/src/engines/engines.controller.spec.ts`

**Interfaces:**
- Consumes: `MailConfigsService.listMasked` (task 2); `NotificationQueuesService` e `ALL_CHANNELS` (task 5); repo `NotificationAttempt`; `AppSettingsService` per configured di APP_IO/SEND.
- Produces: `GET /engines`, `POST /engines/:channel/pause`, `POST /engines/:channel/resume`, `GET /engines/:channel/attempts` come da contratto in testa al piano.

- [ ] **Step 1: Test failing**

```ts
// apps/backend/src/engines/engines.controller.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EnginesController } from './engines.controller';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { NotificationQueuesService } from '../queue/notification-queues.service';

describe('EnginesController', () => {
  let controller: EnginesController;
  const queues = {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 5, active: 1, completed: 100, failed: 3, delayed: 2 }),
    isPaused: jest.fn().mockResolvedValue(false),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
  };
  const attemptRepo = {
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { channel: 'EMAIL', status: 'success', count: '10' },
        { channel: 'EMAIL', status: 'failed', count: '2' },
      ]),
    })),
  };
  const mailConfigs = {
    listMasked: jest.fn().mockResolvedValue([
      { id: '1', type: 'EMAIL', name: 'A', host: 'h', fromAddress: 'a@b.c', active: true, testedAt: '2026-01-01T00:00:00Z' },
    ]),
  };
  const appSettings = { get: jest.fn().mockResolvedValue('') };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        { provide: NotificationQueuesService, useValue: queues },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: MailConfigsService, useValue: mailConfigs },
        { provide: AppSettingsService, useValue: appSettings },
      ],
    }).compile();
    controller = module.get(EnginesController);
  });

  it('GET /engines aggrega per canale coda, stato pausa, config e tentativi 24h', async () => {
    const res = await controller.getEngines();
    expect(res.engines).toHaveLength(5);
    const email = res.engines.find((e: any) => e.channel === 'EMAIL');
    expect(email.queue.waiting).toBe(5);
    expect(email.paused).toBe(false);
    expect(email.configured).toBe(true);
    expect(email.attempts24h).toEqual({ success: 10, failed: 2 });
  });

  it('POST /engines/:channel/pause ferma il motore', async () => {
    const res = await controller.pause('EMAIL');
    expect(queues.pause).toHaveBeenCalledWith('EMAIL');
    expect(res).toEqual({ channel: 'EMAIL', paused: true });
  });

  it('POST /engines/:channel/resume riavvia il motore', async () => {
    const res = await controller.resume('PEC');
    expect(queues.resume).toHaveBeenCalledWith('PEC');
    expect(res).toEqual({ channel: 'PEC', paused: false });
  });

  it('GET /engines/:channel/attempts rifiuta canali sconosciuti', async () => {
    await expect(controller.getAttempts('FAX', '50')).rejects.toThrow();
  });
});
```

Run: `docker compose exec backend node_modules/.bin/jest engines --maxWorkers=2` → Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementare il controller**

```ts
// apps/backend/src/engines/engines.controller.ts
import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { ALL_CHANNELS } from '../queue/notification-job.types';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { AppSettingsService } from '../settings/app-settings.service';

@Controller('engines')
@Roles('admin')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly mailConfigs: MailConfigsService,
    private readonly appSettings: AppSettingsService,
  ) {}

  private assertChannel(channel: string): NotificationChannel {
    if (!ALL_CHANNELS.includes(channel as NotificationChannel)) {
      throw new BadRequestException(`Canale sconosciuto: ${channel}`);
    }
    return channel as NotificationChannel;
  }

  @Get()
  async getEngines() {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const raw = await this.attemptRepo
      .createQueryBuilder('a')
      .select('a.channel_type', 'channel')
      .addSelect('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('a.created_at > :since', { since })
      .groupBy('a.channel_type')
      .addGroupBy('a.status')
      .getRawMany<{ channel: string; status: string; count: string }>();

    const statsByChannel = new Map<string, { success: number; failed: number }>();
    for (const row of raw) {
      const entry = statsByChannel.get(row.channel) ?? { success: 0, failed: 0 };
      if (row.status === 'success') entry.success += Number(row.count);
      if (row.status === 'failed') entry.failed += Number(row.count);
      statsByChannel.set(row.channel, entry);
    }

    const allMailConfigs = await this.mailConfigs.listMasked();
    const appIoKey = await this.appSettings.get<string>('appIo.apiKey');
    const sendKey = await this.appSettings.get<string>('send.apiKey');

    const engines = await Promise.all(
      ALL_CHANNELS.map(async (channel) => {
        const configs =
          channel === 'EMAIL' || channel === 'PEC'
            ? allMailConfigs
                .filter((c) => c.type === channel)
                .map((c) => ({
                  id: c.id, name: c.name, host: c.host, fromAddress: c.fromAddress,
                  active: c.active, testedAt: c.testedAt,
                }))
            : [];
        const configured =
          channel === 'EMAIL' || channel === 'PEC'
            ? configs.some((c) => c.active)
            : channel === 'APP_IO'
              ? !!appIoKey
              : channel === 'SEND'
                ? !!sendKey
                : false; // POSTAL: non ancora integrato
        return {
          channel,
          configured,
          paused: await this.queues.isPaused(channel),
          queue: await this.queues.getJobCounts(channel),
          configs,
          attempts24h: statsByChannel.get(channel) ?? { success: 0, failed: 0 },
        };
      }),
    );

    return { engines };
  }

  @Post(':channel/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Param('channel') channel: string) {
    const ch = this.assertChannel(channel);
    await this.queues.pause(ch);
    return { channel: ch, paused: true };
  }

  @Post(':channel/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('channel') channel: string) {
    const ch = this.assertChannel(channel);
    await this.queues.resume(ch);
    return { channel: ch, paused: false };
  }

  @Get(':channel/attempts')
  async getAttempts(@Param('channel') channel: string, @Query('limit') limit?: string) {
    const ch = this.assertChannel(channel);
    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const attempts = await this.attemptRepo.find({
      where: { channelType: ch },
      order: { createdAt: 'DESC' },
      take,
      relations: ['recipient'],
    });
    return {
      attempts: attempts.map((a) => ({
        id: a.id,
        status: a.status,
        errorMessage: a.errorMessage,
        sentAt: a.sentAt,
        createdAt: a.createdAt,
        recipient: a.recipient
          ? {
              codiceFiscale: a.recipient.codiceFiscale,
              email: a.recipient.email,
              pec: a.recipient.pec,
              fullName: a.recipient.fullName,
            }
          : null,
      })),
    };
  }
}
```

```ts
// apps/backend/src/engines/engines.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { QueueModule } from '../queue/queue.module';
import { EnginesController } from './engines.controller';

@Module({
  imports: [QueueModule, TypeOrmModule.forFeature([NotificationAttempt])],
  controllers: [EnginesController],
})
export class EnginesModule {}
```

Registrare `EnginesModule` in `app.module.ts`.

- [ ] **Step 3: Eseguire i test**

```bash
docker compose exec backend node_modules/.bin/jest engines --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 4: Verifica via curl**

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/engines | head -c 500
```

Expected: JSON con 5 `engines`, ciascuno con `queue`, `paused`, `configs`, `attempts24h`. Poi:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8080/engines/EMAIL/pause
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8080/engines/EMAIL/resume
```

Expected: `{"channel":"EMAIL","paused":true}` e `{"channel":"EMAIL","paused":false}`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/engines apps/backend/src/app.module.ts
git commit -m "feat(backend): endpoint /engines con stato per canale, pause/resume e log"
```

---

### Task 15: UI — tab "Motori" in Impostazioni

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET /engines`, `POST /engines/:channel/pause`, `POST /engines/:channel/resume`, `GET /engines/:channel/attempts` (task 14).
- Produces: tab `motori` (stile dashboard cron GovPay-Interaction-Layer: card per motore con badge RUNNING/PAUSED, bottoni Ferma/Avvia, contatori coda, pannello log).

- [ ] **Step 1: Stati e tipo tab**

Estendere l'union del tab (riga ~272):

```ts
const [activeSettingsTab, setActiveSettingsTab] = useState<'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'send' | 'protocollo' | 'postalizzazione' | 'oidc' | 'motori'>('personalizzazione');
```

Stati nuovi:

```ts
type EngineInfo = {
  channel: string;
  configured: boolean;
  paused: boolean;
  queue: Record<string, number>;
  configs: Array<{ id: string; name: string; host: string; fromAddress: string; active: boolean; testedAt: string | null }>;
  attempts24h: { success: number; failed: number };
};
type EngineAttempt = {
  id: string; status: string; errorMessage: string | null;
  sentAt: string | null; createdAt: string;
  recipient: { codiceFiscale: string; email: string | null; pec: string | null; fullName: string | null } | null;
};

const [enginesData, setEnginesData] = useState<{ engines: EngineInfo[] } | null>(null);
const [engineLogChannel, setEngineLogChannel] = useState<string | null>(null);
const [engineLog, setEngineLog] = useState<EngineAttempt[]>([]);
const [enginesLoading, setEnginesLoading] = useState(false);
```

(dichiarare i tipi `EngineInfo`/`EngineAttempt` a livello modulo accanto a `MailConfigItem`).

- [ ] **Step 2: Funzioni fetch**

```ts
const fetchEngines = async () => {
  setEnginesLoading(true);
  try {
    const res = await fetch(`${API_BASE}/engines`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setEnginesData(await res.json());
  } catch { /* rete */ }
  setEnginesLoading(false);
};

const toggleEngine = async (channel: string, pause: boolean) => {
  await fetch(`${API_BASE}/engines/${channel}/${pause ? 'pause' : 'resume'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  fetchEngines();
};

const fetchEngineLog = async (channel: string) => {
  setEngineLogChannel(channel);
  try {
    const res = await fetch(`${API_BASE}/engines/${channel}/attempts?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const d = (await res.json()) as { attempts: EngineAttempt[] };
      setEngineLog(d.attempts);
    }
  } catch { /* rete */ }
};
```

Caricare al cambio tab: `useEffect(() => { if (activeSettingsTab === 'motori' && token) fetchEngines(); }, [activeSettingsTab, token]);`

- [ ] **Step 3: Voce di menu + titolo**

Nella nav dei tab impostazioni (dopo la voce `oidc`, riga ~2647) aggiungere:

```tsx
<button
  type="button"
  className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'motori' ? 'active' : ''}`}
  onClick={() => setActiveSettingsTab('motori')}
>
  <i className="fas fa-cogs me-2"></i>Motori
</button>
```

E nel titolo: `{activeSettingsTab === 'motori' && 'Motori di Spedizione - Stato & Log'}`.

- [ ] **Step 4: Render del tab** (dentro il form insieme agli altri tab; solo bottoni `type="button"`)

```tsx
{activeSettingsTab === 'motori' && (
  <div>
    <div className="d-flex justify-content-between align-items-center mb-3">
      <div className="small text-muted">
        Stato dei motori di spedizione e della coda di invio. I contatori si riferiscono alle ultime 24 ore.
      </div>
      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={fetchEngines}>
        <i className={`fas fa-rotate-right me-1 ${enginesLoading ? 'fa-spin' : ''}`}></i> Aggiorna
      </button>
    </div>

    <div className="row g-3 mb-4">
      {enginesData?.engines.map(engine => (
        <div className="col-md-6" key={engine.channel}>
          <div className="card h-100">
            <div className="card-body d-flex flex-column gap-2">
              <div className="d-flex align-items-center gap-2">
                <strong className="small">Motore {engine.channel}</strong>
                <span className={`badge ms-auto ${
                  !engine.configured ? 'bg-secondary' : engine.paused ? 'bg-danger' : 'bg-success'
                }`}>
                  {!engine.configured ? 'NON CONFIGURATO' : engine.paused ? 'FERMO' : 'RUNNING'}
                </span>
              </div>
              {engine.configs.length > 0 && (
                <div className="small text-muted">
                  {engine.configs.map(c => (
                    <div key={c.id}>
                      <i className={`fas fa-circle me-1 ${c.active ? 'text-success' : 'text-secondary'}`} style={{ fontSize: '0.55rem' }}></i>
                      {c.name} — {c.host} ({c.fromAddress})
                    </div>
                  ))}
                </div>
              )}
              <div className="small d-flex gap-3 flex-wrap">
                <span>In coda: <strong>{engine.queue['waiting'] ?? 0}</strong></span>
                <span>In lavorazione: <strong>{engine.queue['active'] ?? 0}</strong></span>
                <span>Ritardati (throttling): <strong>{engine.queue['delayed'] ?? 0}</strong></span>
                <span className="text-danger">Falliti: <strong>{engine.queue['failed'] ?? 0}</strong></span>
              </div>
              <div className="small">
                Ultime 24h:{' '}
                <span className="text-success fw-bold">{engine.attempts24h.success} inviati</span>{' / '}
                <span className="text-danger fw-bold">{engine.attempts24h.failed} falliti</span>
              </div>
              <div className="mt-auto d-flex gap-2">
                {engine.paused ? (
                  <button type="button" className="btn btn-sm btn-success"
                    onClick={() => toggleEngine(engine.channel, false)}>
                    <i className="fas fa-play me-1"></i> Avvia
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm btn-danger"
                    onClick={() => toggleEngine(engine.channel, true)}>
                    <i className="fas fa-stop me-1"></i> Ferma
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-outline-secondary"
                  onClick={() => fetchEngineLog(engine.channel)}>
                  <i className="fas fa-terminal me-1"></i> Log
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>

    {engineLogChannel && (
      <div>
        <div className="d-flex align-items-center justify-content-between mb-2">
          <span className="fw-bold small">Log motore {engineLogChannel} (ultimi 50 tentativi)</span>
          <div className="d-flex gap-2">
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => fetchEngineLog(engineLogChannel)}>
              <i className="fas fa-rotate-right"></i>
            </button>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => { setEngineLogChannel(null); setEngineLog([]); }}>
              <i className="fas fa-xmark"></i>
            </button>
          </div>
        </div>
        <div className="table-responsive border rounded" style={{ maxHeight: '360px', overflowY: 'auto' }}>
          <table className="table table-sm table-striped align-middle mb-0" style={{ fontSize: '0.78rem' }}>
            <thead className="table-dark">
              <tr>
                <th>Data</th>
                <th>Destinatario</th>
                <th>Stato</th>
                <th>Errore</th>
              </tr>
            </thead>
            <tbody>
              {engineLog.length === 0 && (
                <tr><td colSpan={4} className="text-center text-muted py-3">Nessun tentativo registrato.</td></tr>
              )}
              {engineLog.map(a => (
                <tr key={a.id}>
                  <td className="text-nowrap">{new Date(a.sentAt ?? a.createdAt).toLocaleString('it-IT')}</td>
                  <td>{a.recipient?.fullName || a.recipient?.codiceFiscale || 'N/D'}<br />
                    <span className="text-muted">{a.recipient?.email || a.recipient?.pec || ''}</span></td>
                  <td>
                    <span className={`badge ${
                      a.status === 'success' ? 'bg-success' :
                      a.status === 'failed' ? 'bg-danger' : 'bg-warning text-dark'
                    }`}>{a.status.toUpperCase()}</span>
                  </td>
                  <td className="text-danger small">{a.errorMessage || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Type-check, verifica manuale, commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Verifica in browser: tab Motori mostra i 5 motori con contatori di coda per canale; "Ferma" sul motore EMAIL → badge FERMO e i job restano `waiting` (lanciare una campagna di prova); "Avvia" → smaltimento della coda; log EMAIL con i tentativi della campagna di prova del task 13.

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): tab Motori con stato per canale, ferma/avvia e log tentativi"
```

---

### Task 16: Validazione wizard — P.IVA malformata come warning non bloccante

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (`handleWizValidation`, pannello validazione step 3, riepilogo step 5)

**Interfaces:**
- Consumes: `handleWizValidation` e stati wizard esistenti; `applyWizCsvText`/`handleWizCsvRemove` (task 11).
- Produces: stato `wizValidationWarnings` (stessa shape degli errori). Regola: valore CF/P.IVA composto di sole cifre ma con lunghezza ≠ 11 → **warning** (la riga resta valida e viene inviata sul canale principale); resta **errore bloccante** per i canali APP_IO e SEND, dove il CF/P.IVA è il recapito.

- [ ] **Step 1: Stato warnings**

Accanto a `wizValidationErrors` (riga ~190):

```ts
const [wizValidationWarnings, setWizValidationWarnings] = useState<Array<{ row: number; field: string; val: string; err: string }>>([]);
```

- [ ] **Step 2: Regola in `handleWizValidation`**

In testa alla funzione:

```ts
const warnings: Array<{ row: number; field: string; val: string; err: string }> = [];
const isCfStrict = wizChannel === 'APP_IO' || wizChannel === 'SEND';
```

Sostituire il ramo di validazione CF/P.IVA (`} else if (cfField && row[cfField]) { ... }`, righe ~1024-1031) con:

```ts
} else if (cfField && row[cfField]) {
  const valClean = row[cfField].trim().replace(/\s/g, '');
  const isCf = cfRegex.test(valClean);
  const isPiva = pivaRegex.test(valClean);
  if (!isCf && !isPiva) {
    const isNumericOnly = /^\d+$/.test(valClean);
    if (isNumericOnly && !isCfStrict) {
      // P.IVA con numero di cifre errato (es. 10 invece di 11): warning, non esclude la riga.
      // L'invio sul canale principale procede; l'eventuale co-delivery App IO per questa riga
      // fallirà silenziosamente il check profilo.
      warnings.push({
        row: rowNum,
        field: 'P.IVA',
        val: row[cfField],
        err: `P.IVA di ${valClean.length} cifre invece di 11: la riga verrà inviata comunque`,
      });
    } else {
      errors.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], err: 'Codice Fiscale (16 caratteri) o P.IVA (11 cifre) non valida' });
      isRowValid = false;
    }
  }
}
```

In coda alla funzione, insieme a `setWizValidationErrors(errors)`:

```ts
setWizValidationWarnings(warnings);
```

Azzerare i warnings ovunque si azzerano gli errori: in `applyWizCsvText`, in `handleWizCsvRemove` e nel blocco di reset di `handleWizLaunch` aggiungere `setWizValidationWarnings([]);`.

- [ ] **Step 3: Pannello warnings nello step 3**

Dopo il blocco `{wizValidationErrors.length > 0 && (...)}` (riga ~2200) aggiungere:

```tsx
{wizValidationWarnings.length > 0 && (
  <div className="alert alert-warning py-2 small mt-3 mb-0">
    <div className="fw-bold mb-1">
      <i className="fas fa-exclamation-circle me-1"></i>
      {wizValidationWarnings.length} avvisi non bloccanti (le righe verranno comunque inviate):
    </div>
    <div style={{ maxHeight: '140px', overflowY: 'auto' }}>
      {wizValidationWarnings.map((w, idx) => (
        <div key={idx}>Riga {w.row} — {w.field} "{w.val}": {w.err}</div>
      ))}
    </div>
  </div>
)}
```

Aggiornare il messaggio di successo («Tutti i N record sono formalmente corretti...») perché appaia anche in presenza di soli warnings: la condizione `wizValidRows.length > 0 && wizValidationErrors.length === 0` va bene così com'è (i warnings non toccano `wizValidationErrors`), ma aggiungere in coda al testo, se `wizValidationWarnings.length > 0`, « (con {wizValidationWarnings.length} avvisi)».

- [ ] **Step 4: Riepilogo step 5**

Dopo il blocco degli errori esclusi (riga ~2387) aggiungere:

```tsx
{wizValidationWarnings.length > 0 && (
  <div className="mb-2 text-warning">
    <i className="fas fa-exclamation-circle me-1"></i> {wizValidationWarnings.length} righe con P.IVA anomala verranno inviate comunque.
  </div>
)}
```

- [ ] **Step 5: Type-check, verifica manuale, commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Verifica: CSV con una P.IVA a 10 cifre su canale EMAIL → validazione mostra 1 warning, 0 errori, la riga è nel conteggio dei validi; stesso CSV su canale APP_IO → errore bloccante.

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): P.IVA malformata come warning non bloccante nel wizard"
```

---

## Verifica finale (dopo l'ultimo task)

- [ ] Suite completa: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` → failure set ≤ baseline (7 preesistenti, alcuni potrebbero essere stati sistemati dai task 4-7).
- [ ] Type-check entrambi: `tsc --noEmit` backend, `tsc -p tsconfig.app.json --noEmit` frontend-admin.
- [ ] Config produzione valida: `docker compose -f docker-compose.yml config --quiet`.
- [ ] Flusso TARI end-to-end in dev: config SMTP senza auth → test → attiva; wizard EMAIL con CSV (header toggle + rimozione file, P.IVA a 10 cifre = warning non bloccante), co-delivery `exclusive`, ZIP con 3 PDF di cui 1 mappato → 2 scartati; mail con logo + footer portale; tab Motori mostra gli invii sulla coda `notifications-email`; "Ferma"/"Avvia" del motore EMAIL blocca e riprende lo smaltimento; con batchSize=1 e 3 destinatari gli invii escono scaglionati (job `delayed` visibili nella card del motore).
