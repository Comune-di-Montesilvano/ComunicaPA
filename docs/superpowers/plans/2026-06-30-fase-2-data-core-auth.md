# ComunicaPA — Fase 2: Data Core & Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere TypeORM + schema PostgreSQL con entità JSONB, autenticazione LDAP/Active Directory per operatori PA (ruoli Admin/User), JWT interno per sessioni, e guard OIDC per cittadini (SPID/CIE via pa-sso-proxy).

**Architecture:** `ConfigModule` legge le env vars; `DatabaseModule` inizializza TypeORM con le tre entità core (Campaign, Recipient, NotificationAttempt); `AuthModule` espone `POST /auth/login` che verifica credenziali AD via ldapjs, estrae membership di gruppo AD, e ritorna un JWT interno. Un secondo strategy (OidcCitizenStrategy) valida i JWT emessi da pa-sso-proxy usando JWKS. Tutti i controller sono protetti via `JwtAuthGuard` globale con `@Public()` per esclusion selettiva.

**Tech Stack:** `@nestjs/config` ^3, `@nestjs/typeorm` ^10 + `typeorm` ^0.3 + `pg` ^8, `@nestjs/passport` ^10 + `passport` ^0.7 + `@nestjs/jwt` ^10 + `passport-jwt` ^4 + `jwks-rsa` ^3, `ldapjs` ^3 + `@types/ldapjs`, `class-validator` ^0.14 + `class-transformer` ^0.5.

## Global Constraints

- Nessun tool installato in locale — tutto gira dentro Docker.
- Node.js image: `node:22-alpine`; pnpm v11 via corepack.
- Rebuild immagine dopo ogni modifica a `package.json`: `docker compose up -d --build backend`
- TypeScript strict mode — tutti i flag strict attivi (`tsconfig.base.json` radice).
- `experimentalDecorators: true` e `emitDecoratorMetadata: true` già attivi in `apps/backend/tsconfig.json`.
- Run tests dentro Docker: `docker compose exec backend node_modules/.bin/jest --runInBand --testPathPattern=<pattern>`
- CMD del backend usa `node_modules/.bin/nest start --watch` (NON `pnpm run dev` — pnpm v11 blocca).
- LDAP dominio: `intranet.comune.montesilvano.pe.it`, porta 389, plain (no StartTLS), TLS skip verify.
- Non committare mai credenziali reali (password LDAP, JWT secret, SMTP password).
- TypeORM `synchronize: true` SOLO in `NODE_ENV=development`.

## Dominio di riferimento (da `C:\Users\mirko.daddiego\Documents\filesharing\.env`)

Configurazione estratta — solo struttura di dominio, nessuna credenziale:
- `LDAP_HOST=ldap://intranet.comune.montesilvano.pe.it:389`
- `LDAP_BASE_DN=DC=intranet,DC=comune,DC=montesilvano,DC=pe,DC=it`
- `LDAP_USER_DN_TEMPLATE=%s@intranet.comune.montesilvano.pe.it`
- `LDAP_TLS_SKIP_VERIFY=true`
- `LDAP_STARTTLS=false`
- Gruppi AD adattati per ComunicaPA: `COMUNICAPA_USERS` (accesso base), `COMUNICAPA_ADMINS` (configurazione)

---

## File Structure

```
apps/backend/src/
├── config/
│   └── configuration.ts              # env config factory, valida tutte le variabili
├── database/
│   └── database.module.ts            # TypeORM forRoot dinamico da ConfigService
├── entities/
│   ├── campaign.entity.ts            # Campaign — entità principale invio massivo
│   ├── recipient.entity.ts           # Recipient — destinatari caricati da CSV
│   └── notification-attempt.entity.ts # Log tentativi di invio (JSONB response)
├── auth/
│   ├── dto/
│   │   ├── login.dto.ts              # {username: string, password: string}
│   │   └── auth-response.dto.ts     # {access_token, role, username, expires_in}
│   ├── ldap/
│   │   └── ldap.service.ts          # ldapjs bind + memberOf group lookup
│   ├── strategies/
│   │   ├── jwt.strategy.ts          # passport-jwt per operatori (JWT interno)
│   │   └── oidc-citizen.strategy.ts # passport-jwt per cittadini (JWKS da pa-sso-proxy)
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        # guard globale operatori, rispetta @Public()
│   │   ├── roles.guard.ts           # check @Roles() su payload.role
│   │   └── oidc-auth.guard.ts       # guard per endpoint cittadini
│   ├── decorators/
│   │   ├── roles.decorator.ts       # @Roles('admin') | @Roles('user')
│   │   └── public.decorator.ts      # @Public() — esclude da JwtAuthGuard
│   ├── auth.service.ts              # loginWithLdap → ldap verify → sign JWT
│   ├── auth.controller.ts           # POST /auth/login, GET /auth/me
│   └── auth.module.ts
├── app.module.ts                    # aggiorna: ConfigModule, DatabaseModule, AuthModule
└── main.ts                          # aggiorna: ValidationPipe, enableCors

packages/shared-types/src/
└── index.ts                         # aggiunge: OperatorRole, JwtOperatorPayload, CitizenTokenClaims

.env.example                         # aggiunge: LDAP_*, JWT_*, OIDC_* vars
docker-compose.yml                   # aggiunge: JWT_SECRET, LDAP_* nel service backend
```

---

## Task 1: Shared Types + package.json + ConfigModule + TypeORM Entities

**Files:**
- Modify: `packages/shared-types/src/index.ts` — aggiunge tipi auth
- Modify: `apps/backend/package.json` — aggiunge tutte le dipendenze Fase 2
- Create: `apps/backend/src/config/configuration.ts`
- Create: `apps/backend/src/database/database.module.ts`
- Create: `apps/backend/src/entities/campaign.entity.ts`
- Create: `apps/backend/src/entities/recipient.entity.ts`
- Create: `apps/backend/src/entities/notification-attempt.entity.ts`
- Modify: `apps/backend/src/app.module.ts` — aggiunge ConfigModule + DatabaseModule

