# Mittente PEC/EMAIL predefinito Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere un flag "predefinito" (`isDefault`) alle configurazioni server PEC/EMAIL (`mail_server_configs`), selezionabile da Impostazioni, usato per preselezionare automaticamente il mittente nel wizard campagne (invio singolo e massivo) quando l'operatore sceglie quel canale.

**Architecture:** Replica esatta del pattern già esistente in questo repo per `IoServiceConfig.isDefault` (App IO): colonna booleana con unset automatico degli altri record dello stesso raggruppamento a ogni `create`/`update`/`setDefault`, endpoint `PATCH :id/default`, badge "(Predefinito)" + bottone in UI, priorità nel resolver di invio. Unica differenza strutturale: il raggruppamento è per `type` (`PEC`/`EMAIL` sono indipendenti), non globale come App IO.

**Tech Stack:** NestJS 10 + TypeORM 0.3 (backend), React 19 + Vite (frontend-admin), Jest (test backend).

## Global Constraints

- Migration TypeORM scritta a mano (niente `migration:generate` per un semplice `ALTER TABLE ADD COLUMN boolean`), verificata su DB temporaneo.
- Timestamp nuova migration deve essere maggiore dell'ultima esistente (`1785200000000-CreateInadVerificationJobs`), es. `1785300000000`.
- Test backend con `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza `--maxWorkers=2`).
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Type-check frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- `frontend-admin` è un unico file `App.tsx` (SPA monolitica) — tutte le modifiche frontend vanno lì, seguendo lo stile esistente (Bootstrap classes, `fetch` diretto, niente nuove astrazioni).
- Nessuna modifica a `packages/shared-types` — verificato: non contiene interfacce per `MailServerConfig`/`IoServiceConfig`, sono locali a backend/frontend.
- Non toccare `wizPecReserveMailConfigId` (fallback INAD) — resta selezione manuale esplicita per decisione di design (fuori scope, vedi spec).

---

### Task 1: Migration + entity `isDefault`

**Files:**
- Create: `apps/backend/src/database/migrations/1785300000000-AddMailServerConfigDefault.ts`
- Modify: `apps/backend/src/entities/mail-server-config.entity.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `MailServerConfig.isDefault: boolean` (colonna DB `is_default`, default `false`).

- [ ] **Step 1: Aggiungi il campo all'entity**

In `apps/backend/src/entities/mail-server-config.entity.ts`, dopo il campo `active` (riga 364, prima di `@CreateDateColumn`):

```ts
  @Column({ type: 'boolean', default: false })
  active!: boolean;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
```

- [ ] **Step 2: Scrivi la migration**

Crea `apps/backend/src/database/migrations/1785300000000-AddMailServerConfigDefault.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMailServerConfigDefault1785300000000 implements MigrationInterface {
    name = 'AddMailServerConfigDefault1785300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_server_configs" ADD "is_default" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_server_configs" DROP COLUMN "is_default"`);
    }
}
```

- [ ] **Step 3: Registra la migration in `database.module.ts`**

In `apps/backend/src/database/database.module.ts`, aggiungi l'import dopo `CreateInadVerificationJobs1785200000000`:

```ts
import { CreateInadVerificationJobs1785200000000 } from './migrations/1785200000000-CreateInadVerificationJobs';
import { AddMailServerConfigDefault1785300000000 } from './migrations/1785300000000-AddMailServerConfigDefault';
```

E aggiungi `AddMailServerConfigDefault1785300000000` come ultimo elemento dell'array `migrations: [...]` (dopo `CreateInadVerificationJobs1785200000000`).

- [ ] **Step 4: Verifica la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_pecdef;"
```

```bash
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_pecdef" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

Expected: output elenca tutte le migration eseguite in ordine, l'ultima è `AddMailServerConfigDefault1785300000000`, nessun errore.

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_pecdef;"
```

