# ComunicaPA Fase 4 — Strategie di Canale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare il pattern Strategy per i 5 canali di notifica (EMAIL, PEC, APP_IO, SEND, POSTAL), collegare il NotificationProcessor alla registry di strategie, gestire il ciclo di vita della campagna (QUEUED → RUNNING → COMPLETED | FAILED), e correggere i bug backlog di Fase 3.

**Architecture:** `ChannelModule` esporta `CHANNEL_STRATEGIES: Map<NotificationChannel, IChannelStrategy>` tramite un token DI. Il `NotificationProcessor` inietta la map, recupera `Recipient` + `Campaign` dal DB, chiama la strategy corretta, salva `responsePayload`, e aggiorna la campagna. Ogni strategy implementa `IChannelStrategy` con una proprietà `channel` e il metodo `send()`. Email/PEC usano nodemailer; App IO e SEND usano `fetch` nativo (Node 22); Postal usa `PdfService.stampWithProtocol`.

**Tech Stack:** `nodemailer ^6`, `@types/nodemailer`, `fetch` nativo Node 22 (no dipendenze extra), `PdfService` (già presente), NestJS 10 + TypeScript strict.

## Global Constraints

- Nessun tool in locale — tutto in Docker
- pnpm v11: rebuild obbligatorio solo dopo modifica `package.json`: `docker compose down && docker volume rm comunicapa_backend_node_modules && docker compose up -d --build backend`
- TypeScript strict mode — zero `any` impliciti, strict null checks
- Test in Docker: `docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern <pattern> --forceExit`
- Restart (senza rebuild) sufficiente per modifiche `.ts` già montati: `docker compose restart backend && sleep 25`
- Working directory: `C:\Users\mirko.daddiego\Documents\comunicapa`
- Git: commit al termine di ogni task
- `@types/nodemailer` solo in devDependencies

---

## File Map

| File | Azione |
|------|--------|
| `apps/backend/package.json` | MODIFY — aggiungi `nodemailer ^6` in deps, `@types/nodemailer` in devDeps |
| `apps/backend/src/config/configuration.ts` | MODIFY — aggiungi sezioni `smtp`, `pec`, `appIo`, `send` |
| `docker-compose.yml` | MODIFY — aggiungi env var SMTP_*, PEC_*, APP_IO_*, SEND_* |
| `.env.example` | MODIFY — aggiungi sezioni SMTP, PEC, App IO, SEND |
| `.env` | MODIFY — aggiungi valori dev per SMTP/PEC/AppIO/SEND |
| `packages/shared-types/src/index.ts` | MODIFY — aggiungi `ChannelSendResult` |
| `apps/backend/src/channels/channel.interface.ts` | CREATE — `IChannelStrategy`, `CHANNEL_STRATEGIES` symbol |
| `apps/backend/src/channels/channel.module.ts` | CREATE — esporta `Map<NotificationChannel, IChannelStrategy>` via token |
| `apps/backend/src/channels/email/email.strategy.ts` | CREATE |
| `apps/backend/src/channels/email/email.strategy.spec.ts` | CREATE |
| `apps/backend/src/channels/pec/pec.strategy.ts` | CREATE |
| `apps/backend/src/channels/pec/pec.strategy.spec.ts` | CREATE |
| `apps/backend/src/channels/app-io/app-io.strategy.ts` | CREATE |
| `apps/backend/src/channels/app-io/app-io.strategy.spec.ts` | CREATE |
| `apps/backend/src/channels/send/send.strategy.ts` | CREATE |
| `apps/backend/src/channels/send/send.strategy.spec.ts` | CREATE |
| `apps/backend/src/channels/postal/postal.strategy.ts` | CREATE |
| `apps/backend/src/channels/postal/postal.strategy.spec.ts` | CREATE |
| `apps/backend/src/queue/notification.processor.ts` | MODIFY — inject CHANNEL_STRATEGIES + Recipient repo + ciclo vita campagna |
| `apps/backend/src/queue/notification.processor.spec.ts` | MODIFY — aggiorna test con mock registry |
| `apps/backend/src/queue/queue.module.ts` | MODIFY — aggiungi Recipient a forFeature, import ChannelModule |
| `apps/backend/src/app.module.ts` | MODIFY — import ChannelModule |
| `apps/backend/src/campaigns/campaigns.service.ts` | MODIFY — atomic launch + fix totalRecipients |
| `apps/backend/src/pdf/pdf.service.ts` | MODIFY — sanitizzazione fileId |

---

### Task 1: nodemailer + configurazione canali + interfaccia + ChannelModule

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/src/config/configuration.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.env`
- Modify: `packages/shared-types/src/index.ts`
- Create: `apps/backend/src/channels/channel.interface.ts`
- Create: `apps/backend/src/channels/channel.module.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Produces:
  - `ChannelSendResult { messageId?: string; responsePayload?: Record<string, unknown> }` (shared-types)
  - `IChannelStrategy { channel: NotificationChannel; send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> }`
  - `CHANNEL_STRATEGIES: symbol` — token per inject `Map<NotificationChannel, IChannelStrategy>`
  - `ChannelModule` esportato (Tasks 2-5 aggiungono le loro strategie al modulo)

- [ ] **Step 1: Aggiungi nodemailer a `apps/backend/package.json`**

Nel blocco `dependencies`, aggiungi dopo `pdf-lib`:
```json
"nodemailer": "^6.0.0",
```