**Interfaces:**
- Produces: `OperatorRole = 'admin' | 'user'`, `JwtOperatorPayload`, `CitizenTokenClaims` da `@comunicapa/shared-types`
- Produces: `configuration()` factory da `apps/backend/src/config/configuration.ts`
- Produces: `DatabaseModule` importabile in `AppModule`
- Produces: `Campaign`, `Recipient`, `NotificationAttempt` TypeORM entities

- [ ] **Step 1: Aggiorna packages/shared-types/src/index.ts**

```typescript
export type NotificationChannel = 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';

export interface INotification {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  createdAt: Date;
  sentAt: Date | null;
}

export interface IChannel {
  type: NotificationChannel;
  enabled: boolean;
  config: Record<string, string>;
}

export type OperatorRole = 'admin' | 'user';

export interface JwtOperatorPayload {
  sub: string;
  username: string;
  role: OperatorRole;
  type: 'operator';
  iat?: number;
  exp?: number;
}

export interface CitizenTokenClaims {
  sub: string;
  codiceFiscale: string;
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
}
```

- [ ] **Step 2: Aggiorna apps/backend/package.json**

```json
{
  "name": "backend",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "dev": "nest start --watch",
    "start:prod": "node dist/main",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "jest"
  },
  "dependencies": {
    "@comunicapa/shared-types": "workspace:*",
    "@nestjs/common": "^10.0.0",
    "@nestjs/config": "^3.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/jwt": "^10.0.0",
    "@nestjs/passport": "^10.0.0",
    "@nestjs/platform-express": "^10.0.0",
    "@nestjs/typeorm": "^10.0.0",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.0",
    "jwks-rsa": "^3.0.0",
    "ldapjs": "^3.0.7",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.0",
    "pg": "^8.0.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.1",
    "typeorm": "^0.3.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.0.0",
    "@nestjs/schematics": "^10.0.0",
    "@nestjs/testing": "^10.0.0",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.0",
    "@types/ldapjs": "^3.0.0",
    "@types/node": "^22.0.0",
    "@types/passport-jwt": "^4.0.0",
    "@types/supertest": "^6.0.0",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.7.0"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": { "^.+\\.(t|j)s$": "ts-jest" },
    "collectCoverageFrom": ["**/*.(t|j)s"],
    "coverageDirectory": "../coverage",
    "testEnvironment": "node"
  }
}
```

- [ ] **Step 3: Rebuild immagine Docker backend**

```powershell
docker compose up -d --build backend
```

Attendi che il container si avvii. Verifica:
```powershell
docker compose logs backend --tail 20
```
Expected: NestJS stampa `Backend running on http://0.0.0.0:8080` senza errori di moduli mancanti.

- [ ] **Step 4: Crea apps/backend/src/config/configuration.ts**

```typescript
export interface AppConfiguration {
  port: number;
  nodeEnv: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  ldap: {
    host: string;
    baseDn: string;
    userDnTemplate: string;
    tlsSkipVerify: boolean;
    startTls: boolean;
    bindDn: string;
    bindPassword: string;
    requiredGroup: string;
    adminGroup: string;
  };
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
  };
}

export default (): AppConfiguration => ({
  port: parseInt(process.env['PORT'] ?? '8080', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  database: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  redis: {
    url: process.env['REDIS_URL'] ?? '',
  },
  jwt: {
    secret: process.env['JWT_SECRET'] ?? 'change-me-in-production',
    expiresIn: process.env['JWT_EXPIRES_IN'] ?? '8h',
  },
  ldap: {
    host: process.env['LDAP_HOST'] ?? '',
    baseDn: process.env['LDAP_BASE_DN'] ?? '',
    userDnTemplate: process.env['LDAP_USER_DN_TEMPLATE'] ?? '%s',
    tlsSkipVerify: process.env['LDAP_TLS_SKIP_VERIFY'] === 'true',
    startTls: process.env['LDAP_STARTTLS'] === 'true',
    bindDn: process.env['LDAP_BIND_DN'] ?? '',
    bindPassword: process.env['LDAP_BIND_PASSWORD'] ?? '',
    requiredGroup: process.env['LDAP_REQUIRED_GROUP'] ?? 'COMUNICAPA_USERS',
    adminGroup: process.env['LDAP_ADMIN_GROUP'] ?? 'COMUNICAPA_ADMINS',
  },
  oidc: {
    issuer: process.env['OIDC_ISSUER'] ?? '',
    audience: process.env['OIDC_AUDIENCE'] ?? 'comunicapa',
    jwksUri: process.env['OIDC_JWKS_URI'] ?? '',
  },
});
```

- [ ] **Step 5: Crea apps/backend/src/database/database.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import type { AppConfiguration } from '../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        type: 'postgres',
        url: config.get('database.url', { infer: true }),
        entities: [Campaign, Recipient, NotificationAttempt],
        synchronize: config.get('nodeEnv', { infer: true }) === 'development',
        logging: config.get('nodeEnv', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
```

- [ ] **Step 6: Crea apps/backend/src/entities/campaign.entity.ts**

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import type { Recipient } from './recipient.entity';

export enum CampaignStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('campaigns')
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: CampaignStatus,
    default: CampaignStatus.DRAFT,
  })
  status!: CampaignStatus;

  @Column({ type: 'varchar', name: 'channel_type', length: 20 })
  channelType!: NotificationChannel;

  @Column({ type: 'jsonb', name: 'channel_config', default: {} })
  channelConfig!: Record<string, unknown>;

  @Column({ name: 'created_by', length: 255 })
  createdBy!: string;

  @Column({ name: 'total_recipients', default: 0 })
  totalRecipients!: number;

  @Column({ name: 'sent_count', default: 0 })
  sentCount!: number;

  @Column({ name: 'failed_count', default: 0 })
  failedCount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @OneToMany('Recipient', 'campaign')
  recipients!: Recipient[];
}
```

- [ ] **Step 7: Crea apps/backend/src/entities/recipient.entity.ts**

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Campaign } from './campaign.entity';
import type { NotificationAttempt } from './notification-attempt.entity';