- [ ] **Step 5: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore (l'entity aggiorna solo un campo, nessun consumer esistente ancora lo referenzia).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/mail-server-config.entity.ts apps/backend/src/database/migrations/1785300000000-AddMailServerConfigDefault.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiunge colonna is_default a mail_server_configs"
```

---

### Task 2: DTO — campo `isDefault`

**Files:**
- Modify: `apps/backend/src/mail-configs/dto/mail-config.dto.ts`

**Interfaces:**
- Consumes: nessuna dipendenza da altri task.
- Produces: `CreateMailConfigDto.isDefault?: boolean`, `UpdateMailConfigDto.isDefault?: boolean`, `MailConfigMaskedDto.isDefault: boolean` — usati da Task 3 (service).

- [ ] **Step 1: Aggiungi `isDefault` a `CreateMailConfigDto`**

In `apps/backend/src/mail-configs/dto/mail-config.dto.ts`, dopo il campo `secure` (riga 34-35):

```ts
  @IsBoolean()
  secure!: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsBoolean()
  authEnabled!: boolean;
```

- [ ] **Step 2: Aggiungi `isDefault` a `UpdateMailConfigDto`**

Dopo il campo `secure?` (riga 72-73):

```ts
  @IsOptional() @IsBoolean()
  secure?: boolean;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  @IsOptional() @IsBoolean()
  authEnabled?: boolean;
```

- [ ] **Step 3: Aggiungi `isDefault` a `MailConfigMaskedDto`**

Dopo il campo `active: boolean;` (riga 108):

```ts
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
  isDefault: boolean;
}
```

- [ ] **Step 4: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: errore atteso in `mail-configs.service.ts` (`toMasked` non popola ancora `isDefault`, TS lo segnala come proprietà mancante nel tipo di ritorno) — è previsto, risolto dal prossimo task. Se compare SOLO questo errore, procedi.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/mail-configs/dto/mail-config.dto.ts
git commit -m "feat(backend): campo isDefault nei DTO mail-configs"
```

---

### Task 3: `MailConfigsService` — logica default

**Files:**
- Modify: `apps/backend/src/mail-configs/mail-configs.service.ts`
- Test: `apps/backend/src/mail-configs/mail-configs.service.spec.ts`

**Interfaces:**
- Consumes: `MailServerConfig.isDefault` (Task 1), `CreateMailConfigDto.isDefault?`/`UpdateMailConfigDto.isDefault?`/`MailConfigMaskedDto.isDefault` (Task 2).
- Produces: `MailConfigsService.setDefault(id: string): Promise<MailConfigMaskedDto>`; `create`/`update` con unset automatico per `type`; `resolveForSend` con priorità default.

- [ ] **Step 1: Scrivi i test falliti per `create`/`update`/`setDefault`/`remove`/`resolveForSend`**

Aggiungi in `apps/backend/src/mail-configs/mail-configs.service.spec.ts`, dentro il `describe('MailConfigsService', ...)`, dopo il test `'create cifra la password e ritorna il DTO mascherato'`:

```ts
  it('create con isDefault:true azzera isDefault sulle altre config dello stesso type', async () => {
    const dto = {
      type: 'PEC' as const, name: 'PEC 2', host: 'pec2.example.org',
      port: 465, secure: true, authEnabled: true,
      username: 'u', password: 'p',
      fromAddress: 'pec2@example.org', batchSize: 100, batchIntervalSeconds: 60,
      isDefault: true,
    };
    await service.create(dto);
    expect(repo.update).toHaveBeenCalledWith({ type: 'PEC', isDefault: true }, { isDefault: false });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(true);
  });

  it('create senza isDefault non tocca le altre config', async () => {
    const dto = {
      type: 'PEC' as const, name: 'PEC 3', host: 'pec3.example.org',
      port: 465, secure: true, authEnabled: true,
      username: 'u', password: 'p',
      fromAddress: 'pec3@example.org', batchSize: 100, batchIntervalSeconds: 60,
    };
    await service.create(dto);
    expect(repo.update).not.toHaveBeenCalled();
    const saved = repo.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(false);
  });

  it('update con isDefault:true azzera isDefault sulle altre config dello stesso type', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'PEC', name: 'a', host: 'h', port: 465, secure: true,
      authEnabled: true, username: 'u', passwordEnc: 'E',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: null, active: false, isDefault: false,
    });
    await service.update('x', { isDefault: true });
    expect(repo.update).toHaveBeenCalledWith({ type: 'PEC', isDefault: true }, { isDefault: false });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(true);
  });

  it('setDefault imposta isDefault sulla config richiesta e lo azzera sulle altre dello stesso type', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: 'u', passwordEnc: 'E',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: new Date(), active: true, isDefault: false,
    });
    const result = await service.setDefault('x');
    expect(repo.update).toHaveBeenCalledWith({ type: 'EMAIL', isDefault: true }, { isDefault: false });
    expect(result.isDefault).toBe(true);
  });

  it('remove blocca se la config è l\'unica active e default del suo type', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'x', type: 'PEC', active: true, isDefault: true });
    repo.count.mockResolvedValue(1);
    await expect(service.remove('x')).rejects.toThrow(BadRequestException);
  });

  it('remove permette eliminazione se non è default o non è l\'unica', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'x', type: 'PEC', active: true, isDefault: false });
    await service.remove('x');
    expect(repo.delete).toHaveBeenCalledWith({ id: 'x' });
  });

  it('resolveForSend senza id preferisce la config default attiva sulla prima attiva', async () => {
    repo.findOneBy.mockResolvedValue(null);
    repo.find.mockResolvedValue([
      {
        id: 'cfg-old', type: 'PEC', name: 'vecchia', host: 'old.pec', port: 465, secure: true,
        authEnabled: true, username: 'u', passwordEnc: '', fromAddress: 'old@b.c',
        batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true, isDefault: false,
      },
      {
        id: 'cfg-default', type: 'PEC', name: 'default', host: 'default.pec', port: 465, secure: true,
        authEnabled: true, username: 'u', passwordEnc: '', fromAddress: 'default@b.c',
        batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true, isDefault: true,
      },
    ]);
    const r = await service.resolveForSend('PEC');
    expect(r.configId).toBe('cfg-default');
    expect(r.host).toBe('default.pec');
  });
```