Nel blocco `devDependencies`, aggiungi dopo `@types/multer`:
```json
"@types/nodemailer": "^6.4.0",
```

- [ ] **Step 2: Rebuild backend (richiesto per nuova dipendenza)**

```powershell
docker compose down
docker volume rm comunicapa_backend_node_modules
docker compose up -d --build backend
Start-Sleep -Seconds 60
docker compose logs backend 2>&1 | Select-Object -Last 5
```

Expected: `Nest application successfully started`

- [ ] **Step 3: Aggiungi `ChannelSendResult` a `packages/shared-types/src/index.ts`**

Aggiungi in fondo al file:
```typescript
export interface ChannelSendResult {
  messageId?: string;
  responsePayload?: Record<string, unknown>;
}
```

- [ ] **Step 4: Aggiorna `apps/backend/src/config/configuration.ts`**

Sostituisci il file intero con:
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
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  pec: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  appIo: {
    apiKey: string;
    baseUrl: string;
  };
  send: {
    apiKey: string;
    baseUrl: string;
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
  smtp: {
    host: process.env['SMTP_HOST'] ?? 'localhost',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: process.env['SMTP_USER'] ?? '',
    password: process.env['SMTP_PASSWORD'] ?? '',
    from: process.env['SMTP_FROM'] ?? 'noreply@comunicapa.local',
  },
  pec: {
    host: process.env['PEC_HOST'] ?? 'localhost',
    port: parseInt(process.env['PEC_PORT'] ?? '587', 10),
    secure: process.env['PEC_SECURE'] === 'true',
    user: process.env['PEC_USER'] ?? '',
    password: process.env['PEC_PASSWORD'] ?? '',
    from: process.env['PEC_FROM'] ?? 'noreply@pec.comunicapa.local',
  },
  appIo: {
    apiKey: process.env['APP_IO_API_KEY'] ?? '',
    baseUrl: process.env['APP_IO_BASE_URL'] ?? 'https://api.io.italia.it',
  },
  send: {
    apiKey: process.env['SEND_API_KEY'] ?? '',
    baseUrl: process.env['SEND_BASE_URL'] ?? 'https://api.notifichedigitali.it',
  },
});
```

- [ ] **Step 5: Aggiungi env var a `docker-compose.yml`**

Nel blocco `environment:` del servizio `backend`, aggiungi dopo `CITIZEN_ORIGIN`:
```yaml
      PDF_STORAGE_PATH: /data/attachments
      SMTP_HOST: ${SMTP_HOST:-localhost}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_SECURE: ${SMTP_SECURE:-false}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      SMTP_FROM: ${SMTP_FROM:-noreply@comunicapa.local}
      PEC_HOST: ${PEC_HOST:-localhost}
      PEC_PORT: ${PEC_PORT:-587}
      PEC_SECURE: ${PEC_SECURE:-false}
      PEC_USER: ${PEC_USER:-}
      PEC_PASSWORD: ${PEC_PASSWORD:-}
      PEC_FROM: ${PEC_FROM:-noreply@pec.comunicapa.local}
      APP_IO_API_KEY: ${APP_IO_API_KEY:-}
      APP_IO_BASE_URL: ${APP_IO_BASE_URL:-https://api.io.italia.it}
      SEND_API_KEY: ${SEND_API_KEY:-}
      SEND_BASE_URL: ${SEND_BASE_URL:-https://api.notifichedigitali.it}
```

Nota: `PDF_STORAGE_PATH` è già presente nel blocco environment — non duplicarlo, solo aggiungi le righe SMTP/PEC/APP_IO/SEND dopo di esso.

- [ ] **Step 6: Aggiungi env var a `.env.example`**

Aggiungi in fondo al file:
```dotenv
# ── SMTP (canale EMAIL) ───────────────────────────────────────────────────────
SMTP_HOST=localhost
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=noreply@comune.example.it

# ── PEC (canale PEC) ─────────────────────────────────────────────────────────
PEC_HOST=smtp.pec.example.it
PEC_PORT=587
PEC_SECURE=false
PEC_USER=
PEC_PASSWORD=
PEC_FROM=noreply@pec.comune.example.it

# ── App IO (canale APP_IO) ────────────────────────────────────────────────────
# Chiave API dal portale io.italia.it
APP_IO_API_KEY=
APP_IO_BASE_URL=https://api.io.italia.it

# ── SEND / Piattaforma Notifiche Digitali (canale SEND) ──────────────────────
SEND_API_KEY=
SEND_BASE_URL=https://api.notifichedigitali.it
```

- [ ] **Step 7: Aggiungi env var a `.env`**

Aggiungi in fondo al file `.env` (git-ignored):
```dotenv
# ── SMTP ─────────────────────────────────────────────────────────────────────
SMTP_HOST=localhost
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=noreply@comunicapa.local

# ── PEC ──────────────────────────────────────────────────────────────────────
PEC_HOST=localhost
PEC_PORT=587
PEC_SECURE=false
PEC_USER=
PEC_PASSWORD=
PEC_FROM=noreply@pec.comunicapa.local

# ── App IO ───────────────────────────────────────────────────────────────────
APP_IO_API_KEY=
APP_IO_BASE_URL=https://api.io.italia.it

# ── SEND ─────────────────────────────────────────────────────────────────────
SEND_API_KEY=
SEND_BASE_URL=https://api.notifichedigitali.it
```

- [ ] **Step 8: Crea `apps/backend/src/channels/channel.interface.ts`**

```typescript
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { Recipient } from '../entities/recipient.entity';
import type { Campaign } from '../entities/campaign.entity';

export interface IChannelStrategy {
  readonly channel: NotificationChannel;
  send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult>;
}

export const CHANNEL_STRATEGIES = Symbol('CHANNEL_STRATEGIES');
```

- [ ] **Step 9: Crea `apps/backend/src/channels/channel.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { PdfModule } from '../pdf/pdf.module';
import type { IChannelStrategy } from './channel.interface';
import { CHANNEL_STRATEGIES } from './channel.interface';
import { EmailStrategy } from './email/email.strategy';
import { PecStrategy } from './pec/pec.strategy';
import { AppIoStrategy } from './app-io/app-io.strategy';
import { SendStrategy } from './send/send.strategy';
import { PostalStrategy } from './postal/postal.strategy';

@Module({
  imports: [PdfModule],
  providers: [
    EmailStrategy,
    PecStrategy,
    AppIoStrategy,
    SendStrategy,
    PostalStrategy,
    {
      provide: CHANNEL_STRATEGIES,
      useFactory: (
        email: EmailStrategy,
        pec: PecStrategy,
        appIo: AppIoStrategy,
        send: SendStrategy,
        postal: PostalStrategy,
      ): Map<NotificationChannel, IChannelStrategy> => {
        const map = new Map<NotificationChannel, IChannelStrategy>();
        for (const s of [email, pec, appIo, send, postal]) {
          map.set(s.channel, s);
        }
        return map;
      },
      inject: [EmailStrategy, PecStrategy, AppIoStrategy, SendStrategy, PostalStrategy],
    },
  ],
  exports: [CHANNEL_STRATEGIES],
})
export class ChannelModule {}
```

- [ ] **Step 10: Aggiungi `ChannelModule` a `apps/backend/src/app.module.ts`**

Aggiungi import:
```typescript
import { ChannelModule } from './channels/channel.module';
```

Aggiungi `ChannelModule` nell'array `imports`:
```typescript
imports: [
  ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
  DatabaseModule,
  AuthModule,
  QueueModule,
  CampaignsModule,
  PdfModule,
  ChannelModule,
],
```

- [ ] **Step 11: Commit**

```bash
git add apps/backend/package.json apps/backend/src/config/configuration.ts docker-compose.yml .env.example packages/shared-types/src/index.ts apps/backend/src/channels/channel.interface.ts apps/backend/src/channels/channel.module.ts apps/backend/src/app.module.ts
git commit -m "feat(fase4): nodemailer dep + config canali + IChannelStrategy + ChannelModule scaffold"
```

---

### Task 2: EmailStrategy + PecStrategy

**Files:**
- Create: `apps/backend/src/channels/email/email.strategy.ts`
- Create: `apps/backend/src/channels/email/email.strategy.spec.ts`
- Create: `apps/backend/src/channels/pec/pec.strategy.ts`
- Create: `apps/backend/src/channels/pec/pec.strategy.spec.ts`

**Interfaces:**
- Consumes: `IChannelStrategy`, `CHANNEL_STRATEGIES` da Task 1; `ConfigService<AppConfiguration>` per SMTP config
- Consumes: `Recipient.email`, `Recipient.pec`, `Recipient.fullName`, `Recipient.codiceFiscale`
- Consumes: `Campaign.channelConfig` — struttura attesa: `{ subject: string; body: string }` con placeholder `{{fullName}}`, `{{codiceFiscale}}`
- Produces: `EmailStrategy` con `channel = 'EMAIL'`; `PecStrategy` con `channel = 'PEC'`

**Template interpolation:** la funzione helper `interpolate` sostituisce `{{chiave}}` con il valore corrispondente da un `Record<string, string>`. Usata da entrambe le strategy.

- [ ] **Step 1: Scrivi test fallente per EmailStrategy**

Crea `apps/backend/src/channels/email/email.strategy.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailStrategy } from './email.strategy';

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...args),
}));

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'smtp.host': 'smtp.test',
      'smtp.port': 587,
      'smtp.secure': false,
      'smtp.user': 'user',
      'smtp.password': 'pass',
      'smtp.from': 'noreply@test.it',
    };
    return cfg[key];
  },
};