export enum RecipientStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('recipients')
export class Recipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'campaign_id' })
  campaignId!: string;

  @Column({ name: 'codice_fiscale', length: 16 })
  codiceFiscale!: string;

  @Column({ length: 255, nullable: true })
  email!: string | null;

  @Column({ length: 255, nullable: true })
  pec!: string | null;

  @Column({ name: 'full_name', length: 255, nullable: true })
  fullName!: string | null;

  @Column({ type: 'jsonb', name: 'extra_data', default: {} })
  extraData!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: RecipientStatus,
    default: RecipientStatus.PENDING,
  })
  status!: RecipientStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Campaign', 'recipients', { onDelete: 'CASCADE' })
  campaign!: Campaign;

  @OneToMany('NotificationAttempt', 'recipient')
  attempts!: NotificationAttempt[];
}
```

- [ ] **Step 8: Crea apps/backend/src/entities/notification-attempt.entity.ts**

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Recipient } from './recipient.entity';

export enum AttemptStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('notification_attempts')
export class NotificationAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'recipient_id' })
  recipientId!: string;

  @Column({ name: 'channel_type', length: 20 })
  channelType!: string;

  @Column({
    type: 'enum',
    enum: AttemptStatus,
    default: AttemptStatus.QUEUED,
  })
  status!: AttemptStatus;

  @Column({ name: 'attempt_number', default: 1 })
  attemptNumber!: number;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ type: 'jsonb', name: 'response_payload', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Recipient', 'attempts', { onDelete: 'CASCADE' })
  recipient!: Recipient;
}
```

- [ ] **Step 9: Aggiorna apps/backend/src/app.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

- [ ] **Step 10: Verifica TypeORM crea le tabelle**

```powershell
docker compose up -d --build backend
```

Attendi 15 secondi poi verifica:
```powershell
docker compose logs backend --tail 30
```
Expected: log TypeORM `query: CREATE TABLE "campaigns"` e `"recipients"` e `"notification_attempts"`. Nessun errore.

Verifica tabelle in PostgreSQL:
```powershell
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\dt"
```
Expected: lista con `campaigns`, `recipients`, `notification_attempts`.

- [ ] **Step 11: Commit**

```bash
git add packages/shared-types/src/index.ts apps/backend/package.json apps/backend/src/config/ apps/backend/src/database/ apps/backend/src/entities/ apps/backend/src/app.module.ts
git commit -m "feat(fase2): shared types auth, TypeORM entities Campaign/Recipient/NotificationAttempt, ConfigModule"
```

---

## Task 2: LDAP Service + JWT Module + Login Endpoint

**Files:**
- Create: `apps/backend/src/auth/dto/login.dto.ts`
- Create: `apps/backend/src/auth/dto/auth-response.dto.ts`
- Create: `apps/backend/src/auth/ldap/ldap.service.ts`
- Create: `apps/backend/src/auth/ldap/ldap.service.spec.ts`
- Create: `apps/backend/src/auth/strategies/jwt.strategy.ts`
- Create: `apps/backend/src/auth/auth.service.ts`
- Create: `apps/backend/src/auth/auth.service.spec.ts`
- Create: `apps/backend/src/auth/auth.controller.ts`
- Create: `apps/backend/src/auth/auth.module.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Consumes: `AppConfiguration` da `config/configuration.ts`
- Consumes: `JwtOperatorPayload`, `OperatorRole` da `@comunicapa/shared-types`
- Produces: `LdapService.authenticate(username, password)` → `Promise<LdapUser>` (dove `LdapUser = { username: string; displayName: string; role: OperatorRole }`)
- Produces: `AuthService.loginWithLdap(dto)` → `Promise<AuthResponseDto>`
- Produces: `POST /auth/login` → `{ access_token, role, username, expires_in }`
- Produces: `GET /auth/me` → `JwtOperatorPayload`
- Produces: `jwt` strategy registrata in Passport — usata da `JwtAuthGuard` in Task 3

- [ ] **Step 1: Crea apps/backend/src/auth/dto/login.dto.ts**

```typescript
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password!: string;
}
```

- [ ] **Step 2: Crea apps/backend/src/auth/dto/auth-response.dto.ts**

```typescript
import type { OperatorRole } from '@comunicapa/shared-types';

export class AuthResponseDto {
  access_token!: string;
  token_type!: 'Bearer';
  expires_in!: number;
  username!: string;
  role!: OperatorRole;
}
```

- [ ] **Step 3: Scrivi il test LDAP (fallisce prima dell'implementazione)**

Crea `apps/backend/src/auth/ldap/ldap.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LdapService } from './ldap.service';
import * as ldapjs from 'ldapjs';

jest.mock('ldapjs');

const mockClient = {
  bind: jest.fn(),
  search: jest.fn(),
  unbind: jest.fn(),
};

