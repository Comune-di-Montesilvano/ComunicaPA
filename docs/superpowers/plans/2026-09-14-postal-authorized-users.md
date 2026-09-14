# Autorizzazione invio POSTAL + CRUD utenti abilitati Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bloccare l'avvio (`launch()`/`launchTestSend()`) di una campagna POSTAL per operatori `user` non esplicitamente autorizzati, con un pannello CRUD in Impostazioni → Postalizzazione per gestire l'elenco.

**Architecture:** Nuova tabella dedicata `postal_authorized_users` (stesso pattern di `postal_provider_configs`) con service/controller CRUD in un modulo `@Global()` proprio. `CampaignsService.launch()`/`launchTestSend()` guadagnano un parametro `requester` e un controllo che, per canale POSTAL e ruolo `user`, verifica la presenza in tabella — bloccando con lo stesso pattern 200+`{blocked:true}` già in uso per gli allegati mancanti (mai eccezione non-2xx, gotcha proxy esterno). Il login (`AuthResponseDto`) espone `canUsePostal` per far sparire l'opzione POSTAL dal wizard lato UX (il gate reale resta server-side).

**Tech Stack:** NestJS 12 (ESM) + TypeORM 0.3.x + Vitest (backend), React 19 + Vite (frontend-admin).

**Spec:** `docs/superpowers/specs/2026-09-14-postal-authorized-users-design.md`

## Global Constraints

- Il blocco copre SOLO `launch()` e `launchTestSend()` — nessun'altra azione (retry, correzione indirizzo, content-correction) va toccata.
- Riguarda solo `channelType === 'POSTAL'` come canale primario.
- Mai lanciare un'eccezione HTTP non-2xx per il blocco di autorizzazione in `launch()`/`launchTestSend()` — sempre `{ blocked: true, message }` con status 200 (gotcha reverse proxy esterno, sostituisce il body delle risposte non-2xx).
- Ogni nuovo import relativo nel backend richiede `.js` esplicito (ESM/NodeNext).
- Dopo ogni modifica di firma di un metodo/costruttore esistente, la suite completa (`docker compose exec backend node_modules/.bin/vitest run`) va eseguita per intero, non un pattern mirato — un service molto testato può avere più `Test.createTestingModule` indipendenti nello stesso file.
- Ogni migration scritta va registrata SIA nell'import SIA nell'array `migrations` di `database.module.ts` — altrimenti resta invisibile, nessun errore.
- Mai un `<form>` annidato dentro il pannello Impostazioni (è già dentro un unico `<form onSubmit={handleSaveSettings}>`) — bottoni con `onClick` espliciti, non `onSubmit`.

---

## Task 1: Entity + migration `postal_authorized_users`

**Files:**
- Create: `apps/backend/src/entities/postal-authorized-user.entity.ts`
- Create: `apps/backend/src/database/migrations/1786900000000-AddPostalAuthorizedUsersTable.ts`
- Modify: `apps/backend/src/database/database.module.ts:62` (aggiungere import) e la riga dell'array `migrations` (aggiungere `AddPostalAuthorizedUsersTable1786900000000` in coda)

**Interfaces:**
- Produce: `PostalAuthorizedUser` entity con colonne `id: string`, `username: string`, `addedBy: string`, `createdAt: Date` — usata da Task 2.

- [ ] **Step 1: Creare l'entity**

```ts
// apps/backend/src/entities/postal-authorized-user.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Elenco utenti 'user' abilitati ad avviare campagne POSTAL (oltre agli
 * admin, sempre autorizzati). Nessun campo ruolo: la presenza della riga
 * = autorizzato. username normalizzato lowercase/trim in
 * PostalAuthorizedUsersService — deve combaciare con
 * JwtOperatorPayload.username al momento del check in launch().
 */
@Entity('postal_authorized_users')
export class PostalAuthorizedUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  username!: string;

  @Column({ name: 'added_by', type: 'varchar', length: 255 })
  addedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

- [ ] **Step 2: Creare la migration**

```ts
// apps/backend/src/database/migrations/1786900000000-AddPostalAuthorizedUsersTable.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalAuthorizedUsersTable1786900000000 implements MigrationInterface {
    name = 'AddPostalAuthorizedUsersTable1786900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "postal_authorized_users" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "username" character varying(255) NOT NULL,
                "added_by" character varying(255) NOT NULL,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_postal_authorized_users_username" UNIQUE ("username"),
                CONSTRAINT "PK_postal_authorized_users" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "postal_authorized_users"`);
    }
}
```

- [ ] **Step 3: Registrare la migration in `database.module.ts`**

Aggiungere subito dopo la riga 62:

```ts
import { AddPostalAuthorizedUsersTable1786900000000 } from './migrations/1786900000000-AddPostalAuthorizedUsersTable.js';
```

Nella riga dell'array `migrations` (unica riga lunghissima), aggiungere `AddPostalAuthorizedUsersTable1786900000000` subito dopo `AddPivaColumnsToInadVerificationJobs1786800000000` (ultimo elemento):

```
..., AddPivaColumnsToInadVerificationJobs1786800000000, AddPostalAuthorizedUsersTable1786900000000],
```

- [ ] **Step 4: Verificare che la classe sia registrata**

```bash
grep -c "AddPostalAuthorizedUsersTable1786900000000" apps/backend/src/database/database.module.ts
```

Expected: `2` (import + array).