describe('EmailStrategy', () => {
  let strategy: EmailStrategy;

  beforeEach(async () => {
    mockSendMail.mockClear();
    mockCreateTransport.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'msg-001', accepted: ['mario@example.com'] });

    const module = await Test.createTestingModule({
      providers: [
        EmailStrategy,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    strategy = module.get(EmailStrategy);
  });

  it('is defined with channel EMAIL', () => {
    expect(strategy).toBeDefined();
    expect(strategy.channel).toBe('EMAIL');
  });

  it('send() chiama nodemailer con email del recipient', async () => {
    const recipient = {
      id: 'r1',
      email: 'mario@example.com',
      pec: null,
      fullName: 'Mario Rossi',
      codiceFiscale: 'RSSMRA85M01H501Z',
    };
    const campaign = {
      id: 'c1',
      name: 'TARI 2024',
      channelConfig: { subject: 'Avviso {{fullName}}', body: 'CF: {{codiceFiscale}}' },
    };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'mario@example.com',
        subject: 'Avviso Mario Rossi',
        text: 'CF: RSSMRA85M01H501Z',
      }),
    );
    expect(result.messageId).toBe('msg-001');
  });

  it('send() lancia BadRequestException se recipient.email è null', async () => {
    const recipient = { id: 'r2', email: null, fullName: 'Luca', codiceFiscale: 'CF2' };
    const campaign = { channelConfig: { subject: 'S', body: 'B' } };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'Recipient non ha indirizzo email',
    );
  });
});
```

- [ ] **Step 2: Esegui test — devono fallire**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern email.strategy --forceExit 2>&1 | tail -10
```

