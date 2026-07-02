# Env cleanup, stack prod, CI/CD tagging, settings da UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurazioni applicative persistite in DB (UI admin), env solo bootstrap, stack compose prod/dev separati (podman rootless), Dockerfile prod + CI/CD GitHub Actions con tagging automatico e badge versione, storage allegati unificato su `ATTACHMENTS_PATH`.

**Architecture:** Nuovo modulo `settings` NestJS (entity key-value jsonb + service con fallback DB→env→default e cifratura AES-256-GCM per i secret, chiave derivata da `JWT_SECRET` via HKDF). Le strategy di canale leggono da `AppSettingsService` a ogni `send()`. `docker-compose.yml` diventa la base di produzione (immagini ghcr, volumi named), `docker-compose.override.yml` contiene lo sviluppo (bind mount). Frontend legge `API_BASE` a runtime da `config.js` generato dall'entrypoint nginx.

**Tech Stack:** NestJS 10, TypeORM (postgres, `synchronize` in dev), Jest + ts-jest, React 19 + Vite 6, pnpm workspaces in Docker, GitHub Actions, ghcr.io, nginx-unprivileged.

**Spec:** `docs/superpowers/specs/2026-07-02-env-cleanup-prod-stack-settings-design.md`

## Global Constraints

- Tutto gira in Docker: i test backend si lanciano con `docker compose exec backend node_modules/.bin/jest <pattern>` (workdir container: `/app/apps/backend`).
- pnpm v11: `pnpm install --ignore-scripts` sempre; per immagini Vite aggiungere `pnpm rebuild esbuild`; CMD con binario diretto, mai `pnpm run`.
- TypeScript strict completo (`tsconfig.base.json`): `noUnusedLocals`, `noUnusedParameters`, `strictNullChecks` attivi — niente variabili morte nei diff.
- Lingua: commenti e messaggi utente in italiano; identificatori in inglese.
- Endpoint backend SENZA prefisso globale `/api` (lo spec usa `/api/...` come notazione: le route reali sono `/version`, `/branding`, `/settings`).
- Chiavi settings migrate: `brand.name`, `brand.subtitle`, `brand.logo`, `brand.favicon`, `retention.maxDays`, `smtp.host|port|secure|user|password|from`, `pec.host|port|secure|user|password|from`, `appIo.apiKey|baseUrl`, `send.apiKey|baseUrl`. Secret: `smtp.password`, `pec.password`, `appIo.apiKey`, `send.apiKey`.
- Maschera secret nelle risposte admin: stringa `••••••••` (8 × U+2022).
- Commit frequenti, messaggi convenzionali in italiano, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Utility di cifratura settings

**Files:**
- Create: `apps/backend/src/settings/settings-crypto.ts`
- Test: `apps/backend/src/settings/settings-crypto.spec.ts`

**Interfaces:**
- Produces:
  - `deriveSettingsKey(masterSecret: string): Buffer` (32 byte)
  - `encryptValue(plain: string, key: Buffer): string` — formato `enc:v1:<iv b64>:<tag b64>:<ct b64>`
  - `decryptValue(stored: string, key: Buffer): string` — lancia `Error` su formato/chiave errati
  - `isEncryptedValue(v: unknown): v is string` — true se stringa che inizia con `enc:v1:`

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/settings/settings-crypto.spec.ts
import { deriveSettingsKey, encryptValue, decryptValue, isEncryptedValue } from './settings-crypto';