- [ ] **Step 5: Applicare la migration sul DB dev per testarla subito**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "
CREATE TABLE IF NOT EXISTS postal_authorized_users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  username character varying(255) NOT NULL,
  added_by character varying(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT UQ_postal_authorized_users_username UNIQUE (username),
  CONSTRAINT PK_postal_authorized_users PRIMARY KEY (id)
);"
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/postal-authorized-user.entity.ts apps/backend/src/database/migrations/1786900000000-AddPostalAuthorizedUsersTable.ts apps/backend/src/database/database.module.ts
git commit -m "feat: entity + migration postal_authorized_users"
```

---

## Task 2: `PostalAuthorizedUsersService` + modulo `@Global()`

**Files:**
- Create: `apps/backend/src/postal-authorized-users/postal-authorized-users.service.ts`
- Create: `apps/backend/src/postal-authorized-users/postal-authorized-users.module.ts`
- Create: `apps/backend/src/postal-authorized-users/dto/postal-authorized-user.dto.ts`
- Create: `apps/backend/src/postal-authorized-users/postal-authorized-users.service.spec.ts`
- Modify: `apps/backend/src/app.module.ts` (import + registrazione)

**Interfaces:**
- Consumes: `PostalAuthorizedUser` entity (Task 1), `OperatorDirectoryService.resolveMany(usernames: string[]): Promise<Record<string, string>>` (esistente).
- Produces: `PostalAuthorizedUsersService` con `list()`, `create(username, addedBy)`, `remove(id)`, `isAuthorized(username): Promise<boolean>` — usata da Task 3 (controller), Task 4 (CampaignsService), Task 5 (AuthService).

- [ ] **Step 1: Creare il DTO**

```ts
// apps/backend/src/postal-authorized-users/dto/postal-authorized-user.dto.ts
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePostalAuthorizedUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username!: string;
}

export interface PostalAuthorizedUserDto {
  id: string;
  username: string;
  addedBy: string;
  addedByDisplayName?: string;
  createdAt: string;
}
```

- [ ] **Step 2: Scrivere il test del service (fallirà — service non esiste ancora)**

```ts
// apps/backend/src/postal-authorized-users/postal-authorized-users.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';