describe('LdapService', () => {
  let service: LdapService;

  beforeEach(async () => {
    (ldapjs.createClient as jest.Mock).mockReturnValue(mockClient);

    const module = await Test.createTestingModule({
      providers: [
        LdapService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const cfg: Record<string, unknown> = {
                'ldap.host': 'ldap://localhost:389',
                'ldap.baseDn': 'DC=test,DC=local',
                'ldap.userDnTemplate': '%s@test.local',
                'ldap.tlsSkipVerify': true,
                'ldap.adminGroup': 'COMUNICAPA_ADMINS',
                'ldap.requiredGroup': 'COMUNICAPA_USERS',
              };
              return cfg[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get<LdapService>(LdapService);
  });

  it('should resolve with role=admin when user is in admin group', async () => {
    mockClient.bind.mockImplementation((_dn: string, _pw: string, cb: (err: null) => void) => cb(null));

    const mockSearchRes = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'searchEntry') {
          cb({
            object: {
              sAMAccountName: 'mario.rossi',
              displayName: 'Mario Rossi',
              memberOf: [
                'CN=COMUNICAPA_ADMINS,OU=Groups,DC=test,DC=local',
                'CN=COMUNICAPA_USERS,OU=Groups,DC=test,DC=local',
              ],
            },
          });
        }
        if (event === 'end') {
          cb({ status: 0 });
        }
        return mockSearchRes;
      }),
    };

    mockClient.search.mockImplementation(
      (_base: string, _opts: unknown, cb: (err: null, res: typeof mockSearchRes) => void) => cb(null, mockSearchRes),
    );
    mockClient.unbind.mockImplementation((cb: () => void) => cb());

    const result = await service.authenticate('mario.rossi', 'password123');

    expect(result.username).toBe('mario.rossi');
    expect(result.role).toBe('admin');
    expect(result.displayName).toBe('Mario Rossi');
  });

  it('should reject when bind fails (wrong password)', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: Error) => void) => cb(new Error('Invalid credentials')),
    );

    await expect(service.authenticate('mario.rossi', 'wrongpass')).rejects.toThrow(
      'Credenziali non valide',
    );
  });
});
```

Esegui — deve fallire con "Cannot find module './ldap.service'":
```powershell
docker compose exec backend node_modules/.bin/jest --runInBand --testPathPattern=ldap.service.spec --no-coverage 2>&1 | tail -20
```

- [ ] **Step 4: Crea apps/backend/src/auth/ldap/ldap.service.ts**

```typescript
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ldapjs from 'ldapjs';
import type { OperatorRole } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';

export interface LdapUser {
  username: string;
  displayName: string;
  role: OperatorRole;
}

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async authenticate(username: string, password: string): Promise<LdapUser> {
    const host = this.config.get('ldap.host', { infer: true });
    const baseDn = this.config.get('ldap.baseDn', { infer: true });
    const dnTemplate = this.config.get('ldap.userDnTemplate', { infer: true });
    const tlsSkipVerify = this.config.get('ldap.tlsSkipVerify', { infer: true });
    const adminGroup = this.config.get('ldap.adminGroup', { infer: true });
    const requiredGroup = this.config.get('ldap.requiredGroup', { infer: true });

    const userDn = dnTemplate.replace('%s', username);

    const client = ldapjs.createClient({
      url: host,
      tlsOptions: { rejectUnauthorized: !tlsSkipVerify },
      timeout: 5000,
      connectTimeout: 5000,
    });

    try {
      await this.bind(client, userDn, password);
      const entry = await this.searchUser(client, baseDn, username);

      if (!entry) {
        throw new UnauthorizedException('Utente non trovato in Active Directory');
      }

      const memberOf = this.extractMemberOf(entry);
      const groupCns = memberOf.map((dn) => this.extractCn(dn));

      this.logger.debug(`User ${username} memberOf: ${groupCns.join(', ')}`);

      if (!groupCns.includes(requiredGroup) && !groupCns.includes(adminGroup)) {
        throw new UnauthorizedException('Accesso non autorizzato: gruppo AD richiesto non trovato');
      }

      const role: OperatorRole = groupCns.includes(adminGroup) ? 'admin' : 'user';

      return {
        username,
        displayName: String(entry['displayName'] ?? username),
        role,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(`LDAP error for user ${username}: ${String(error)}`);
      throw new UnauthorizedException('Credenziali non valide');
    } finally {
      client.unbind(() => {/* fire and forget */});
    }
  }

  private bind(client: ldapjs.Client, dn: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.bind(dn, password, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private searchUser(
    client: ldapjs.Client,
    baseDn: string,
    username: string,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter: `(sAMAccountName=${ldapjs.parseFilter(`(sAMAccountName=${username})`).toString().slice(1, -1)})`,
          attributes: ['sAMAccountName', 'displayName', 'mail', 'memberOf'],
        },
        (err, res) => {
          if (err) return reject(err);

          let found: Record<string, unknown> | null = null;

          res.on('searchEntry', (entry: ldapjs.SearchEntry) => {
            found = entry.object as Record<string, unknown>;
          });
          res.on('error', reject);
          res.on('end', () => resolve(found));
        },
      );
    });
  }

  private extractMemberOf(entry: Record<string, unknown>): string[] {
    const val = entry['memberOf'];
    if (!val) return [];
    if (Array.isArray(val)) return val as string[];
    return [String(val)];
  }

  private extractCn(dn: string): string {
    const match = /^CN=([^,]+)/i.exec(dn);
    return match ? match[1] : dn;
  }
}
```

- [ ] **Step 5: Esegui test LDAP — deve passare**

```powershell
docker compose exec backend node_modules/.bin/jest --runInBand --testPathPattern=ldap.service.spec --no-coverage 2>&1 | tail -30
```

Expected: `Tests: 2 passed, 2 total`

- [ ] **Step 6: Crea apps/backend/src/auth/strategies/jwt.strategy.ts**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<AppConfiguration, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt.secret', { infer: true }),
    });
  }

  validate(payload: JwtOperatorPayload): JwtOperatorPayload {
    return payload;
  }
}
```

- [ ] **Step 7: Scrivi test AuthService (fallisce)**