describe('settings-crypto', () => {
  const key = deriveSettingsKey('test-master-secret');

  it('deriva una chiave a 32 byte deterministica', () => {
    expect(key.length).toBe(32);
    expect(deriveSettingsKey('test-master-secret').equals(key)).toBe(true);
    expect(deriveSettingsKey('altro-secret').equals(key)).toBe(false);
  });

  it('cifra e decifra round-trip', () => {
    const stored = encryptValue('password-segreta', key);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('password-segreta');
    expect(decryptValue(stored, key)).toBe('password-segreta');
  });

  it('produce ciphertext diversi per lo stesso plaintext (IV casuale)', () => {
    expect(encryptValue('x', key)).not.toBe(encryptValue('x', key));
  });

  it('rifiuta la decifratura con chiave diversa', () => {
    const stored = encryptValue('segreto', key);
    expect(() => decryptValue(stored, deriveSettingsKey('altra'))).toThrow();
  });

  it('rifiuta formati non validi', () => {
    expect(() => decryptValue('non-cifrato', key)).toThrow('Formato valore cifrato non valido');
  });

  it('isEncryptedValue riconosce solo il formato enc:v1:', () => {
    expect(isEncryptedValue(encryptValue('a', key))).toBe(true);
    expect(isEncryptedValue('plain')).toBe(false);
    expect(isEncryptedValue(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui il test — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest settings-crypto`
Expected: FAIL — `Cannot find module './settings-crypto'`

- [ ] **Step 3: Implementazione minima**

```typescript
// apps/backend/src/settings/settings-crypto.ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';

/** Deriva la chiave di cifratura dei settings dal JWT_SECRET via HKDF-SHA256. */
export function deriveSettingsKey(masterSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterSecret, 'comunicapa-settings', 'settings-encryption-v1', 32),
  );
}

export function encryptValue(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptValue(stored: string, key: Buffer): string {
  if (!stored.startsWith(PREFIX)) {
    throw new Error('Formato valore cifrato non valido');
  }
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Formato valore cifrato non valido');
  }
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function isEncryptedValue(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}
```

- [ ] **Step 4: Esegui il test — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest settings-crypto`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/settings/settings-crypto.ts apps/backend/src/settings/settings-crypto.spec.ts
git commit -m "feat(settings): utility cifratura AES-256-GCM con chiave derivata da JWT_SECRET"
```

---

### Task 2: Entity `app_settings`, registry chiavi e `AppSettingsService`

**Files:**
- Create: `apps/backend/src/entities/app-setting.entity.ts`
- Create: `apps/backend/src/settings/settings.registry.ts`
- Create: `apps/backend/src/settings/app-settings.service.ts`
- Modify: `apps/backend/src/database/database.module.ts` (aggiungi entity)
- Test: `apps/backend/src/settings/app-settings.service.spec.ts`

**Interfaces:**
- Consumes: `deriveSettingsKey`, `encryptValue`, `decryptValue`, `isEncryptedValue` (Task 1)
- Produces:
  - `AppSetting` entity (`key: string` PK, `value: string | number | boolean` jsonb, `encrypted: boolean`, `updatedAt: Date`, `updatedBy: string | null`)
  - `SETTING_DEFS: Record<SettingKey, SettingDef>` e tipo `SettingKey`
  - `AppSettingsService.get<T extends string | number | boolean>(key: SettingKey): Promise<T>`
  - `AppSettingsService.getAllMasked(): Promise<Record<SettingKey, string | number | boolean>>`
  - `AppSettingsService.setMany(entries: Record<string, string | number | boolean>, updatedBy: string): Promise<void>` — lancia `BadRequestException` su chiave sconosciuta o tipo errato
  - `AppSettingsService.clearCache(): void`

- [ ] **Step 1: Crea il registry delle chiavi**

```typescript
// apps/backend/src/settings/settings.registry.ts
export type SettingValue = string | number | boolean;
export type SettingType = 'string' | 'number' | 'boolean';

export interface SettingDef {
  /** Variabile d'ambiente di fallback (installazioni pre-migrazione). */
  env?: string;
  type: SettingType;
  /** true = cifrato in DB e mascherato nelle risposte admin. */
  secret?: boolean;
  default: SettingValue;
}

export const MASKED_VALUE = '••••••••';

export const SETTING_DEFS = {
  'brand.name': { env: 'BRAND_NAME', type: 'string', default: 'Comune di Montesilvano' },
  'brand.subtitle': { type: 'string', default: '' },
  'brand.logo': { env: 'BRAND_LOGO', type: 'string', default: '' },
  'brand.favicon': { type: 'string', default: '' },
  'retention.maxDays': { env: 'RETENTION_MAX_DAYS', type: 'number', default: 90 },
  'smtp.host': { env: 'SMTP_HOST', type: 'string', default: 'localhost' },
  'smtp.port': { env: 'SMTP_PORT', type: 'number', default: 587 },
  'smtp.secure': { env: 'SMTP_SECURE', type: 'boolean', default: false },
  'smtp.user': { env: 'SMTP_USER', type: 'string', default: '' },
  'smtp.password': { env: 'SMTP_PASSWORD', type: 'string', secret: true, default: '' },
  'smtp.from': { env: 'SMTP_FROM', type: 'string', default: 'noreply@comunicapa.local' },
  'pec.host': { env: 'PEC_HOST', type: 'string', default: 'localhost' },
  'pec.port': { env: 'PEC_PORT', type: 'number', default: 587 },
  'pec.secure': { env: 'PEC_SECURE', type: 'boolean', default: false },
  'pec.user': { env: 'PEC_USER', type: 'string', default: '' },
  'pec.password': { env: 'PEC_PASSWORD', type: 'string', secret: true, default: '' },
  'pec.from': { env: 'PEC_FROM', type: 'string', default: 'noreply@pec.comunicapa.local' },
  'appIo.apiKey': { env: 'APP_IO_API_KEY', type: 'string', secret: true, default: '' },
  'appIo.baseUrl': { env: 'APP_IO_BASE_URL', type: 'string', default: 'https://api.io.italia.it' },
  'send.apiKey': { env: 'SEND_API_KEY', type: 'string', secret: true, default: '' },
  'send.baseUrl': { env: 'SEND_BASE_URL', type: 'string', default: 'https://api.notifichedigitali.it' },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTING_DEFS;

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFS, k);
}
```

- [ ] **Step 2: Crea l'entity**

```typescript
// apps/backend/src/entities/app-setting.entity.ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('app_settings')
export class AppSetting {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: string | number | boolean;

  @Column({ type: 'boolean', default: false })
  encrypted!: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'varchar', length: 128, nullable: true })
  updatedBy!: string | null;
}
```

Registra in `apps/backend/src/database/database.module.ts`: importa `AppSetting` e aggiungila all'array `entities: [Campaign, Recipient, NotificationAttempt, AppSetting]`. (`synchronize: true` in dev crea la tabella da sola.)

- [ ] **Step 3: Scrivi il test del service che fallisce**

```typescript
// apps/backend/src/settings/app-settings.service.spec.ts
import { BadRequestException } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from '../entities/app-setting.entity';
import { MASKED_VALUE } from './settings.registry';
import { deriveSettingsKey, encryptValue } from './settings-crypto';

describe('AppSettingsService', () => {
  let rows: Map<string, AppSetting>;
  let service: AppSettingsService;

  const repoMock = {
    findOneBy: jest.fn(async ({ key }: { key: string }) => rows.get(key) ?? null),
    find: jest.fn(async () => Array.from(rows.values())),
    save: jest.fn(async (entity: AppSetting) => {
      rows.set(entity.key, entity);
      return entity;
    }),
  };

  const configMock = {
    get: jest.fn(() => 'test-jwt-secret'),
  };

  beforeEach(() => {
    rows = new Map();
    jest.clearAllMocks();
    delete process.env['SMTP_HOST'];
    delete process.env['RETENTION_MAX_DAYS'];
    delete process.env['SMTP_PASSWORD'];
    service = new AppSettingsService(repoMock as never, configMock as never);
  });

  it('legge dal DB quando la chiave esiste', async () => {
    rows.set('smtp.host', { key: 'smtp.host', value: 'mail.example.it', encrypted: false } as AppSetting);
    await expect(service.get('smtp.host')).resolves.toBe('mail.example.it');
  });

  it('fallback su env quando assente in DB, con coercizione di tipo', async () => {
    process.env['RETENTION_MAX_DAYS'] = '30';
    await expect(service.get('retention.maxDays')).resolves.toBe(30);
  });

  it('fallback sul default quando assente in DB e env', async () => {
    await expect(service.get('retention.maxDays')).resolves.toBe(90);
    await expect(service.get('smtp.host')).resolves.toBe('localhost');
  });

  it('usa la cache: seconda lettura senza query', async () => {
    rows.set('smtp.host', { key: 'smtp.host', value: 'mail.example.it', encrypted: false } as AppSetting);
    await service.get('smtp.host');
    await service.get('smtp.host');
    expect(repoMock.findOneBy).toHaveBeenCalledTimes(1);
  });

  it('decifra i valori cifrati', async () => {
    const key = deriveSettingsKey('test-jwt-secret');
    rows.set('smtp.password', {
      key: 'smtp.password',
      value: encryptValue('super-segreta', key),
      encrypted: true,
    } as AppSetting);
    await expect(service.get('smtp.password')).resolves.toBe('super-segreta');
  });

  it('decrypt fallito → fallback env/default senza lanciare', async () => {
    const wrongKey = deriveSettingsKey('altro-secret');
    rows.set('smtp.password', {
      key: 'smtp.password',
      value: encryptValue('x', wrongKey),
      encrypted: true,
    } as AppSetting);
    await expect(service.get('smtp.password')).resolves.toBe('');
  });

  it('setMany cifra i secret e invalida la cache', async () => {
    await service.get('smtp.host'); // popola cache col default
    await service.setMany({ 'smtp.host': 'nuovo.host.it', 'smtp.password': 'pwd123' }, 'mario.rossi');
    const saved = rows.get('smtp.password');
    expect(saved?.encrypted).toBe(true);
    expect(String(saved?.value).startsWith('enc:v1:')).toBe(true);
    await expect(service.get('smtp.host')).resolves.toBe('nuovo.host.it');
    await expect(service.get('smtp.password')).resolves.toBe('pwd123');
  });

  it('setMany ignora i secret mascherati (valore ••••••••)', async () => {
    await service.setMany({ 'smtp.password': 'originale' }, 'mario.rossi');
    await service.setMany({ 'smtp.password': MASKED_VALUE }, 'mario.rossi');
    await expect(service.get('smtp.password')).resolves.toBe('originale');
  });

  it('setMany rifiuta chiavi sconosciute con 400', async () => {
    await expect(service.setMany({ 'hack.me': 'x' }, 'u')).rejects.toThrow(BadRequestException);
  });

  it('setMany rifiuta tipi errati con 400', async () => {
    await expect(service.setMany({ 'retention.maxDays': 'trenta' }, 'u')).rejects.toThrow(BadRequestException);
  });

  it('getAllMasked maschera i secret valorizzati e lascia vuoti quelli assenti', async () => {
    await service.setMany({ 'smtp.password': 'pwd', 'smtp.host': 'h' }, 'u');
    const all = await service.getAllMasked();
    expect(all['smtp.password']).toBe(MASKED_VALUE);
    expect(all['pec.password']).toBe('');
    expect(all['smtp.host']).toBe('h');
    expect(all['retention.maxDays']).toBe(90);
  });
});
```

- [ ] **Step 4: Esegui il test — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest app-settings.service`
Expected: FAIL — `Cannot find module './app-settings.service'`

- [ ] **Step 5: Implementa il service**

```typescript
// apps/backend/src/settings/app-settings.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AppSetting } from '../entities/app-setting.entity';
import type { AppConfiguration } from '../config/configuration';
import {
  MASKED_VALUE,
  SETTING_DEFS,
  isSettingKey,
  type SettingDef,
  type SettingKey,
  type SettingValue,
} from './settings.registry';
import { decryptValue, deriveSettingsKey, encryptValue } from './settings-crypto';

@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);
  private readonly cache = new Map<SettingKey, SettingValue>();
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  async get<T extends SettingValue>(key: SettingKey): Promise<T> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    const def = SETTING_DEFS[key] as SettingDef;
    const row = await this.repo.findOneBy({ key });

    if (row) {
      if (row.encrypted) {
        try {
          const plain = decryptValue(String(row.value), this.cryptoKey);
          this.cache.set(key, plain);
          return plain as T;
        } catch {
          // JWT_SECRET cambiato: il valore va reinserito da UI. Fallback env/default.
          this.logger.warn(`Impossibile decifrare il setting "${key}": reinserirlo dalla UI.`);
        }
      } else {
        this.cache.set(key, row.value);
        return row.value as T;
      }
    }

    const value = this.envOrDefault(def);
    this.cache.set(key, value);
    return value as T;
  }

  async getAllMasked(): Promise<Record<SettingKey, SettingValue>> {
    const result = {} as Record<SettingKey, SettingValue>;
    for (const key of Object.keys(SETTING_DEFS) as SettingKey[]) {
      const def = SETTING_DEFS[key] as SettingDef;
      const value = await this.get(key);
      result[key] = def.secret ? (value ? MASKED_VALUE : '') : value;
    }
    return result;
  }

  async setMany(entries: Record<string, SettingValue>, updatedBy: string): Promise<void> {
    const validated: Array<{ key: SettingKey; def: SettingDef; value: SettingValue }> = [];

    for (const [key, value] of Object.entries(entries)) {
      if (!isSettingKey(key)) {
        throw new BadRequestException(
          `Chiave sconosciuta: "${key}". Chiavi valide: ${Object.keys(SETTING_DEFS).join(', ')}`,
        );
      }
      const def = SETTING_DEFS[key] as SettingDef;
      if (def.secret && value === MASKED_VALUE) {
        continue; // valore mascherato dalla UI: non toccare quello salvato
      }
      if (typeof value !== def.type) {
        throw new BadRequestException(`Il setting "${key}" richiede tipo ${def.type}`);
      }
      validated.push({ key, def, value });
    }

    for (const { key, def, value } of validated) {
      const entity = new AppSetting();
      entity.key = key;
      entity.encrypted = def.secret === true;
      entity.value = def.secret ? encryptValue(String(value), this.cryptoKey) : value;
      entity.updatedBy = updatedBy;
      await this.repo.save(entity);
    }

    this.clearCache();
  }

  clearCache(): void {
    this.cache.clear();
  }

  private envOrDefault(def: SettingDef): SettingValue {
    const raw = def.env ? process.env[def.env] : undefined;
    if (raw === undefined || raw === '') {
      return def.default;
    }
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        return Number.isFinite(n) ? n : def.default;
      }
      case 'boolean':
        return raw === 'true';
      default:
        return raw;
    }
  }
}
```

- [ ] **Step 6: Esegui i test — devono passare**

Run: `docker compose exec backend node_modules/.bin/jest app-settings.service`
Expected: PASS (11 test)

- [ ] **Step 7: Verifica che l'intera suite passi ancora**

Run: `docker compose exec backend node_modules/.bin/jest`
Expected: PASS (nessuna regressione)

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/entities/app-setting.entity.ts apps/backend/src/settings/ apps/backend/src/database/database.module.ts
git commit -m "feat(settings): entity app_settings + AppSettingsService con fallback DB->env->default"
```

---

### Task 3: SettingsModule con endpoint GET/PUT /settings

**Files:**
- Create: `apps/backend/src/settings/settings.module.ts`
- Create: `apps/backend/src/settings/dto/update-settings.dto.ts`
- Modify: `apps/backend/src/settings/settings.controller.ts` (aggiungi GET/PUT, inietta `AppSettingsService`)
- Modify: `apps/backend/src/app.module.ts` (importa `SettingsModule`, rimuovi `SettingsController` da `controllers`)
- Test: `apps/backend/src/settings/settings.controller.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.getAllMasked/setMany` (Task 2)
- Produces:
  - `GET /settings` (admin) → `{ settings: Record<SettingKey, string | number | boolean> }` (secret mascherati)
  - `PUT /settings` (admin) body `{ settings: Record<string, string | number | boolean> }` → stessa shape del GET dopo il salvataggio
  - `SettingsModule` globale che esporta `AppSettingsService`

- [ ] **Step 1: Crea il modulo (globale: config cross-cutting usata da channels, queue, campaigns)**

```typescript
// apps/backend/src/settings/settings.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from '../entities/app-setting.entity';
import { AppSettingsService } from './app-settings.service';
import { SettingsController } from './settings.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  controllers: [SettingsController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
```

In `app.module.ts`: aggiungi `SettingsModule` agli `imports`, togli `SettingsController` dall'array `controllers` e il relativo import.

- [ ] **Step 2: DTO**

```typescript
// apps/backend/src/settings/dto/update-settings.dto.ts
import { IsObject } from 'class-validator';

export class UpdateSettingsDto {
  @IsObject()
  settings!: Record<string, string | number | boolean>;
}
```

(La validazione puntuale di chiavi e tipi resta in `AppSettingsService.setMany`.)

- [ ] **Step 3: Scrivi il test del controller che fallisce**

```typescript
// apps/backend/src/settings/settings.controller.spec.ts
import { SettingsController } from './settings.controller';
import { MASKED_VALUE } from './settings.registry';

describe('SettingsController — GET/PUT', () => {
  const settingsMock = {
    getAllMasked: jest.fn(async () => ({ 'smtp.host': 'h', 'smtp.password': MASKED_VALUE })),
    setMany: jest.fn(async () => undefined),
  };
  const configMock = { get: jest.fn(() => '') };

  const controller = new SettingsController(configMock as never, settingsMock as never);

  it('GET restituisce i settings mascherati', async () => {
    const res = await controller.getAll();
    expect(res).toEqual({ settings: { 'smtp.host': 'h', 'smtp.password': MASKED_VALUE } });
  });

  it('PUT salva con lo username del token e restituisce lo stato aggiornato', async () => {
    const req = { user: { username: 'mario.rossi' } };
    const res = await controller.update({ settings: { 'smtp.host': 'nuovo' } }, req as never);
    expect(settingsMock.setMany).toHaveBeenCalledWith({ 'smtp.host': 'nuovo' }, 'mario.rossi');
    expect(res.settings['smtp.host']).toBe('h');
  });
});
```

- [ ] **Step 4: Esegui il test — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest settings.controller`
Expected: FAIL — il costruttore attuale accetta solo `ConfigService`, mancano `getAll`/`update`

- [ ] **Step 5: Estendi il controller**

In `settings.controller.ts` aggiungi import e metodi (il resto del file — test-email/test-pec — resta invariato):

```typescript
import { Body, Get, Put, Req } from '@nestjs/common'; // aggiungi ai già importati
import type { Request } from 'express';
import { AppSettingsService } from './app-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

// costruttore:
constructor(
  private readonly configService: ConfigService<AppConfiguration, true>,
  private readonly appSettings: AppSettingsService,
) {}

@Get()
async getAll() {
  return { settings: await this.appSettings.getAllMasked() };
}

@Put()
async update(@Body() body: UpdateSettingsDto, @Req() req: Request) {
  const user = (req as { user?: { username?: string } }).user?.username ?? 'sconosciuto';
  await this.appSettings.setMany(body.settings, user);
  return { settings: await this.appSettings.getAllMasked() };
}
```

- [ ] **Step 6: Esegui test + suite completa**

Run: `docker compose exec backend node_modules/.bin/jest settings.controller && docker compose exec backend node_modules/.bin/jest`
Expected: PASS

- [ ] **Step 7: Verifica manuale end-to-end (synchronize crea la tabella)**

```bash
docker compose up -d --build backend
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d app_settings"
```
Expected: tabella `app_settings` con colonne `key`, `value`, `encrypted`, `updated_at`, `updated_by`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/settings/ apps/backend/src/app.module.ts
git commit -m "feat(settings): endpoint GET/PUT /settings (admin) con secret mascherati"
```

---

### Task 4: Path allegati unificato su ATTACHMENTS_PATH

**Files:**
- Create: `apps/backend/src/attachments/attachment-paths.ts`
- Modify: `apps/backend/src/config/configuration.ts` (aggiungi `attachments.path`)
- Modify: `apps/backend/src/pdf/pdf.service.ts:9`
- Modify: `apps/backend/src/attachments/attachment.service.ts:44`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts:79-81`
- Modify: `apps/backend/src/campaigns/retention-cleanup.service.ts:52`
- Test: `apps/backend/src/attachments/attachment-paths.spec.ts` + aggiornamento spec esistenti che stub-bano i path

**Interfaces:**
- Produces:
  - `getAttachmentsRoot(): string` — `process.env['ATTACHMENTS_PATH'] ?? '/data/attachments'`
  - `getUploadsDir(campaignId: string): string` — `<root>/uploads/<campaignId>`
  - `getBrandingDir(): string` — `<root>/branding`

Funzioni (non costanti modulo) così i test possono variare `process.env` per-test.

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/attachments/attachment-paths.spec.ts
import { join } from 'path';
import { getAttachmentsRoot, getUploadsDir, getBrandingDir } from './attachment-paths';

describe('attachment-paths', () => {
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('default /data/attachments', () => {
    expect(getAttachmentsRoot()).toBe('/data/attachments');
  });

  it('rispetta ATTACHMENTS_PATH', () => {
    process.env['ATTACHMENTS_PATH'] = '/mnt/allegati';
    expect(getAttachmentsRoot()).toBe('/mnt/allegati');
    expect(getUploadsDir('camp-1')).toBe(join('/mnt/allegati', 'uploads', 'camp-1'));
    expect(getBrandingDir()).toBe(join('/mnt/allegati', 'branding'));
  });
});
```

- [ ] **Step 2: Esegui — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest attachment-paths`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Implementa**

```typescript
// apps/backend/src/attachments/attachment-paths.ts
import { join } from 'path';

/**
 * Radice unica dello storage allegati (volume dedicato in prod).
 * Letta a ogni chiamata così i test possono variare l'env.
 */
export function getAttachmentsRoot(): string {
  return process.env['ATTACHMENTS_PATH'] ?? '/data/attachments';
}

/** PDF caricati dall'operatore per una campagna. */
export function getUploadsDir(campaignId: string): string {
  return join(getAttachmentsRoot(), 'uploads', campaignId);
}

/** Logo e favicon caricati dalla UI admin. */
export function getBrandingDir(): string {
  return join(getAttachmentsRoot(), 'branding');
}
```

- [ ] **Step 4: Sostituisci i quattro consumer**

In `configuration.ts` aggiungi all'interfaccia e alla factory:

```typescript
// nell'interfaccia AppConfiguration:
attachments: {
  path: string;
};
// nella factory:
attachments: {
  path: process.env['ATTACHMENTS_PATH'] ?? '/data/attachments',
},
```

`pdf.service.ts` — sostituisci la riga 9:

```typescript
import { getAttachmentsRoot } from '../attachments/attachment-paths';
// al posto di: private readonly storagePath = process.env['PDF_STORAGE_PATH'] ?? '/data/attachments';
private get storagePath(): string {
  return getAttachmentsRoot();
}
```

`attachment.service.ts:44` — sostituisci:

```typescript
import { getUploadsDir } from './attachment-paths';
// al posto di: const filePath = join(__dirname, '..', '..', 'uploads', 'attachments', recipient.campaignId, customFilename);
const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
```

`campaigns.controller.ts:79-81` — sostituisci la callback `destination`:

```typescript
import { getUploadsDir } from '../attachments/attachment-paths';
// dentro diskStorage:
destination: (req, _file, cb) => {
  const dir = getUploadsDir(req.params['id'] as string);
  fs.mkdirSync(dir, { recursive: true });
  cb(null, dir);
},
```

`retention-cleanup.service.ts:52` — sostituisci:

```typescript
import { getUploadsDir } from '../attachments/attachment-paths';
// al posto della join su __dirname:
const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
```

- [ ] **Step 5: Aggiorna gli spec esistenti che dipendono dal vecchio path**

Esegui la suite: `docker compose exec backend node_modules/.bin/jest`. Se `retention-cleanup.service.spec.ts` (o altri) asseriscono il vecchio path con `__dirname`, aggiorna le asserzioni usando `getUploadsDir(campaignId)` importato dallo stesso helper — mai ricostruire il path a mano nei test. Esempio di asserzione aggiornata:

```typescript
import { getUploadsDir } from '../attachments/attachment-paths';
import { join } from 'path';
// ...
expect(unlinkMock).toHaveBeenCalledWith(join(getUploadsDir('campaign-id'), 'file.pdf'));
```

- [ ] **Step 6: Suite completa verde**

Run: `docker compose exec backend node_modules/.bin/jest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/attachments/ apps/backend/src/pdf/pdf.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/retention-cleanup.service.ts apps/backend/src/config/configuration.ts
git commit -m "fix(attachments): path unificato ATTACHMENTS_PATH, upload operatore su volume persistente"
```

---

### Task 5: Endpoint branding (upload logo/favicon + GET pubblico)

**Files:**
- Create: `apps/backend/src/settings/branding.controller.ts`
- Modify: `apps/backend/src/settings/settings.module.ts` (registra il controller)
- Test: `apps/backend/src/settings/branding.controller.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get/setMany` (Task 2), `getBrandingDir()` (Task 4)
- Produces:
  - `GET /branding` (pubblico) → `{ name: string; subtitle: string; logoUrl: string | null; faviconUrl: string | null }` (URL relativi `/branding/logo`, `/branding/favicon`)
  - `GET /branding/logo`, `GET /branding/favicon` (pubblici) → bytes del file, 404 se non configurato
  - `POST /settings/branding/logo`, `POST /settings/branding/favicon` (admin, multipart `file`) → `{ filename: string }`

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/settings/branding.controller.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BrandingController, ALLOWED_LOGO_TYPES } from './branding.controller';

describe('BrandingController', () => {
  const values = new Map<string, string | number | boolean>([
    ['brand.name', 'Comune Test'],
    ['brand.subtitle', ''],
    ['brand.logo', ''],
    ['brand.favicon', ''],
  ]);
  const settingsMock = {
    get: jest.fn(async (k: string) => values.get(k)),
    setMany: jest.fn(async (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) values.set(k, v);
    }),
  };
  const controller = new BrandingController(settingsMock as never);

  it('GET /branding senza logo → logoUrl null', async () => {
    const res = await controller.getBranding();
    expect(res).toEqual({ name: 'Comune Test', subtitle: '', logoUrl: null, faviconUrl: null });
  });

  it('GET /branding con logo → URL relativo', async () => {
    values.set('brand.logo', 'logo.png');
    const res = await controller.getBranding();
    expect(res.logoUrl).toBe('/branding/logo');
  });

  it('GET /branding/logo senza file configurato → 404', async () => {
    values.set('brand.logo', '');
    await expect(controller.getLogo({ sendFile: jest.fn() } as never)).rejects.toThrow(NotFoundException);
  });

  it('upload rifiuta mimetype non ammessi', async () => {
    const file = { mimetype: 'application/pdf', originalname: 'x.pdf', buffer: Buffer.from('') };
    await expect(controller.uploadLogo(file as never)).rejects.toThrow(BadRequestException);
  });

  it('espone i mimetype ammessi per il logo', () => {
    expect(ALLOWED_LOGO_TYPES).toContain('image/png');
    expect(ALLOWED_LOGO_TYPES).toContain('image/svg+xml');
  });
});
```

- [ ] **Step 2: Esegui — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest branding.controller`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Implementa il controller**