Expected: FAIL con `Cannot find module './email.strategy'`

- [ ] **Step 3: Crea `apps/backend/src/channels/email/email.strategy.ts`**

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class EmailStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'EMAIL';

  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {
    this.transporter = nodemailer.createTransport({
      host: config.get('smtp.host', { infer: true }),
      port: config.get('smtp.port', { infer: true }),
      secure: config.get('smtp.secure', { infer: true }),
      auth: {
        user: config.get('smtp.user', { infer: true }),
        pass: config.get('smtp.password', { infer: true }),
      },
    });
  }

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.email) {
      throw new BadRequestException('Recipient non ha indirizzo email');
    }

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };

    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const body = interpolate(cfg['body'] ?? '', vars);

    const info = await this.transporter.sendMail({
      from: this.config.get('smtp.from', { infer: true }),
      to: recipient.email,
      subject,
      text: body,
    });

    return {
      messageId: String(info.messageId ?? ''),
      responsePayload: { accepted: info.accepted },
    };
  }
}
```

- [ ] **Step 4: Esegui test EmailStrategy — devono passare**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern email.strategy --forceExit 2>&1 | tail -10
```

Expected: `Tests: 3 passed`

- [ ] **Step 5: Scrivi test fallente per PecStrategy**

Crea `apps/backend/src/channels/pec/pec.strategy.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PecStrategy } from './pec.strategy';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'pec.host': 'pec.test',
      'pec.port': 587,
      'pec.secure': false,
      'pec.user': 'u',
      'pec.password': 'p',
      'pec.from': 'noreply@pec.test.it',
    };
    return cfg[key];
  },
};

describe('PecStrategy', () => {
  let strategy: PecStrategy;

  beforeEach(async () => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'pec-001', accepted: ['luca@pec.it'] });

    const module = await Test.createTestingModule({
      providers: [PecStrategy, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    strategy = module.get(PecStrategy);
  });

  it('is defined with channel PEC', () => {
    expect(strategy.channel).toBe('PEC');
  });

  it('send() chiama nodemailer con pec del recipient', async () => {
    const recipient = { pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1' };
    const campaign = { name: 'T', channelConfig: { subject: 'Avviso {{fullName}}', body: 'CF: {{codiceFiscale}}' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'luca@pec.it', subject: 'Avviso Luca' }),
    );
    expect(result.messageId).toBe('pec-001');
  });

  it('send() lancia BadRequestException se recipient.pec è null', async () => {
    const recipient = { pec: null, fullName: 'X', codiceFiscale: 'CF2' };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'Recipient non ha indirizzo PEC',
    );
  });
});
```

- [ ] **Step 6: Crea `apps/backend/src/channels/pec/pec.strategy.ts`**

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class PecStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'PEC';

  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {
    this.transporter = nodemailer.createTransport({
      host: config.get('pec.host', { infer: true }),
      port: config.get('pec.port', { infer: true }),
      secure: config.get('pec.secure', { infer: true }),
      auth: {
        user: config.get('pec.user', { infer: true }),
        pass: config.get('pec.password', { infer: true }),
      },
    });
  }

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    if (!recipient.pec) {
      throw new BadRequestException('Recipient non ha indirizzo PEC');
    }

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };

    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const body = interpolate(cfg['body'] ?? '', vars);

    const info = await this.transporter.sendMail({
      from: this.config.get('pec.from', { infer: true }),
      to: recipient.pec,
      subject,
      text: body,
    });

    return {
      messageId: String(info.messageId ?? ''),
      responsePayload: { accepted: info.accepted },
    };
  }
}
```

- [ ] **Step 7: Esegui test Email + PEC**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern "email.strategy|pec.strategy" --forceExit 2>&1 | tail -10
```

Expected: `Tests: 6 passed`

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/channels/email/ apps/backend/src/channels/pec/
git commit -m "feat(fase4): EmailStrategy + PecStrategy (nodemailer)"
```

---

### Task 3: AppIoStrategy + SendStrategy

**Files:**
- Create: `apps/backend/src/channels/app-io/app-io.strategy.ts`
- Create: `apps/backend/src/channels/app-io/app-io.strategy.spec.ts`
- Create: `apps/backend/src/channels/send/send.strategy.ts`
- Create: `apps/backend/src/channels/send/send.strategy.spec.ts`

**Interfaces:**
- Consumes: `IChannelStrategy`, `ConfigService` per `appIo.apiKey/baseUrl` e `send.apiKey/baseUrl`
- Consumes: `Recipient.codiceFiscale`, `Campaign.channelConfig`
- App IO body: `{ fiscal_code: string; content: { subject: string; markdown: string } }` — POST a `{APP_IO_BASE_URL}/api/v1/messages`
- SEND body: `{ recipientTaxId: string; subject: string; notificationBody: string }` — POST a `{SEND_BASE_URL}/delivery/notifications/sent`
- Produce response: `{ id: string }` (App IO), `{ notificationRequestId: string }` (SEND)

- [ ] **Step 1: Scrivi test fallente per AppIoStrategy**

Crea `apps/backend/src/channels/app-io/app-io.strategy.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppIoStrategy } from './app-io.strategy';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockConfig = {
  get: (key: string) => ({ 'appIo.apiKey': 'test-key', 'appIo.baseUrl': 'https://api.io.test' }[key]),
};