describe('PostalAuthorizedUsersService', () => {
  let service: PostalAuthorizedUsersService;
  let repo: {
    find: ReturnType<typeof vi.fn>;
    existsBy: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let operatorDirectory: { resolveMany: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      find: vi.fn(),
      existsBy: vi.fn(),
      create: vi.fn((v) => v),
      save: vi.fn((v) => Promise.resolve({ id: 'new-id', createdAt: new Date('2026-01-01'), ...v })),
      delete: vi.fn(),
    };
    operatorDirectory = { resolveMany: vi.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostalAuthorizedUsersService,
        { provide: getRepositoryToken(PostalAuthorizedUser), useValue: repo },
        { provide: OperatorDirectoryService, useValue: operatorDirectory },
      ],
    }).compile();

    service = module.get(PostalAuthorizedUsersService);
  });

  describe('isAuthorized', () => {
    it('ritorna true se lo username esiste in tabella (case-insensitive)', async () => {
      repo.existsBy.mockResolvedValueOnce(true);
      const result = await service.isAuthorized('Mario.Rossi');
      expect(result).toBe(true);
      expect(repo.existsBy).toHaveBeenCalledWith({ username: 'mario.rossi' });
    });

    it('ritorna false se lo username non esiste', async () => {
      repo.existsBy.mockResolvedValueOnce(false);
      const result = await service.isAuthorized('sconosciuto');
      expect(result).toBe(false);
    });
  });

  describe('create', () => {
    it('rifiuta username vuoto', async () => {
      await expect(service.create('   ', 'admin1')).rejects.toThrow(BadRequestException);
    });

    it('rifiuta un duplicato', async () => {
      repo.existsBy.mockResolvedValueOnce(true);
      await expect(service.create('mario.rossi', 'admin1')).rejects.toThrow('Utente già abilitato');
    });

    it('normalizza e crea la riga', async () => {
      repo.existsBy.mockResolvedValueOnce(false);
      const result = await service.create('  Mario.Rossi  ', 'admin1');
      expect(repo.create).toHaveBeenCalledWith({ username: 'mario.rossi', addedBy: 'admin1' });
      expect(result.username).toBe('mario.rossi');
    });
  });

  describe('remove', () => {
    it('lancia NotFoundException se la riga non esiste', async () => {
      repo.delete.mockResolvedValueOnce({ affected: 0 });
      await expect(service.remove('no-id')).rejects.toThrow(NotFoundException);
    });

    it('elimina la riga esistente', async () => {
      repo.delete.mockResolvedValueOnce({ affected: 1 });
      await expect(service.remove('id-1')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('risolve i display name via OperatorDirectoryService', async () => {
      repo.find.mockResolvedValueOnce([
        { id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: new Date('2026-01-01') },
      ]);
      operatorDirectory.resolveMany.mockResolvedValueOnce({ admin1: 'Amministratore Uno' });

      const result = await service.list();

      expect(result).toEqual([
        {
          id: '1',
          username: 'mario.rossi',
          addedBy: 'admin1',
          addedByDisplayName: 'Amministratore Uno',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });
  });
});
```

- [ ] **Step 3: Eseguire il test per verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/vitest run postal-authorized-users.service.spec.ts
```

Expected: FAIL — `Cannot find module './postal-authorized-users.service.js'`.

- [ ] **Step 4: Implementare il service**

```ts
// apps/backend/src/postal-authorized-users/postal-authorized-users.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import type { PostalAuthorizedUserDto } from './dto/postal-authorized-user.dto.js';

@Injectable()
export class PostalAuthorizedUsersService {
  constructor(
    @InjectRepository(PostalAuthorizedUser)
    private readonly repo: Repository<PostalAuthorizedUser>,
    private readonly operatorDirectory: OperatorDirectoryService,
  ) {}

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }

  async isAuthorized(username: string): Promise<boolean> {
    return this.repo.existsBy({ username: this.normalize(username) });
  }

  async list(): Promise<PostalAuthorizedUserDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    const displayNames = await this.operatorDirectory.resolveMany(rows.map((r) => r.addedBy));
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      addedBy: r.addedBy,
      addedByDisplayName: displayNames[r.addedBy],
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(username: string, addedBy: string): Promise<PostalAuthorizedUserDto> {
    const normalized = this.normalize(username);
    if (!normalized) {
      throw new BadRequestException('Username non valido');
    }
    // Pre-check invece di catturare il vincolo unique del driver Postgres:
    // race tra due admin che aggiungono lo stesso utente nello stesso
    // istante è un edge case trascurabile per un CRUD amministrativo.
    const exists = await this.repo.existsBy({ username: normalized });
    if (exists) {
      throw new BadRequestException('Utente già abilitato');
    }
    const entity = this.repo.create({ username: normalized, addedBy });
    const saved = await this.repo.save(entity);
    return {
      id: saved.id,
      username: saved.username,
      addedBy: saved.addedBy,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) {
      throw new NotFoundException(`Utente abilitato ${id} non trovato`);
    }
  }
}
```

- [ ] **Step 5: Eseguire il test per verificare che passi**

```bash
docker compose exec backend node_modules/.bin/vitest run postal-authorized-users.service.spec.ts
```

Expected: PASS (tutti i test).

- [ ] **Step 6: Creare il modulo**

```ts
// apps/backend/src/postal-authorized-users/postal-authorized-users.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PostalAuthorizedUser]), OperatorDirectoryModule],
  providers: [PostalAuthorizedUsersService],
  exports: [PostalAuthorizedUsersService],
})
export class PostalAuthorizedUsersModule {}
```

Nota: il controller (Task 3) viene registrato in un modulo separato più avanti, non qui — questo modulo resta minimale (solo il service, `@Global()`, iniettabile ovunque senza import espliciti, stesso pattern di `PostalProvidersModule`).

- [ ] **Step 7: Registrare il modulo in `app.module.ts`**

Aggiungere l'import accanto a `PostalProvidersModule` (riga 17) e la registrazione accanto a riga 47:

```ts
import { PostalAuthorizedUsersModule } from './postal-authorized-users/postal-authorized-users.module.js';
```

```ts
    PostalAuthorizedUsersModule,
```

- [ ] **Step 8: Verificare il type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/postal-authorized-users apps/backend/src/app.module.ts
git commit -m "feat: PostalAuthorizedUsersService + modulo globale"
```

---

## Task 3: `PostalAuthorizedUsersController` (CRUD admin-only)

**Files:**
- Create: `apps/backend/src/postal-authorized-users/postal-authorized-users.controller.ts`
- Modify: `apps/backend/src/postal-authorized-users/postal-authorized-users.module.ts` (aggiungere il controller)
- Create: `apps/backend/src/postal-authorized-users/postal-authorized-users.controller.spec.ts`

**Interfaces:**
- Consumes: `PostalAuthorizedUsersService.list()/create()/remove()` (Task 2).
- Produces: endpoint HTTP `GET/POST/DELETE admin/postal-authorized-users` — usati dal frontend in Task 6.

- [ ] **Step 1: Scrivere il test del controller (fallirà)**

```ts
// apps/backend/src/postal-authorized-users/postal-authorized-users.controller.spec.ts
import { PostalAuthorizedUsersController } from './postal-authorized-users.controller.js';
import type { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';

describe('PostalAuthorizedUsersController', () => {
  const svc = {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  };
  const controller = new PostalAuthorizedUsersController(svc as unknown as PostalAuthorizedUsersService);

  it('list() delega al service', async () => {
    svc.list.mockResolvedValueOnce([{ id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: '2026-01-01' }]);
    const result = await controller.list();
    expect(result).toEqual({ users: [{ id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: '2026-01-01' }] });
  });

  it('create() passa username e requester.username al service', async () => {
    svc.create.mockResolvedValueOnce({ id: '2', username: 'nuovo', addedBy: 'admin1', createdAt: '2026-01-01' });
    const req = { user: { username: 'admin1', role: 'admin' as const } };
    await controller.create({ username: 'nuovo' }, req as never);
    expect(svc.create).toHaveBeenCalledWith('nuovo', 'admin1');
  });

  it('remove() delega al service', async () => {
    await controller.remove('id-1');
    expect(svc.remove).toHaveBeenCalledWith('id-1');
  });
});
```

- [ ] **Step 2: Eseguire il test per verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/vitest run postal-authorized-users.controller.spec.ts
```

Expected: FAIL — modulo controller non esiste.

- [ ] **Step 3: Implementare il controller**

```ts
// apps/backend/src/postal-authorized-users/postal-authorized-users.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';
import { CreatePostalAuthorizedUserDto } from './dto/postal-authorized-user.dto.js';

@Controller('admin/postal-authorized-users')
@Roles('admin')
export class PostalAuthorizedUsersController {
  constructor(private readonly svc: PostalAuthorizedUsersService) {}

  @Get()
  async list() {
    return { users: await this.svc.list() };
  }

  @Post()
  create(
    @Body() dto: CreatePostalAuthorizedUserDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.svc.create(dto.username, req.user.username);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
```

- [ ] **Step 4: Eseguire il test per verificare che passi**

```bash
docker compose exec backend node_modules/.bin/vitest run postal-authorized-users.controller.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Registrare il controller nel modulo**

Modificare `postal-authorized-users.module.ts` (creato in Task 2):

```ts
import { PostalAuthorizedUsersController } from './postal-authorized-users.controller.js';
```

```ts
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PostalAuthorizedUser]), OperatorDirectoryModule],
  controllers: [PostalAuthorizedUsersController],
  providers: [PostalAuthorizedUsersService],
  exports: [PostalAuthorizedUsersService],
})
export class PostalAuthorizedUsersModule {}
```

- [ ] **Step 6: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/postal-authorized-users
git commit -m "feat: CRUD controller admin/postal-authorized-users"
```