```typescript
// apps/backend/src/settings/branding.controller.ts
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { getBrandingDir } from '../attachments/attachment-paths';
import { AppSettingsService } from './app-settings.service';

export const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
export const ALLOWED_FAVICON_TYPES = ['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

@Controller()
export class BrandingController {
  constructor(private readonly appSettings: AppSettingsService) {}

  @Public()
  @Get('branding')
  async getBranding() {
    const [name, subtitle, logo, favicon] = await Promise.all([
      this.appSettings.get<string>('brand.name'),
      this.appSettings.get<string>('brand.subtitle'),
      this.appSettings.get<string>('brand.logo'),
      this.appSettings.get<string>('brand.favicon'),
    ]);
    return {
      name,
      subtitle,
      logoUrl: logo ? '/branding/logo' : null,
      faviconUrl: favicon ? '/branding/favicon' : null,
    };
  }

  @Public()
  @Get('branding/logo')
  async getLogo(@Res() res: Response): Promise<void> {
    await this.serveFile('brand.logo', res);
  }

  @Public()
  @Get('branding/favicon')
  async getFavicon(@Res() res: Response): Promise<void> {
    await this.serveFile('brand.favicon', res);
  }

  @Post('settings/branding/logo')
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file'))
  async uploadLogo(@UploadedFile() file: Express.Multer.File) {
    return this.saveBrandingFile(file, ALLOWED_LOGO_TYPES, 'logo', 'brand.logo');
  }

  @Post('settings/branding/favicon')
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFavicon(@UploadedFile() file: Express.Multer.File) {
    return this.saveBrandingFile(file, ALLOWED_FAVICON_TYPES, 'favicon', 'brand.favicon');
  }

  private async serveFile(settingKey: 'brand.logo' | 'brand.favicon', res: Response): Promise<void> {
    const filename = await this.appSettings.get<string>(settingKey);
    const filePath = filename ? join(getBrandingDir(), filename) : '';
    if (!filename || !existsSync(filePath)) {
      throw new NotFoundException('File di branding non configurato');
    }
    res.sendFile(filePath);
  }

  private async saveBrandingFile(
    file: Express.Multer.File,
    allowedTypes: string[],
    baseName: 'logo' | 'favicon',
    settingKey: 'brand.logo' | 'brand.favicon',
  ): Promise<{ filename: string }> {
    if (!file) {
      throw new BadRequestException('File richiesto (campo multipart "file")');
    }
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(`Tipo non ammesso: ${file.mimetype}. Ammessi: ${allowedTypes.join(', ')}`);
    }
    if (file.buffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException('File troppo grande (max 2 MB)');
    }

    const dir = getBrandingDir();
    mkdirSync(dir, { recursive: true });

    // Rimuovi le versioni precedenti con estensione diversa (logo.png vs logo.svg)
    for (const existing of readdirSync(dir)) {
      if (existing.startsWith(`${baseName}.`)) {
        unlinkSync(join(dir, existing));
      }
    }

    const filename = `${baseName}${extname(file.originalname).toLowerCase() || '.png'}`;
    writeFileSync(join(dir, filename), file.buffer);
    await this.appSettings.setMany({ [settingKey]: filename }, 'branding-upload');
    return { filename };
  }
}
```