Aggiorna anche il mock `repo` in cima al file per includere `update`:

```ts
  const repo = {
    find: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn((e) => Promise.resolve({ id: 'gen-id', ...e })),
    create: jest.fn((e) => e),
    delete: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
  };
```

E aggiorna il test esistente `'resolveForSend senza id usa la prima config attiva del tipo'` aggiungendo `isDefault: false` all'oggetto mockato (per restare coerente col nuovo campo, non è strettamente necessario ma evita `undefined` nel comportamento).

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.service --maxWorkers=2
```

Expected: FAIL sui nuovi test (`repo.update` non chiamato, `setDefault` non esiste, `remove` non lancia mai, priorità `resolveForSend` sbagliata).

- [ ] **Step 3: Implementa `create` con unset automatico**

In `apps/backend/src/mail-configs/mail-configs.service.ts`, sostituisci il metodo `create`:

```ts
  async create(dto: CreateMailConfigDto): Promise<MailConfigMaskedDto> {
    if (dto.isDefault) {
      await this.repo.update({ type: dto.type, isDefault: true }, { isDefault: false });
    }
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
      isDefault: dto.isDefault ?? false,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }
```

- [ ] **Step 4: Implementa `update` con unset automatico**

Sostituisci il metodo `update`:

```ts
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

    if (dto.isDefault === true) {
      await this.repo.update({ type: entity.type, isDefault: true }, { isDefault: false });
      entity.isDefault = true;
    } else if (dto.isDefault === false) {
      entity.isDefault = false;
    }

    if (invalidatesTest) {
      entity.testedAt = null;
      entity.active = false;
    }

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }
```

- [ ] **Step 5: Implementa `setDefault`**

Aggiungi il metodo dopo `update`:

```ts
  async setDefault(id: string): Promise<MailConfigMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    await this.repo.update({ type: entity.type, isDefault: true }, { isDefault: false });
    entity.isDefault = true;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }
```

- [ ] **Step 6: Aggiungi il guard in `remove`**

Sostituisci il metodo `remove`:

```ts
  async remove(id: string): Promise<void> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    if (entity.isDefault) {
      const count = await this.repo.count();
      if (count > 1) {
        throw new BadRequestException('Imposta un\'altra configurazione come predefinita prima di eliminare questa.');
      }
    }
    await this.repo.delete({ id });
  }
```

- [ ] **Step 7: Aggiorna `toMasked` con `isDefault`**

Nel metodo `toMasked`, dopo `active: entity.active,`:

```ts
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
      isDefault: entity.isDefault,
    };
  }