Crea `apps/backend/src/auth/auth.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LdapService } from './ldap/ldap.service';
import type { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let ldapService: jest.Mocked<LdapService>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: LdapService,
          useValue: {
            authenticate: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('mock.jwt.token'),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    ldapService = module.get(LdapService);
    jwtService = module.get(JwtService);
  });

  it('should return access_token on valid LDAP credentials', async () => {
    ldapService.authenticate.mockResolvedValue({
      username: 'mario.rossi',
      displayName: 'Mario Rossi',
      role: 'admin',
    });

    const dto: LoginDto = { username: 'mario.rossi', password: 'pass' };
    const result = await service.loginWithLdap(dto);

    expect(result.access_token).toBe('mock.jwt.token');
    expect(result.role).toBe('admin');
    expect(result.username).toBe('mario.rossi');
    expect(result.token_type).toBe('Bearer');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: 'mario.rossi',
      username: 'mario.rossi',
      role: 'admin',
      type: 'operator',
    });
  });

  it('should propagate UnauthorizedException from LDAP', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    ldapService.authenticate.mockRejectedValue(new UnauthorizedException('Credenziali non valide'));

    await expect(service.loginWithLdap({ username: 'x', password: 'y' })).rejects.toThrow(
      'Credenziali non valide',
    );
  });
});
```

```powershell
docker compose exec backend node_modules/.bin/jest --runInBand --testPathPattern=auth.service.spec --no-coverage 2>&1 | tail -20
```
Expected: FAIL — `Cannot find module './auth.service'`

- [ ] **Step 8: Crea apps/backend/src/auth/auth.service.ts**

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { LdapService } from './ldap/ldap.service';
import type { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';

@Injectable()
export class AuthService {
  private static readonly EXPIRES_IN_SECONDS = 8 * 60 * 60;

  constructor(
    private readonly ldapService: LdapService,
    private readonly jwtService: JwtService,
  ) {}

  async loginWithLdap(dto: LoginDto): Promise<AuthResponseDto> {
    const ldapUser = await this.ldapService.authenticate(dto.username, dto.password);

    const payload: Omit<JwtOperatorPayload, 'iat' | 'exp'> = {
      sub: ldapUser.username,
      username: ldapUser.username,
      role: ldapUser.role,
      type: 'operator',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: AuthService.EXPIRES_IN_SECONDS,
      username: ldapUser.username,
      role: ldapUser.role,
    };
  }
}
```

- [ ] **Step 9: Esegui test AuthService — deve passare**

```powershell
docker compose exec backend node_modules/.bin/jest --runInBand --testPathPattern=auth.service.spec --no-coverage 2>&1 | tail -20
```
Expected: `Tests: 2 passed, 2 total`

- [ ] **Step 10: Crea apps/backend/src/auth/auth.controller.ts**

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Public } from './decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.loginWithLdap(dto);
  }

  @Get('me')
  me(@Request() req: { user: JwtOperatorPayload }): JwtOperatorPayload {
    return req.user;
  }
}
```

- [ ] **Step 11: Crea apps/backend/src/auth/auth.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { LdapService } from './ldap/ldap.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import type { AppConfiguration } from '../config/configuration';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        secret: config.get('jwt.secret', { infer: true }),
        signOptions: { expiresIn: config.get('jwt.expiresIn', { infer: true }) },
      }),
    }),
  ],
  providers: [AuthService, LdapService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 12: Aggiorna apps/backend/src/app.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

- [ ] **Step 13: Verifica hot-reload + login endpoint**

Il backend hot-reload rileva i cambiamenti. Attendi il riavvio NestJS:
```powershell
docker compose logs backend --tail 20
```
Expected: `[NestApplication] Nest application successfully started`

Test login (con credenziali fittizie — in dev restituisce 401 se LDAP non raggiungibile):
```powershell
Invoke-RestMethod -Uri http://localhost:8080/auth/login -Method POST -ContentType 'application/json' -Body '{"username":"test","password":"test"}' -ErrorAction SilentlyContinue
```
Expected: errore 401 con messaggio (LDAP non raggiungibile in dev locale), oppure 400 Bad Request se body mancante. Il punto è che l'endpoint esiste e risponde.

Test endpoint `/auth/me` senza token:
```powershell
Invoke-RestMethod -Uri http://localhost:8080/auth/me -Method GET -ErrorAction SilentlyContinue
```
Expected: 401 Unauthorized (guard non ancora applicato — sarà in Task 3).

- [ ] **Step 14: Commit**

```bash
git add apps/backend/src/auth/ apps/backend/src/app.module.ts
git commit -m "feat(fase2): LDAP auth service, JWT strategy, login endpoint POST /auth/login"
```

---

## Task 3: Guards + Decorators + Protezione Routes Globale

**Files:**
- Create: `apps/backend/src/auth/decorators/roles.decorator.ts`
- Create: `apps/backend/src/auth/decorators/public.decorator.ts`
- Create: `apps/backend/src/auth/guards/jwt-auth.guard.ts`
- Create: `apps/backend/src/auth/guards/roles.guard.ts`
- Modify: `apps/backend/src/auth/guards/jwt-auth.guard.ts` (guard usa `@Public()`)
- Modify: `apps/backend/src/main.ts` — aggiunge ValidationPipe
- Modify: `apps/backend/src/app.module.ts` — registra guard globali via APP_GUARD

**Interfaces:**
- Consumes: `JwtStrategy` ('jwt') da Task 2
- Consumes: `JwtOperatorPayload` da `@comunicapa/shared-types`
- Produces: `@Public()` decorator — salta `JwtAuthGuard` globale
- Produces: `@Roles('admin')` / `@Roles('user')` — usato con `RolesGuard`
- Produces: `JwtAuthGuard` — guard globale su tutti i controller (esclude `@Public()`)
- Produces: `RolesGuard` — guard opzionale per endpoint admin-only
- Produces: `GET /` risponde normalmente (public); `GET /auth/me` richiede JWT; `POST /auth/login` è public

- [ ] **Step 1: Crea apps/backend/src/auth/decorators/public.decorator.ts**

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 2: Crea apps/backend/src/auth/decorators/roles.decorator.ts**

```typescript
import { SetMetadata } from '@nestjs/common';
import type { OperatorRole } from '@comunicapa/shared-types';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: OperatorRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 3: Crea apps/backend/src/auth/guards/jwt-auth.guard.ts**

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

- [ ] **Step 4: Crea apps/backend/src/auth/guards/roles.guard.ts**

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtOperatorPayload, OperatorRole } from '@comunicapa/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<OperatorRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: JwtOperatorPayload }>();
    const user = request.user;

    if (!user) throw new ForbiddenException('Token operatore richiesto');
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(`Ruolo richiesto: ${requiredRoles.join(' o ')}`);
    }

    return true;
  }
}
```

- [ ] **Step 5: Aggiorna apps/backend/src/app.module.ts — registra guard globali**

```typescript
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Aggiorna apps/backend/src/app.controller.ts — aggiunge @Public()**

```typescript
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHealth(): string {
    return this.appService.getHealth();
  }
}
```

- [ ] **Step 7: Aggiorna apps/backend/src/main.ts — ValidationPipe + CORS**

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
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

- [ ] **Step 8: Verifica protezione routes**

Attendi hot-reload del backend:
```powershell
docker compose logs backend --tail 10
```

Test `GET /` — deve rispondere senza token (public):
```powershell
Invoke-RestMethod -Uri http://localhost:8080 -Method GET
```
Expected: `ComunicaPA Backend OK`

Test `GET /auth/me` senza token — deve restituire 401:
```powershell
Invoke-RestMethod -Uri http://localhost:8080/auth/me -Method GET -ErrorAction SilentlyContinue
```
Expected: `401 Unauthorized`

Test `POST /auth/login` con body mancante — ValidationPipe deve restituire 400:
```powershell
Invoke-RestMethod -Uri http://localhost:8080/auth/login -Method POST -ContentType 'application/json' -Body '{}' -ErrorAction SilentlyContinue
```
Expected: `400 Bad Request` con `message` array di errori class-validator.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/auth/guards/ apps/backend/src/auth/decorators/ apps/backend/src/app.module.ts apps/backend/src/app.controller.ts apps/backend/src/main.ts
git commit -m "feat(fase2): JwtAuthGuard globale, RolesGuard, decoratori @Public() e @Roles(), ValidationPipe"
```

