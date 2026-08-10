# API esterna caricamento puntuale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere a un sistema PA esterno di lanciare una notifica puntuale (un destinatario per chiamata, qualunque canale) via API server-to-server autenticata con API key, senza passare dal wizard admin.

**Architecture:** Nuovo modulo `apps/backend/src/external-api/` sotto prefix bare `external/v1/*` (nessuna modifica nginx: `/api/` su frontend-admin già stripa e proxya tutto a `backend:8080/`). Auth via `X-Api-Key` (guard dedicato, bypassa JWT/Roles globali). Tutte le risposte sempre HTTP 200 (reverse proxy esterno sostituisce body non-2xx con HTML) via `ExceptionFilter` dedicato. Riuso diretto di `CampaignsService.launch()` esistente per ereditare gratis check protocollo SEND/blocco allegati/skip INAD. Gestione client esterni via CRUD admin (`admin/external-clients`) + nuova tab Impostazioni.

**Tech Stack:** NestJS 10, TypeORM 0.3.30, class-validator, React 19 (frontend-admin), Jest.

## Global Constraints

- Tutti gli endpoint `external/v1/*` rispondono **sempre HTTP 200**, esito in `{ success: boolean, ... }` — mai eccezioni non gestite dal filtro dedicato.
- Nessuna modifica a nginx/reverse proxy: `/api/external/v1/...` funziona già oggi via lo stripping esistente.
- Test backend sempre con `--maxWorkers=2` (vincolo RAM WSL2).
- Ogni migration va registrata in `apps/backend/src/database/database.module.ts` (array `migrations`) — verificare con `grep` dopo averla scritta.
- Ogni endpoint che agisce su dati personali (CF, indirizzo) logga su `AuditLogsService`.
- CF: 16 caratteri alfanumerici. App IO: `subject` [10,120], `body` [80,10000] caratteri.
- Dopo ogni modifica a firma di costruttore di Controller/Service esistente, lanciare la suite Jest COMPLETA prima di considerare la baseline pulita (non un pattern mirato).

---

### Task 1: Entity `ExternalApiClient` + colonna `Campaign.externalClientId`

**Files:**
- Create: `apps/backend/src/entities/external-api-client.entity.ts`
- Create: `apps/backend/src/entities/external-api-client.entity.spec.ts`
- Modify: `apps/backend/src/entities/campaign.entity.ts` (aggiungi colonna `externalClientId`)
- Create (dopo generazione contro DB temporaneo): due file in `apps/backend/src/database/migrations/`
- Modify: `apps/backend/src/database/database.module.ts` (entities array + migrations array)

**Interfaces:**
- Produces: `ExternalApiClient { id: string; name: string; apiKeyHash: string; active: boolean; createdAt: Date; lastUsedAt: Date | null }`
- Produces: `Campaign.externalClientId: string | null` (nuovo campo)

- [ ] **Step 1: Scrivi l'entity**

```typescript
// apps/backend/src/entities/external-api-client.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('external_api_clients')
export class ExternalApiClient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'varchar', name: 'api_key_hash', length: 64, unique: true })
  apiKeyHash!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt!: Date | null;
}
```

- [ ] **Step 2: Test smoke sull'entity (istanziabile, colonne attese)**

```typescript
// apps/backend/src/entities/external-api-client.entity.spec.ts
import { ExternalApiClient } from './external-api-client.entity';

describe('ExternalApiClient', () => {
  it('ha i campi attesi con i default corretti prima del save', () => {
    const entity = new ExternalApiClient();
    entity.name = 'Comune X — sistema tributi';
    entity.apiKeyHash = 'a'.repeat(64);
    expect(entity.name).toBe('Comune X — sistema tributi');
    expect(entity.apiKeyHash).toHaveLength(64);
  });
});
```

- [ ] **Step 3: Run test**

Run: `docker compose exec backend node_modules/.bin/jest external-api-client.entity --maxWorkers=2`
Expected: PASS

- [ ] **Step 4: Aggiungi colonna a `Campaign`**

In `apps/backend/src/entities/campaign.entity.ts`, subito dopo `parentCampaignId`:

```typescript
  @Column({ type: 'uuid', name: 'external_client_id', nullable: true })
  externalClientId!: string | null;
```

- [ ] **Step 5: Genera le due migration contro un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/CreateExternalApiClients -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Verifica il file generato: deve contenere `CREATE TABLE "external_api_clients"` e `ALTER TABLE "campaigns" ADD "external_client_id" uuid`. Se TypeORM li separa in due classi, tieni entrambe.

- [ ] **Step 6: Registra le migration in `database.module.ts`**

Aggiungi l'import e l'entry nell'array `entities` (per `ExternalApiClient`) e nell'array `migrations` (per la/le classi generate), stesso pattern delle righe esistenti. Verifica:

```bash
docker compose exec backend grep -n "CreateExternalApiClients" src/database/database.module.ts
```
Expected: due righe (import + array `migrations`).

- [ ] **Step 7: Rebuild e verifica applicazione migration su dev**

```bash
docker compose build backend
docker compose up -d backend
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d external_api_clients"
```
Expected: tabella con colonne `id, name, api_key_hash, active, created_at, last_used_at`. In dev `synchronize` copre comunque lo schema — questa verifica conferma che la migration è comunque corretta per il path di produzione.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/entities/external-api-client.entity.ts apps/backend/src/entities/external-api-client.entity.spec.ts apps/backend/src/entities/campaign.entity.ts apps/backend/src/database/migrations/*ExternalApiClient* apps/backend/src/database/database.module.ts
git commit -m "feat(backend): entity ExternalApiClient + colonna Campaign.externalClientId"
```

---

### Task 2: `ApiKeyGuard` + `ExternalApiClientsService`

**Files:**
- Create: `apps/backend/src/external-api/external-api-clients.service.ts`
- Create: `apps/backend/src/external-api/external-api-clients.service.spec.ts`
- Create: `apps/backend/src/external-api/guards/api-key.guard.ts`
- Create: `apps/backend/src/external-api/guards/api-key.guard.spec.ts`

**Interfaces:**
- Consumes: `ExternalApiClient` entity (Task 1)
- Produces: `ExternalApiClientsService { generateKey(name: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }>; regenerateKey(id: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }>; revoke(id: string): Promise<void>; listMasked(): Promise<ExternalApiClientMaskedDto[]>; findActiveByKey(apiKeyPlain: string): Promise<ExternalApiClient | null>; touchLastUsed(id: string): Promise<void> }`
- Produces: `ApiKeyGuard` (Nest `CanActivate`), attacca `req.apiClient: ExternalApiClient` su richieste autenticate
- Produces: `ExternalApiClientMaskedDto { id: string; name: string; active: boolean; createdAt: string; lastUsedAt: string | null }`

- [ ] **Step 1: Test del service — hashing e lookup**

```typescript
// apps/backend/src/external-api/external-api-clients.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExternalApiClientsService } from './external-api-clients.service';
import { ExternalApiClient } from '../entities/external-api-client.entity';

describe('ExternalApiClientsService', () => {
  let service: ExternalApiClientsService;
  let repo: { create: jest.Mock; save: jest.Mock; findOneBy: jest.Mock; find: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    repo = { create: jest.fn((x) => x), save: jest.fn(async (x) => ({ id: 'id-1', ...x })), findOneBy: jest.fn(), find: jest.fn(), update: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [ExternalApiClientsService, { provide: getRepositoryToken(ExternalApiClient), useValue: repo }],
    }).compile();
    service = module.get(ExternalApiClientsService);
  });

  it('generateKey crea un client con hash SHA-256 e ritorna la key in chiaro una sola volta', async () => {
    const { client, apiKeyPlain } = await service.generateKey('Comune X');
    expect(apiKeyPlain).toHaveLength(43); // 32 byte base64url senza padding
    expect(client.name).toBe('Comune X');
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );
  });

  it('findActiveByKey trova il client dal hash della key in chiaro', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'id-1', active: true });
    const found = await service.findActiveByKey('una-key-qualsiasi');
    expect(repo.findOneBy).toHaveBeenCalledWith({ apiKeyHash: expect.any(String), active: true });
    expect(found).toEqual({ id: 'id-1', active: true });
  });

  it('findActiveByKey ritorna null se nessun client attivo corrisponde', async () => {
    repo.findOneBy.mockResolvedValue(null);
    expect(await service.findActiveByKey('key-sbagliata')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest external-api-clients.service --maxWorkers=2`
Expected: FAIL — `Cannot find module './external-api-clients.service'`

- [ ] **Step 3: Implementa il service**

```typescript
// apps/backend/src/external-api/external-api-clients.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { ExternalApiClient } from '../entities/external-api-client.entity';

export interface ExternalApiClientMaskedDto {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

function hashKey(apiKeyPlain: string): string {
  return createHash('sha256').update(apiKeyPlain).digest('hex');
}

function generatePlainKey(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class ExternalApiClientsService {
  constructor(
    @InjectRepository(ExternalApiClient)
    private readonly repo: Repository<ExternalApiClient>,
  ) {}

  private toMasked(entity: ExternalApiClient): ExternalApiClientMaskedDto {
    return {
      id: entity.id,
      name: entity.name,
      active: entity.active,
      createdAt: entity.createdAt.toISOString(),
      lastUsedAt: entity.lastUsedAt ? entity.lastUsedAt.toISOString() : null,
    };
  }

  async listMasked(): Promise<ExternalApiClientMaskedDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toMasked(r));
  }

  async generateKey(name: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }> {
    const apiKeyPlain = generatePlainKey();
    const entity = this.repo.create({ name, apiKeyHash: hashKey(apiKeyPlain), active: true, lastUsedAt: null });
    const saved = await this.repo.save(entity);
    return { client: this.toMasked(saved), apiKeyPlain };
  }

  async regenerateKey(id: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Client ${id} non trovato`);
    const apiKeyPlain = generatePlainKey();
    entity.apiKeyHash = hashKey(apiKeyPlain);
    const saved = await this.repo.save(entity);
    return { client: this.toMasked(saved), apiKeyPlain };
  }

  async revoke(id: string): Promise<void> {
    const result = await this.repo.update({ id }, { active: false });
    if (!result.affected) throw new NotFoundException(`Client ${id} non trovato`);
  }

  /** Nessuna eccezione: guard e chiamante decidono cosa fare di un `null`. */
  async findActiveByKey(apiKeyPlain: string): Promise<ExternalApiClient | null> {
    return this.repo.findOneBy({ apiKeyHash: hashKey(apiKeyPlain), active: true });
  }

  /** Fire-and-forget lato chiamante: non deve mai bloccare la risposta. */
  async touchLastUsed(id: string): Promise<void> {
    await this.repo.update({ id }, { lastUsedAt: new Date() });
  }
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-api-clients.service --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: Test del guard**