Registra in `settings.module.ts`: `controllers: [SettingsController, BrandingController]`.

Nota: `FileInterceptor` senza `diskStorage` usa memory storage → `file.buffer` disponibile. I due `@Get('branding/...')` usano `@Res()` raw: niente return JSON, solo `sendFile`.

- [ ] **Step 4: Esegui test + suite**

Run: `docker compose exec backend node_modules/.bin/jest branding.controller && docker compose exec backend node_modules/.bin/jest`
Expected: PASS

- [ ] **Step 5: Verifica manuale**

```bash
curl -s http://localhost:8080/branding
```
Expected: `{"name":"Comune di Montesilvano","subtitle":"","logoUrl":null,"faviconUrl":null}`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/settings/
git commit -m "feat(branding): upload logo/favicon da UI e endpoint pubblico /branding"
```

---

### Task 6: Endpoint /version

**Files:**
- Modify: `apps/backend/src/app.controller.ts`
- Test: `apps/backend/src/app.controller.spec.ts` (create)

**Interfaces:**
- Produces: `GET /version` (pubblico) → `{ version: string }` — `process.env['APP_VERSION'] ?? 'dev'`

- [ ] **Step 1: Test che fallisce**

```typescript
// apps/backend/src/app.controller.spec.ts
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController — version', () => {
  const controller = new AppController(new AppService());

  afterEach(() => {
    delete process.env['APP_VERSION'];
  });

  it('senza APP_VERSION → dev', () => {
    expect(controller.getVersion()).toEqual({ version: 'dev' });
  });

  it('con APP_VERSION → valore iniettato', () => {
    process.env['APP_VERSION'] = 'v0.5.0';
    expect(controller.getVersion()).toEqual({ version: 'v0.5.0' });
  });
});
```

- [ ] **Step 2: Esegui — deve fallire**

Run: `docker compose exec backend node_modules/.bin/jest app.controller`
Expected: FAIL — `getVersion is not a function`

- [ ] **Step 3: Implementa**

In `app.controller.ts` aggiungi:

```typescript
@Public()
@Get('version')
getVersion(): { version: string } {
  return { version: process.env['APP_VERSION'] ?? 'dev' };
}
```

- [ ] **Step 4: Esegui — deve passare**

Run: `docker compose exec backend node_modules/.bin/jest app.controller`
Expected: PASS. Verifica manuale: `curl -s http://localhost:8080/version` → `{"version":"dev"}`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/app.controller.ts apps/backend/src/app.controller.spec.ts
git commit -m "feat(version): endpoint pubblico /version con APP_VERSION (default dev)"
```

---

### Task 7: Refactor consumatori — strategy, processor, test-email/pec su AppSettingsService

**Files:**
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Modify: `apps/backend/src/channels/app-io/app-io.strategy.ts`
- Modify: `apps/backend/src/channels/send/send.strategy.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts:80,135`
- Modify: `apps/backend/src/settings/settings.controller.ts` (fallback password test-email/test-pec)
- Test: aggiorna `email.strategy.spec.ts`, `pec.strategy.spec.ts`, `app-io.strategy.spec.ts`, `send.strategy.spec.ts`, `notification.processor.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get` (Task 2; il modulo è `@Global()`, quindi iniettabile ovunque senza import di modulo)
- Produces: nessuna nuova API — stesso comportamento, sorgente valori diversa. `ConfigService` resta per `origins.publicApi`, `downloadLink.secret`.

- [ ] **Step 1: Refactor `EmailStrategy`**

Costruttore e letture (righe 17, 24-34):

```typescript
import { AppSettingsService } from '../../settings/app-settings.service';

constructor(
  private readonly config: ConfigService<AppConfiguration, true>,
  private readonly settings: AppSettingsService,
) {}