describe('AppIoStrategy', () => {
  let strategy: AppIoStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'io-msg-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [AppIoStrategy, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    strategy = module.get(AppIoStrategy);
  });

  it('is defined with channel APP_IO', () => {
    expect(strategy.channel).toBe('APP_IO');
  });

  it('send() chiama App IO API con fiscal_code e content', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { name: 'TARI', channelConfig: { subject: 'Avviso {{fullName}}', body: 'Importo dovuto.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.io.test/api/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'test-key' }),
        body: JSON.stringify({
          fiscal_code: 'RSSMRA85M01H501Z',
          content: { subject: 'Avviso Mario', markdown: 'Importo dovuto.' },
        }),
      }),
    );
    expect(result.messageId).toBe('io-msg-001');
  });

  it('send() lancia Error se API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('App IO API error: 429');
  });
});
```

- [ ] **Step 2: Crea `apps/backend/src/channels/app-io/app-io.strategy.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const apiKey = this.config.get('appIo.apiKey', { infer: true });
    const baseUrl = this.config.get('appIo.baseUrl', { infer: true });

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const markdown = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      body: JSON.stringify({
        fiscal_code: recipient.codiceFiscale,
        content: { subject, markdown },
      }),
    });

    if (!response.ok) {
      throw new Error(`App IO API error: ${response.status}`);
    }

    const data = (await response.json()) as { id: string };
    return { messageId: data.id, responsePayload: data as unknown as Record<string, unknown> };
  }
}
```

- [ ] **Step 3: Esegui test AppIoStrategy**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern app-io.strategy --forceExit 2>&1 | tail -10
```

Expected: `Tests: 3 passed`

- [ ] **Step 4: Scrivi test fallente per SendStrategy**

Crea `apps/backend/src/channels/send/send.strategy.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SendStrategy } from './send.strategy';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockConfig = {
  get: (key: string) => ({ 'send.apiKey': 'send-key', 'send.baseUrl': 'https://send.test' }[key]),
};

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notificationRequestId: 'send-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [SendStrategy, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('send() chiama SEND API con recipientTaxId', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/notifications/sent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'send-key' }),
        body: JSON.stringify({
          recipientTaxId: 'RSSMRA85M01H501Z',
          subject: 'Avviso',
          notificationBody: 'Testo notifica.',
        }),
      }),
    );
    expect(result.messageId).toBe('send-001');
  });

  it('send() lancia Error se SEND API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('SEND API error: 503');
  });
});
```

- [ ] **Step 5: Crea `apps/backend/src/channels/send/send.strategy.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class SendStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'SEND';

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const apiKey = this.config.get('send.apiKey', { infer: true });
    const baseUrl = this.config.get('send.baseUrl', { infer: true });

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const notificationBody = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${baseUrl}/delivery/notifications/sent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        recipientTaxId: recipient.codiceFiscale,
        subject,
        notificationBody,
      }),
    });

    if (!response.ok) {
      throw new Error(`SEND API error: ${response.status}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    return {
      messageId: data.notificationRequestId,
      responsePayload: data as unknown as Record<string, unknown>,
    };
  }
}
```

- [ ] **Step 6: Esegui test AppIo + SEND**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern "app-io.strategy|send.strategy" --forceExit 2>&1 | tail -10
```

Expected: `Tests: 6 passed`

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/app-io/ apps/backend/src/channels/send/
git commit -m "feat(fase4): AppIoStrategy (fetch io.italia.it) + SendStrategy (fetch notifiche digitali)"
```

---

### Task 4: PostalStrategy

**Files:**
- Create: `apps/backend/src/channels/postal/postal.strategy.ts`
- Create: `apps/backend/src/channels/postal/postal.strategy.spec.ts`

**Interfaces:**
- Consumes: `PdfService` (iniettato da PdfModule); `Campaign.channelConfig.pdfTemplateId: string`
- Produce: timbra `{PDF_STORAGE_PATH}/{pdfTemplateId}.pdf` con segnatura `TARI/${codiceFiscale}/${YYYYMMDD}`, ritorna `stampedId` come `messageId`
- `ChannelSendResult.responsePayload = { stampedId: string }`

- [ ] **Step 1: Scrivi test fallente per PostalStrategy**

Crea `apps/backend/src/channels/postal/postal.strategy.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { PostalStrategy } from './postal.strategy';
import { PdfService } from '../../pdf/pdf.service';