```typescript
// apps/backend/src/external-api/guards/api-key.guard.spec.ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { ExternalApiClientsService } from '../external-api-clients.service';

function makeContext(headers: Record<string, string>): ExecutionContext {
  const req: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let clientsService: { findActiveByKey: jest.Mock; touchLastUsed: jest.Mock };
  let guard: ApiKeyGuard;

  beforeEach(() => {
    clientsService = { findActiveByKey: jest.fn(), touchLastUsed: jest.fn().mockResolvedValue(undefined) };
    guard = new ApiKeyGuard(clientsService as unknown as ExternalApiClientsService);
  });

  it('lancia UnauthorizedException se header X-Api-Key assente', async () => {
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('lancia UnauthorizedException se la key non corrisponde a nessun client attivo', async () => {
    clientsService.findActiveByKey.mockResolvedValue(null);
    await expect(guard.canActivate(makeContext({ 'x-api-key': 'key-invalida' }))).rejects.toThrow(UnauthorizedException);
  });

  it('attacca req.apiClient e ritorna true su key valida', async () => {
    const client = { id: 'client-1', name: 'Comune X' };
    clientsService.findActiveByKey.mockResolvedValue(client);
    const ctx = makeContext({ 'x-api-key': 'key-valida' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).apiClient).toBe(client);
    expect(clientsService.touchLastUsed).toHaveBeenCalledWith('client-1');
  });
});
```

- [ ] **Step 6: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest api-key.guard --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 7: Implementa il guard**

```typescript
// apps/backend/src/external-api/guards/api-key.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ExternalApiClientsService } from '../external-api-clients.service';
import type { ExternalApiClient } from '../../entities/external-api-client.entity';

export type RequestWithApiClient = Request & { apiClient: ExternalApiClient };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly clientsService: ExternalApiClientsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithApiClient>();
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Header X-Api-Key mancante');
    }
    const client = await this.clientsService.findActiveByKey(apiKey);
    if (!client) {
      throw new UnauthorizedException('API key non valida o revocata');
    }
    req.apiClient = client;
    void this.clientsService.touchLastUsed(client.id);
    return true;
  }
}
```

- [ ] **Step 8: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest api-key.guard --maxWorkers=2`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/external-api/external-api-clients.service.ts apps/backend/src/external-api/external-api-clients.service.spec.ts apps/backend/src/external-api/guards/
git commit -m "feat(backend): ExternalApiClientsService + ApiKeyGuard"
```

---

### Task 3: CRUD `admin/external-clients`

**Files:**
- Create: `apps/backend/src/external-api/dto/create-external-client.dto.ts`
- Create: `apps/backend/src/external-api/admin-external-clients.controller.ts`
- Create: `apps/backend/src/external-api/admin-external-clients.controller.spec.ts`
- Create: `apps/backend/src/external-api/external-api.module.ts`
- Modify: `apps/backend/src/app.module.ts` (aggiungi `ExternalApiModule`)

**Interfaces:**
- Consumes: `ExternalApiClientsService` (Task 2)
- Produces: route `admin/external-clients` (`GET`, `POST`, `POST :id/regenerate-key`, `DELETE :id` → revoke)

- [ ] **Step 1: DTO creazione client**

```typescript
// apps/backend/src/external-api/dto/create-external-client.dto.ts
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateExternalClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}
```

- [ ] **Step 2: Test del controller**

```typescript
// apps/backend/src/external-api/admin-external-clients.controller.spec.ts
import { AdminExternalClientsController } from './admin-external-clients.controller';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ExternalApiClientsService } from './external-api-clients.service';

describe('AdminExternalClientsController', () => {
  let controller: AdminExternalClientsController;
  let service: { listMasked: jest.Mock; generateKey: jest.Mock; regenerateKey: jest.Mock; revoke: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(() => {
    service = {
      listMasked: jest.fn().mockResolvedValue([]),
      generateKey: jest.fn().mockResolvedValue({ client: { id: 'c1' }, apiKeyPlain: 'plain-key' }),
      regenerateKey: jest.fn().mockResolvedValue({ client: { id: 'c1' }, apiKeyPlain: 'new-plain-key' }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminExternalClientsController(
      service as unknown as ExternalApiClientsService,
      audit as unknown as AuditLogsService,
    );
  });

  const req = { user: { username: 'admin1' } } as any;

  it('create ritorna client + apiKeyPlain e logga', async () => {
    const result = await controller.create({ name: 'Comune X' }, req);
    expect(result).toEqual({ client: { id: 'c1' }, apiKeyPlain: 'plain-key' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_CREATE', operator: 'admin1' }));
  });

  it('regenerateKey logga con action dedicata', async () => {
    await controller.regenerateKey('c1', req);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_REGENERATE_KEY' }));
  });

  it('revoke logga con action dedicata', async () => {
    await controller.revoke('c1', req);
    expect(service.revoke).toHaveBeenCalledWith('c1');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_REVOKE' }));
  });
});
```

- [ ] **Step 3: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest admin-external-clients.controller --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 4: Implementa il controller**

```typescript
// apps/backend/src/external-api/admin-external-clients.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateExternalClientDto } from './dto/create-external-client.dto';

@Controller('admin/external-clients')
@Roles('admin')
export class AdminExternalClientsController {
  constructor(
    private readonly clientsService: ExternalApiClientsService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Get()
  list() {
    return this.clientsService.listMasked();
  }

  @Post()
  async create(@Body() dto: CreateExternalClientDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const result = await this.clientsService.generateKey(dto.name);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_CREATE',
      details: { clientId: result.client.id, name: dto.name },
    });
    return result;
  }

  @Post(':id/regenerate-key')
  async regenerateKey(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    const result = await this.clientsService.regenerateKey(id);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_REGENERATE_KEY',
      details: { clientId: id },
    });
    return result;
  }

  @Delete(':id')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { user: JwtOperatorPayload }) {
    await this.clientsService.revoke(id);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'EXTERNAL_CLIENT_REVOKE',
      details: { clientId: id },
    });
    return { revoked: true };
  }
}
```

- [ ] **Step 5: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest admin-external-clients.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Crea il modulo e registralo in `app.module.ts`**

```typescript
// apps/backend/src/external-api/external-api.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalApiClient } from '../entities/external-api-client.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AdminExternalClientsController } from './admin-external-clients.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExternalApiClient]), AuditLogsModule],
  controllers: [AdminExternalClientsController],
  providers: [ExternalApiClientsService],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
```

In `apps/backend/src/app.module.ts`: aggiungi `import { ExternalApiModule } from './external-api/external-api.module';` e `ExternalApiModule` nell'array `imports`.

- [ ] **Step 7: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: nessun errore tsc, stesso failure set noto (1 fallimento pre-esistente `app.controller.spec.ts`).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/external-api/ apps/backend/src/app.module.ts
git commit -m "feat(backend): CRUD admin/external-clients"
```

---

### Task 4: UI admin — tab "API Esterne"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuova funzione `renderExternalClientsTab`, wiring nel tab bar Impostazioni, stati `wizExternal*`/`externalClients*`)

**Interfaces:**
- Consumes: `GET/POST admin/external-clients`, `POST admin/external-clients/:id/regenerate-key`, `DELETE admin/external-clients/:id` (Task 3)

- [ ] **Step 1: Individua il punto di wiring esistente**

```bash
grep -n "activeSettingsTab === 'postalizzazione'" apps/frontend-admin/src/App.tsx
grep -n "const renderPostalProvidersTab" apps/frontend-admin/src/App.tsx
grep -n "settingsTabs\s*=\|SETTINGS_TABS" apps/frontend-admin/src/App.tsx
```

Usa l'output per trovare: (a) dove aggiungere la nuova voce di tab nell'elenco dei tab di Impostazioni, (b) dove inserire `{activeSettingsTab === 'external-api' && renderExternalClientsTab()}` accanto alle altre condizioni analoghe.

- [ ] **Step 2: Aggiungi stato locale e fetch**

Vicino agli state esistenti di `PostalProviders` (`postalProviders`, `postalProvidersLoading`, ecc.), aggiungi:

```typescript
const [externalClients, setExternalClients] = useState<Array<{ id: string; name: string; active: boolean; createdAt: string; lastUsedAt: string | null }>>([]);
const [externalClientsLoading, setExternalClientsLoading] = useState(false);
const [newExternalClientName, setNewExternalClientName] = useState('');
const [revealedApiKey, setRevealedApiKey] = useState<{ clientId: string; key: string } | null>(null);

const fetchExternalClients = useCallback(async () => {
  setExternalClientsLoading(true);
  try {
    const res = await fetch(`${ADMIN_API_BASE}/external-clients`, { headers: authHeaders() });
    if (res.ok) setExternalClients(await res.json());
  } finally {
    setExternalClientsLoading(false);
  }
}, []);