---

## Task 4: Enforcement in `CampaignsService.launch()` / `launchTestSend()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (costruttore, `launch()`, `launchTestSend()`)
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (`launch()`, `testSend()`)
- Modify: `apps/backend/src/external-api/external-api.service.ts:92` (nuovo requester sintetico)
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts` (12 provider array + nuovi test)
- Modify: `apps/backend/src/campaigns/campaigns.service.cost.spec.ts` (1 provider array)

**Interfaces:**
- Consumes: `PostalAuthorizedUsersService.isAuthorized(username): Promise<boolean>` (Task 2), `CampaignRequester { username, role }` (già esistente in `campaigns.service.ts`).
- Produces: `launch(campaignId, requester)` e `launchTestSend(parentCampaignId, dto, requester)` — nuova firma, consumata da `campaigns.controller.ts` e `external-api.service.ts`.

- [ ] **Step 1: Scrivere i test del nuovo branch in `campaigns.service.spec.ts`**

Aggiungere, nel blocco di test esistente per `launch()` (vicino alla riga 292, dopo il test su `assertSendProtocolConfigured`), i seguenti test:

```ts
  it('launch(): blocca un user non autorizzato su campagna POSTAL', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'POSTAL' });
    mockPostalAuthorizedUsersService.isAuthorized.mockResolvedValueOnce(false);

    const result = await service.launch('c-postal-blocked', { username: 'user1', role: 'user' });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('Non sei autorizzato');
    expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-postal-blocked' }, { status: CampaignStatus.DRAFT });
  });

  it('launch(): un admin lancia POSTAL senza controllare la tabella', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'POSTAL' });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);

    const result = await service.launch('c-postal-admin', ADMIN_REQUESTER);

    expect(mockPostalAuthorizedUsersService.isAuthorized).not.toHaveBeenCalled();
    expect(result.blocked).toBeUndefined();
  });

  it('launch(): un user autorizzato in tabella lancia POSTAL', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'POSTAL' });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
    mockPostalAuthorizedUsersService.isAuthorized.mockResolvedValueOnce(true);

    const result = await service.launch('c-postal-user-ok', { username: 'user2', role: 'user' });

    expect(mockPostalAuthorizedUsersService.isAuthorized).toHaveBeenCalledWith('user2');
    expect(result.blocked).toBeUndefined();
  });

  it('launch(): un canale non-POSTAL non controlla mai la tabella', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'EMAIL' });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);

    const result = await service.launch('c-email', { username: 'user3', role: 'user' });

    expect(mockPostalAuthorizedUsersService.isAuthorized).not.toHaveBeenCalled();
    expect(result.blocked).toBeUndefined();
  });
```

Aggiungere anche, nel blocco `describe` di `launchTestSend` (vicino alla riga 2180), questo test:

```ts
  it('launchTestSend(): blocca un user non autorizzato su campagna POSTAL', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'parent-1', channelType: 'POSTAL' });
    mockPostalAuthorizedUsersService.isAuthorized.mockResolvedValueOnce(false);

    const result = await service.launchTestSend(
      'parent-1',
      { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} },
      { username: 'user1', role: 'user' },
    );

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('Non sei autorizzato');
    expect(mockCampaignRepo.save).not.toHaveBeenCalled();
  });
```

Dichiarare il mock condiviso vicino agli altri mock in cima al file (dopo la dichiarazione di `mockRegistroImpreseVerifyQueue` o analoga, cercare `const mockInadService = {` per la posizione esatta e aggiungere subito dopo il blocco simile):

```ts
const mockPostalAuthorizedUsersService = { isAuthorized: vi.fn().mockResolvedValue(true) };
```

E resettarlo nel `beforeEach` principale (accanto a `jest.clearAllMocks();` alla riga 128):

```ts
    mockPostalAuthorizedUsersService.isAuthorized.mockReset();
    mockPostalAuthorizedUsersService.isAuthorized.mockResolvedValue(true);
```

- [ ] **Step 2: Aggiungere il provider mock a tutti e 12 i `Test.createTestingModule` di questo file**

```bash
sed -i 's/^        CampaignsService,$/        CampaignsService,\n        { provide: PostalAuthorizedUsersService, useValue: mockPostalAuthorizedUsersService },/' apps/backend/src/campaigns/campaigns.service.spec.ts
```

Verificare che siano diventate 12 occorrenze della nuova riga:

```bash
grep -c "provide: PostalAuthorizedUsersService, useValue: mockPostalAuthorizedUsersService" apps/backend/src/campaigns/campaigns.service.spec.ts
```

Expected: `12`.

Aggiungere l'import in cima al file (accanto a `import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';`):

```ts
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
```

- [ ] **Step 3: Stesso trattamento per `campaigns.service.cost.spec.ts`**

```bash
sed -i 's/^        CampaignsService,$/        CampaignsService,\n        { provide: PostalAuthorizedUsersService, useValue: { isAuthorized: vi.fn().mockResolvedValue(true) } },/' apps/backend/src/campaigns/campaigns.service.cost.spec.ts
```

Aggiungere l'import in cima al file:

```ts
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
```

- [ ] **Step 4: Eseguire i nuovi test per verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "launch"
```

Expected: FAIL — `launch()` non accetta ancora un secondo argomento, `PostalAuthorizedUsersService` non iniettato nel costruttore reale.

- [ ] **Step 5: Aggiungere la dipendenza al costruttore di `CampaignsService`**

Modificare `apps/backend/src/campaigns/campaigns.service.ts`:

```ts
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
```

```ts
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly notificationQueues: NotificationQueuesService,
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly inadService: InadService,
    private readonly postalStatusSync: PostalStatusSyncService,
    private readonly registroImpreseService: RegistroImpreseService,
    private readonly registroImpreseVerifyQueue: RegistroImpreseVerifyQueueService,
    private readonly postalAuthorizedUsers: PostalAuthorizedUsersService,
  ) {}