---

## Task 4: OIDC Citizen Guard (pa-sso-proxy)

**Files:**
- Create: `apps/backend/src/auth/strategies/oidc-citizen.strategy.ts`
- Create: `apps/backend/src/auth/guards/oidc-auth.guard.ts`
- Modify: `apps/backend/src/auth/auth.module.ts` — aggiunge OidcCitizenStrategy

**Interfaces:**
- Consumes: `CitizenTokenClaims` da `@comunicapa/shared-types`
- Consumes: `AppConfiguration` — `oidc.issuer`, `oidc.audience`, `oidc.jwksUri`
- Produces: `OidcCitizenStrategy` registrata come `'oidc-citizen'` in Passport
- Produces: `OidcAuthGuard` — usato su endpoint `GET /citizen/*` futuri
- Produces: `req.user` = `CitizenTokenClaims` quando guard passa

- [ ] **Step 1: Crea apps/backend/src/auth/strategies/oidc-citizen.strategy.ts**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';

@Injectable()
export class OidcCitizenStrategy extends PassportStrategy(Strategy, 'oidc-citizen') {
  private readonly logger = new Logger(OidcCitizenStrategy.name);

  constructor(config: ConfigService<AppConfiguration, true>) {
    const jwksUri = config.get('oidc.jwksUri', { infer: true });
    const issuer = config.get('oidc.issuer', { infer: true });
    const audience = config.get('oidc.audience', { infer: true });

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience,
      issuer,
      algorithms: ['RS256'],
      secretOrKeyProvider: jwksUri
        ? passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 10,
            jwksUri,
          })
        : (_req: unknown, _rawJwt: unknown, done: (err: null, secret: string) => void) => {
            done(null, config.get('jwt.secret', { infer: true }));
          },
    });
  }

  validate(payload: Record<string, unknown>): CitizenTokenClaims {
    const codiceFiscale =
      String(payload['fiscal_number'] ?? payload['codice_fiscale'] ?? payload['cf'] ?? '').toUpperCase();

    return {
      sub: String(payload['sub'] ?? ''),
      codiceFiscale,
      email: payload['email'] ? String(payload['email']) : undefined,
      name: payload['name'] ? String(payload['name']) : undefined,
    };
  }
}
```

- [ ] **Step 2: Crea apps/backend/src/auth/guards/oidc-auth.guard.ts**

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OidcAuthGuard extends AuthGuard('oidc-citizen') {}
```

- [ ] **Step 3: Aggiorna apps/backend/src/auth/auth.module.ts — aggiunge OidcCitizenStrategy**

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { LdapService } from './ldap/ldap.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OidcCitizenStrategy } from './strategies/oidc-citizen.strategy';
import type { AppConfiguration } from '../config/configuration';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        secret: config.get('jwt.secret', { infer: true }),
        signOptions: { expiresIn: config.get('jwt.expiresIn', { infer: true }) },
      }),
    }),
  ],
  providers: [AuthService, LdapService, JwtStrategy, OidcCitizenStrategy],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 4: Verifica avvio senza errori**

```powershell
docker compose logs backend --tail 20
```
Expected: NestJS avviato senza errori. Le due strategies registrate (`jwt`, `oidc-citizen`) non compaiono nel log ma non devono dare errori di init.