// dentro send(), al posto delle config.get('smtp.*') e affini:
const host = await this.settings.get<string>('smtp.host');
const port = await this.settings.get<number>('smtp.port');
const secure = await this.settings.get<boolean>('smtp.secure');
const user = await this.settings.get<string>('smtp.user');
const password = await this.settings.get<string>('smtp.password');
const defaultFrom = await this.settings.get<string>('smtp.from');
const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
const publicApiUrl = this.config.get('origins.publicApi', { infer: true });      // resta env
const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true }); // resta env
const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
```

- [ ] **Step 2: Stesso refactor per `PecStrategy`** (chiavi `pec.*`, più `brand.name` e `retention.maxDays` — righe 24-33, stessa forma dello Step 1)

- [ ] **Step 3: Stesso refactor per `AppIoStrategy` e `SendStrategy`**

```typescript
// app-io.strategy.ts righe 20-21:
const apiKey = await this.settings.get<string>('appIo.apiKey');
const baseUrl = await this.settings.get<string>('appIo.baseUrl');
// send.strategy.ts righe 20-21:
const apiKey = await this.settings.get<string>('send.apiKey');
const baseUrl = await this.settings.get<string>('send.baseUrl');
```

- [ ] **Step 4: `notification.processor.ts`** — righe 80 e 135: sostituisci `this.config.get('retention.maxDays', { infer: true })` con `await this.settings.get<number>('retention.maxDays')` (aggiungi `AppSettingsService` al costruttore come sopra; verifica che i due punti siano in funzioni `async` — lo sono, sono nel flusso del processor).

- [ ] **Step 5: `settings.controller.ts`** — nei metodi `testEmail`/`testPec` sostituisci il fallback password:

```typescript
// testEmail:
password = (await this.appSettings.get<string>('smtp.password')) || '';
// testPec:
password = (await this.appSettings.get<string>('pec.password')) || '';
```

Dopo questo passo `configService` nel controller non ha più usi: rimuovi il parametro dal costruttore e aggiorna `settings.controller.spec.ts` (il costruttore diventa `new SettingsController(settingsMock as never)` e il mock deve esporre anche `get`).

- [ ] **Step 6: Aggiorna gli spec delle strategy**

Pattern per tutti (esempio `email.strategy.spec.ts`): dove il test costruisce la strategy con un mock di `ConfigService`, aggiungi un secondo mock per `AppSettingsService` che risolve le stesse chiavi:

```typescript
const settingsValues: Record<string, string | number | boolean> = {
  'smtp.host': 'smtp.test.it',
  'smtp.port': 587,
  'smtp.secure': false,
  'smtp.user': '',
  'smtp.password': '',
  'smtp.from': 'noreply@test.it',
  'brand.name': 'Comune Test',
  'retention.maxDays': 90,
};
const settingsMock = { get: jest.fn(async (k: string) => settingsValues[k]) };
// costruzione: new EmailStrategy(configMock as never, settingsMock as never)
```

Sposta nel `settingsMock` le chiavi che prima erano nel mock di `ConfigService` (che conserva solo `origins.publicApi` e `downloadLink.secret`). Stessa operazione per pec (`pec.*`), app-io (`appIo.*`), send (`send.*`), processor (`retention.maxDays`).

- [ ] **Step 7: Suite completa verde**

Run: `docker compose exec backend node_modules/.bin/jest`
Expected: PASS

- [ ] **Step 8: Verifica funzionale**

```bash
docker compose logs backend --tail 20   # nessun errore DI all'avvio
```
Poi dalla UI admin (o via curl con token admin): `PUT /settings` con `{"settings":{"smtp.host":"mailhog"}}` seguito da `GET /settings` → il valore torna aggiornato.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/channels/ apps/backend/src/queue/ apps/backend/src/settings/
git commit -m "refactor(channels): config canali e retention letti da AppSettingsService (DB con fallback env)"
```

---

### Task 8: Pulizia configuration.ts, .env e .env.example

**Files:**
- Modify: `apps/backend/src/config/configuration.ts` (rimuovi sezioni migrate)
- Modify: `.env.example` (riscrittura completa)
- Modify: `.env` (allineamento)

**Interfaces:**
- Consumes: dopo il Task 7 nessun codice legge più `smtp|pec|appIo|send|brand|retention` da `ConfigService` — verifica con `grep` prima di rimuovere.
- Produces: `AppConfiguration` ridotta a: `port`, `nodeEnv`, `database`, `redis`, `jwt`, `ldap`, `oidc`, `origins`, `downloadLink`, `attachments`.

- [ ] **Step 1: Verifica che non restino consumer**

```bash
docker compose exec backend sh -c "grep -rn \"config.get('smtp\|config.get('pec\|config.get('appIo\|config.get('send\|config.get('brand\|config.get('retention\" src/ || echo PULITO"
```
Expected: `PULITO`. Se escono match, torna al Task 7.

- [ ] **Step 2: Riduci `configuration.ts`**

Rimuovi dall'interfaccia `AppConfiguration` e dalla factory le sezioni `smtp`, `pec`, `appIo`, `send`, `brand`, `retention` (i fallback env vivono ora in `settings.registry.ts`). Restano: `port`, `nodeEnv`, `database`, `redis`, `jwt`, `ldap`, `oidc`, `origins`, `downloadLink`, `attachments`.

- [ ] **Step 3: Riscrivi `.env.example`**

Contenuto completo (sostituisce il file):

```bash
# ComunicaPA — Esempio configurazione
# Copia questo file in .env e adatta i valori al tuo ambiente.
# Non committare mai .env con credenziali reali nel repository!
#
# Qui vivono SOLO le variabili sistemistiche/di bootstrap.
# Branding, retention, SMTP, PEC, App IO e SEND si configurano dalla
# UI admin (menu Impostazioni) e sono persistite nel database.

# ── Compose ───────────────────────────────────────────────────────────────────
# SOLO SVILUPPO: attiva l'override con bind mount e hot-reload.
# Windows usa ";" come separatore, Linux/macOS usa ":".
# In produzione (Portainer/podman) NON impostare questa variabile.
COMPOSE_FILE=docker-compose.yml;docker-compose.override.yml

# Tag delle immagini di produzione (es. v0.5.0). Default: latest.
IMAGE_TAG=latest

# ── Porte host ────────────────────────────────────────────────────────────────
BACKEND_PORT=8080
ADMIN_PORT=3000
CITIZEN_PORT=3001

# ── PostgreSQL ────────────────────────────────────────────────────────────────
# Il compose costruisce da sé la stringa di connessione: servono solo questi.
POSTGRES_USER=comunicapa
POSTGRES_PASSWORD=comunicapa_dev_password
POSTGRES_DB=comunicapa_db

# ── Node ──────────────────────────────────────────────────────────────────────
LOG_LEVEL=info

# ── Secret ────────────────────────────────────────────────────────────────────
# OBBLIGATORI in produzione. Genera con: openssl rand -hex 32
# JWT_SECRET firma i token operatore E deriva la chiave di cifratura dei
# settings salvati in DB: se lo cambi, i secret salvati vanno reinseriti da UI.
JWT_SECRET=change-me-in-production-use-openssl-rand-hex-32
JWT_EXPIRES_IN=8h
DOWNLOAD_LINK_SECRET=change-me-in-production-use-openssl-rand-hex-32

# ── URL pubblici ──────────────────────────────────────────────────────────────
PUBLIC_BACKEND_URL=http://localhost:8080
ADMIN_ORIGIN=http://localhost:3000
CITIZEN_ORIGIN=http://localhost:3001

# ── Storage allegati ─────────────────────────────────────────────────────────
# Path INTERNO al container, montato sul volume attachments_data.
# Per cambiare posizione fisica: rimappa il volume, non questa variabile.
ATTACHMENTS_PATH=/data/attachments

# ── LDAP / Active Directory (bootstrap auth operatori) ───────────────────────
LDAP_HOST=ldap://intranet.comune.montesilvano.pe.it:389
LDAP_TLS_SKIP_VERIFY=true
LDAP_STARTTLS=false
LDAP_BASE_DN=DC=intranet,DC=comune,DC=montesilvano,DC=pe,DC=it
LDAP_USER_DN_TEMPLATE=%s@intranet.comune.montesilvano.pe.it
LDAP_BIND_DN=
LDAP_BIND_PASSWORD=
LDAP_REQUIRED_GROUP=COMUNICAPA_USERS
LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS

# ── OIDC / pa-sso-proxy (cittadini SPID/CIE) ─────────────────────────────────
OIDC_ISSUER=
OIDC_AUDIENCE=comunicapa
OIDC_JWKS_URI=
```

- [ ] **Step 4: Allinea `.env`**

Applica la stessa struttura a `.env` conservando i valori locali reali già presenti (`LDAP_REQUIRED_GROUP=ALL_USERS_GOPULLEY`, `LDAP_ADMIN_GROUP=ADMIN_GOPULLEY`, `JWT_SECRET=dev-secret-change-in-production`, `NODE_ENV` non serve più qui: il compose lo imposta). Rimuovi da `.env`: `POSTGRES_HOST/PORT`, `REDIS_HOST/PORT`, `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `SMTP_*`, `PEC_*`, `APP_IO_*`, `SEND_*`, `BRAND_*`, `PDF_STORAGE_PATH`. Aggiungi `COMPOSE_FILE`, `IMAGE_TAG`, `DOWNLOAD_LINK_SECRET`, `PUBLIC_BACKEND_URL`, `ATTACHMENTS_PATH`.

NOTA: `.env` è gitignored — modifica solo il file locale, niente da committare per quello.

- [ ] **Step 5: Rebuild e suite verde**

Run: `docker compose up -d --build backend && docker compose exec backend node_modules/.bin/jest`
Expected: avvio pulito + PASS. (Il compose non è ancora stato splittato: le var rimosse avevano già i default nel compose attuale, il backend usa il fallback del registry.)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config/configuration.ts .env.example
git commit -m "chore(env): .env solo bootstrap; config applicative migrate al registry settings"
```