```

- [ ] **Step 6: Aggiungere il controllo in `launch()`**

Cambiare la firma e aggiungere il blocco subito dopo il caricamento di `campaign` (prima di `assertSendProtocolConfigured`):

```ts
  async launch(
    campaignId: string,
    requester: CampaignRequester,
  ): Promise<{ launched: number; campaignId: string; blocked?: boolean; message?: string }> {
    const launchResult = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.QUEUED })
      .where('id = :id AND status = :draft', { id: campaignId, draft: CampaignStatus.DRAFT })
      .execute();

    if (launchResult.affected === 0) {
      const exists = await this.campaignRepo.existsBy({ id: campaignId });
      if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);
      throw new BadRequestException('Only draft campaigns can be launched');
    }

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    // Solo l'avvio (launch/launchTestSend) è gated — retry/correzioni su
    // una campagna POSTAL già avviata restano permessi a qualunque 'user'
    // (perimetro deciso in fase di design, vedi spec).
    if (campaign.channelType === 'POSTAL' && requester.role !== 'admin') {
      const authorized = await this.postalAuthorizedUsers.isAuthorized(requester.username);
      if (!authorized) {
        await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
        return {
          launched: 0,
          campaignId,
          blocked: true,
          message: 'Non sei autorizzato ad avviare invii Postalizzazione. Contatta un amministratore.',
        };
      }
    }

    // ... resto del metodo invariato (assertSendProtocolConfigured, checkAttachmentsBlocking, ecc.)