```

- [ ] **Step 8: Aggiorna la priorità in `resolveForSend`**

Sostituisci il blocco di ricerca delle config attive dentro `resolveForSend` (quello che oggi fa `find({ where: { type, active: true }, order: { createdAt: 'ASC' } })`):

```ts
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
      const defaultActive = actives.find((c) => c.isDefault);
      return this.toResolved(defaultActive ?? actives[0]);
    }

    // Fallback legacy: chiavi smtp.*/pec.* dei settings (installazioni pre-migrazione)
    const prefix = type === 'EMAIL' ? 'smtp' : 'pec';
    const key = (suffix: string) => `${prefix}.${suffix}` as SettingKey;
    const username = (await this.appSettings.get<string>(key('user'))) as unknown as string;
    return {
      host: (await this.appSettings.get<string>(key('host'))) as unknown as string,
      port: (await this.appSettings.get<number>(key('port'))) as unknown as number,
      secure: (await this.appSettings.get<boolean>(key('secure'))) as unknown as boolean,
      authEnabled: !!username,
      username,
      password: (await this.appSettings.get<string>(key('password'))) as unknown as string,
      fromAddress: (await this.appSettings.get<string>(key('from'))) as unknown as string,
      batchSize: 100,
      batchIntervalSeconds: 60,
      configId: null,
    };
  }
```

- [ ] **Step 9: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.service --maxWorkers=2
```

Expected: tutti i test PASS (esistenti + nuovi).

- [ ] **Step 10: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/mail-configs/mail-configs.service.ts apps/backend/src/mail-configs/mail-configs.service.spec.ts
git commit -m "feat(backend): MailConfigsService gestisce isDefault (setDefault, priorita resolveForSend, guard remove)"
```

---

### Task 4: `MailConfigsController` — route `PATCH :id/default`

**Files:**
- Modify: `apps/backend/src/mail-configs/mail-configs.controller.ts`
- Test: `apps/backend/src/mail-configs/mail-configs.controller.spec.ts`

**Interfaces:**
- Consumes: `MailConfigsService.setDefault(id: string)` (Task 3).
- Produces: route HTTP `PATCH admin/mail-configs/:id/default` (ruolo `admin`), consumata da Task 6 (frontend).

- [ ] **Step 1: Scrivi il test fallito**

In `apps/backend/src/mail-configs/mail-configs.controller.spec.ts`, aggiungi al mock `svc`:

```ts
  const svc = {
    listMasked: jest.fn().mockResolvedValue([{ id: '1' }]),
    create: jest.fn().mockResolvedValue({ id: '2' }),
    update: jest.fn().mockResolvedValue({ id: '1' }),
    remove: jest.fn().mockResolvedValue(undefined),
    test: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    setActive: jest.fn().mockResolvedValue({ id: '1', active: false }),
    setDefault: jest.fn().mockResolvedValue({ id: '1', isDefault: true }),
  };