describe('PostalStrategy', () => {
  let strategy: PostalStrategy;
  let pdfService: jest.Mocked<PdfService>;

  beforeEach(async () => {
    const mockPdfService = { stampWithProtocol: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PostalStrategy,
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    strategy = module.get(PostalStrategy);
    pdfService = module.get(PdfService);
  });

  it('is defined with channel POSTAL', () => {
    expect(strategy.channel).toBe('POSTAL');
  });

  it('send() chiama PdfService.stampWithProtocol con fileId e segnatura', async () => {
    const stampedId = 'template-tari_stamped_1234567890';
    pdfService.stampWithProtocol.mockResolvedValue(stampedId);

    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = {
      name: 'TARI 2024',
      channelConfig: { pdfTemplateId: 'template-tari' },
    };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(pdfService.stampWithProtocol).toHaveBeenCalledWith(
      'template-tari',
      expect.stringMatching(/^TARI\/RSSMRA85M01H501Z\/\d{8}$/),
    );
    expect(result.messageId).toBe(stampedId);
    expect(result.responsePayload).toEqual({ stampedId });
  });

  it('send() lancia BadRequestException se pdfTemplateId mancante in channelConfig', async () => {
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'channelConfig.pdfTemplateId richiesto per canale POSTAL',
    );
  });
});
```

- [ ] **Step 2: Esegui test — deve fallire**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern postal.strategy --forceExit 2>&1 | tail -10
```

Expected: FAIL con `Cannot find module './postal.strategy'`

- [ ] **Step 3: Crea `apps/backend/src/channels/postal/postal.strategy.ts`**

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { PdfService } from '../../pdf/pdf.service';

@Injectable()
export class PostalStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'POSTAL';

  constructor(private readonly pdfService: PdfService) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const cfg = campaign.channelConfig as Record<string, string>;
    const pdfTemplateId = cfg['pdfTemplateId'];

    if (!pdfTemplateId) {
      throw new BadRequestException('channelConfig.pdfTemplateId richiesto per canale POSTAL');
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const stamp = `TARI/${recipient.codiceFiscale}/${date}`;

    const stampedId = await this.pdfService.stampWithProtocol(pdfTemplateId, stamp);

    return {
      messageId: stampedId,
      responsePayload: { stampedId },
    };
  }
}
```

- [ ] **Step 4: Esegui test PostalStrategy**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern postal.strategy --forceExit 2>&1 | tail -10
```

Expected: `Tests: 3 passed`

- [ ] **Step 5: Esegui tutti i test di canale**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern "channels" --forceExit 2>&1 | tail -10
```

Expected: `Tests: 12 passed` (3 Email + 3 PEC + 3 AppIO + 3 SEND + 3 Postal = 15... ma Email + PEC = 3+3=6, AppIO+SEND=3+3=6, Postal=3 → 15 total)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/
git commit -m "feat(fase4): PostalStrategy (PdfService.stampWithProtocol)"
```

---

### Task 5: NotificationProcessor refactor + ciclo vita campagna

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Modify: `apps/backend/src/queue/notification.processor.spec.ts`
- Modify: `apps/backend/src/queue/queue.module.ts`

**Interfaces:**
- Consumes: `CHANNEL_STRATEGIES: Map<NotificationChannel, IChannelStrategy>` da ChannelModule
- Consumes: `Recipient` entity (aggiunto a `TypeOrmModule.forFeature`)
- Flusso campagna: `QUEUED → RUNNING` (primo job) → `RUNNING → COMPLETED` (sentCount + failedCount >= totalRecipients, almeno 1 sent) o `RUNNING → FAILED` (tutti falliti)

- [ ] **Step 1: Aggiorna `apps/backend/src/queue/queue.module.ts`**

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
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
    ChannelModule,
  ],
  providers: [NotificationProcessor],
  exports: [BullModule],
})
export class QueueModule {}
```

- [ ] **Step 2: Scrivi test aggiornati per NotificationProcessor**

Sostituisci il contenuto di `apps/backend/src/queue/notification.processor.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES } from '../channels/channel.interface';
import { NOTIFICATION_QUEUE } from './notification-job.types';
import type { NotificationJobData } from '@comunicapa/shared-types';

const mockAttemptRepo = {
  update: jest.fn(),
};

const mockCampaignRepo = {
  findOne: jest.fn(),
  increment: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockRecipientRepo = {
  findOne: jest.fn(),
};

const mockStrategy = {
  send: jest.fn(),
};

const mockStrategies = new Map([['EMAIL', mockStrategy]]);

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;

  const mockJob = (data: NotificationJobData) =>
    ({ id: '1', data } as unknown as Job<NotificationJobData>);

  const baseData: NotificationJobData = {
    campaignId: 'camp-1',
    recipientId: 'rec-1',
    attemptId: 'att-1',
    channel: 'EMAIL',
  };

  const mockCampaign = {
    id: 'camp-1',
    status: CampaignStatus.QUEUED,
    name: 'TARI',
    channelType: 'EMAIL',
    channelConfig: {},
    sentCount: 0,
    failedCount: 0,
    totalRecipients: 1,
  };

  const mockRecipient = {
    id: 'rec-1',
    email: 'mario@example.com',
    pec: null,
    fullName: 'Mario',
    codiceFiscale: 'RSSMRA85M01H501Z',
  };

  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);
    mockRecipientRepo.findOne.mockResolvedValue(mockRecipient);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockStrategy.send.mockResolvedValue({ messageId: 'msg-001', responsePayload: {} });

    const module = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: CHANNEL_STRATEGIES, useValue: mockStrategies },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: {} },
      ],
    }).compile();

    processor = module.get(NotificationProcessor);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  it('process() aggiorna attempt PROCESSING → SUCCESS e chiama strategy', async () => {
    await processor.process(mockJob(baseData));

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', { status: AttemptStatus.PROCESSING });
    expect(mockStrategy.send).toHaveBeenCalledWith(mockRecipient, mockCampaign);
    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.SUCCESS,
      responsePayload: expect.any(Object),
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
  });

  it('process() aggiorna attempt PROCESSING → FAILED e rilancia se strategy lancia', async () => {
    mockStrategy.send.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP timeout');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.FAILED,
      errorMessage: 'SMTP timeout',
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
  });

  it('process() lancia Error se nessuna strategy per channel', async () => {
    const data: NotificationJobData = { ...baseData, channel: 'POSTAL' };

    await expect(processor.process(mockJob(data))).rejects.toThrow('Nessuna strategy per channel POSTAL');
  });
});
```

- [ ] **Step 3: Esegui test — devono fallire**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern notification.processor --forceExit 2>&1 | tail -15
```