Se `OIDC_JWKS_URI` è vuoto (dev), la strategy usa fallback al `JWT_SECRET` interno — nessun crash.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth/strategies/oidc-citizen.strategy.ts apps/backend/src/auth/guards/oidc-auth.guard.ts apps/backend/src/auth/auth.module.ts
git commit -m "feat(fase2): OidcCitizenStrategy per validazione JWT pa-sso-proxy, OidcAuthGuard"
```

---

## Task 5: .env.example + docker-compose + istruzioni rebuild

**Files:**
- Modify: `.env.example` — aggiunge sezioni LDAP, JWT, OIDC
- Modify: `docker-compose.yml` — passa variabili al service backend
- Modify: `apps/backend/.env` (solo locale, git-ignored) — aggiunge JWT_SECRET dev

**Interfaces:**
- Produces: template completo per Fase 2 in `.env.example`
- Produces: docker-compose backend service con tutte le env Fase 2

- [ ] **Step 1: Aggiorna .env.example**

```dotenv
# ComunicaPA — Esempio configurazione
# Copia questo file in .env e adatta i valori al tuo ambiente.
# Non committare mai .env con credenziali reali nel repository!

# ── Porte host (mappate dal docker-compose ai container) ──────────────────────
BACKEND_PORT=8080
ADMIN_PORT=3000
CITIZEN_PORT=3001

# ── PostgreSQL ────────────────────────────────────────────────────────────────
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=comunicapa
POSTGRES_PASSWORD=comunicapa_dev_password
POSTGRES_DB=comunicapa_db

# URL completo per TypeORM. In prod sovrascrivere con la stringa di connessione.
DATABASE_URL=postgresql://comunicapa:comunicapa_dev_password@postgres:5432/comunicapa_db

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_URL=redis://redis:6379

# ── Node ──────────────────────────────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=info

# ── JWT ───────────────────────────────────────────────────────────────────────
# Usato per firmare i token degli operatori dopo login LDAP.
# OBBLIGATORIO in produzione. Genera con: openssl rand -hex 32
JWT_SECRET=change-me-in-production-use-openssl-rand-hex-32

# Durata token operatore (formato ms/vercel: 8h, 1d, etc.)
JWT_EXPIRES_IN=8h

# ── LDAP / Active Directory ───────────────────────────────────────────────────
# Autenticazione operatori PA via Active Directory.
# Configurazione di riferimento: Comune di Montesilvano

# ldap:// porta 389 (plain) o ldaps:// porta 636 (TLS nativo)
LDAP_HOST=ldap://intranet.comune.montesilvano.pe.it:389

# true = ignora errori certificato (utile per CA interna / self-signed)
LDAP_TLS_SKIP_VERIFY=true

# Auto-upgrade ldap:// → TLS via StartTLS. false = connessione plain
LDAP_STARTTLS=false

# Base DN corrispondente al FQDN del dominio AD
LDAP_BASE_DN=DC=intranet,DC=comune,DC=montesilvano,DC=pe,DC=it

# Template UPN: l'utente inserisce "mario.rossi" → bind come "mario.rossi@dominio"
LDAP_USER_DN_TEMPLATE=%s@intranet.comune.montesilvano.pe.it

# Account di servizio (read-only) per ricerche di gruppo.
# Lasciare vuoti se gli utenti possono ricercare autonomamente.
LDAP_BIND_DN=
LDAP_BIND_PASSWORD=

# Gruppo AD minimo per accedere a ComunicaPA (solo CN, senza OU/DC)
LDAP_REQUIRED_GROUP=COMUNICAPA_USERS

# Gruppo AD con privilegi di amministrazione (configurazioni, mapping canali)
LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS

# ── OIDC / pa-sso-proxy (cittadini SPID/CIE) ─────────────────────────────────
# Endpoint emittente del JWT restituito da pa-sso-proxy dopo autenticazione SPID/CIE.
# Esempio: https://sso.comune.example.it/realms/pa
OIDC_ISSUER=

# Audience attesa nel JWT cittadino (deve corrispondere al client_id registrato)
OIDC_AUDIENCE=comunicapa

# JWKS URI per validare la firma del JWT con chiave pubblica RS256.
# Esempio: https://sso.comune.example.it/realms/pa/protocol/openid-connect/certs
OIDC_JWKS_URI=

# ── SMTP (invio email/PEC — Fase 4) ──────────────────────────────────────────
# Server SMTP del Comune. Configurazione di riferimento: Comune di Montesilvano
# SMTP_SERVER=mailserver.comune.montesilvano.pe.it
# SMTP_PORT=25
# SMTP_SECURITY=starttls
# SMTP_USER=comunicapa@comune.montesilvano.pe.it
# SMTP_PASSWORD=<password-da-non-committare>
# SMTP_FROM=comunicapa@comune.montesilvano.pe.it