useEffect(() => {
  if (activeSettingsTab === 'external-api') fetchExternalClients();
}, [activeSettingsTab, fetchExternalClients]);
```

(Adatta `authHeaders()`/pattern fetch esatto a quello già usato dalle altre tab Impostazioni nello stesso file — cercalo con `grep -n "ADMIN_API_BASE}/postal-providers" apps/frontend-admin/src/App.tsx` per copiare l'idioma esatto di header/gestione errori in uso.)

- [ ] **Step 3: Implementa `renderExternalClientsTab`**

```typescript
const renderExternalClientsTab = () => {
  const handleCreate = async () => {
    if (!newExternalClientName.trim()) return;
    const res = await fetch(`${ADMIN_API_BASE}/external-clients`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newExternalClientName.trim() }),
    });
    if (res.ok) {
      const { client, apiKeyPlain } = await res.json();
      setRevealedApiKey({ clientId: client.id, key: apiKeyPlain });
      setNewExternalClientName('');
      fetchExternalClients();
    }
  };

  const handleRegenerate = async (id: string) => {
    const res = await fetch(`${ADMIN_API_BASE}/external-clients/${id}/regenerate-key`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (res.ok) {
      const { apiKeyPlain } = await res.json();
      setRevealedApiKey({ clientId: id, key: apiKeyPlain });
    }
  };

  const handleRevoke = async (id: string) => {
    const res = await fetch(`${ADMIN_API_BASE}/external-clients/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) fetchExternalClients();
  };

  return (
    <div>
      <h3>API Esterne — Caricamento Puntuale</h3>
      <div className="mb-3 d-flex gap-2">
        <input
          className="form-control"
          placeholder="Nome client (es. Sistema Tributi)"
          value={newExternalClientName}
          onChange={(e) => setNewExternalClientName(e.target.value)}
        />
        <button className="btn btn-primary" onClick={handleCreate} disabled={!newExternalClientName.trim()}>
          Nuovo client
        </button>
      </div>
      {revealedApiKey && (
        <div className="alert alert-warning">
          API key generata (mostrata una sola volta, copiala ora):
          <code className="d-block mt-2">{revealedApiKey.key}</code>
          <button className="btn btn-sm btn-outline-secondary mt-2" onClick={() => navigator.clipboard.writeText(revealedApiKey.key)}>
            Copia
          </button>
          <button className="btn btn-sm btn-link mt-2" onClick={() => setRevealedApiKey(null)}>
            Chiudi
          </button>
        </div>
      )}
      {externalClientsLoading ? (
        <p>Caricamento...</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Stato</th>
              <th>Creato il</th>
              <th>Ultimo utilizzo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {externalClients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.active ? 'Attivo' : 'Revocato'}</td>
                <td>{new Date(c.createdAt).toLocaleString('it-IT')}</td>
                <td>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString('it-IT') : '—'}</td>
                <td>
                  <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => handleRegenerate(c.id)}>
                    Rigenera key
                  </button>
                  {c.active && (
                    <button className="btn btn-sm btn-outline-danger" onClick={() => handleRevoke(c.id)}>
                      Revoca
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
```

Nota: `className`/`btn`/`table` sono classi Bootstrap — `frontend-admin` (a differenza di `frontend-citizen`) carica Bootstrap, verificalo con `grep -n "bootstrap" apps/frontend-admin/src/main.tsx` prima di assumerlo.

- [ ] **Step 4: Aggiungi la voce di tab e il rendering condizionale**

Nel punto trovato allo Step 1, aggiungi una entry tab `{ key: 'external-api', label: 'API Esterne' }` (adatta all'esatta struttura dati esistente) e `{activeSettingsTab === 'external-api' && renderExternalClientsTab()}` accanto alle altre.

- [ ] **Step 5: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser (dev)**

```bash
docker compose up -d --build backend frontend-admin
```
Login admin/admin (LDAP mock), vai su Impostazioni → API Esterne, crea un client, verifica che la key appaia una sola volta, rigenera, revoca. Nessun cleanup richiesto per dati di test in dev locale.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(ui): tab Impostazioni API Esterne"
```

---

### Task 5: `ExternalApiExceptionFilter` — sempre HTTP 200

**Files:**
- Create: `apps/backend/src/external-api/external-api-exception.filter.ts`
- Create: `apps/backend/src/external-api/external-api-exception.filter.spec.ts`

**Interfaces:**
- Produces: `ExternalApiExceptionFilter` (Nest `ExceptionFilter`, `@Catch()` globale — intercetta QUALUNQUE eccezione)
- Produces: shape errore standard `{ success: false, error: { code: string; message: string; details?: unknown } }`

- [ ] **Step 1: Test del filter**

```typescript
// apps/backend/src/external-api/external-api-exception.filter.spec.ts
import { ArgumentsHost, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('ExternalApiExceptionFilter', () => {
  const filter = new ExternalApiExceptionFilter();

  it('normalizza UnauthorizedException a 200 con code UNAUTHORIZED', () => {
    const { host, status, json } = makeHost();
    filter.catch(new UnauthorizedException('key mancante'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'UNAUTHORIZED', message: 'key mancante' } });
  });

  it('normalizza NotFoundException a 200 con code NOT_FOUND', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('non trovato'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'NOT_FOUND', message: 'non trovato' } });
  });

  it('normalizza BadRequestException (validazione class-validator, array di messaggi) a VALIDATION_ERROR', () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException(['subject troppo corto', 'cf non valido']), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details: ['subject troppo corto', 'cf non valido'] },
    });
  });

  it('normalizza un errore generico non-HttpException a INTERNAL_ERROR senza esporre lo stack', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('boom interno con dettagli sensibili'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Errore interno' } });
  });
});
```

- [ ] **Step 2: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest external-api-exception.filter --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 3: Implementa il filter**

```typescript
// apps/backend/src/external-api/external-api-exception.filter.ts
import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

interface NormalizedError {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

@Catch()
export class ExternalApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ExternalApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.normalize(exception);
    if (body.error.code === 'INTERNAL_ERROR') {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(200).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof UnauthorizedException) {
      return { success: false, error: { code: 'UNAUTHORIZED', message: this.messageOf(exception) } };
    }
    if (exception instanceof NotFoundException) {
      return { success: false, error: { code: 'NOT_FOUND', message: this.messageOf(exception) } };
    }
    if (exception instanceof BadRequestException) {
      const response = exception.getResponse();
      const details = typeof response === 'object' && response !== null && 'message' in response ? (response as { message: unknown }).message : this.messageOf(exception);
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details } };
    }
    if (exception instanceof HttpException) {
      return { success: false, error: { code: 'LAUNCH_BLOCKED', message: this.messageOf(exception) } };
    }
    return { success: false, error: { code: 'INTERNAL_ERROR', message: 'Errore interno' } };
  }

  private messageOf(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const msg = (response as { message: unknown }).message;
      return typeof msg === 'string' ? msg : exception.message;
    }
    return exception.message;
  }
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-api-exception.filter --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-api-exception.filter.ts apps/backend/src/external-api/external-api-exception.filter.spec.ts
git commit -m "feat(backend): ExternalApiExceptionFilter — sempre HTTP 200"
```

---

### Task 6: Upload allegati esterni + retention token

**Files:**
- Create: `apps/backend/src/external-api/external-attachment-tokens.service.ts`
- Create: `apps/backend/src/external-api/external-attachment-tokens.service.spec.ts`
- Create: `apps/backend/src/external-api/external-attachments.controller.ts`
- Create: `apps/backend/src/external-api/external-attachments.controller.spec.ts`
- Create: `apps/backend/src/external-api/external-attachment-retention.service.ts`
- Modify: `apps/backend/src/external-api/external-api.module.ts`

**Interfaces:**
- Consumes: `assembleChunkedUpload`, `chunkUploadDir`, `cleanupChunkedUpload`, `initChunkedUpload`, `MAX_CHUNK_SIZE_BYTES` da `../campaigns/chunked-upload.util`
- Produces: `ExternalAttachmentTokensService { completeUpload(clientId: string, uploadId: string): Promise<{ token: string }>; resolve(clientId: string, token: string): { path: string; filename: string } | null; markConsumed(clientId: string, token: string): void; }`
- Produces: route `external/v1/attachments/upload/{init,chunk,complete}`

- [ ] **Step 1: Test del token service**

```typescript
// apps/backend/src/external-api/external-attachment-tokens.service.spec.ts
import * as fs from 'fs';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import * as chunkedUpload from '../campaigns/chunked-upload.util';

jest.mock('../campaigns/chunked-upload.util');