---

### Task 9: Split compose — base prod + override dev

**Files:**
- Modify: `docker-compose.yml` (diventa produzione)
- Create: `docker-compose.override.yml` (sviluppo)
- Modify: `CLAUDE.md` (sezione Dev Environment: `COMPOSE_FILE`, nuovo flusso)

**Interfaces:**
- Consumes: variabili `.env` del Task 8; immagini prod del Task 12 (per il deploy reale — la verifica qui usa solo `docker compose config`).
- Produces: stack prod self-contained per Portainer/podman rootless; dev identico a prima via override.

- [ ] **Step 1: Riscrivi `docker-compose.yml` (produzione)**

```yaml
name: comunicapa

# PRODUZIONE (podman rootless / Portainer): immagini da registry, solo volumi
# named, nessun bind mount. Per lo sviluppo vedi docker-compose.override.yml
# (attivato da COMPOSE_FILE in .env).

services:

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - comunicapa-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    networks:
      - comunicapa-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/mirkochipdotcom/comunicapa-backend:${IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "${BACKEND_PORT:-8080}:8080"
    environment:
      NODE_ENV: production
      PORT: "8080"
      LOG_LEVEL: ${LOG_LEVEL:-info}
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET obbligatorio - genera con openssl rand -hex 32}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-8h}
      DOWNLOAD_LINK_SECRET: ${DOWNLOAD_LINK_SECRET:?DOWNLOAD_LINK_SECRET obbligatorio - genera con openssl rand -hex 32}
      PUBLIC_BACKEND_URL: ${PUBLIC_BACKEND_URL:-http://localhost:8080}
      ADMIN_ORIGIN: ${ADMIN_ORIGIN:-http://localhost:3000}
      CITIZEN_ORIGIN: ${CITIZEN_ORIGIN:-http://localhost:3001}
      ATTACHMENTS_PATH: ${ATTACHMENTS_PATH:-/data/attachments}
      LDAP_HOST: ${LDAP_HOST:-}
      LDAP_TLS_SKIP_VERIFY: ${LDAP_TLS_SKIP_VERIFY:-true}
      LDAP_STARTTLS: ${LDAP_STARTTLS:-false}
      LDAP_BASE_DN: ${LDAP_BASE_DN:-}
      LDAP_USER_DN_TEMPLATE: ${LDAP_USER_DN_TEMPLATE:-%s}
      LDAP_BIND_DN: ${LDAP_BIND_DN:-}
      LDAP_BIND_PASSWORD: ${LDAP_BIND_PASSWORD:-}
      LDAP_REQUIRED_GROUP: ${LDAP_REQUIRED_GROUP:-COMUNICAPA_USERS}
      LDAP_ADMIN_GROUP: ${LDAP_ADMIN_GROUP:-COMUNICAPA_ADMINS}
      OIDC_ISSUER: ${OIDC_ISSUER:-}
      OIDC_AUDIENCE: ${OIDC_AUDIENCE:-comunicapa}
      OIDC_JWKS_URI: ${OIDC_JWKS_URI:-}
    volumes:
      - attachments_data:${ATTACHMENTS_PATH:-/data/attachments}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - comunicapa-net

  frontend-admin:
    image: ghcr.io/mirkochipdotcom/comunicapa-frontend-admin:${IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "${ADMIN_PORT:-3000}:8080"
    environment:
      API_BASE: ${PUBLIC_BACKEND_URL:-http://localhost:8080}
    networks:
      - comunicapa-net

  frontend-citizen:
    image: ghcr.io/mirkochipdotcom/comunicapa-frontend-citizen:${IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "${CITIZEN_PORT:-3001}:8080"
    environment:
      API_BASE: ${PUBLIC_BACKEND_URL:-http://localhost:8080}
    networks:
      - comunicapa-net

volumes:
  postgres_data:
  redis_data:
  attachments_data:

networks:
  comunicapa-net:
    driver: bridge
```

Note: niente `container_name` (podman rootless multi-stack), niente porte pubblicate per postgres/redis, `:?` blocca l'avvio prod senza secret.

- [ ] **Step 2: Crea `docker-compose.override.yml` (sviluppo)**

```yaml
# SVILUPPO: attivato da COMPOSE_FILE=docker-compose.yml;docker-compose.override.yml
# in .env. Bind mount per hot-reload, build da Dockerfile.dev, porte DB esposte.

services:

  postgres:
    ports:
      - "5432:5432"

  redis:
    ports:
      - "6379:6379"

  backend:
    image: comunicapa/backend:dev
    build:
      context: .
      dockerfile: apps/backend/Dockerfile.dev
    environment:
      NODE_ENV: development
    volumes:
      - ./apps/backend/src:/app/apps/backend/src:delegated
      - ./packages/shared-types/src:/app/packages/shared-types/src:delegated
      - backend_node_modules:/app/node_modules

  frontend-admin:
    image: comunicapa/frontend-admin:dev
    build:
      context: .
      dockerfile: apps/frontend-admin/Dockerfile.dev
    ports: !override
      - "${ADMIN_PORT:-3000}:3000"
    environment:
      NODE_ENV: development
    volumes:
      - ./apps/frontend-admin/src:/app/apps/frontend-admin/src:delegated
      - ./apps/frontend-admin/public:/app/apps/frontend-admin/public:delegated
      - ./packages/shared-types/src:/app/packages/shared-types/src:delegated
      - admin_node_modules:/app/node_modules

  frontend-citizen:
    image: comunicapa/frontend-citizen:dev
    build:
      context: .
      dockerfile: apps/frontend-citizen/Dockerfile.dev
    ports: !override
      - "${CITIZEN_PORT:-3001}:3001"
    environment:
      NODE_ENV: development
    volumes:
      - ./apps/frontend-citizen/src:/app/apps/frontend-citizen/src:delegated
      - ./apps/frontend-citizen/public:/app/apps/frontend-citizen/public:delegated
      - ./packages/shared-types/src:/app/packages/shared-types/src:delegated
      - citizen_node_modules:/app/node_modules

volumes:
  backend_node_modules:
  admin_node_modules:
  citizen_node_modules:
```

Note: `ports: !override` (compose ≥ 2.24.4) sostituisce invece di accodare — i frontend dev ascoltano 3000/3001, non 8080. Il backend dev ascolta 8080 come in prod: mappa base ok. Il volume `attachments_data` della base resta montato anche in dev (sostituisce il vecchio `pdf_storage`).

- [ ] **Step 3: Verifica merge**

```bash
docker compose config --quiet && echo DEV-OK
docker compose -f docker-compose.yml config --quiet 2>&1 | head -5
```
Expected: `DEV-OK`; il secondo comando fallisce SOLO per `JWT_SECRET obbligatorio` se le var non sono passate — è il comportamento voluto in prod. Con `.env` presente deve passare anche quello.

- [ ] **Step 4: Riavvio stack dev completo**

```bash
docker compose up -d --build
docker compose ps
curl -s http://localhost:8080/version
```
Expected: 5 servizi up, `{"version":"dev"}`.

- [ ] **Step 5: Aggiorna `CLAUDE.md`**

Nella sezione "Dev Environment" documenta: `COMPOSE_FILE` in `.env` per lo sviluppo; `docker-compose.yml` = produzione (immagini ghcr, volumi named); `docker-compose.override.yml` = sviluppo; deploy Portainer usa solo il file base.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.override.yml CLAUDE.md
git commit -m "feat(compose): base = produzione (podman rootless, volumi named), override = sviluppo"
```

---

### Task 10: Frontend admin — API base runtime + badge versione

**Files:**
- Create: `apps/frontend-admin/public/config.js`
- Modify: `apps/frontend-admin/index.html` (script config.js)
- Modify: `apps/frontend-admin/src/App.tsx:3` (API_BASE) + badge nel menù
- Create: `apps/frontend-citizen/public/config.js`
- Modify: `apps/frontend-citizen/index.html`
- Modify: `apps/frontend-citizen/src/App.tsx` (API_BASE con lo stesso pattern, se presente hardcoded)

**Interfaces:**
- Consumes: `GET /version` (Task 6)
- Produces: `window.__COMUNICAPA_CONFIG__ = { apiBase }` letto da entrambi i frontend; badge versione nel sidebar admin. Il file `config.js` in prod è sovrascritto dall'entrypoint nginx (Task 12).

- [ ] **Step 1: Config runtime dev**

```javascript
// apps/frontend-admin/public/config.js  (identico in frontend-citizen/public/)
// In produzione questo file è rigenerato dall'entrypoint del container nginx
// a partire dalla variabile d'ambiente API_BASE.
window.__COMUNICAPA_CONFIG__ = { apiBase: 'http://localhost:8080' };
```

In entrambi gli `index.html`, PRIMA dello script del modulo Vite:

```html
<script src="/config.js"></script>
```

- [ ] **Step 2: App.tsx admin — API_BASE runtime**

Sostituisci la riga 3 `const API_BASE = 'http://localhost:8080';` con:

```typescript
declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';
```

Stessa sostituzione in `apps/frontend-citizen/src/App.tsx` se contiene un API base hardcoded (verifica con grep prima).

- [ ] **Step 3: Badge versione nel sidebar admin**

In `App.tsx` aggiungi lo stato e il fetch accanto agli altri `useState` del componente principale:

```typescript
const [appVersion, setAppVersion] = useState<string>('');