Expected: FAIL (metodi mancanti nel processor)

- [ ] **Step 4: Sostituisci `apps/backend/src/queue/notification.processor.ts`**

```typescript
import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { NOTIFICATION_QUEUE } from './notification-job.types';

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @Inject(CHANNEL_STRATEGIES)
    private readonly strategies: Map<NotificationChannel, IChannelStrategy>,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { campaignId, recipientId, attemptId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} channel=${channel}`);

    const strategy = this.strategies.get(channel);
    if (!strategy) {
      throw new Error(`Nessuna strategy per channel ${channel}`);
    }

    const [campaign, recipient] = await Promise.all([
      this.campaignRepo.findOne({
        where: { id: campaignId },
        select: ['id', 'status', 'name', 'channelType', 'channelConfig', 'sentCount', 'failedCount', 'totalRecipients'],
      }),
      this.recipientRepo.findOne({
        where: { id: recipientId },
        select: ['id', 'codiceFiscale', 'email', 'pec', 'fullName'],
      }),
    ]);

    if (!campaign || !recipient) {
      throw new Error(`Campaign o Recipient non trovati: campaignId=${campaignId} recipientId=${recipientId}`);
    }

    // QUEUED → RUNNING (atomic, solo il primo worker che elabora vince)
    if (campaign.status === CampaignStatus.QUEUED) {
      await this.campaignRepo
        .createQueryBuilder()
        .update()
        .set({ status: CampaignStatus.RUNNING })
        .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
        .execute();
    }

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    try {
      const result = await strategy.send(recipient, campaign);

      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.SUCCESS,
        sentAt: new Date(),
        responsePayload: result.responsePayload ?? null,
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
    } finally {
      await this.checkAndCompleteCampaign(campaignId);
    }
  }

  private async checkAndCompleteCampaign(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId },
      select: ['id', 'status', 'sentCount', 'failedCount', 'totalRecipients'],
    });

    if (!campaign || campaign.status !== CampaignStatus.RUNNING) return;
    if (campaign.sentCount + campaign.failedCount < campaign.totalRecipients) return;

    const finalStatus =
      campaign.sentCount === 0 ? CampaignStatus.FAILED : CampaignStatus.COMPLETED;

    // Atomic: WHERE status = 'running' — solo un worker completa la campagna
    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: finalStatus, completedAt: new Date() })
      .where('id = :id AND status = :running', { id: campaignId, running: CampaignStatus.RUNNING })
      .execute();

    this.logger.log(`Campaign ${campaignId} → ${finalStatus}`);
  }
}
```

- [ ] **Step 5: Esegui test NotificationProcessor**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --testPathPattern notification.processor --forceExit 2>&1 | tail -15
```

Expected: `Tests: 4 passed` (is defined + SUCCESS + FAILED+rethrow + no strategy error)

- [ ] **Step 6: Restart backend e verifica avvio**

```powershell
docker compose restart backend
Start-Sleep -Seconds 30
docker compose logs backend 2>&1 | Select-Object -Last 5
```

Expected: `Nest application successfully started`

- [ ] **Step 7: Esegui suite completa**

```powershell
docker exec comunicapa-backend node_modules/.bin/jest --forceExit 2>&1 | tail -15
```

Expected: tutti i test passano (≥ 32 test: 17 esistenti + 15 nuovi strategie + 4 processor aggiornati = ~36)

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/queue/
git commit -m "feat(fase4): NotificationProcessor usa CHANNEL_STRATEGIES + ciclo vita campagna QUEUED→RUNNING→COMPLETED/FAILED"
```

---

### Task 6: Backlog Fase 3 — Race condition launch + totalRecipients + path traversal

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/backend/src/pdf/pdf.service.ts`

**Interfaces:**
- Fix 1 (`launch`): `UPDATE campaigns SET status='queued' WHERE id=:id AND status='draft'` — atomic, remove 2-step guard
- Fix 2 (`uploadCsv`): `campaignRepo.increment` invece di `campaignRepo.update` per `totalRecipients`
- Fix 3 (`stampWithProtocol`): guard `if (/[\\/]|\.\./.test(fileId)) throw BadRequestException`

- [ ] **Step 1: Scrivi test fallente per atomic launch**

Aggiungi il seguente test in `apps/backend/src/campaigns/campaigns.service.spec.ts`, nella describe block `launch`:

Leggi prima il file per capire la struttura dei test esistenti. Poi aggiungi (senza rimuovere i test esistenti) un test che verifica il comportamento atomico:

```typescript
it('launch() usa UPDATE atomico WHERE status=draft invece di findOneBy+update separati', async () => {
  // Setup: campaign trovata ma findOneBy NON deve essere chiamato
  // Il nuovo launch usa createQueryBuilder().update() direttamente
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  mockCampaignRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb);
  mockRecipientRepo.find = jest.fn().mockResolvedValue([]);

  await expect(service.launch('camp-1')).rejects.toThrow('Only draft campaigns can be launched');
  expect(mockQb.execute).toHaveBeenCalled();
});
```

Nota: il test verifica che `launch` con `affected: 0` lanci `BadRequestException`. L'implementazione non chiama più `findOneBy` + guard separato.

- [ ] **Step 2: Applica Fix 1 — atomic launch in `campaigns.service.ts`**

Leggi il file `apps/backend/src/campaigns/campaigns.service.ts`. Nel metodo `launch`, sostituisci:

```typescript
// PRIMA (da rimuovere):
const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
if (campaign.status !== CampaignStatus.DRAFT) {
  throw new BadRequestException('Only draft campaigns can be launched');
}
```

Con:

```typescript
// DOPO (atomic):
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
```

Poi rimuovi la riga esistente `await this.campaignRepo.update(campaignId, { status: CampaignStatus.QUEUED })` più in basso nel metodo (è già fatto nell'UPDATE atomico sopra).

- [ ] **Step 3: Applica Fix 2 — increment totalRecipients in `campaigns.service.ts`**

Nel metodo `uploadCsv`, sostituisci:

```typescript
await this.campaignRepo.update(campaignId, { totalRecipients: imported });
```

Con:

```typescript
await this.campaignRepo.increment({ id: campaignId }, 'totalRecipients', imported);
```

- [ ] **Step 4: Applica Fix 3 — sanitizzazione fileId in `pdf.service.ts`**

In `apps/backend/src/pdf/pdf.service.ts`, aggiungi `BadRequestException` agli import da `@nestjs/common`:

```typescript
import { Injectable, Logger, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
```

Poi, all'inizio del metodo `stampWithProtocol`, prima di `const inputPath = ...`, aggiungi:

```typescript
if (/[\\/]|\.\./.test(fileId)) {
  throw new BadRequestException(`fileId non valido: ${fileId}`);
}
```

- [ ] **Step 5: Restart e verifica test**

```powershell
docker compose restart backend
Start-Sleep -Seconds 25
docker exec comunicapa-backend node_modules/.bin/jest --forceExit 2>&1 | tail -15
```

Expected: tutti i test passano. Il test `campaigns.service.spec.ts` può richiedere aggiornamenti mock se i test esistenti usano `findOneBy` nel metodo `launch` — aggiustali: il nuovo `launch` usa `createQueryBuilder` quindi i mock devono fornire un `mockQb` con `affected: 1`.

**Se i test esistenti di launch falliscono:** Leggi `campaigns.service.spec.ts`, trova i test su `launch`, e aggiusta il mock così:

```typescript
// Nel beforeEach o nei test di launch:
const mockQb = {
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue({ affected: 1 }),
};
mockCampaignRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb);
mockCampaignRepo.existsBy = jest.fn().mockResolvedValue(false);
```

I test che verificavano `campaign.status !== DRAFT` ora verificano invece `affected === 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/pdf/pdf.service.ts
git commit -m "fix(backlog): atomic launch, totalRecipients increment, fileId path traversal guard"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Strategy Pattern per EMAIL, PEC, APP_IO, SEND, POSTAL → Tasks 2-4
- ✅ NotificationProcessor chiama strategy corretta → Task 5
- ✅ Ciclo vita QUEUED → RUNNING → COMPLETED/FAILED → Task 5
- ✅ Race condition launch → Task 6 Fix 1
- ✅ totalRecipients corruption → Task 6 Fix 2
- ✅ Path traversal fileId → Task 6 Fix 3
- ✅ nodemailer per Email/PEC → Task 1 (dep) + Task 2 (impl)
- ✅ fetch nativo per App IO/SEND → Task 3
- ✅ PdfService.stampWithProtocol per Postal → Task 4
- ✅ CHANNEL_STRATEGIES token DI → Task 1

**2. Placeholder scan:** nessun "TBD" o "similar to Task N". Ogni step ha codice completo.

**3. Type consistency:**
- `IChannelStrategy.channel: NotificationChannel` — definito in Task 1, usato da ogni strategy come `readonly channel: NotificationChannel = 'EMAIL'` ecc.
- `ChannelSendResult` — definito in shared-types Task 1, ritornato da ogni `send()`
- `CHANNEL_STRATEGIES: symbol` — definito in `channel.interface.ts` Task 1, iniettato in processor Task 5
- `Map<NotificationChannel, IChannelStrategy>` — tipo consistente tra ChannelModule (Task 1) e processor (Task 5)
- `interpolate` — duplicata in email.strategy, pec.strategy, app-io.strategy, send.strategy (intenzionale: no dipendenza interna tra strategie, YAGNI su util condivisa)
- `CampaignStatus.RUNNING` — aggiunto al flusso in Task 5 processor, già definito in `campaign.entity.ts`
- `mockCampaignRepo.createQueryBuilder` — aggiunto ai mock nei test di Task 5 e Task 6