```

E aggiungi il test:

```ts
  it('PATCH /:id/default delega al service', async () => {
    const res = await controller.setDefault('abc');
    expect(svc.setDefault).toHaveBeenCalledWith('abc');
    expect(res.isDefault).toBe(true);
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.controller --maxWorkers=2
```

Expected: FAIL — `controller.setDefault is not a function`.

- [ ] **Step 3: Aggiungi la route**

In `apps/backend/src/mail-configs/mail-configs.controller.ts`, dopo il metodo `setActive`:

```ts
  @Patch(':id/active')
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetActiveMailConfigDto) {
    return this.svc.setActive(id, body.active);
  }

  @Patch(':id/default')
  @Roles('admin')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs.controller --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 5: Esegui l'intera suite backend (audit costruttori/regressioni)**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`), nessuna nuova regressione.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/mail-configs/mail-configs.controller.ts apps/backend/src/mail-configs/mail-configs.controller.spec.ts
git commit -m "feat(backend): route PATCH admin/mail-configs/:id/default"
```

---

### Task 5: Frontend — tipo, form, salvataggio con `isDefault`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: risposta API `GET/POST/PUT admin/mail-configs` ora include `isDefault: boolean` (Task 3/4).
- Produces: `MailConfigItem.isDefault: boolean`, `editingMailConfig.isDefault`, checkbox nel form — usati da Task 6 (badge/bottone) e Task 7 (wizard).

- [ ] **Step 1: Aggiungi `isDefault` al tipo `MailConfigItem` e a `EMPTY_MAIL_CONFIG`**

In `App.tsx` righe 758-779, sostituisci:

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
  isDefault: boolean;
};

const EMPTY_MAIL_CONFIG: Omit<MailConfigItem, 'id' | 'testedAt' | 'active'> = {
  type: 'EMAIL', name: '', host: '', port: 587, secure: false,
  authEnabled: true, username: '', password: '', fromAddress: '',
  batchSize: 100, batchIntervalSeconds: 60, isDefault: false,
};
```

- [ ] **Step 2: Includi `isDefault` nel payload di `handleSaveMailConfig`**

In `App.tsx` riga 3107-3127, nel corpo di `handleSaveMailConfig`, nel `payload`:

```ts
    const payload = {
      ...(isEdit ? {} : { type: editingMailConfig.type }),
      name: editingMailConfig.name,
      host: editingMailConfig.host,
      port: Number(editingMailConfig.port),
      secure: editingMailConfig.secure,
      authEnabled: editingMailConfig.authEnabled,
      username: editingMailConfig.username,
      password: editingMailConfig.password,
      fromAddress: editingMailConfig.fromAddress,
      batchSize: Number(editingMailConfig.batchSize),
      batchIntervalSeconds: Number(editingMailConfig.batchIntervalSeconds),
      isDefault: editingMailConfig.isDefault ?? false,
    };
```

- [ ] **Step 3: Aggiungi checkbox "Imposta come predefinito" nel form**

In `renderMailConfigTab` (App.tsx riga 3664+), dentro il blocco `editing && (<form ...>`, subito dopo il blocco checkbox "Abilita Autenticazione" (righe 1000-1013 del dump, cerca `chkAuth`), aggiungi una terza colonna checkbox:

```tsx
              <div className="col-md-6">
                <div className="form-check mt-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="chkAuth"
                    checked={editing.authEnabled ?? true}
                    onChange={(e) => setEditingMailConfig({ ...editing, authEnabled: e.target.checked })}
                  />
                  <label className="form-check-label small" htmlFor="chkAuth">
                    Abilita Autenticazione
                  </label>
                </div>
              </div>

              <div className="col-md-6">
                <div className="form-check mt-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="chkMailDefault"
                    checked={editing.isDefault ?? false}
                    onChange={(e) => setEditingMailConfig({ ...editing, isDefault: e.target.checked })}
                  />
                  <label className="form-check-label small" htmlFor="chkMailDefault">
                    Imposta come predefinito per {label}
                  </label>
                </div>
              </div>
```

- [ ] **Step 4: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): campo isDefault nel form server PEC/EMAIL"
```

---

### Task 6: Frontend — badge e bottone "Imposta come predefinito" in Impostazioni

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `MailConfigItem.isDefault` (Task 5), route `PATCH admin/mail-configs/:id/default` (Task 4).
- Produces: `handleSetDefaultMailConfig(id: string): Promise<void>`.

- [ ] **Step 1: Aggiungi l'handler**

In `App.tsx`, subito dopo `handleToggleMailConfigActive` (dopo la riga 3207, chiusura della funzione):

```ts
  const handleSetDefaultMailConfig = async (id: string) => {
    if (!token) return;
    setMailConfigBusyId(id);
    setMailConfigMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/mail-configs/${id}/default`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Errore impostazione predefinito');
      }
      setMailConfigMsg({ text: 'Configurazione impostata come predefinita.', error: false });
      fetchMailConfigs();
    } catch (err: any) {
      setMailConfigMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setMailConfigBusyId(null);
    }
  };
```

- [ ] **Step 2: Aggiungi badge e bottone nella card di `renderMailConfigTab`**

Nel blocco che renderizza il badge "Attivo/Inattivo" (App.tsx, dentro `list.map((c) => (...))`, cerca `{c.active ? 'Attivo' : 'Inattivo'}`), aggiungi il badge "Predefinito" subito dopo:

```tsx
                            <div className="fw-bold text-dark d-flex align-items-center gap-2">
                              {c.name}
                              {c.secure && <span className="badge bg-info" style={{ fontSize: '0.65rem' }}>SSL/TLS</span>}
                              <span className={`badge ${c.active ? 'bg-success' : 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>
                                {c.active ? 'Attivo' : 'Inattivo'}
                              </span>
                              {c.isDefault && <span className="badge bg-primary" style={{ fontSize: '0.65rem' }}>Predefinito</span>}
                            </div>
```

Nel blocco "Right: Actions" (cerca `handleToggleMailConfigActive(c.id, c.active)`), aggiungi il bottone "Imposta come predefinito" sopra il bottone Attiva/Disattiva, visibile solo se non è già default:

```tsx
                        {/* Right: Actions */}
                        <div className="d-flex flex-column gap-2 flex-shrink-0">
                          {!c.isDefault && (
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                              onClick={() => handleSetDefaultMailConfig(c.id)}
                              disabled={mailConfigBusyId === c.id}
                              title="Imposta come predefinito"
                            >
                              <Star size={14} /> Predefinito
                            </button>
                          )}
                          <button
                            type="button"
                            className={`btn btn-sm ${c.active ? 'btn-outline-success' : 'btn-outline-secondary'} d-flex align-items-center gap-1`}
                            onClick={() => handleToggleMailConfigActive(c.id, c.active)}
                            disabled={mailConfigBusyId === c.id}
                          >
                            {c.active ? <ToggleRight /> : <ToggleLeft />}
                            {c.active ? 'Disattiva' : 'Attiva'}
                          </button>
```

`Star` è già importato in `App.tsx` (usato dal pattern App IO — verifica con grep `from 'lucide-react'` che `Star` sia nell'import; se non lo è, aggiungilo).

- [ ] **Step 3: Verifica import `Star`**

```bash
grep -n "Star" apps/frontend-admin/src/App.tsx | head -5
```

Se `Star` non compare nell'import da `lucide-react` in cima al file, aggiungilo alla lista degli import.

- [ ] **Step 4: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 5: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Login admin (`admin`/`admin` con `LDAP_HOST=mock`), vai su Impostazioni → tab PEC, crea/apri una config PEC esistente, spunta "Imposta come predefinito per PEC" e salva — verifica badge "Predefinito" sulla card e che il bottone "Predefinito" scompaia solo su quella riga. Ripeti su una seconda config PEC: verifica che il badge si sposti (solo una config PEC default alla volta). Ripeti su EMAIL: verifica che il default EMAIL sia indipendente da quello PEC.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): badge e bottone predefinito su server PEC/EMAIL"
```

---

### Task 7: Frontend — preselezione automatica nel wizard e invio singolo

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `MailConfigItem.isDefault` (Task 5).
- Produces: nessuna nuova interfaccia — modifica comportamento dei call-site esistenti che leggono `mailConfigs`.

- [ ] **Step 1: Invio singolo rapido — `handleCreateCampaign`**

In `App.tsx` righe 2407-2421, sostituisci il blocco `if (!configOverrides) { ... }`:

```ts
      if (!configOverrides) {
        if (channelVal === 'EMAIL') {
          const activeSmtp = mailConfigs.find(c => c.type === 'EMAIL' && c.active && c.isDefault)
            ?? mailConfigs.find(c => c.type === 'EMAIL' && c.active);
          channelConfig = { from: activeSmtp?.fromAddress || '', mailConfigId: activeSmtp?.id };
        } else if (channelVal === 'PEC') {
          const activePec = mailConfigs.find(c => c.type === 'PEC' && c.active && c.isDefault)
            ?? mailConfigs.find(c => c.type === 'PEC' && c.active);
          channelConfig = { from: activePec?.fromAddress || '', mailConfigId: activePec?.id };
        } else if (channelVal === 'SEND') {
          channelConfig = {};
        }
      }
```

- [ ] **Step 2: Wizard singolo — auto-pick al cambio canale, solo se non già impostato (riga ~6666)**

**Importante:** il requisito approvato in spec è "preseleziona solo se vuoto — scelta manuale mai sovrascritta". Il codice attuale invece sovrascrive `wizMailConfigId` a OGNI cambio canale (anche quando l'operatore aveva già scelto manualmente un mittente). Il fix non è solo "aggiungere isDefault alla ricerca" ma anche aggiungere il guard "solo se vuoto": usa la forma funzionale di `setWizMailConfigId` che legge il valore precedente, e applica il default SOLO se `prev` è stringa vuota (non tenta di validare se `prev` appartiene ancora al nuovo `type`: una volta popolato, anche da un cambio canale precedente, non viene più toccato automaticamente — coerente con "il default si applica solo al primo cambio canale", il resto è scelta esplicita dell'operatore).

Cerca il blocco `onChange={(e: any) => { const newChan = e.target.value as any; setWizChannel(newChan); const activeCfg = mailConfigs.find(c => c.type === newChan && c.active);` nel select del canale del wizard invio singolo (App.tsx intorno riga 6656-6672), sostituisci la riga `const activeCfg = ...` e la riga `setWizMailConfigId(...)`:

```tsx
                            onChange={(e: any) => {
                              const newChan = e.target.value as any;
                              setWizChannel(newChan);
                              setWizMailConfigId(prev => {
                                if (prev) return prev;
                                const defaultCfg = mailConfigs.find(c => c.type === newChan && c.active && c.isDefault)
                                  ?? mailConfigs.find(c => c.type === newChan && c.active);
                                return defaultCfg?.id || '';
                              });
                              if (newChan === 'SEND') setWizProtocolla(true);
                              if (newChan !== 'SEND' && newChan !== 'APP_IO' && !(wizAppIoMode === 'parallel' && singleAppIoActive)) {
                                setWizPaymentEnabled(false);
                              }
                            }}
```

- [ ] **Step 3: Wizard massivo — auto-pick al cambio canale Step 1, stesso guard (riga ~7165)**

Stesso pattern nel blocco bulk (App.tsx intorno riga 7156-7173):

```tsx
                    onChange={(e: any) => {
                      const newChan = e.target.value as any;
                      setWizChannel(newChan);
                      setWizMailConfigId(prev => {
                        if (prev) return prev;
                        const defaultCfg = mailConfigs.find(c => c.type === newChan && c.active && c.isDefault)
                          ?? mailConfigs.find(c => c.type === newChan && c.active);
                        return defaultCfg?.id || '';
                      });
                      if (newChan === 'SEND') setWizProtocolla(true);
                    }}
```

- [ ] **Step 4: Badge "(Predefinito)" nelle option dei due select "Server di Invio / Mittente"**

Blocco 1 (App.tsx ~6717-6741) e Blocco 2 (App.tsx ~7313-7337), stesso identico cambio in entrambi — sostituisci il `.map(c => (...))`:

```tsx
                              {mailConfigs
                                .filter(c => c.type === wizChannel && c.active)
                                .map(c => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} ({c.fromAddress}){c.isDefault ? ' (Predefinito)' : ''}
                                  </option>
                                ))}
```

(stesso cambio, indentazione adattata, nel secondo blocco con `form-select-sm`).

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser — invio singolo**

Con una config PEC marcata default (da Task 6), vai su invio singolo, seleziona canale PEC: verifica che il select "Server di Invio / Mittente" si preselezioni da solo sulla config default (opzione con "(Predefinito)"). Cambia manualmente il mittente su un'altra config PEC, poi cambia canale a EMAIL (si preseleziona default EMAIL) e torna a PEC: verifica che il campo mittente resti quello scelto da EMAIL (non torna al mittente PEC scelto manualmente né al default PEC) — comportamento atteso col guard "solo se vuoto" del Task 7 Step 2/3: il default si applica solo quando `wizMailConfigId` è vuoto, non per-tipo. Se questo comportamento non è accettabile in pratica, va deciso un follow-up con memoria per-tipo (fuori scope di questo piano).

- [ ] **Step 7: Verifica manuale in browser — wizard massivo**

Crea nuova campagna massiva, canale PEC: verifica preselezione automatica del mittente default e badge "(Predefinito)" nella option selezionata.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): preseleziona mittente PEC/EMAIL predefinito in wizard e invio singolo"
```

---

### Task 8: Suite completa + verifica finale

**Files:** nessuna modifica, solo verifica.

- [ ] **Step 1: Suite backend completa**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: failure set identico alla baseline nota (solo `app.controller.spec.ts`/`isLdapMock`).

- [ ] **Step 2: Type-check backend e frontend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore su entrambi.

- [ ] **Step 3: Verifica end-to-end manuale**

Con backend e frontend-admin rebuildati (`docker compose up -d --build backend frontend-admin`):
1. Impostazioni → PEC: crea 2 config, imposta una come predefinita, verifica badge/bottone.
2. Impostazioni → EMAIL: stesso, verifica indipendenza dal default PEC.
3. Invio singolo canale PEC: verifica preselezione automatica.
4. Wizard massivo canale PEC: verifica preselezione automatica in entrambi gli step che mostrano il select mittente.
5. Elimina la config PEC default mentre è l'unica attiva: verifica messaggio di blocco lato UI (l'errore `BadRequestException` del backend deve propagarsi come messaggio leggibile, non un errore generico).

- [ ] **Step 4: Nessun commit aggiuntivo (task di sola verifica)**