```

- [ ] **Step 7: Aggiungere il controllo in `launchTestSend()`**

Cambiare la firma e aggiungere il blocco subito dopo il caricamento di `parent` (prima di `assertSendProtocolConfigured`):

```ts
  async launchTestSend(
    parentCampaignId: string,
    dto: TestSendDto,
    requester: CampaignRequester,
  ): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }> {
    const parent = await this.campaignRepo.findOneBy({ id: parentCampaignId });
    if (!parent) throw new NotFoundException(`Campaign ${parentCampaignId} not found`);

    if (parent.channelType === 'POSTAL' && requester.role !== 'admin') {
      const authorized = await this.postalAuthorizedUsers.isAuthorized(requester.username);
      if (!authorized) {
        return {
          attemptId: '',
          testCampaignId: '',
          blocked: true,
          message: 'Non sei autorizzato ad avviare invii Postalizzazione. Contatta un amministratore.',
        };
      }
    }

    this.assertSendProtocolConfigured(parent);

    // ... resto del metodo invariato
```

- [ ] **Step 8: Eseguire i nuovi test per verificare che passino**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "launch"
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "launchTestSend"
```

Expected: PASS.

- [ ] **Step 9: Aggiornare i 24 call-site esistenti di `.launch(` nello stesso file**

Tutti i test pre-esistenti passano oggi un solo argomento — aggiungere un requester admin di default (non attiva mai il nuovo branch, comportamento invariato):

```bash
sed -i -E "s/service\.launch\('([^']+)'\)/service.launch('\1', ADMIN_REQUESTER)/g" apps/backend/src/campaigns/campaigns.service.spec.ts
```

Verificare che non restino chiamate a un solo argomento:

```bash
grep -n "service\.launch('[^']*')" apps/backend/src/campaigns/campaigns.service.spec.ts
```

Expected: nessun output (tutte hanno ora il secondo argomento).

- [ ] **Step 10: Aggiornare i 5 call-site esistenti di `.launchTestSend(` con solo 2 argomenti**

Sono 5 (il 6° è già stato scritto con 3 argomenti nello Step 1) e alcuni multi-riga — modificarli singolarmente:

```ts
// riga ~2180 e ~2216: cambiare
const result = await service.launchTestSend('parent-1', dto);
// in
const result = await service.launchTestSend('parent-1', dto, ADMIN_REQUESTER);
```

```ts
// riga ~2227: cambiare
await expect(service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} }))
// in
await expect(service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} }, ADMIN_REQUESTER))
```

```ts
// riga ~2271: cambiare
await service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} });
// in
await service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} }, ADMIN_REQUESTER);
```

```ts
// riga ~2311 (multi-riga): cambiare
        const result = await service.launchTestSend('parent-1', {
          codiceFiscale: 'RSSMRA80A01H501U',
          extraData: { file: 'xyz.pdf' },
        });
// in
        const result = await service.launchTestSend('parent-1', {
          codiceFiscale: 'RSSMRA80A01H501U',
          extraData: { file: 'xyz.pdf' },
        }, ADMIN_REQUESTER);
```

```ts
// riga ~2373 (multi-riga): cambiare
      const result = await service.launchTestSend('parent-1', {
        codiceFiscale: 'RSSMRA80A01H501U',
        extraData: { file: 'xyz.pdf' },
      });
// in
      const result = await service.launchTestSend('parent-1', {
        codiceFiscale: 'RSSMRA80A01H501U',
        extraData: { file: 'xyz.pdf' },
      }, ADMIN_REQUESTER);
```

- [ ] **Step 11: Aggiornare `campaigns.controller.ts`**

```ts
  @Post(':id/launch')
  async launch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ launched: number; campaignId: string; blocked?: boolean; message?: string }> {
    const result = await this.campaignsService.launch(id, { username: req.user.username, role: req.user.role });
```

(resto del metodo invariato)

```ts
  @Post(':id/test-send')
  async testSend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestSendDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }> {
    const result = await this.campaignsService.launchTestSend(id, dto, { username: req.user.username, role: req.user.role });
```

(resto del metodo invariato)

- [ ] **Step 12: Aggiornare `external-api.service.ts`**

```ts
    // Requester sintetico admin: l'accesso è già gated dal proprio confine
    // di sicurezza (ApiKeyGuard esterno), non dal ruolo operatore — bypassa
    // l'allowlist POSTAL per design, stesso livello di fiducia di un admin.
    const launchResult = await this.campaignsService.launch(campaign.id, { username: 'external-api', role: 'admin' });
```

- [ ] **Step 13: Type-check completo**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 14: Eseguire la suite COMPLETA (non un pattern mirato)**

```bash
docker compose exec backend node_modules/.bin/vitest run
```

Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`), nessun nuovo fallimento.

- [ ] **Step 15: Commit**

```bash
git add apps/backend/src/campaigns apps/backend/src/external-api/external-api.service.ts
git commit -m "feat: enforcement autorizzazione POSTAL in launch()/launchTestSend()"
```

---

## Task 5: `canUsePostal` nel login

**Files:**
- Modify: `apps/backend/src/auth/dto/auth-response.dto.ts`
- Modify: `apps/backend/src/auth/auth.service.ts`
- Modify: `apps/backend/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `PostalAuthorizedUsersService.isAuthorized(username): Promise<boolean>` (Task 2).
- Produces: `AuthResponseDto.canUsePostal: boolean` — consumato dal frontend in Task 6.

- [ ] **Step 1: Scrivere il test (fallirà)**

Aggiungere in `apps/backend/src/auth/auth.service.spec.ts`, dentro il `describe('loginWithLdap'` esistente (o al livello principale se non esiste un describe dedicato — cercare `loginWithLdap` nel file per la posizione):

```ts
  it('loginWithLdap(): canUsePostal true per un admin anche se non in tabella', async () => {
    ldapService.authenticate.mockResolvedValueOnce({ username: 'admin1', displayName: 'Admin Uno', role: 'admin' });
    postalAuthorizedUsers.isAuthorized.mockResolvedValueOnce(false);

    const result = await service.loginWithLdap({ username: 'admin1', password: 'x' });

    expect(result.canUsePostal).toBe(true);
    expect(postalAuthorizedUsers.isAuthorized).not.toHaveBeenCalled();
  });

  it('loginWithLdap(): canUsePostal true per un user presente in tabella', async () => {
    ldapService.authenticate.mockResolvedValueOnce({ username: 'user1', displayName: 'User Uno', role: 'user' });
    postalAuthorizedUsers.isAuthorized.mockResolvedValueOnce(true);

    const result = await service.loginWithLdap({ username: 'user1', password: 'x' });

    expect(result.canUsePostal).toBe(true);
    expect(postalAuthorizedUsers.isAuthorized).toHaveBeenCalledWith('user1');
  });

  it('loginWithLdap(): canUsePostal false per un user non in tabella', async () => {
    ldapService.authenticate.mockResolvedValueOnce({ username: 'user2', displayName: 'User Due', role: 'user' });
    postalAuthorizedUsers.isAuthorized.mockResolvedValueOnce(false);

    const result = await service.loginWithLdap({ username: 'user2', password: 'x' });

    expect(result.canUsePostal).toBe(false);
  });
```

Aggiungere il mock nella lista `providers` del `Test.createTestingModule` (unico builder del file):

```ts
        {
          provide: PostalAuthorizedUsersService,
          useValue: {
            isAuthorized: jest.fn(),
          },
        },
```

E dichiarare/assegnare la variabile insieme alle altre (`let postalAuthorizedUsers: jest.Mocked<PostalAuthorizedUsersService>;` in cima al `describe`, `postalAuthorizedUsers = module.get(PostalAuthorizedUsersService);` dopo `service = module.get<AuthService>(AuthService);`).

Aggiungere l'import in cima al file:

```ts
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
```

- [ ] **Step 2: Eseguire i test per verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/vitest run auth.service.spec.ts
```

Expected: FAIL — `canUsePostal` undefined, `PostalAuthorizedUsersService` non iniettato.

- [ ] **Step 3: Aggiornare `AuthResponseDto`**

```ts
// apps/backend/src/auth/dto/auth-response.dto.ts
import type { OperatorRole } from '@comunicapa/shared-types';

export class AuthResponseDto {
  access_token!: string;
  token_type!: 'Bearer';
  expires_in!: number;
  username!: string;
  displayName?: string;
  role!: OperatorRole;
  canUsePostal!: boolean;
}
```

- [ ] **Step 4: Aggiornare `AuthService`**

```ts
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
```

```ts
  constructor(
    private readonly ldapService: LdapService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly operatorDirectory: OperatorDirectoryService,
    private readonly postalAuthorizedUsers: PostalAuthorizedUsersService,
  ) {}
```

```ts
  async loginWithLdap(dto: LoginDto): Promise<AuthResponseDto> {
    const ldapUser = await this.ldapService.authenticate(dto.username, dto.password);
    await this.operatorDirectory.upsert(ldapUser.username, ldapUser.displayName);

    const canUsePostal =
      ldapUser.role === 'admin' || (await this.postalAuthorizedUsers.isAuthorized(ldapUser.username));

    const payload: Omit<JwtOperatorPayload, 'iat' | 'exp'> = {
      sub: ldapUser.username,
      username: ldapUser.username,
      displayName: ldapUser.displayName,
      role: ldapUser.role,
      type: 'operator',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: AuthService.EXPIRES_IN_SECONDS,
      username: ldapUser.username,
      displayName: ldapUser.displayName,
      role: ldapUser.role,
      canUsePostal,
    };
  }
```

- [ ] **Step 5: Eseguire i test per verificare che passino**

```bash
docker compose exec backend node_modules/.bin/vitest run auth.service.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Type-check + suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec backend node_modules/.bin/vitest run
```

Expected: nessun nuovo fallimento oltre la baseline nota.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/auth
git commit -m "feat: canUsePostal nella risposta di login"
```

---

## Task 6: Frontend — pannello CRUD + gate wizard

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET/POST/DELETE admin/postal-authorized-users` (Task 3), `AuthResponseDto.canUsePostal` (Task 5).

- [ ] **Step 1: Aggiungere tipo, stato e persistenza login di `canUsePostal`**

Accanto alla dichiarazione di `role` (riga 1308):

```ts
  const [role, setRole] = useState<string | null>(localStorage.getItem('comunicapa_role'));
  const [canUsePostal, setCanUsePostal] = useState<boolean>(localStorage.getItem('comunicapa_can_use_postal') === 'true');
```

Nel blocco di login (dopo `localStorage.setItem('comunicapa_role', data.role);`, prima di `setToken(data.access_token);`):

```ts
      localStorage.setItem('comunicapa_role', data.role);
      localStorage.setItem('comunicapa_can_use_postal', String(!!data.canUsePostal));

      setToken(data.access_token);
      setUsername(data.username);
      setRole(data.role);
      setCanUsePostal(!!data.canUsePostal);
```

Nel `handleLogout` (dove si fa `localStorage.removeItem('comunicapa_token');` e simili), aggiungere:

```ts
    localStorage.removeItem('comunicapa_can_use_postal');
```

- [ ] **Step 2: Aggiungere tipo, stato e fetch per l'elenco utenti abilitati**

Accanto a `PostalProviderItem` (riga 1240), aggiungere il tipo:

```ts
type PostalAuthorizedUserItem = {
  id: string;
  username: string;
  addedBy: string;
  addedByDisplayName?: string;
  createdAt: string;
};
```

Accanto a `postalProviders`/`postalProviderMsg` (riga 2229-2232), aggiungere lo stato:

```ts
  const [postalAuthorizedUsers, setPostalAuthorizedUsers] = useState<PostalAuthorizedUserItem[]>([]);
  const [postalAuthorizedUserMsg, setPostalAuthorizedUserMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [postalAuthorizedUserBusy, setPostalAuthorizedUserBusy] = useState(false);
  const [newPostalAuthorizedUsername, setNewPostalAuthorizedUsername] = useState('');
```

Accanto a `fetchPostalProviders` (riga 4558), aggiungere la fetch (solo per admin — l'endpoint è `@Roles('admin')`):

```ts
  const fetchPostalAuthorizedUsers = async () => {
    if (!token || role !== 'admin') return;
    try {
      const res = await fetch(`${ADMIN_API_BASE}/postal-authorized-users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setPostalAuthorizedUsers(data.users || []);
      }
    } catch (err) {
      console.error("Errore caricamento postal-authorized-users:", err);
    }
  };

  const handleAddPostalAuthorizedUser = async () => {
    if (!token || !newPostalAuthorizedUsername.trim()) return;
    setPostalAuthorizedUserBusy(true);
    setPostalAuthorizedUserMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/postal-authorized-users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: newPostalAuthorizedUsername.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Errore aggiunta (HTTP ${res.status})`);
      }
      setPostalAuthorizedUserMsg({ text: 'Utente abilitato.', error: false });
      setNewPostalAuthorizedUsername('');
      fetchPostalAuthorizedUsers();
    } catch (err: any) {
      setPostalAuthorizedUserMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setPostalAuthorizedUserBusy(false);
    }
  };

  const handleRemovePostalAuthorizedUser = async (id: string, usernameLabel: string) => {
    if (!token || !window.confirm(`Rimuovere "${usernameLabel}" dagli utenti abilitati?`)) return;
    setPostalAuthorizedUserBusy(true);
    setPostalAuthorizedUserMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/postal-authorized-users/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Errore rimozione (HTTP ${res.status})`);
      }
      setPostalAuthorizedUserMsg({ text: 'Utente rimosso.', error: false });
      fetchPostalAuthorizedUsers();
    } catch (err: any) {
      setPostalAuthorizedUserMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setPostalAuthorizedUserBusy(false);
    }
  };
```

Nel `useEffect` di mount (riga 2540-2550), aggiungere la chiamata:

```ts
  useEffect(() => {
    if (token) {
      if (isJwtExpired(token)) {
        handleLogout();
        return;
      }
      fetchCampaigns();
      fetchMailConfigs();
      fetchPostalProviders();
      fetchPostalAuthorizedUsers();
      fetchIoServices();
    }
  }, [token]);
```

- [ ] **Step 3: Aggiungere la sezione UI nel pannello Postalizzazione**

In `renderPostalProvidersTab()`, subito dopo la chiusura del blocco `{!editing && ( ... )}` (riga 4822, prima di `{editing && (`), inserire:

```tsx
        )}

        <div className="card border shadow-sm">
          <div className="card-body p-3">
            {postalAuthorizedUserMsg && (
              <div className={`alert ${postalAuthorizedUserMsg.error ? 'alert-danger' : 'alert-success'} d-flex align-items-center gap-2 mb-3`}>
                {postalAuthorizedUserMsg.error ? <AlertTriangle /> : <CheckCircle2 />}
                <div>{postalAuthorizedUserMsg.text}</div>
              </div>
            )}
            <h5 className="h6 fw-bold text-secondary text-uppercase tracking-wider mb-3 d-flex align-items-center gap-2">
              <Users size={18} /> Utenti abilitati all'invio Postalizzazione ({postalAuthorizedUsers.length})
            </h5>
            <p className="text-muted small mb-3">
              Gli amministratori possono sempre avviare campagne POSTAL. Aggiungi qui gli operatori
              'user' a cui vuoi consentire l'avvio di invii Postalizzazione.
            </p>
            <div className="d-flex gap-2 mb-3">
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Username operatore (es. mario.rossi)"
                value={newPostalAuthorizedUsername}
                onChange={(e) => setNewPostalAuthorizedUsername(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary d-flex align-items-center gap-1 text-nowrap"
                disabled={postalAuthorizedUserBusy || !newPostalAuthorizedUsername.trim()}
                onClick={() => handleAddPostalAuthorizedUser()}
              >
                <Plus size={16} /> Aggiungi
              </button>
            </div>
            {postalAuthorizedUsers.length === 0 ? (
              <div className="text-center py-3 border rounded bg-white text-muted small">
                Nessun utente abilitato oltre agli amministratori.
              </div>
            ) : (
              <table className="table table-sm mb-0">
                <thead>
                  <tr>
                    <th>Utente</th>
                    <th>Aggiunto da</th>
                    <th>Data</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {postalAuthorizedUsers.map((u) => (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{u.addedByDisplayName || u.addedBy}</td>
                      <td>{new Date(u.createdAt).toLocaleDateString('it-IT')}</td>
                      <td className="text-end">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          disabled={postalAuthorizedUserBusy}
                          onClick={() => handleRemovePostalAuthorizedUser(u.id, u.username)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {editing && (
```

- [ ] **Step 4: Gate del canale POSTAL nei due selettori del wizard**

Accanto a `wizSingleNeedsTemplateStep` (riga ~1895), aggiungere:

```ts
  // Admin sempre autorizzato; un 'user' solo se presente nell'elenco
  // caricato al login (canUsePostal) — gate solo UX, il controllo reale
  // resta server-side in launch()/launchTestSend().
  const canSelectPostal = role === 'admin' || canUsePostal;
```

Nel selettore del wizard singolo (riga ~8943-8948), cambiare:

```tsx
                            {(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'] as const)
                              .filter(key => !singleInadForced || key === 'PEC' || key === 'SEND')
                              .map(key => (
                                <option key={key} value={key}>
                                  {getChannelMeta(key).label}
                                </option>
                              ))}
```

in:

```tsx
                            {(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'] as const)
                              .filter(key => !singleInadForced || key === 'PEC' || key === 'SEND')
                              .filter(key => key !== 'POSTAL' || canSelectPostal)
                              .map(key => (
                                <option key={key} value={key}>
                                  {getChannelMeta(key).label}
                                </option>
                              ))}
```

Nel selettore del wizard massivo (riga ~9593-9595), cambiare:

```tsx
                      {(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'] as const).map(key => (
                        <option key={key} value={key}>{getChannelMeta(key).label}</option>
                      ))}
```

in:

```tsx
                      {(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'] as const)
                        .filter(key => key !== 'POSTAL' || canSelectPostal)
                        .map(key => (
                          <option key={key} value={key}>{getChannelMeta(key).label}</option>
                        ))}
```

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Lint frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/eslint .
```

Expected: nessun nuovo errore (solo warning `no-explicit-any` preesistenti).

- [ ] **Step 7: Verifica manuale nel browser (dev)**

1. `docker compose restart backend frontend-admin` (bind mount dev: il watch NestJS spesso non vede da solo le modifiche).
2. Login come `admin`/`admin` (mock LDAP dev) → Impostazioni → Postalizzazione → verificare la nuova sezione "Utenti abilitati", aggiungere un utente `user1`, verificare che compaia in tabella, rimuoverlo.
3. Login come `operator`/`operator` (ruolo `user`, mock LDAP dev) → Nuova campagna → wizard: verificare che POSTAL NON compaia nell'elenco canali (né in modalità singola né massiva).
4. Da admin, aggiungere `operator` all'elenco autorizzati → nuovo login come `operator`/`operator` → verificare che POSTAL ora compaia nel wizard.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat: pannello CRUD utenti abilitati POSTAL + gate wizard"
```

---

## Task 7: Verifica finale end-to-end

**Files:** nessuna modifica, solo verifica.

- [ ] **Step 1: Suite backend completa**

```bash
docker compose exec backend node_modules/.bin/vitest run
```

Expected: stesso failure set della baseline nota (`app.controller.spec.ts`/`isLdapMock`), zero nuovi fallimenti.

- [ ] **Step 2: Type-check backend completo (src + spec)**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```

- [ ] **Step 3: Type-check + lint frontend-admin**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-admin node_modules/.bin/eslint .
```

- [ ] **Step 4: Test manuale end-to-end via token JWT (senza login UI)**

```bash
# Token 'user' non autorizzato
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'user-noauth',username:'user-noauth',role:'user',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

Con il token ottenuto, creare una campagna POSTAL via API (`POST admin/campaigns`), lanciarla (`POST admin/campaigns/:id/launch`) e verificare che la risposta sia `{ launched: 0, campaignId, blocked: true, message: '...' }` con status HTTP 200 (non 403).

Aggiungere `user-noauth` alla tabella (`POST admin/postal-authorized-users` con token admin), rilanciare la stessa campagna e verificare che questa volta parta (`launched: 1`, nessun `blocked`).

- [ ] **Step 5: Verificare la migration in produzione-simulata**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test" backend node_modules/.bin/typeorm-ts-node-esm migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_test -c "\d postal_authorized_users"
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```

Expected: la tabella `postal_authorized_users` esiste con le colonne attese, tutte le migration precedenti girano senza errori.

- [ ] **Step 6: Commit finale (se ci sono stati fix durante la verifica)**

```bash
git add -A
git commit -m "test: verifica end-to-end autorizzazione POSTAL"
```

- [ ] **Step 7: Push del branch e apertura PR**

```bash
git push -u origin feat/postal-authorized-users
gh pr create --title "feat: autorizzazione invio POSTAL + CRUD utenti abilitati" --body "Implementa la spec docs/superpowers/specs/2026-09-14-postal-authorized-users-design.md"
```

Verificare che il check `run-tests` sulla PR sia verde prima di chiedere review/merge.