describe('ExternalAttachmentTokensService', () => {
  let service: ExternalAttachmentTokensService;
  const root = '/tmp/comunicapa-uploads/external-attachments-test';

  beforeEach(() => {
    service = new ExternalAttachmentTokensService();
    (service as any).root = root;
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('completeUpload assembla il chunked upload e lo materializza sotto un token scoped per client', async () => {
    (chunkedUpload.assembleChunkedUpload as jest.Mock).mockResolvedValue({ path: '/tmp/fake-assembled.pdf', filename: 'avviso.pdf' });
    jest.spyOn(fs, 'copyFileSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    (chunkedUpload.cleanupChunkedUpload as jest.Mock).mockImplementation(() => undefined);

    const { token } = await service.completeUpload('client-1', 'upload-1');

    expect(token).toEqual(expect.any(String));
    expect(chunkedUpload.assembleChunkedUpload).toHaveBeenCalledWith('upload-1');
    expect(chunkedUpload.cleanupChunkedUpload).toHaveBeenCalledWith('upload-1');
  });

  it('resolve ritorna null per un token di un altro client (nessun leak cross-client)', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(service.resolve('client-2', 'token-di-client-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest external-attachment-tokens.service --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 3: Implementa il token service**

```typescript
// apps/backend/src/external-api/external-attachment-tokens.service.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { assembleChunkedUpload, cleanupChunkedUpload } from '../campaigns/chunked-upload.util';
import { getAttachmentsRoot } from '../attachments/attachment-paths';

interface TokenMeta {
  filename: string;
  createdAt: string;
  consumed: boolean;
}

@Injectable()
export class ExternalAttachmentTokensService {
  private root = join(getAttachmentsRoot(), 'external-attachments');

  private tokenDir(clientId: string, token: string): string {
    return join(this.root, clientId, token);
  }

  async completeUpload(clientId: string, uploadId: string): Promise<{ token: string }> {
    const { path, filename } = await assembleChunkedUpload(uploadId);
    const token = randomUUID();
    const dir = this.tokenDir(clientId, token);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path, join(dir, filename));
    const meta: TokenMeta = { filename, createdAt: new Date().toISOString(), consumed: false };
    fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    cleanupChunkedUpload(uploadId);
    return { token };
  }

  resolve(clientId: string, token: string): { path: string; filename: string } | null {
    const dir = this.tokenDir(clientId, token);
    const metaPath = join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
    return { path: join(dir, meta.filename), filename: meta.filename };
  }

  markConsumed(clientId: string, token: string): void {
    const metaPath = join(this.tokenDir(clientId, token), 'meta.json');
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
    meta.consumed = true;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }

  /** Usata dal retention cron (Step 8): elenca token più vecchi di `maxAgeMs`. */
  listStaleTokenDirs(maxAgeMs: number): string[] {
    if (!fs.existsSync(this.root)) return [];
    const stale: string[] = [];
    for (const clientId of fs.readdirSync(this.root)) {
      const clientDir = join(this.root, clientId);
      for (const token of fs.readdirSync(clientDir)) {
        const dir = join(clientDir, token);
        const metaPath = join(dir, 'meta.json');
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
        if (Date.now() - new Date(meta.createdAt).getTime() > maxAgeMs) stale.push(dir);
      }
    }
    return stale;
  }
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-attachment-tokens.service --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: Test del controller upload**

```typescript
// apps/backend/src/external-api/external-attachments.controller.spec.ts
import { ExternalAttachmentsController } from './external-attachments.controller';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import * as chunkedUpload from '../campaigns/chunked-upload.util';

jest.mock('../campaigns/chunked-upload.util');

describe('ExternalAttachmentsController', () => {
  let controller: ExternalAttachmentsController;
  let tokens: { completeUpload: jest.Mock };
  const req = { apiClient: { id: 'client-1' } } as any;

  beforeEach(() => {
    tokens = { completeUpload: jest.fn().mockResolvedValue({ token: 'tok-1' }) };
    controller = new ExternalAttachmentsController(tokens as unknown as ExternalAttachmentTokensService);
    (chunkedUpload.initChunkedUpload as jest.Mock).mockReturnValue('upload-1');
  });

  it('init ritorna uploadId', () => {
    const result = controller.init({ filename: 'avviso.pdf', totalChunks: 2 });
    expect(result).toEqual({ success: true, uploadId: 'upload-1' });
  });

  it('complete ritorna attachmentToken scoped al client della richiesta', async () => {
    const result = await controller.complete({ uploadId: 'upload-1' }, req);
    expect(tokens.completeUpload).toHaveBeenCalledWith('client-1', 'upload-1');
    expect(result).toEqual({ success: true, attachmentToken: 'tok-1' });
  });
});
```

- [ ] **Step 6: Run test per vedere il fallimento, poi implementa il controller**

Run: `docker compose exec backend node_modules/.bin/jest external-attachments.controller --maxWorkers=2`
Expected: FAIL — modulo non trovato

```typescript
// apps/backend/src/external-api/external-attachments.controller.ts
import { BadRequestException, Body, Controller, Param, Post, Req, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { join } from 'path';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { chunkPartPath, chunkUploadDir, initChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util';

@Controller('external/v1/attachments/upload')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalAttachmentsController {
  constructor(private readonly tokens: ExternalAttachmentTokensService) {}

  @Post('init')
  init(@Body() body: { filename: string; totalChunks: number }) {
    const uploadId = initChunkedUpload(body.filename, body.totalChunks);
    return { success: true, uploadId };
  }

  @Post('chunk')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadId = (req.body as { uploadId?: string }).uploadId;
          if (!uploadId) return cb(new BadRequestException('uploadId mancante'), '');
          const dir = chunkUploadDir(uploadId);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = (req.body as { index?: string }).index;
          cb(null, `${index}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  chunk(@UploadedFile() file: Express.Multer.File, @Body() body: { uploadId: string; index: string }) {
    if (!file) throw new BadRequestException('chunk mancante');
    return { success: true };
  }

  @Post('complete')
  async complete(@Body() body: { uploadId: string }, @Req() req: RequestWithApiClient) {
    const { token } = await this.tokens.completeUpload(req.apiClient.id, body.uploadId);
    return { success: true, attachmentToken: token };
  }
}
```

Nota: `chunkPartPath` non serve qui (multer scrive già col nome corretto via `filename` sopra) — rimuovilo dall'import se il linter lo segnala come inutilizzato.

- [ ] **Step 7: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-attachments.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 8: Cron di retention token non consumati**

```typescript
// apps/backend/src/external-api/external-attachment-retention.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, coerente col design

@Injectable()
export class ExternalAttachmentRetentionService {
  private readonly logger = new Logger(ExternalAttachmentRetentionService.name);

  constructor(private readonly tokens: ExternalAttachmentTokensService) {}

  @Cron(CronExpression.EVERY_HOUR)
  cleanupStaleTokens(): void {
    const staleDirs = this.tokens.listStaleTokenDirs(MAX_AGE_MS);
    for (const dir of staleDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (staleDirs.length > 0) {
      this.logger.log(`Rimossi ${staleDirs.length} token allegato esterni non consumati entro 24h`);
    }
  }
}
```

- [ ] **Step 9: Registra tutto nel modulo**

In `external-api.module.ts`: aggiungi `MulterModule` non serve (usato per-route via `@UseInterceptors`), aggiungi `ExternalAttachmentTokensService`, `ExternalAttachmentRetentionService` a `providers`, `ExternalAttachmentsController` a `controllers`.

- [ ] **Step 10: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/external-api/
git commit -m "feat(backend): upload allegati esterni con token scoped-per-client + retention"
```

---

### Task 7: `CreateExternalNotificationDto` + validazione

**Files:**
- Create: `apps/backend/src/external-api/dto/create-external-notification.dto.ts`
- Create: `apps/backend/src/external-api/dto/create-external-notification.dto.spec.ts`

**Interfaces:**
- Produces: `CreateExternalNotificationDto { channelType: NotificationChannel; codiceFiscale: string; email?: string; pec?: string; extraData: Record<string,string>; attachments?: { token: string; label?: string }[]; protocolla?: boolean; subject?: string; body?: string }`

- [ ] **Step 1: Test dei casi limite**

```typescript
// apps/backend/src/external-api/dto/create-external-notification.dto.spec.ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateExternalNotificationDto } from './create-external-notification.dto';

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateExternalNotificationDto, payload);
  return validate(dto);
}

describe('CreateExternalNotificationDto', () => {
  const base = {
    channelType: 'EMAIL',
    codiceFiscale: 'RSSMRA80A01H501U',
    email: 'test@example.com',
    extraData: {},
  };

  it('payload EMAIL minimo valido non produce errori', async () => {
    expect(await validateDto(base)).toHaveLength(0);
  });

  it('CF malformato (lunghezza sbagliata) produce errore', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'TROPPOCORTO' });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(true);
  });

  it('EMAIL senza campo email né pec produce errore', async () => {
    const errors = await validateDto({ channelType: 'EMAIL', codiceFiscale: base.codiceFiscale, extraData: {} });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('APP_IO con subject sotto i 10 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'corto', body: 'x'.repeat(80) });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('APP_IO con body sotto gli 80 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'oggetto valido di 12+', body: 'troppo corto' });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con subject/body ai bordi esatti [10,120]/[80,10000] è valido', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(10),
      body: 'x'.repeat(80),
    });
    expect(errors).toHaveLength(0);
  });

  it('SEND senza protocolla=true produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'SEND', attachments: [{ token: 't1' }], protocolla: false });
    expect(errors.some((e) => e.property === 'protocolla')).toBe(true);
  });

  it('SEND senza attachments produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'SEND', protocolla: true, attachments: [] });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('POSTAL senza attachments produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'POSTAL', attachments: [] });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('secondaryAppIo valido (parallel, campi opzionali) non produce errori', async () => {
    const errors = await validateDto({ ...base, secondaryAppIo: { subjectOverride: 'oggetto valido' } });
    expect(errors).toHaveLength(0);
  });

  it('SEND/POSTAL valido con attachments popolato non produce errori', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: 't1', label: 'Atto' }],
    });
    expect(errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest create-external-notification.dto --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 3: Implementa il DTO**

```typescript
// apps/backend/src/external-api/dto/create-external-notification.dto.ts
import { ArrayMinSize, Equals, IsArray, IsEnum, IsIn, IsObject, IsOptional, IsString, Length, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { NotificationChannel } from '@comunicapa/shared-types';

const CF_PATTERN = /^[A-Za-z0-9]{16}$/;

class ExternalAttachmentRefDto {
  @IsString()
  token!: string;

  @IsString()
  @IsOptional()
  label?: string;
}

/**
 * Stesso principio di TestSendDto (test-send.dto.ts): `extraData` porta
 * qualunque colonna aggiuntiva il chiamante voglia passare (es. indirizzo
 * postale completo per POSTAL) — il backend non deduce mapping, il
 * chiamante esterno mette le chiavi che il canale scelto si aspetta.
 *
 * Validazione nuova, non esiste altrove nel backend fuori dal frontend
 * wizard (vedi design doc): questo DTO è l'UNICO gate per un payload che
 * arriva senza mai passare dalle validazioni client-side di App.tsx.
 */
class SecondaryAppIoDto {
  @IsString()
  @IsOptional()
  subjectOverride?: string;

  @IsString()
  @IsOptional()
  bodyOverride?: string;
}

export class CreateExternalNotificationDto {
  @IsIn(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  /**
   * Co-consegna App IO in parallelo (mai esclusiva — vedi design doc,
   * sezione "Eccezione — App IO parallela": l'esclusiva presuppone un check
   * di dirottamento che il client ha già fatto a monte via domicilio/cerca).
   */
  @ValidateNested()
  @Type(() => SecondaryAppIoDto)
  @IsOptional()
  secondaryAppIo?: SecondaryAppIoDto;

  @IsString()
  @Matches(CF_PATTERN, { message: 'codiceFiscale deve essere alfanumerico di 16 caratteri' })
  codiceFiscale!: string;

  @ValidateIf((o) => o.channelType === 'EMAIL' && !o.pec)
  @IsString({ message: 'email obbligatoria per canale EMAIL (o valorizzare pec)' })
  email?: string;

  @ValidateIf((o) => o.channelType === 'PEC' && !o.email)
  @IsString({ message: 'pec obbligatoria per canale PEC (o valorizzare email)' })
  pec?: string;

  @IsObject()
  extraData!: Record<string, string>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalAttachmentRefDto)
  @IsOptional()
  @ValidateIf((o) => o.channelType === 'SEND' || o.channelType === 'POSTAL')
  @ArrayMinSize(1, { message: 'attachments obbligatorio (almeno 1) per SEND e POSTAL' })
  attachments?: ExternalAttachmentRefDto[];

  @ValidateIf((o) => o.channelType === 'SEND')
  @Equals(true, { message: 'protocolla deve essere true per canale SEND' })
  protocolla?: boolean;

  @ValidateIf((o) => o.channelType === 'APP_IO')
  @IsString()
  @Length(10, 120, { message: 'subject deve avere lunghezza tra 10 e 120 caratteri' })
  subject?: string;

  @ValidateIf((o) => o.channelType === 'APP_IO')
  @IsString()
  @Length(80, 10000, { message: 'body deve avere lunghezza tra 80 e 10000 caratteri' })
  body?: string;
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest create-external-notification.dto --maxWorkers=2`
Expected: PASS (se un caso limite fallisce per un dettaglio di `class-validator`, es. `@ValidateIf` con `email`/`pec` mutuamente opzionali su EMAIL — verifica l'errore riportato e aggiusta la condizione, non il test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/dto/create-external-notification.dto.ts apps/backend/src/external-api/dto/create-external-notification.dto.spec.ts
git commit -m "feat(backend): CreateExternalNotificationDto con validazione per canale"
```

---

### Task 8: `CampaignsService` — `setExternalClientId()` + `addSingleRecipient()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `CampaignsService.setExternalClientId(campaignId: string, externalClientId: string): Promise<void>`
- Produces: `CampaignsService.addSingleRecipient(campaignId: string, data: { codiceFiscale: string; email?: string | null; pec?: string | null; extraData: Record<string, unknown> }): Promise<Recipient>`

- [ ] **Step 1: Individua dove aggiungere i metodi**

```bash
grep -n "^  create(dto: CreateCampaignDto" apps/backend/src/campaigns/campaigns.service.ts
```

Aggiungi i due nuovi metodi subito dopo `create()` (riga ~353 secondo l'esplorazione fatta in fase di design — verifica il numero esatto con la grep sopra, potrebbe essere leggermente diverso al momento dell'implementazione).

- [ ] **Step 2: Scrivi i test (aggiunti al file spec esistente)**

Apri `apps/backend/src/campaigns/campaigns.service.spec.ts`, individua il blocco di test relativo a `create()` (`grep -n "describe('create'" apps/backend/src/campaigns/campaigns.service.spec.ts`) e aggiungi, nello stesso stile di mock già in uso in quel file:

```typescript
describe('setExternalClientId', () => {
  it('aggiorna la colonna externalClientId sulla campagna', async () => {
    await service.setExternalClientId('camp-1', 'client-1');
    expect(campaignRepo.update).toHaveBeenCalledWith({ id: 'camp-1' }, { externalClientId: 'client-1' });
  });
});

describe('addSingleRecipient', () => {
  it('crea e salva un Recipient PENDING con i dati passati', async () => {
    recipientRepo.create.mockReturnValue({ id: 'rec-1' });
    recipientRepo.save.mockResolvedValue({ id: 'rec-1' });

    const result = await service.addSingleRecipient('camp-1', {
      codiceFiscale: 'RSSMRA80A01H501U',
      email: 'test@example.com',
      pec: null,
      extraData: { indirizzo: 'Via Roma 1' },
    });

    expect(recipientRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'camp-1',
        codiceFiscale: 'RSSMRA80A01H501U',
        email: 'test@example.com',
        pec: null,
        extraData: { indirizzo: 'Via Roma 1' },
        status: RecipientStatus.PENDING,
      }),
    );
    expect(result).toEqual({ id: 'rec-1' });
  });
});
```

Verifica quali mock (`campaignRepo`, `recipientRepo`) sono già definiti nel file — riusa gli stessi nomi/istanze, non crearne di nuovi.

- [ ] **Step 3: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "setExternalClientId|addSingleRecipient" --maxWorkers=2`
Expected: FAIL — metodi non esistenti su `CampaignsService`

- [ ] **Step 4: Implementa i due metodi**

```typescript
  async setExternalClientId(campaignId: string, externalClientId: string): Promise<void> {
    await this.campaignRepo.update({ id: campaignId }, { externalClientId });
  }

  /**
   * Riusa lo stesso pattern già visto in launchTestSend() (creazione singolo
   * Recipient PENDING), estratto qui come metodo pubblico riusabile anche
   * dal path esterno — nessuna duplicazione della logica campo-per-campo.
   */
  async addSingleRecipient(
    campaignId: string,
    data: { codiceFiscale: string; email?: string | null; pec?: string | null; extraData: Record<string, unknown> },
  ): Promise<Recipient> {
    const recipient = this.recipientRepo.create({
      campaignId,
      codiceFiscale: data.codiceFiscale,
      email: data.email ?? null,
      pec: data.pec ?? null,
      fullName: (data.extraData['full_name'] as string | undefined) ?? null,
      extraData: data.extraData,
      status: RecipientStatus.PENDING,
    });
    return this.recipientRepo.save(recipient);
  }
```

Verifica che `Recipient` sia già importato nel file (`import { Recipient, RecipientStatus } from '../entities/recipient.entity';` o simile) — se manca, aggiungilo.

- [ ] **Step 5: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "setExternalClientId|addSingleRecipient" --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Suite completa campaigns (rischio regressione su file grande)**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS, stesso failure set noto

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): CampaignsService.setExternalClientId + addSingleRecipient"
```

---

### Task 9: `ExternalApiService.createAndLaunch()` + `POST external/v1/notifications`

**Files:**
- Create: `apps/backend/src/external-api/external-api.service.ts`
- Create: `apps/backend/src/external-api/external-api.service.spec.ts`
- Create: `apps/backend/src/external-api/external-notifications.controller.ts`
- Create: `apps/backend/src/external-api/external-notifications.controller.spec.ts`
- Modify: `apps/backend/src/external-api/external-api.module.ts`
- Modify: `apps/backend/src/entities/campaign.entity.ts` — nessuna modifica ulteriore (già fatto Task 1)

**Interfaces:**
- Consumes: `CampaignsService.create/setExternalClientId/addSingleRecipient/launch` (Task 8, esistente), `ExternalAttachmentTokensService.resolve/markConsumed` (Task 6), `AuditLogsService.log` (esistente)
- Produces: `ExternalApiService.createAndLaunch(dto: CreateExternalNotificationDto, apiClient: ExternalApiClient): Promise<{ success: true; campaignId: string; status: string } | { success: false; error: { code: string; message: string } }>`

- [ ] **Step 1: Test del service**

```typescript
// apps/backend/src/external-api/external-api.service.spec.ts
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import * as fs from 'fs';

jest.mock('fs');

describe('ExternalApiService', () => {
  let service: ExternalApiService;
  let campaigns: {
    create: jest.Mock;
    setExternalClientId: jest.Mock;
    addSingleRecipient: jest.Mock;
    updateDraft: jest.Mock;
    launch: jest.Mock;
  };
  let tokens: { resolve: jest.Mock; markConsumed: jest.Mock };
  let audit: { log: jest.Mock };

  const apiClient = { id: 'client-1', name: 'Comune X' } as any;

  beforeEach(() => {
    campaigns = {
      create: jest.fn().mockResolvedValue({ id: 'camp-1', channelConfig: {} }),
      setExternalClientId: jest.fn().mockResolvedValue(undefined),
      addSingleRecipient: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      updateDraft: jest.fn().mockResolvedValue({ id: 'camp-1' }),
      launch: jest.fn().mockResolvedValue({ launched: 1, campaignId: 'camp-1' }),
    };
    tokens = { resolve: jest.fn(), markConsumed: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    (fs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (fs.copyFileSync as jest.Mock).mockReturnValue(undefined);
    service = new ExternalApiService(
      campaigns as unknown as CampaignsService,
      tokens as unknown as ExternalAttachmentTokensService,
      audit as unknown as AuditLogsService,
    );
  });

  it('canale EMAIL senza allegati: crea campagna, recipient, lancia e ritorna QUEUED', async () => {
    const result = await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'EMAIL' }),
      'external:Comune X',
    );
    expect(campaigns.setExternalClientId).toHaveBeenCalledWith('camp-1', 'client-1');
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ codiceFiscale: 'RSSMRA80A01H501U' }));
    expect(campaigns.launch).toHaveBeenCalledWith('camp-1');
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'QUEUED' });
  });

  it('canale SEND con attachments: risolve i token, copia i file e aggiorna extraData/channelConfig prima del lancio', async () => {
    tokens.resolve.mockReturnValue({ path: '/data/attachments/external-attachments/client-1/tok-1/atto.pdf', filename: 'atto.pdf' });
    await service.createAndLaunch(
      {
        channelType: 'SEND',
        codiceFiscale: 'RSSMRA80A01H501U',
        extraData: {},
        attachments: [{ token: 'tok-1', label: 'Atto' }],
        protocolla: true,
      } as any,
      apiClient,
    );
    expect(tokens.resolve).toHaveBeenCalledWith('client-1', 'tok-1');
    expect(fs.copyFileSync).toHaveBeenCalled();
    expect(tokens.markConsumed).toHaveBeenCalledWith('client-1', 'tok-1');
    expect(campaigns.updateDraft).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ channelConfig: expect.objectContaining({ attachments: [expect.objectContaining({ key: 'allegato_0', label: 'Atto' })] }) }),
    );
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ extraData: expect.objectContaining({ allegato_0: 'atto.pdf' }) }),
    );
  });

  it('secondaryAppIo popolato mappa channelConfig.secondaryChannels in modalità parallel', async () => {
    await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {}, secondaryAppIo: { subjectOverride: 'oggetto App IO' } } as any,
      apiClient,
    );
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelConfig: expect.objectContaining({
          secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', subjectOverride: 'oggetto App IO', bodyOverride: undefined }],
        }),
      }),
      'external:Comune X',
    );
  });

  it('token allegato non risolvibile ritorna errore LAUNCH_BLOCKED senza chiamare launch()', async () => {
    tokens.resolve.mockReturnValue(null);
    const result = await service.createAndLaunch(
      { channelType: 'SEND', codiceFiscale: 'RSSMRA80A01H501U', extraData: {}, attachments: [{ token: 'tok-invalido' }], protocolla: true } as any,
      apiClient,
    );
    expect(result).toEqual({ success: false, error: { code: 'LAUNCH_BLOCKED', message: expect.stringContaining('tok-invalido') } });
    expect(campaigns.launch).not.toHaveBeenCalled();
  });

  it('launch() con blocked:true propaga come LAUNCH_BLOCKED', async () => {
    campaigns.launch.mockResolvedValue({ launched: 0, campaignId: 'camp-1', blocked: true, message: 'Allegato mancante' });
    const result = await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(result).toEqual({ success: false, error: { code: 'LAUNCH_BLOCKED', message: 'Allegato mancante' } });
  });

  it('logga su AuditLogsService con operator "external:<name>" al successo', async () => {
    await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'camp-1', operator: 'external:Comune X', action: 'EXTERNAL_API_CREATE' }),
    );
  });
});
```

- [ ] **Step 2: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest external-api.service --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 3: Implementa il service**

```typescript
// apps/backend/src/external-api/external-api.service.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';
import type { AttachmentConfigEntry } from '../attachments/attachment.service';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateExternalNotificationDto } from './dto/create-external-notification.dto';
import type { ExternalApiClient } from '../entities/external-api-client.entity';

export type CreateAndLaunchResult =
  | { success: true; campaignId: string; status: 'QUEUED' }
  | { success: false; error: { code: string; message: string } };

@Injectable()
export class ExternalApiService {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly tokens: ExternalAttachmentTokensService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async createAndLaunch(dto: CreateExternalNotificationDto, apiClient: ExternalApiClient): Promise<CreateAndLaunchResult> {
    const secondaryChannels = dto.secondaryAppIo
      ? [{ channel: 'APP_IO' as const, mode: 'parallel' as const, subjectOverride: dto.secondaryAppIo.subjectOverride, bodyOverride: dto.secondaryAppIo.bodyOverride }]
      : undefined;

    const campaign = await this.campaignsService.create(
      {
        name: `[Esterno] ${apiClient.name} — ${new Date().toISOString()}`,
        channelType: dto.channelType,
        channelConfig: {
          wizSingleMode: true,
          subject: dto.subject,
          body: dto.body,
          protocolla: dto.protocolla ?? false,
          ...(secondaryChannels ? { secondaryChannels } : {}),
        },
      } as any,
      `external:${apiClient.name}`,
    );
    await this.campaignsService.setExternalClientId(campaign.id, apiClient.id);

    const extraData: Record<string, unknown> = { ...dto.extraData };

    if (dto.attachments && dto.attachments.length > 0) {
      const attachmentsConfig: AttachmentConfigEntry[] = [];
      const destDir = getUploadsDir(campaign.id);
      fs.mkdirSync(destDir, { recursive: true });

      for (let i = 0; i < dto.attachments.length; i++) {
        const ref = dto.attachments[i];
        const resolved = this.tokens.resolve(apiClient.id, ref.token);
        if (!resolved) {
          return { success: false, error: { code: 'LAUNCH_BLOCKED', message: `Allegato con token "${ref.token}" non trovato o già scaduto` } };
        }
        const key = `allegato_${i}`;
        const destFilename = `${i}_${resolved.filename}`;
        fs.copyFileSync(resolved.path, join(destDir, destFilename));
        this.tokens.markConsumed(apiClient.id, ref.token);
        attachmentsConfig.push({ key, label: ref.label ?? `Allegato ${i + 1}` });
        extraData[key] = destFilename;
      }

      await this.campaignsService.updateDraft(campaign.id, {
        channelConfig: { ...campaign.channelConfig, attachments: attachmentsConfig },
      } as any);
    }

    await this.campaignsService.addSingleRecipient(campaign.id, {
      codiceFiscale: dto.codiceFiscale,
      email: dto.email ?? null,
      pec: dto.pec ?? null,
      extraData,
    });

    const launchResult = await this.campaignsService.launch(campaign.id);
    if (launchResult.blocked) {
      return { success: false, error: { code: 'LAUNCH_BLOCKED', message: launchResult.message ?? 'Lancio bloccato' } };
    }

    await this.auditLogsService.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: `external:${apiClient.name}`,
      action: 'EXTERNAL_API_CREATE',
      details: { channelType: dto.channelType },
    });

    return { success: true, campaignId: campaign.id, status: 'QUEUED' };
  }
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-api.service --maxWorkers=2`
Expected: PASS. Se `updateDraft`/`create` hanno una firma leggermente diversa da quella assunta qui, allinea l'implementazione alla firma reale (verificata in Task 8/nel file `campaigns.service.ts` esistente), non il test.

- [ ] **Step 5: Test del controller**

```typescript
// apps/backend/src/external-api/external-notifications.controller.spec.ts
import { ExternalNotificationsController } from './external-notifications.controller';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';

describe('ExternalNotificationsController', () => {
  let controller: ExternalNotificationsController;
  let externalApi: { createAndLaunch: jest.Mock };
  let campaigns: { findOne: jest.Mock };
  const req = { apiClient: { id: 'client-1', name: 'Comune X' } } as any;

  beforeEach(() => {
    externalApi = { createAndLaunch: jest.fn().mockResolvedValue({ success: true, campaignId: 'camp-1', status: 'QUEUED' }) };
    campaigns = { findOne: jest.fn() };
    controller = new ExternalNotificationsController(
      externalApi as unknown as ExternalApiService,
      campaigns as unknown as CampaignsService,
    );
  });

  it('create delega a ExternalApiService.createAndLaunch con l\'apiClient della richiesta', async () => {
    const dto = { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any;
    const result = await controller.create(dto, req);
    expect(externalApi.createAndLaunch).toHaveBeenCalledWith(dto, req.apiClient);
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'QUEUED' });
  });

  it('getStatus ritorna NOT_FOUND se la campagna non appartiene al client chiamante', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-1', externalClientId: 'altro-client', status: 'queued' });
    const result = await controller.getStatus('camp-1', req);
    expect(result).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } });
  });

  it('getStatus ritorna lo stato se la campagna appartiene al client chiamante', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-1', externalClientId: 'client-1', status: 'completed', channelType: 'EMAIL' });
    const result = await controller.getStatus('camp-1', req);
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'completed', channelType: 'EMAIL' });
  });
});
```

- [ ] **Step 6: Run test per vedere il fallimento, poi implementa il controller**

Run: `docker compose exec backend node_modules/.bin/jest external-notifications.controller --maxWorkers=2`
Expected: FAIL — modulo non trovato

```typescript
// apps/backend/src/external-api/external-notifications.controller.ts
import { Body, Controller, Get, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreateExternalNotificationDto } from './dto/create-external-notification.dto';

@Controller('external/v1/notifications')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalNotificationsController {
  constructor(
    private readonly externalApiService: ExternalApiService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Post()
  create(@Body() dto: CreateExternalNotificationDto, @Req() req: RequestWithApiClient) {
    return this.externalApiService.createAndLaunch(dto, req.apiClient);
  }

  @Get(':campaignId')
  async getStatus(@Param('campaignId') campaignId: string, @Req() req: RequestWithApiClient) {
    const campaign = await this.campaignsService.findOne(campaignId).catch(() => null);
    // Stesso messaggio sia per "non esiste" sia per "non è tuo" — mai enumeration
    // (vedi design doc, gotcha già noto in altri endpoint di questo repo).
    if (!campaign || campaign.externalClientId !== req.apiClient.id) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } };
    }
    return { success: true, campaignId: campaign.id, status: campaign.status, channelType: campaign.channelType };
  }
}
```

- [ ] **Step 7: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-notifications.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 8: Registra tutto nel modulo, importa `CampaignsModule`**

In `external-api.module.ts`: aggiungi `import { CampaignsModule } from '../campaigns/campaigns.module';` in `imports`, `ExternalApiService` in `providers`, `ExternalNotificationsController` in `controllers`.

- [ ] **Step 9: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: nessun errore, stesso failure set noto (1 pre-esistente).

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/external-api/
git commit -m "feat(backend): ExternalApiService.createAndLaunch + endpoint POST/GET notifications"
```

---

### Task 10: `GET external/v1/capabilities`

**Files:**
- Create: `apps/backend/src/external-api/external-capabilities.controller.ts`
- Create: `apps/backend/src/external-api/external-capabilities.controller.spec.ts`
- Modify: `apps/backend/src/external-api/external-api.module.ts` (import `MailConfigsModule`, `IoServicesModule`, `PostalProvidersModule`, `SettingsModule`)

**Interfaces:**
- Consumes: `MailConfigsService.listMasked()`, `IoServicesService.resolveApiKey()`, `PostalProvidersService.getActive()`, `AppSettingsService.get()` (tutti esistenti)
- Produces: route `GET external/v1/capabilities`

- [ ] **Step 1: Verifica le firme reali dei metodi consumati**

```bash
grep -n "async listMasked\|async resolveApiKey\|async getActive" apps/backend/src/mail-configs/mail-configs.service.ts apps/backend/src/io-services/io-services.service.ts apps/backend/src/postal-providers/postal-providers.service.ts
```

Conferma i tipi di ritorno esatti prima di scrivere il test (se un dettaglio di shape differisce da quanto assunto qui — es. nome del campo `type` su `MailConfigMaskedDto` — allinea il test alla realtà, non il codice al test).

- [ ] **Step 2: Test del controller**

```typescript
// apps/backend/src/external-api/external-capabilities.controller.spec.ts
import { ExternalCapabilitiesController } from './external-capabilities.controller';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { PostalProvidersService } from '../postal-providers/postal-providers.service';
import { AppSettingsService } from '../settings/app-settings.service';

describe('ExternalCapabilitiesController', () => {
  let controller: ExternalCapabilitiesController;
  let mailConfigs: { listMasked: jest.Mock };
  let ioServices: { resolveApiKey: jest.Mock };
  let postalProviders: { getActive: jest.Mock };
  let settings: { get: jest.Mock };

  beforeEach(() => {
    mailConfigs = {
      listMasked: jest.fn().mockResolvedValue([
        { type: 'EMAIL', active: true },
        { type: 'PEC', active: false },
      ]),
    };
    ioServices = { resolveApiKey: jest.fn().mockResolvedValue(null) };
    postalProviders = { getActive: jest.fn().mockResolvedValue(null) };
    settings = {
      get: jest.fn(async (key: string) => {
        if (key === 'send.enabledTaxonomyCodes') return '["TARI","SANZIONI"]';
        if (key === 'send.environment') return 'collaudo';
        if (key === 'send.test.group') return 'gruppo-1';
        return '';
      }),
    };
    controller = new ExternalCapabilitiesController(
      mailConfigs as unknown as MailConfigsService,
      ioServices as unknown as IoServicesService,
      postalProviders as unknown as PostalProvidersService,
      settings as unknown as AppSettingsService,
    );
  });

  it('EMAIL attivo, PEC non attivo, riflette listMasked()', async () => {
    const result = await controller.get();
    expect(result.channels.EMAIL).toEqual({ active: true });
    expect(result.channels.PEC).toEqual({ active: false });
  });

  it('APP_IO e appIoSecondary non attivi se resolveApiKey ritorna null', async () => {
    const result = await controller.get();
    expect(result.channels.APP_IO).toEqual({ active: false });
    expect(result.appIoSecondary).toEqual({ available: false });
  });

  it('APP_IO attivo se resolveApiKey ritorna una chiave', async () => {
    ioServices.resolveApiKey.mockResolvedValue({ apiKey: 'k', idService: 's1' });
    const result = await controller.get();
    expect(result.channels.APP_IO).toEqual({ active: true });
    expect(result.appIoSecondary).toEqual({ available: true });
  });

  it('SEND riflette enabledTaxonomyCodes e requiresGroup', async () => {
    const result = await controller.get();
    expect(result.channels.SEND).toEqual({ active: true, enabledTaxonomyCodes: ['TARI', 'SANZIONI'], requiresGroup: true });
  });

  it('POSTAL non attivo se nessun provider attivo', async () => {
    const result = await controller.get();
    expect(result.channels.POSTAL).toEqual({ active: false, enabledServiceTypes: [], contratti: [] });
  });

  it('POSTAL attivo riflette enabledServiceTypes/contratti del provider attivo', async () => {
    postalProviders.getActive.mockResolvedValue({ enabledServiceTypes: ['Raccomandata1Market'], contratti: [{ codiceContratto: 'C1', descrizione: 'd', tipologia: 't', estero: false }] });
    const result = await controller.get();
    expect(result.channels.POSTAL).toEqual({
      active: true,
      enabledServiceTypes: ['Raccomandata1Market'],
      contratti: [{ codiceContratto: 'C1', descrizione: 'd', tipologia: 't', estero: false }],
    });
  });
});
```

- [ ] **Step 3: Run test per vedere il fallimento**

Run: `docker compose exec backend node_modules/.bin/jest external-capabilities.controller --maxWorkers=2`
Expected: FAIL — modulo non trovato

- [ ] **Step 4: Implementa il controller**

```typescript
// apps/backend/src/external-api/external-capabilities.controller.ts
import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { PostalProvidersService } from '../postal-providers/postal-providers.service';
import { AppSettingsService } from '../settings/app-settings.service';

@Controller('external/v1/capabilities')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalCapabilitiesController {
  constructor(
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly postalProviders: PostalProvidersService,
    private readonly settings: AppSettingsService,
  ) {}

  @Get()
  async get() {
    const [mailList, appIoKey, postalActive, taxonomyRaw, sendEnv] = await Promise.all([
      this.mailConfigs.listMasked(),
      this.ioServices.resolveApiKey(),
      this.postalProviders.getActive(),
      this.settings.get<string>('send.enabledTaxonomyCodes'),
      this.settings.get<string>('send.environment'),
    ]);

    const emailActive = mailList.some((c) => c.type === 'EMAIL' && c.active);
    const pecActive = mailList.some((c) => c.type === 'PEC' && c.active);
    const appIoActive = appIoKey !== null;
    const sendGroup = await this.settings.get<string>(`send.${sendEnv === 'produzione' ? 'prod' : 'test'}.group`);
    let enabledTaxonomyCodes: string[] = [];
    try {
      enabledTaxonomyCodes = JSON.parse(taxonomyRaw || '[]');
    } catch {
      enabledTaxonomyCodes = [];
    }

    return {
      success: true,
      channels: {
        EMAIL: { active: emailActive },
        PEC: { active: pecActive },
        APP_IO: { active: appIoActive },
        SEND: { active: enabledTaxonomyCodes.length > 0, enabledTaxonomyCodes, requiresGroup: !!sendGroup },
        POSTAL: {
          active: postalActive !== null,
          enabledServiceTypes: postalActive?.enabledServiceTypes ?? [],
          contratti: postalActive?.contratti ?? [],
        },
      },
      appIoSecondary: { available: appIoActive },
    };
  }
}
```

Verifica il nome esatto del file/classe `AppSettingsService` (`grep -n "class AppSettingsService" apps/backend/src/settings/*.ts`) — se il metodo `get()` non è generico (`get<T>`) o il path del modulo differisce, allinea gli import.

- [ ] **Step 5: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-capabilities.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Registra il controller e i moduli dipendenti**

In `external-api.module.ts`: aggiungi `MailConfigsModule`, `IoServicesModule`, `PostalProvidersModule` (già `@Global()`, ma import esplicito comunque corretto per chiarezza dipendenze) e `SettingsModule` a `imports`, `ExternalCapabilitiesController` a `controllers`.

- [ ] **Step 7: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/external-api/
git commit -m "feat(backend): GET external/v1/capabilities — discovery canali attivi istanza"
```

---

### Task 11: `POST external/v1/domicilio/cerca`

**Files:**
- Create: `apps/backend/src/external-api/external-domicilio.controller.ts`
- Create: `apps/backend/src/external-api/external-domicilio.controller.spec.ts`
- Create: `apps/backend/src/external-api/dto/cerca-domicilio-external.dto.ts`
- Modify: `apps/backend/src/external-api/external-api.module.ts` (import `DomicilioModule`, `AuditLogsModule` già presente)

**Interfaces:**
- Consumes: `DomicilioService.cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult>` (esistente)
- Produces: route `POST external/v1/domicilio/cerca`

- [ ] **Step 1: DTO richiesta**

```typescript
// apps/backend/src/external-api/dto/cerca-domicilio-external.dto.ts
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CercaDomicilioExternalDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{16}$/, { message: 'codiceFiscale deve essere alfanumerico di 16 caratteri' })
  codiceFiscale!: string;
}
```

- [ ] **Step 2: Test del controller**

```typescript
// apps/backend/src/external-api/external-domicilio.controller.spec.ts
import { ExternalDomicilioController } from './external-domicilio.controller';
import { DomicilioService } from '../channels/domicilio/domicilio.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

describe('ExternalDomicilioController', () => {
  let controller: ExternalDomicilioController;
  let domicilioService: { cercaDomicilio: jest.Mock };
  let audit: { log: jest.Mock };
  const req = { apiClient: { id: 'client-1', name: 'Comune X' } } as any;

  beforeEach(() => {
    domicilioService = { cercaDomicilio: jest.fn().mockResolvedValue({ codiceFiscale: 'RSSMRA80A01H501U', inad: {}, appIo: {}, anpr: {} }) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ExternalDomicilioController(
      domicilioService as unknown as DomicilioService,
      audit as unknown as AuditLogsService,
    );
  });

  it('cerca delega a DomicilioService con label operatore "external:<name>" e ritorna success:true + risultato', async () => {
    const result = await controller.cerca({ codiceFiscale: 'RSSMRA80A01H501U' }, req);
    expect(domicilioService.cercaDomicilio).toHaveBeenCalledWith('RSSMRA80A01H501U', 'external:Comune X');
    expect(result).toEqual({ success: true, codiceFiscale: 'RSSMRA80A01H501U', inad: {}, appIo: {}, anpr: {} });
  });

  it('logga su AuditLogsService con action EXTERNAL_DOMICILIO_SEARCH e il CF cercato', async () => {
    await controller.cerca({ codiceFiscale: 'RSSMRA80A01H501U' }, req);
    expect(audit.log).toHaveBeenCalledWith({
      operator: 'external:Comune X',
      action: 'EXTERNAL_DOMICILIO_SEARCH',
      details: { codiceFiscale: 'RSSMRA80A01H501U' },
    });
  });
});
```

- [ ] **Step 3: Run test per vedere il fallimento, poi implementa il controller**

Run: `docker compose exec backend node_modules/.bin/jest external-domicilio.controller --maxWorkers=2`
Expected: FAIL — modulo non trovato

```typescript
// apps/backend/src/external-api/external-domicilio.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { DomicilioService } from '../channels/domicilio/domicilio.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CercaDomicilioExternalDto } from './dto/cerca-domicilio-external.dto';

@Controller('external/v1/domicilio')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalDomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Post('cerca')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioExternalDto, @Req() req: RequestWithApiClient) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    const result = await this.domicilioService.cercaDomicilio(cf, `external:${req.apiClient.name}`);
    await this.auditLogsService.log({
      operator: `external:${req.apiClient.name}`,
      action: 'EXTERNAL_DOMICILIO_SEARCH',
      details: { codiceFiscale: cf },
    });
    return { success: true, ...result };
  }
}
```

- [ ] **Step 4: Run test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest external-domicilio.controller --maxWorkers=2`
Expected: PASS (se il test Step 2 assume `toUpperCase()`/`trim()` su un CF già in maiuscolo, il risultato coincide comunque — nessun aggiustamento atteso)

- [ ] **Step 5: Registra nel modulo**

In `external-api.module.ts`: aggiungi `import { DomicilioModule } from '../channels/domicilio/domicilio.module';` a `imports`, `ExternalDomicilioController` a `controllers`.

- [ ] **Step 6: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/external-api/
git commit -m "feat(backend): POST external/v1/domicilio/cerca — lookup ANPR/INAD/AppIO per il client esterno"
```

---

### Task 12: Test end-to-end manuale con token JWT/API key reali

**Files:** nessuno (verifica manuale, nessun codice nuovo)

- [ ] **Step 1: Rebuild e avvio stack dev**

```bash
docker compose up -d --build backend frontend-admin
```

- [ ] **Step 2: Genera un token operatore admin per creare un client via API (o usa la UI Task 4)**

```bash
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

- [ ] **Step 3: Crea un client esterno e cattura la key**

```bash
docker compose exec backend node -e "
const jwt = require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');
const token = jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'}, process.env.JWT_SECRET, {expiresIn:'10m'});
fetch('http://localhost:8080/admin/external-clients', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Test E2E' }),
}).then((r) => r.json()).then((r) => console.log(JSON.stringify(r)));
"
```
Annota `apiKeyPlain` dalla risposta.

- [ ] **Step 4: Verifica capabilities e domicilio prima del lancio**

```bash
docker compose exec backend node -e "
fetch('http://localhost:8080/external/v1/capabilities', { headers: { 'X-Api-Key': '<KEY>' } })
  .then((r) => r.json()).then((r) => console.log('capabilities:', JSON.stringify(r)));
"
docker compose exec backend node -e "
fetch('http://localhost:8080/external/v1/domicilio/cerca', {
  method: 'POST',
  headers: { 'X-Api-Key': '<KEY>', 'Content-Type': 'application/json' },
  body: JSON.stringify({ codiceFiscale: 'RSSMRA80A01H501U' }),
}).then((r) => r.json()).then((r) => console.log('domicilio:', JSON.stringify(r)));
"
```
Expected: `capabilities` riflette lo stato reale configurato in dev (verifica a occhio contro cosa risulta attivo in Impostazioni); `domicilio` risponde `success:true` anche se ANPR/INAD non sono raggiungibili in dev (ogni ramo cattura il proprio errore, vedi `DomicilioService`). Verifica poi in Audit Log una riga `EXTERNAL_DOMICILIO_SEARCH` col CF cercato.

- [ ] **Step 5: Lancia una notifica EMAIL puntuale con la API key**

```bash
docker compose exec backend node -e "
fetch('http://localhost:8080/external/v1/notifications', {
  method: 'POST',
  headers: { 'X-Api-Key': '<INCOLLA_LA_KEY_QUI>', 'Content-Type': 'application/json' },
  body: JSON.stringify({ channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: {} }),
}).then((r) => r.json()).then((r) => console.log(JSON.stringify(r)));
"
```
Expected: `{"success":true,"campaignId":"...","status":"QUEUED"}`

- [ ] **Step 6: Verifica polling stato**

```bash
docker compose exec backend node -e "
fetch('http://localhost:8080/external/v1/notifications/<CAMPAIGN_ID>', { headers: { 'X-Api-Key': '<KEY>' } })
  .then((r) => r.json()).then((r) => console.log(JSON.stringify(r)));
"
```
Expected: `{"success":true,"campaignId":"...","status":"...","channelType":"EMAIL"}`

- [ ] **Step 7: Verifica il caso auth fallita risponde comunque 200**

```bash
docker compose exec backend node -e "
fetch('http://localhost:8080/external/v1/notifications', {
  method: 'POST',
  headers: { 'X-Api-Key': 'key-completamente-sbagliata', 'Content-Type': 'application/json' },
  body: JSON.stringify({ channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: {} }),
}).then((r) => console.log('status:', r.status)).then(() => {});
"
```
Expected: `status: 200`

- [ ] **Step 8: Verifica audit log**

Login admin UI → sezione Audit Log → filtra per `EXTERNAL_API_CREATE` e `EXTERNAL_CLIENT_CREATE`, conferma le righe presenti con l'operator `external:Test E2E` / `debug`.

Nessun cleanup richiesto per i dati di test creati in dev locale.

---

### Task 13: Specifica OpenAPI

**Files:**
- Create: `apps/backend/openapi/external-api.yaml`

**Interfaces:**
- Nessuna — documento statico, nessun impatto su codice runtime.

- [ ] **Step 1: Scrivi la spec**

```yaml
openapi: 3.0.3
info:
  title: ComunicaPA — API esterna caricamento puntuale
  version: 1.0.0
  description: >
    API per sistemi PA esterni per lanciare una notifica puntuale (un
    destinatario per chiamata) su un canale ComunicaPA (EMAIL/PEC/APP_IO/
    SEND/POSTAL). Tutte le risposte sono SEMPRE HTTP 200: l'esito è
    espresso nel campo `success` del body, mai nello status code (un
    reverse proxy esterno in produzione sostituisce il body delle risposte
    non-2xx con una pagina HTML propria).
servers:
  - url: /api/external/v1
security:
  - apiKey: []
paths:
  /capabilities:
    get:
      summary: Discovery — canali e opzioni realmente configurati su questa istanza
      responses:
        '200':
          description: sempre 200
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  channels:
                    type: object
                    properties:
                      EMAIL: { $ref: '#/components/schemas/ChannelCapability' }
                      PEC: { $ref: '#/components/schemas/ChannelCapability' }
                      APP_IO: { $ref: '#/components/schemas/ChannelCapability' }
                      SEND:
                        allOf:
                          - $ref: '#/components/schemas/ChannelCapability'
                          - type: object
                            properties:
                              enabledTaxonomyCodes: { type: array, items: { type: string } }
                              requiresGroup: { type: boolean }
                      POSTAL:
                        allOf:
                          - $ref: '#/components/schemas/ChannelCapability'
                          - type: object
                            properties:
                              enabledServiceTypes: { type: array, items: { type: string } }
                              contratti:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    codiceContratto: { type: string }
                                    descrizione: { type: string }
                                    tipologia: { type: string }
                                    estero: { type: boolean }
                  appIoSecondary:
                    type: object
                    properties:
                      available: { type: boolean }
  /domicilio/cerca:
    post:
      summary: >
        Lookup domicilio digitale reale del destinatario (ANPR+INAD+App IO) —
        da chiamare PRIMA di /notifications per scegliere channelType senza
        rischio di dirottamento a sorpresa.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [codiceFiscale]
              properties:
                codiceFiscale: { type: string, pattern: '^[A-Za-z0-9]{16}$' }
      responses:
        '200':
          description: sempre 200 — ogni fonte (INAD/App IO/ANPR) fallisce indipendentemente, mai un 500 totale
          content:
            application/json:
              schema:
                oneOf:
                  - type: object
                    properties:
                      success: { type: boolean, example: true }
                      codiceFiscale: { type: string }
                      inad: { type: object }
                      appIo: { type: object }
                      anpr: { type: object }
                      anprEsistenzaInVita: { type: object }
                  - $ref: '#/components/schemas/ErrorResponse'
  /attachments/upload/init:
    post:
      summary: Inizializza un upload allegato a chunk
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [filename, totalChunks]
              properties:
                filename: { type: string, example: avviso.pdf }
                totalChunks: { type: integer, minimum: 1, example: 3 }
      responses:
        '200':
          description: uploadId generato
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  uploadId: { type: string, format: uuid }
  /attachments/upload/chunk:
    post:
      summary: Carica un singolo chunk (max 2MB, chunk client-side consigliato 512KB)
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [uploadId, index, chunk]
              properties:
                uploadId: { type: string, format: uuid }
                index: { type: integer, minimum: 0 }
                chunk: { type: string, format: binary }
      responses:
        '200':
          description: chunk ricevuto
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
  /attachments/upload/complete:
    post:
      summary: Assembla i chunk e restituisce il token allegato
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [uploadId]
              properties:
                uploadId: { type: string, format: uuid }
      responses:
        '200':
          description: >
            attachmentToken opaco, valido 24h e consumato al primo lancio
            che lo referenzia — non riusabile su più chiamate.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  attachmentToken: { type: string, format: uuid }
  /notifications:
    post:
      summary: Crea e lancia una notifica puntuale (asincrono — risposta immediata, stato via GET)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateNotificationRequest'
            examples:
              email_minimo:
                summary: EMAIL — payload minimo
                value:
                  channelType: EMAIL
                  codiceFiscale: RSSMRA80A01H501U
                  email: cittadino@example.com
                  extraData: {}
              send_completo:
                summary: SEND — con allegato obbligatorio e protocollo
                value:
                  channelType: SEND
                  codiceFiscale: RSSMRA80A01H501U
                  extraData: { indirizzo: Via Roma 1, cap: '00100', citta: Roma, provincia: RM }
                  attachments: [{ token: 3fbb1e2a-...-token, label: Atto notificato }]
                  protocolla: true
              email_con_app_io_parallela:
                summary: EMAIL con co-consegna App IO parallela
                value:
                  channelType: EMAIL
                  codiceFiscale: RSSMRA80A01H501U
                  email: cittadino@example.com
                  extraData: {}
                  secondaryAppIo: { subjectOverride: 'Hai una nuova comunicazione', bodyOverride: 'Consulta la PEC per i dettagli.' }
      responses:
        '200':
          description: sempre 200 — vedi `success` per l'esito reale
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/LaunchSuccess'
                  - $ref: '#/components/schemas/ErrorResponse'
  /notifications/{campaignId}:
    get:
      summary: Stato di una notifica lanciata da questo client
      parameters:
        - name: campaignId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: >
            sempre 200 — error.code NOT_FOUND sia per campagna inesistente
            sia per campagna di un altro client (nessuna enumeration)
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/StatusSuccess'
                  - $ref: '#/components/schemas/ErrorResponse'
components:
  securitySchemes:
    apiKey:
      type: apiKey
      in: header
      name: X-Api-Key
  schemas:
    CreateNotificationRequest:
      type: object
      required: [channelType, codiceFiscale, extraData]
      properties:
        channelType: { type: string, enum: [PEC, EMAIL, APP_IO, SEND, POSTAL] }
        codiceFiscale: { type: string, pattern: '^[A-Za-z0-9]{16}$' }
        email: { type: string, description: obbligatorio se channelType=EMAIL e pec assente }
        pec: { type: string, description: obbligatorio se channelType=PEC e email assente }
        extraData:
          type: object
          additionalProperties: { type: string }
          description: >
            colonne aggiuntive canale-specifiche (es. indirizzo postale
            completo per POSTAL) — il chiamante conosce le chiavi attese
            dal canale scelto, il backend non deduce alcun mapping.
        attachments:
          type: array
          description: obbligatorio (min 1) per SEND e POSTAL
          items:
            type: object
            required: [token]
            properties:
              token: { type: string, format: uuid }
              label: { type: string }
        protocolla: { type: boolean, description: 'deve essere true per SEND' }
        subject: { type: string, description: 'per APP_IO, lunghezza [10,120]' }
        body: { type: string, description: 'per APP_IO, lunghezza [80,10000]' }
        secondaryAppIo:
          type: object
          description: >
            co-consegna App IO in parallelo (mai esclusiva — vedi GET
            /domicilio/cerca per risolvere il canale reale a monte)
          properties:
            subjectOverride: { type: string }
            bodyOverride: { type: string }
    ChannelCapability:
      type: object
      properties:
        active: { type: boolean }
    LaunchSuccess:
      type: object
      properties:
        success: { type: boolean, example: true }
        campaignId: { type: string, format: uuid }
        status: { type: string, enum: [QUEUED] }
    StatusSuccess:
      type: object
      properties:
        success: { type: boolean, example: true }
        campaignId: { type: string, format: uuid }
        status: { type: string, enum: [draft, checking_inad, queued, running, completed, failed, cancelled] }
        channelType: { type: string, enum: [PEC, EMAIL, APP_IO, SEND, POSTAL] }
    ErrorResponse:
      type: object
      properties:
        success: { type: boolean, example: false }
        error:
          type: object
          properties:
            code: { type: string, enum: [UNAUTHORIZED, VALIDATION_ERROR, NOT_FOUND, LAUNCH_BLOCKED, INTERNAL_ERROR] }
            message: { type: string }
            details: {}
```

- [ ] **Step 2: Valida sintassi YAML**

```bash
docker run --rm -v "$(pwd)/apps/backend/openapi:/spec" node:22-alpine sh -c "node -e \"require('yaml').parse(require('fs').readFileSync('/spec/external-api.yaml','utf8'))\" 2>&1 || node -e \"const yaml=require('js-yaml'); yaml.load(require('fs').readFileSync('/spec/external-api.yaml','utf8')); console.log('YAML valido')\""
```

Se nessuno dei due moduli è disponibile nell'immagine base, usa un validatore online offline-friendly o un semplice `python3 -c "import yaml; yaml.safe_load(open('apps/backend/openapi/external-api.yaml'))"` se Python è disponibile sull'host — l'obiettivo è solo verificare che sia YAML sintatticamente corretto, non un lint semantico OpenAPI completo (fuori scope se Spectral non è già nella toolchain).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/openapi/external-api.yaml
git commit -m "docs(api): specifica OpenAPI per external-api v1"
```

---

### Task 14: Verifica finale — suite completa + type-check + aggiornamento CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (nuova sezione breve, se emergono gotcha reali durante l'implementazione dei task precedenti)

- [ ] **Step 1: Suite backend completa**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: stesso failure set noto (1 fallimento pre-esistente `app.controller.spec.ts`/`isLdapMock`), nessuna regressione.

- [ ] **Step 2: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```
Expected: nessun errore.

- [ ] **Step 3: Type-check frontend-admin**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore.

- [ ] **Step 4: Build immagine di produzione backend (verifica pattern shared-types/pnpm)**

```bash
docker build -f apps/backend/Dockerfile -t comunicapa-backend-verify .
```
Expected: build riuscita — nessuna nuova dipendenza introdotta da questo modulo, ma verifica comunque per lo stesso motivo già noto (dev bind-mount maschera bug di produzione).

- [ ] **Step 5: Aggiorna CLAUDE.md se emerso un gotcha reale**

Se durante l'esecuzione dei task precedenti è emerso un comportamento sorprendente non già documentato (es. una particolarità di `class-validator` con `@ValidateIf` multipli, o un dettaglio del pattern multer/chunk non previsto qui), aggiungi una sezione breve a `CLAUDE.md` nello stesso stile delle altre — non aggiungere nulla se non c'è stata sorpresa reale.

- [ ] **Step 6: Commit finale**

```bash
git add -A
git commit -m "chore: verifica finale API esterna caricamento puntuale"
```