useEffect(() => {
  fetch(`${API_BASE}/version`)
    .then((r) => r.json())
    .then((d: { version?: string }) => setAppVersion(d.version ?? 'dev'))
    .catch(() => setAppVersion('dev'));
}, []);
```

Individua il sidebar (la nav che contiene la voce `Impostazioni`, intorno alla riga 1356) e in fondo alla nav aggiungi il badge:

```tsx
{appVersion && (
  <div className="mt-auto px-3 py-2 text-center">
    <span className="badge bg-secondary" title="Versione applicazione">
      <i className="fas fa-tag me-1"></i>{appVersion}
    </span>
  </div>
)}
```

Adatta le classi al markup circostante del sidebar (Bootstrap è già in uso: `fas`, `me-2`, `badge` coerenti).

- [ ] **Step 4: Verifica manuale**

```bash
docker compose up -d --build frontend-admin frontend-citizen
```
Apri `http://localhost:3000`: nel sidebar compare il badge `dev`. Console browser senza errori su `config.js`.

- [ ] **Step 5: Type-check**

```bash
docker compose exec frontend-admin sh -c "cd /app/apps/frontend-admin && node_modules/.bin/tsc -b --force"
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/public/config.js apps/frontend-admin/index.html apps/frontend-admin/src/App.tsx apps/frontend-citizen/public/config.js apps/frontend-citizen/index.html apps/frontend-citizen/src/App.tsx
git commit -m "feat(frontend): API base da config runtime + badge versione nel menu admin"
```

---

### Task 11: Frontend admin — pagina impostazioni collegata al backend

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (handleSaveSettings ~riga 556, caricamento iniziale, sezione branding/retention nella view `impostazioni` ~righe 2364-2939)
- Modify: `apps/frontend-citizen/src/App.tsx` (fetch `/branding` per nome ente e favicon)

**Interfaces:**
- Consumes: `GET/PUT /settings` (Task 3), `POST /settings/branding/logo|favicon` e `GET /branding` (Task 5)
- Produces: UI che persiste in DB. Mappa stato ↔ chiave:

| Stato React | Chiave setting |
|---|---|
| `settEntityName` | `brand.name` |
| `settSubtitle` | `brand.subtitle` |
| `settSmtpHost/Port/User/Pass/From` | `smtp.host/port/user/password/from` |
| `settSmtpSecure` (nuovo) | `smtp.secure` |
| `settPecHost/Port/User/Pass/From` | `pec.host/port/user/password/from` |
| `settPecSecure` (nuovo) | `pec.secure` |
| `settIoApiKey` (nuovo) | `appIo.apiKey` |
| `settIoUrl` | `appIo.baseUrl` |
| `settSendApiKey` | `send.apiKey` |
| `settSendUrl` | `send.baseUrl` |
| `settRetentionDays` (nuovo) | `retention.maxDays` |

`ioServices`, `settProto*`, `settPostal*` NON hanno chiave backend: restano su localStorage (canali futuri).

- [ ] **Step 1: Caricamento iniziale da backend**

Aggiungi un `useEffect` che al login (dipendenza `token`) fa `GET /settings` e popola gli stati:

```typescript
useEffect(() => {
  if (!token) return;
  fetch(`${API_BASE}/settings`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { settings: Record<string, string | number | boolean> }) => {
      const s = d.settings;
      setSettEntityName(String(s['brand.name'] ?? ''));
      setSettSubtitle(String(s['brand.subtitle'] ?? ''));
      setSettSmtpHost(String(s['smtp.host'] ?? ''));
      setSettSmtpPort(String(s['smtp.port'] ?? '587'));
      setSettSmtpSecure(Boolean(s['smtp.secure']));
      setSettSmtpUser(String(s['smtp.user'] ?? ''));
      setSettSmtpPass(String(s['smtp.password'] ?? ''));
      setSettSmtpFrom(String(s['smtp.from'] ?? ''));
      setSettPecHost(String(s['pec.host'] ?? ''));
      setSettPecPort(String(s['pec.port'] ?? '587'));
      setSettPecSecure(Boolean(s['pec.secure']));
      setSettPecUser(String(s['pec.user'] ?? ''));
      setSettPecPass(String(s['pec.password'] ?? ''));
      setSettPecFrom(String(s['pec.from'] ?? ''));
      setSettIoApiKey(String(s['appIo.apiKey'] ?? ''));
      setSettIoUrl(String(s['appIo.baseUrl'] ?? ''));
      setSettSendApiKey(String(s['send.apiKey'] ?? ''));
      setSettSendUrl(String(s['send.baseUrl'] ?? ''));
      setSettRetentionDays(String(s['retention.maxDays'] ?? '90'));
    })
    .catch(() => { /* backend non raggiungibile: la pagina resta editabile */ });
}, [token]);
```

Dichiara i nuovi stati (`settSmtpSecure`, `settPecSecure` boolean; `settIoApiKey`, `settRetentionDays` string) accanto agli esistenti e rimuovi le inizializzazioni da localStorage per gli stati migrati (cerca `localStorage.getItem('sett_` e lascia solo proto/postal/ioServices).

- [ ] **Step 2: Riscrivi `handleSaveSettings` (righe 556-584)**

```typescript
const handleSaveSettings = async (e: React.FormEvent) => {
  e.preventDefault();
  // Canali non ancora migrati al backend: restano su localStorage
  localStorage.setItem('sett_io_services', JSON.stringify(ioServices));
  localStorage.setItem('sett_proto_provider', settProtoProvider);
  localStorage.setItem('sett_proto_url', settProtoUrl);
  localStorage.setItem('sett_proto_user', settProtoUser);
  localStorage.setItem('sett_proto_pass', settProtoPass);
  localStorage.setItem('sett_postal_provider', settPostalProvider);
  localStorage.setItem('sett_postal_key', settPostalKey);
  localStorage.setItem('sett_postal_url', settPostalUrl);

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        settings: {
          'brand.name': settEntityName,
          'brand.subtitle': settSubtitle,
          'smtp.host': settSmtpHost,
          'smtp.port': Number(settSmtpPort) || 587,
          'smtp.secure': settSmtpSecure,
          'smtp.user': settSmtpUser,
          'smtp.password': settSmtpPass,
          'smtp.from': settSmtpFrom,
          'pec.host': settPecHost,
          'pec.port': Number(settPecPort) || 587,
          'pec.secure': settPecSecure,
          'pec.user': settPecUser,
          'pec.password': settPecPass,
          'pec.from': settPecFrom,
          'appIo.apiKey': settIoApiKey,
          'appIo.baseUrl': settIoUrl,
          'send.apiKey': settSendApiKey,
          'send.baseUrl': settSendUrl,
          'retention.maxDays': Number(settRetentionDays) || 90,
        },
      }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { message?: string };
      setSettingsSavedMessage(`Errore salvataggio: ${err.message ?? res.status}`);
    } else {
      setSettingsSavedMessage('Impostazioni salvate con successo!');
    }
  } catch {
    setSettingsSavedMessage('Errore di rete durante il salvataggio.');
  }
  setTimeout(() => setSettingsSavedMessage(null), 3000);
};
```

- [ ] **Step 3: Campi UI nuovi nella view `impostazioni`**

Nella sezione Branding (dove vive `settEntityName`): aggiungi upload logo e favicon:

```tsx
const handleUploadBranding = async (kind: 'logo' | 'favicon', file: File) => {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/settings/branding/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  setSettingsSavedMessage(res.ok ? `${kind === 'logo' ? 'Logo' : 'Favicon'} caricato.` : 'Errore upload.');
  setTimeout(() => setSettingsSavedMessage(null), 3000);
};
```

```tsx
<div className="mb-3">
  <label className="form-label">Logo ente (PNG/JPG/SVG, max 2 MB)</label>
  <input type="file" className="form-control" accept="image/png,image/jpeg,image/svg+xml"
    onChange={(e) => e.target.files?.[0] && handleUploadBranding('logo', e.target.files[0])} />
</div>
<div className="mb-3">
  <label className="form-label">Favicon (ICO/PNG/SVG, max 2 MB)</label>
  <input type="file" className="form-control" accept="image/x-icon,image/png,image/svg+xml"
    onChange={(e) => e.target.files?.[0] && handleUploadBranding('favicon', e.target.files[0])} />
</div>
```

Aggiungi campo retention (nuova card o dentro Branding):

```tsx
<div className="mb-3">
  <label className="form-label">Conservazione allegati (giorni)</label>
  <input type="number" min={1} className="form-control" value={settRetentionDays}
    onChange={(e) => setSettRetentionDays(e.target.value)} />
</div>
```

Checkbox TLS nelle card SMTP e PEC:

```tsx
<div className="form-check mb-3">
  <input className="form-check-input" type="checkbox" id="smtpSecure" checked={settSmtpSecure}
    onChange={(e) => setSettSmtpSecure(e.target.checked)} />
  <label className="form-check-label" htmlFor="smtpSecure">Connessione sicura (TLS implicito, porta 465)</label>
</div>
```

Campo API key nella card App IO (`settIoApiKey`, input `type="password"`).

- [ ] **Step 4: Frontend citizen — branding dinamico**

In `apps/frontend-citizen/src/App.tsx` aggiungi al mount:

```typescript
useEffect(() => {
  fetch(`${API_BASE}/branding`)
    .then((r) => r.json())
    .then((b: { name?: string; faviconUrl?: string | null }) => {
      if (b.name) document.title = `${b.name} — ComunicaPA`;
      if (b.faviconUrl) {
        const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']") ?? document.createElement('link');
        link.rel = 'icon';
        link.href = `${API_BASE}${b.faviconUrl}`;
        document.head.appendChild(link);
      }
    })
    .catch(() => { /* branding default */ });
}, []);
```

Se il componente mostra un nome ente hardcoded, sostituiscilo con uno stato popolato da questo fetch. Stessa logica favicon nel frontend admin (aggiungila nello stesso useEffect del badge versione).

- [ ] **Step 5: Verifica manuale end-to-end**

1. `http://localhost:3000` → login admin → Impostazioni.
2. Cambia "Nome ente" e host SMTP → Salva → ricarica pagina → i valori persistono (arrivano dal DB, non da localStorage).
3. `docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "SELECT key, encrypted FROM app_settings ORDER BY key;"` → righe presenti, `smtp.password` con `encrypted = t`.
4. Carica un PNG come logo → `curl -s http://localhost:8080/branding` → `logoUrl: "/branding/logo"`.
5. Password SMTP mostrata come `••••••••` dopo reload; salva senza toccarla → resta quella vera (test invio da bottone test).

- [ ] **Step 6: Type-check entrambi i frontend**

```bash
docker compose exec frontend-admin sh -c "cd /app/apps/frontend-admin && node_modules/.bin/tsc -b --force"
docker compose exec frontend-citizen sh -c "cd /app/apps/frontend-citizen && node_modules/.bin/tsc -b --force"
```
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx apps/frontend-citizen/src/App.tsx
git commit -m "feat(admin-ui): impostazioni persistite su backend + upload logo/favicon + retention"
```

---

### Task 12: Dockerfile di produzione + nginx + .dockerignore

**Files:**
- Create: `.dockerignore`
- Create: `apps/backend/Dockerfile`
- Create: `apps/frontend-admin/Dockerfile`
- Create: `apps/frontend-admin/nginx/default.conf`
- Create: `apps/frontend-admin/nginx/20-runtime-config.sh`
- Create: `apps/frontend-citizen/Dockerfile` + `nginx/default.conf` + `nginx/20-runtime-config.sh` (identici, cambia solo il nome app nei COPY)
- Modify: committa `pnpm-lock.yaml` (oggi untracked — indispensabile per `--frozen-lockfile` e per il caching CI)

**Interfaces:**
- Consumes: `config.js` runtime (Task 10), compose prod (Task 9)
- Produces: immagini `comunicapa-backend`, `comunicapa-frontend-admin`, `comunicapa-frontend-citizen` non-root con `ARG APP_VERSION=dev`; entrypoint nginx che genera `/usr/share/nginx/html/config.js` da `$API_BASE`.

- [ ] **Step 1: `.dockerignore`**

```
node_modules
**/node_modules
**/dist
.git
.env
*.tsbuildinfo
docs
.serena
.claude
```

- [ ] **Step 2: `apps/backend/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/backend/package.json apps/backend/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/backend apps/backend

WORKDIR /app/apps/backend
RUN node_modules/.bin/nest build

# Albero deploy con sole dipendenze di produzione
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter backend deploy --prod --ignore-scripts --legacy /prod/backend

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/backend /app
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

Nota: se la versione pnpm installata rifiuta `--legacy`, rimuovi il flag e aggiungi `inject-workspace-packages=true` in `.npmrc`. Verifica col build dello Step 5. Il runtime non richiede `@comunicapa/shared-types` (tutti gli import backend sono `import type`, erased alla compilazione).

- [ ] **Step 3: `apps/frontend-admin/Dockerfile` + nginx**

```dockerfile
# syntax=docker/dockerfile:1
# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/frontend-admin/package.json apps/frontend-admin/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/frontend-admin apps/frontend-admin

WORKDIR /app/apps/frontend-admin
RUN node_modules/.bin/tsc -b && node_modules/.bin/vite build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=build --chown=nginx:nginx /app/apps/frontend-admin/dist /usr/share/nginx/html
COPY apps/frontend-admin/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/frontend-admin/nginx/20-runtime-config.sh /docker-entrypoint.d/
EXPOSE 8080
```

```nginx
# apps/frontend-admin/nginx/default.conf
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # config.js è generato a runtime: mai in cache
    location = /config.js {
        add_header Cache-Control "no-store";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```sh
#!/bin/sh
# apps/frontend-admin/nginx/20-runtime-config.sh
# Genera la config runtime del frontend dalla variabile API_BASE.
set -eu
: "${API_BASE:=http://localhost:8080}"
cat > /usr/share/nginx/html/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}' };
EOF
```

Il `--chown=nginx:nginx` sulla dist è necessario: l'entrypoint gira come utente `nginx` (uid 101) e deve poter scrivere `config.js`.

- [ ] **Step 4: Replica per frontend-citizen**

Copia `Dockerfile`, `nginx/default.conf`, `nginx/20-runtime-config.sh` in `apps/frontend-citizen/` sostituendo ogni occorrenza `frontend-admin` → `frontend-citizen` nel Dockerfile. I file nginx sono identici.

- [ ] **Step 5: Build locale di verifica (le 3 immagini)**

```bash
docker build -f apps/backend/Dockerfile -t comunicapa-backend:test .
docker build -f apps/frontend-admin/Dockerfile -t comunicapa-frontend-admin:test .
docker build -f apps/frontend-citizen/Dockerfile -t comunicapa-frontend-citizen:test .
```
Expected: 3 build ok. Se il backend fallisce su `pnpm deploy --legacy`, applica la nota dello Step 2.

- [ ] **Step 6: Smoke test runtime**

```bash
docker run --rm -d --name t-admin -p 18080:8080 -e API_BASE=https://api.example.it comunicapa-frontend-admin:test
curl -s http://localhost:18080/config.js
docker rm -f t-admin
```
Expected: `window.__COMUNICAPA_CONFIG__ = { apiBase: 'https://api.example.it' };`

```bash
docker run --rm comunicapa-backend:test node -e "console.log(process.env.APP_VERSION)"
```
Expected: `dev`.

- [ ] **Step 7: Commit (incluso il lockfile)**

```bash
git add .dockerignore pnpm-lock.yaml apps/backend/Dockerfile apps/frontend-admin/Dockerfile apps/frontend-admin/nginx/ apps/frontend-citizen/Dockerfile apps/frontend-citizen/nginx/
git commit -m "feat(docker): Dockerfile prod multi-stage non-root, nginx-unprivileged, config runtime API_BASE"
```

---

### Task 13: Workflow CI/CD con tagging automatico e caching

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Dockerfile prod (Task 12)
- Produces: immagini su `ghcr.io/mirkochipdotcom/comunicapa-{backend,frontend-admin,frontend-citizen}` — tag `vX.Y.Z` + `latest` su push di tag `v*`; tag `dev` su push `main`. `APP_VERSION` = tag git o `dev`.

- [ ] **Step 1: Scrivi il workflow**

```yaml
# .github/workflows/release.yml
name: Build & Push immagini

on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read
  packages: write

jobs:
  build-push:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app: [backend, frontend-admin, frontend-citizen]
    steps:
      - uses: actions/checkout@v5

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/comunicapa-${{ matrix.app }}
          tags: |
            type=ref,event=tag
            type=raw,value=latest,enable=${{ github.ref_type == 'tag' }}
            type=raw,value=dev,enable=${{ github.ref == 'refs/heads/main' }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/${{ matrix.app }}/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            APP_VERSION=${{ github.ref_type == 'tag' && github.ref_name || 'dev' }}
          cache-from: type=registry,ref=ghcr.io/${{ github.repository_owner }}/comunicapa-${{ matrix.app }}:buildcache
          cache-to: type=registry,ref=ghcr.io/${{ github.repository_owner }}/comunicapa-${{ matrix.app }}:buildcache,mode=max
```

Note caching: layer cache via registry (`:buildcache`, `mode=max`, condiviso tra run e più capiente del cache GHA); il primo run è freddo, i successivi riusano install/build layer. I cache mount `RUN --mount=type=cache` accelerano i rebuild locali; in CI il grosso lo fa il registry cache.

- [ ] **Step 2: Valida la sintassi del workflow**

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:latest -color
```
Expected: nessun errore. (In alternativa: push su un branch e controllo del run.)

- [ ] **Step 3: Commit e push**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build e push immagini su ghcr con tagging automatico (v* + latest, dev su main)"
git push
```

- [ ] **Step 4: Verifica run su main**

```bash
gh run watch --exit-status || gh run view --log-failed
```
Expected: 3 job verdi; su ghcr compaiono le immagini `:dev`. Al primo tag `v0.5.0` (`git tag v0.5.0 && git push --tags`) compaiono `:v0.5.0` e `:latest`, e il badge nel menù admin mostra `v0.5.0` quando si usa quell'immagine.

---

## Verifica finale (dopo tutti i task)

- [ ] Suite backend completa: `docker compose exec backend node_modules/.bin/jest` → PASS
- [ ] Type-check frontend: `tsc -b --force` in entrambe le app → exit 0
- [ ] Stack dev: `docker compose up -d --build` → 5 servizi up, badge `dev`, impostazioni persistite in DB, upload logo funzionante
- [ ] Prod dry-run: `docker compose -f docker-compose.yml config --quiet` con `.env` valorizzato → ok
- [ ] `git tag v0.5.0 && git push --tags` → immagini taggate, badge `v0.5.0`
- [ ] Invocare superpowers:finishing-a-development-branch