# ── URL pubblici ──────────────────────────────────────────────────────────────
# PUBLIC_BACKEND_URL=http://localhost:8080
# ADMIN_ORIGIN=http://localhost:3000
# CITIZEN_ORIGIN=http://localhost:3001
```

- [ ] **Step 2: Aggiorna docker-compose.yml — sezione environment del service backend**

Aggiorna solo il blocco `environment` del service `backend` dentro `docker-compose.yml`:

```yaml
  backend:
    build:
      context: .
      dockerfile: apps/backend/Dockerfile.dev
    container_name: comunicapa-backend
    restart: unless-stopped
    ports:
      - "${BACKEND_PORT:-8080}:8080"
    environment:
      NODE_ENV: development
      PORT: "8080"
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET:-change-me-in-development}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-8h}
      LDAP_HOST: ${LDAP_HOST:-}
      LDAP_BASE_DN: ${LDAP_BASE_DN:-}
      LDAP_USER_DN_TEMPLATE: ${LDAP_USER_DN_TEMPLATE:-%s}
      LDAP_TLS_SKIP_VERIFY: ${LDAP_TLS_SKIP_VERIFY:-true}
      LDAP_STARTTLS: ${LDAP_STARTTLS:-false}
      LDAP_BIND_DN: ${LDAP_BIND_DN:-}
      LDAP_BIND_PASSWORD: ${LDAP_BIND_PASSWORD:-}
      LDAP_REQUIRED_GROUP: ${LDAP_REQUIRED_GROUP:-COMUNICAPA_USERS}
      LDAP_ADMIN_GROUP: ${LDAP_ADMIN_GROUP:-COMUNICAPA_ADMINS}
      OIDC_ISSUER: ${OIDC_ISSUER:-}
      OIDC_AUDIENCE: ${OIDC_AUDIENCE:-comunicapa}
      OIDC_JWKS_URI: ${OIDC_JWKS_URI:-}
      ADMIN_ORIGIN: http://localhost:${ADMIN_PORT:-3000}
      CITIZEN_ORIGIN: http://localhost:${CITIZEN_PORT:-3001}
    volumes:
      - ./apps/backend/src:/app/apps/backend/src:delegated
      - ./packages/shared-types/src:/app/packages/shared-types/src:delegated
      - backend_node_modules:/app/node_modules
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - comunicapa-net
```

- [ ] **Step 3: Aggiorna .env locale con JWT_SECRET dev**

Nel file `.env` (git-ignored, creato da `.env.example`), aggiunge:

```dotenv
JWT_SECRET=comunicapa-dev-secret-non-usare-in-produzione
LDAP_HOST=ldap://intranet.comune.montesilvano.pe.it:389
LDAP_BASE_DN=DC=intranet,DC=comune,DC=montesilvano,DC=pe,DC=it
LDAP_USER_DN_TEMPLATE=%s@intranet.comune.montesilvano.pe.it
LDAP_TLS_SKIP_VERIFY=true
LDAP_STARTTLS=false
LDAP_REQUIRED_GROUP=COMUNICAPA_USERS
LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS
```

Su Windows PowerShell (aggiunge in append a `.env`):
```powershell
@"
JWT_SECRET=comunicapa-dev-secret-non-usare-in-produzione
LDAP_HOST=ldap://intranet.comune.montesilvano.pe.it:389
LDAP_BASE_DN=DC=intranet,DC=comune,DC=montesilvano,DC=pe,DC=it
LDAP_USER_DN_TEMPLATE=%s@intranet.comune.montesilvano.pe.it
LDAP_TLS_SKIP_VERIFY=true
LDAP_STARTTLS=false
LDAP_REQUIRED_GROUP=COMUNICAPA_USERS
LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS
"@ | Add-Content -Path .env -Encoding UTF8
```

- [ ] **Step 4: Riavvia stack con nuove variabili**

```powershell
docker compose down
docker compose up -d
```

Attendi avvio:
```powershell
docker compose ps
```
Expected: tutti i container `running` o `healthy`.

- [ ] **Step 5: Test E2E completo**

Test health (public):
```powershell
Invoke-RestMethod -Uri http://localhost:8080 -Method GET
```
Expected: `ComunicaPA Backend OK`

Test login senza LDAP raggiungibile — deve restituire 401 con messaggio:
```powershell
try {
  Invoke-RestMethod -Uri http://localhost:8080/auth/login -Method POST `
    -ContentType 'application/json' `
    -Body '{"username":"test","password":"test"}'
} catch { $_.ErrorDetails.Message }
```
Expected: JSON con `statusCode: 401` e `message: "Credenziali non valide"`.

Test `GET /auth/me` con JWT valido generato manualmente:
```powershell
$token = (Invoke-RestMethod -Uri http://localhost:8080/auth/login -Method POST `
  -ContentType 'application/json' `
  -Body '{"username":"real.user","password":"real.pass"}' `
  -ErrorAction SilentlyContinue).access_token

if ($token) {
  Invoke-RestMethod -Uri http://localhost:8080/auth/me -Method GET `
    -Headers @{ Authorization = "Bearer $token" }
}
```
Expected se LDAP raggiungibile: `{sub, username, role, type: 'operator'}`.

- [ ] **Step 6: Commit finale**

```bash
git add .env.example docker-compose.yml
git commit -m "feat(fase2): .env.example completo con LDAP/JWT/OIDC, docker-compose backend env vars Fase 2"
```

---

## Self-Review

**Spec coverage checklist:**

| Requisito Plane.md Fase 2 | Task che lo implementa |
|---|---|
| TypeORM setup | Task 1: DatabaseModule + TypeOrmModule.forRootAsync |
| Schema PostgreSQL + JSONB | Task 1: campaign.channelConfig, notification_attempt.responsePayload, recipient.extraData |
| Tabelle queue (Fase 3 prep) | Task 1: notification_attempts (status queued→processing→success/failed) |
| Guard LDAP per Admin | Task 2: LdapService.authenticate + JWT issuance |
| Ruoli Admin/User | Task 2: LdapService estrae memberOf, determina role |
| Guard OIDC per Cittadino | Task 4: OidcCitizenStrategy + OidcAuthGuard |
| JWT interno per sessione | Task 2: JwtModule + JwtStrategy + JwtAuthGuard globale |
| .env.example aggiornato | Task 5: sezioni LDAP, JWT, OIDC |

**Placeholder scan:** nessun TBD/TODO nel codice — tutti gli snippet sono completi.

**Type consistency:**
- `LdapUser` definito in `ldap.service.ts`, usato in `auth.service.ts` ✓
- `JwtOperatorPayload` da shared-types, usato in jwt.strategy, auth.controller, roles.guard ✓
- `CitizenTokenClaims` da shared-types, ritornato da oidc-citizen.strategy.validate ✓
- `AppConfiguration` da configuration.ts, usato via `ConfigService<AppConfiguration, true>` in tutti i moduli ✓
- `OperatorRole = 'admin' | 'user'` — usato in LdapUser.role, JwtOperatorPayload.role, AuthResponseDto.role ✓
