# Redesign dashboard operatore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il box "Da attenzionare" della dashboard operatore mostra i motori con job falliti senza limite temporale (resta rosso per sempre finché un operatore non pulisce i job in Motori). Questo piano finestra l'alert a 7 giorni, aggiunge la coda Arricchimento Tracciati (oggi invisibile in dashboard), un contatore "operatori online" e sostituisce il widget "Attività Recenti" (ultime 5 campagne create) con "Campagne recenti" basato su attività reale (status attivo o aggiornamento di consegna SEND/POSTAL negli ultimi 7 giorni).

**Architecture:** Nessun subsystem nuovo. 3 estensioni backend granulari (esiste già questo pattern: fetch indipendenti pollabili a cadenza propria) + un piccolo `PresenceModule` (stato in RAM, nessuna persistenza — backend single-instance). Frontend continua a comporre la dashboard da più fetch indipendenti, nessun endpoint aggregato.

**Tech Stack:** NestJS 12 (ESM), TypeORM 0.3, BullMQ 5.81, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-dashboard-redesign-design.md`

## Global Constraints

- Finestra alert motori/campagne: **7 giorni** ovunque (nessuna finestra diversa per un widget e non per un altro).
- Presence: **stato in RAM**, nessun Redis/persistenza — backend è single-instance (vedi CLAUDE.md).
- Struttura backend: **endpoint granulari**, mai un endpoint aggregato unico.
- `campaign.updatedAt` NON riflette mai gli aggiornamenti di consegna SEND/POSTAL (verificato: `SendStatusSyncService`/`PostalStatusSyncService` scrivono solo su `NotificationAttempt`) — ogni query su "ultimo aggiornamento" deve leggere `notification_attempts.send_status_updated_at`/`postal_status_updated_at`, mai `campaign.updatedAt` da solo.
- Ogni nuovo import relativo ESM richiede estensione `.js` esplicita (vincolo NodeNext di questo backend).
- Ogni endpoint sotto `admin/*` eredita `@Roles(...)` di classe dove già presente, altrimenti va annotato esplicitamente.

---

### Task 1: Backend — `lastFailedAt` per motore + coda Arricchimento in `GET /admin/engines`

**Files:**
- Modify: `apps/backend/src/queue/notification-queues.service.ts`
- Modify: `apps/backend/src/engines/engines.controller.ts`
- Modify: `apps/backend/src/engines/engines.module.ts`
- Test: `apps/backend/src/engines/engines.controller.spec.ts`

**Interfaces:**
- Produces: risposta `GET /admin/engines` — ogni elemento di `engines[]` guadagna `lastFailedAt: string | null` (ISO timestamp dell'ultimo job fallito, `null` se nessuno); nuovo elemento `{ channel: 'ENRICHMENT', queueName: 'enrichment-jobs', paused: false, pausable: false, counts: {waiting,active,completed,failed,delayed}, lastFailedAt }`.

- [ ] **Step 1: Scrivere il test fallente per `NotificationQueuesService.getLastFailedAt`**

Apri `apps/backend/src/queue/notification-queues.service.spec.ts` (se non esiste, crealo con questo contenuto minimo attorno al metodo esistente — verifica prima con `ls apps/backend/src/queue/*.spec.ts` se un file di test già copre questo service e aggiungi lì il blocco `describe`):

```ts
describe('getLastFailedAt', () => {
  it('ritorna l\'ISO timestamp del job fallito più recente', async () => {
    const mockJob = { finishedOn: 1700000000000 };
    const mockQueue = { getFailed: vi.fn().mockResolvedValue([mockJob]) };
    (service as any).queues.set('EMAIL', mockQueue);

    const result = await service.getLastFailedAt('EMAIL');

    expect(mockQueue.getFailed).toHaveBeenCalledWith(0, 0);
    expect(result).toBe(new Date(1700000000000).toISOString());
  });

  it('ritorna null se non ci sono job falliti', async () => {
    const mockQueue = { getFailed: vi.fn().mockResolvedValue([]) };
    (service as any).queues.set('EMAIL', mockQueue);

    const result = await service.getLastFailedAt('EMAIL');

    expect(result).toBeNull();
  });
});
```

Se il file di test non esiste ancora, crealo da zero con questo header (segui lo stile già in uso in `engines.controller.spec.ts`, mock diretto senza `Test.createTestingModule` dato che il service non ha dipendenze Nest oltre le queue iniettate):

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationQueuesService } from './notification-queues.service.js';

describe('NotificationQueuesService', () => {
  let service: NotificationQueuesService;

  beforeEach(() => {
    service = Object.create(NotificationQueuesService.prototype);
    (service as any).queues = new Map();
  });

  // ... describe('getLastFailedAt', ...) come sopra
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/vitest run notification-queues.service -v`
Expected: FAIL con `service.getLastFailedAt is not a function`

- [ ] **Step 3: Implementare `getLastFailedAt` in `NotificationQueuesService`**

In `apps/backend/src/queue/notification-queues.service.ts`, aggiungi dopo il metodo `getJobCounts`:

```ts
  async getLastFailedAt(channel: EngineName): Promise<string | null> {
    const [job] = await this.getQueue(channel).getFailed(0, 0);
    return job?.finishedOn ? new Date(job.finishedOn).toISOString() : null;
  }
```

Nota: `Queue.getFailed(start, end)` in bullmq chiama internamente `getJobs(['failed'], start, end, false)` — `asc=false` ordina per timestamp decrescente, quindi `getFailed(0, 0)` ritorna il fallimento più recente (verificato leggendo `queue-getters.js` in bullmq@5.81.5).

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/vitest run notification-queues.service -v`
Expected: PASS

- [ ] **Step 5: Aggiornare `engines.module.ts` per registrare la coda Arricchimento**

In `apps/backend/src/engines/engines.module.ts`, sostituisci il contenuto con:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from '../queue/queue.module.js';
import { ChannelModule } from '../channels/channel.module.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';
import { EnginesController } from './engines.controller.js';

@Module({
  imports: [
    QueueModule,
    ChannelModule,
    BullModule.registerQueue({ name: ENRICHMENT_QUEUE }),
    TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient]),
  ],
  controllers: [EnginesController],
})
export class EnginesModule {}
```

Nota: registrare la stessa coda (`ENRICHMENT_QUEUE`) in un secondo modulo oltre a `EnrichmentModule` è un pattern supportato da `@nestjs/bullmq` — ogni modulo ottiene una propria istanza `Queue` connessa allo stesso nome/Redis, sufficiente per operazioni di sola lettura come `getJobCounts`/`getFailed`.

- [ ] **Step 6: Scrivere il test fallente per `EnginesController.list()` esteso**

Sostituisci in `apps/backend/src/engines/engines.controller.spec.ts` il mock `mockQueuesService` e il test `list()`:

```ts
import { getQueueToken } from '@nestjs/bullmq';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';

// ... nel describe, sostituire mockQueuesService:
  const mockQueuesService = {
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getLastFailedAt: jest.fn().mockResolvedValue(null),
    pause: jest.fn(),
    resume: jest.fn(),
    getJobsDetail: jest.fn().mockResolvedValue([{ jobId: 'j1' }]),
  };
  const mockEnrichmentQueue = {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, active: 0, completed: 5, failed: 0, delayed: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
  };

// ... nel beforeEach, aggiungere al providers array:
        { provide: getQueueToken(ENRICHMENT_QUEUE), useValue: mockEnrichmentQueue },
```

Aggiorna il test esistente:

```ts
  it('list() ritorna 7 motori (5 code BullMQ pausabili + INAD + ENRICHMENT non pausabili), nessun SEND', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(7);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      pausable: true,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      lastFailedAt: null,
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
    expect(res.engines.map((e: any) => e.channel)).not.toContain('SEND');
    const inad = res.engines.find((e: any) => e.channel === 'INAD');
    expect(inad).toBeDefined();
    expect(inad!.pausable).toBe(false);
    expect(inad!.lastFailedAt).toBeNull();
    const enrichment = res.engines.find((e: any) => e.channel === 'ENRICHMENT');
    expect(enrichment).toBeDefined();
    expect(enrichment).toEqual({
      channel: 'ENRICHMENT',
      queueName: ENRICHMENT_QUEUE,
      paused: false,
      pausable: false,
      counts: { waiting: 1, active: 0, completed: 5, failed: 0, delayed: 0 },
      lastFailedAt: null,
    });
  });

  it('list() popola lastFailedAt del motore ENRICHMENT dal job fallito più recente', async () => {
    mockEnrichmentQueue.getFailed.mockResolvedValueOnce([{ finishedOn: 1700000000000 }]);
    const res = await controller.list();
    const enrichment = res.engines.find((e: any) => e.channel === 'ENRICHMENT');
    expect(enrichment!.lastFailedAt).toBe(new Date(1700000000000).toISOString());
  });
```

- [ ] **Step 7: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/vitest run engines.controller -v`
Expected: FAIL (`getQueueToken` non risolvibile / `lastFailedAt` undefined / lunghezza 6 invece di 7)

- [ ] **Step 8: Implementare l'estensione in `EnginesController`**

In `apps/backend/src/engines/engines.controller.ts`:

```ts
import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Not, IsNull, Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { ENGINE_NAMES, type EngineName } from '../queue/notification-job.types.js';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity.js';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';

function isEngineName(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

@Controller('admin/engines')
export class EnginesController {
  constructor(
    private readonly queues: NotificationQueuesService,
    private readonly postalStatusSync: PostalStatusSyncService,
    @InjectQueue(ENRICHMENT_QUEUE) private readonly enrichmentQueue: Queue,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  @Get()
  @Roles('admin', 'user')
  async list() {
    const engines: Array<{
      channel: EngineName | 'INAD' | 'ENRICHMENT';
      queueName: string;
      paused: boolean;
      pausable: boolean;
      counts: Record<string, number>;
      lastFailedAt: string | null;
    }> = await Promise.all(
      ENGINE_NAMES.map(async (name) => {
        const [paused, counts, lastFailedAt] = await Promise.all([
          this.queues.isPaused(name),
          this.queues.getJobCounts(name),
          this.queues.getLastFailedAt(name),
        ]);
        return {
          channel: name,
          queueName: `notifications-${name.toLowerCase()}`,
          paused,
          pausable: true,
          counts,
          lastFailedAt,
        };
      }),
    );

    const [inadCheckingCampaigns, inadPendingRecipients, inadTotalCheckedRecipients] = await Promise.all([
      this.campaignRepo.count({ where: { status: CampaignStatus.CHECKING_INAD } }),
      this.recipientRepo.count({ where: { status: RecipientStatus.PENDING, campaign: { status: CampaignStatus.CHECKING_INAD } } }),
      this.recipientRepo.count({ where: { inadCheck: Not(IsNull()) } }),
    ]);

    engines.push({
      channel: 'INAD',
      queueName: 'inad-check-bulk',
      paused: false,
      pausable: false,
      counts: {
        active: inadPendingRecipients,
        completed: inadTotalCheckedRecipients,
        failed: 0,
        delayed: 0,
        waiting: inadCheckingCampaigns,
        paused: 0,
      },
      lastFailedAt: null,
    });

    const [enrichmentCounts, enrichmentFailedJobs] = await Promise.all([
      this.enrichmentQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.enrichmentQueue.getFailed(0, 0),
    ]);
    engines.push({
      channel: 'ENRICHMENT',
      queueName: ENRICHMENT_QUEUE,
      paused: false,
      pausable: false,
      counts: enrichmentCounts as Record<string, number>,
      lastFailedAt: enrichmentFailedJobs[0]?.finishedOn ? new Date(enrichmentFailedJobs[0].finishedOn).toISOString() : null,
    });

    return { engines };
  }

  // ... resto dei metodi invariato (sendStageCounts, postalQueueHealth, pause, resume, jobs, jobLogs)
}
```

- [ ] **Step 9: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/vitest run engines.controller notification-queues.service -v`
Expected: PASS

- [ ] **Step 10: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit && docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun errore

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/queue/notification-queues.service.ts apps/backend/src/queue/notification-queues.service.spec.ts apps/backend/src/engines/engines.controller.ts apps/backend/src/engines/engines.module.ts apps/backend/src/engines/engines.controller.spec.ts
git commit -m "feat(engines): lastFailedAt per motore + coda Arricchimento in GET /admin/engines"
```

---

### Task 2: Frontend — finestra 7gg alert motori + widget Arricchimento in dashboard

**Files:**
- Modify: `apps/frontend-admin/src/data/channels.ts`
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET /admin/engines` risposta con `lastFailedAt: string | null` per ogni entry, entry `channel: 'ENRICHMENT'` (Task 1).

- [ ] **Step 1: Aggiungere la label "Arricchimento Tracciati" a `ENGINE_LABELS`**

In `apps/frontend-admin/src/data/channels.ts`, dopo la definizione esistente:

```ts
export const ENGINE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNELS_REGISTRY).map(([key, meta]) => [key, meta.label])
);
```

aggiungi subito sotto:

```ts
ENGINE_LABELS.ENRICHMENT = 'Arricchimento Tracciati';
```

(Coerente con la regola CLAUDE.md "label/loghi/badge canali sempre dal registro centralizzato": `ENRICHMENT` non è un `NotificationChannel` quindi non può stare in `CHANNELS_REGISTRY`, ma resta nello stesso file/unica fonte per le label dei motori.)

- [ ] **Step 2: Finestrare `failingEngines` a 7 giorni in `App.tsx`**

Trova il blocco (dentro la sezione "Da attenzionare" della dashboard):

```tsx
                const pausedEngines = engines.filter((e) => e.paused);
                const failingEngines = engines.filter((e) => (e.counts?.failed ?? 0) > 0);
```

Sostituiscilo con:

```tsx
                const pausedEngines = engines.filter((e) => e.paused);
                const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
                const failingEngines = engines.filter(
                  (e) => (e.counts?.failed ?? 0) > 0 && e.lastFailedAt && new Date(e.lastFailedAt).getTime() >= sevenDaysAgoMs,
                );
```

- [ ] **Step 3: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Apri la dashboard admin, tab Motori: verifica che un motore con job falliti VECCHI (>7gg, es. controlla `lastFailedAt` nella risposta di `GET /admin/engines` via devtools Network) non compaia più in "Da attenzionare", mentre un motore con `lastFailedAt` recente sì. Verifica che "Arricchimento Tracciati" compaia nel conteggio "Stato Connettori" (X su Y motori attivi) e, se ha job falliti recenti, nel box "Da attenzionare" con l'etichetta corretta (non la stringa raw "ENRICHMENT").

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/data/channels.ts apps/frontend-admin/src/App.tsx
git commit -m "fix(dashboard): finestra a 7gg l'alert motori, aggiunge coda Arricchimento"
```

---

### Task 3: Backend — `PresenceModule` (heartbeat + utenti online)

**Files:**
- Create: `apps/backend/src/presence/presence.service.ts`
- Create: `apps/backend/src/presence/presence.controller.ts`
- Create: `apps/backend/src/presence/presence.module.ts`
- Create: `apps/backend/src/presence/presence.service.spec.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Produces: `PresenceService.heartbeat(username: string): void`, `PresenceService.getOnlineCount(): number`. Endpoint `POST /admin/presence/heartbeat` (200, body vuoto), `GET /admin/presence/online` → `{ count: number }`.

- [ ] **Step 1: Scrivere il test fallente per `PresenceService`**

Crea `apps/backend/src/presence/presence.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PresenceService } from './presence.service.js';

describe('PresenceService', () => {
  let service: PresenceService;

  beforeEach(() => {
    service = new PresenceService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('conta un operatore che ha fatto heartbeat come online', () => {
    service.heartbeat('mrossi');
    expect(service.getOnlineCount()).toBe(1);
  });

  it('conta operatori distinti una sola volta ciascuno', () => {
    service.heartbeat('mrossi');
    service.heartbeat('mrossi');
    service.heartbeat('averdi');
    expect(service.getOnlineCount()).toBe(2);
  });

  it('non conta un operatore il cui ultimo heartbeat supera 90 secondi', () => {
    service.heartbeat('mrossi');
    vi.setSystemTime(new Date('2026-09-16T10:01:31.000Z')); // +91s
    expect(service.getOnlineCount()).toBe(0);
  });

  it('conta un operatore al limite della soglia (90s esatti)', () => {
    service.heartbeat('mrossi');
    vi.setSystemTime(new Date('2026-09-16T10:01:30.000Z')); // +90s esatti
    expect(service.getOnlineCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/vitest run presence.service -v`
Expected: FAIL con `Cannot find module './presence.service.js'`

- [ ] **Step 3: Implementare `PresenceService`**

Crea `apps/backend/src/presence/presence.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

const ONLINE_THRESHOLD_MS = 90_000;

@Injectable()
export class PresenceService {
  private readonly lastSeen = new Map<string, number>();

  heartbeat(username: string): void {
    this.lastSeen.set(username, Date.now());
  }

  getOnlineCount(): number {
    const now = Date.now();
    let count = 0;
    for (const [username, seenAt] of this.lastSeen) {
      if (now - seenAt <= ONLINE_THRESHOLD_MS) {
        count++;
      } else {
        this.lastSeen.delete(username);
      }
    }
    return count;
  }
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/vitest run presence.service -v`
Expected: PASS

- [ ] **Step 5: Creare il controller**

Crea `apps/backend/src/presence/presence.controller.ts`:

```ts
import { Controller, Get, Post, Req, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PresenceService } from './presence.service.js';

@Controller('admin/presence')
@Roles('admin', 'user')
export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Req() req: Request & { user: JwtOperatorPayload }): { success: true } {
    this.presenceService.heartbeat(req.user.username);
    return { success: true };
  }

  @Get('online')
  online(): { count: number } {
    return { count: this.presenceService.getOnlineCount() };
  }
}
```

- [ ] **Step 6: Creare il modulo**

Crea `apps/backend/src/presence/presence.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service.js';
import { PresenceController } from './presence.controller.js';

@Module({
  controllers: [PresenceController],
  providers: [PresenceService],
})
export class PresenceModule {}
```

- [ ] **Step 7: Registrare il modulo in `app.module.ts`**

In `apps/backend/src/app.module.ts`, aggiungi l'import:

```ts
import { PresenceModule } from './presence/presence.module.js';
```

e aggiungi `PresenceModule` all'array `imports` (dopo `AuditLogsModule`):

```ts
    AuditLogsModule,
    PresenceModule,
    ExternalApiModule,
```

- [ ] **Step 8: Verifica manuale end-to-end**

```bash
docker compose up -d --build backend
```

Genera un token JWT di debug (vedi CLAUDE.md, sezione Test) e chiama:

```bash
docker compose exec backend node -e "
const token = '<TOKEN_GENERATO>';
fetch('http://localhost:8080/api/admin/presence/heartbeat', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
  .then(r => r.status)
  .then(console.log);
fetch('http://localhost:8080/api/admin/presence/online', { headers: { Authorization: 'Bearer ' + token } })
  .then(r => r.json())
  .then(console.log);
"
```

Expected: primo status `200`, secondo output `{ count: 1 }`.

- [ ] **Step 9: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit && docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun errore

- [ ] **Step 10: Eseguire l'intera suite backend (audit costruttore nuovo — vedi CLAUDE.md)**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: stesso failure set noto (1 fallimento pre-esistente `app.controller.spec.ts` `isLdapMock`), nessuna nuova regressione.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/presence/ apps/backend/src/app.module.ts
git commit -m "feat(presence): nuovo PresenceModule per il conteggio operatori online (heartbeat in RAM)"
```

---

### Task 4: Frontend — heartbeat + badge "operatori online"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST /admin/presence/heartbeat`, `GET /admin/presence/online` → `{ count: number }` (Task 3).

- [ ] **Step 1: Aggiungere lo stato `onlineCount`**

Vicino alla dichiarazione di `appVersion`/`backendStatus` (introdotti in una sessione precedente), aggiungi:

```tsx
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
```

- [ ] **Step 2: Aggiungere `fetchOnlineCount` e `fetchRecentActivity` vicino a `fetchDashboardStats`**

Subito dopo la definizione di `fetchDashboardStats` (che chiama `/campaigns/stats/global`), aggiungi:

```tsx
  const fetchOnlineCount = async () => {
    try {
      const res = await apiFetch('/presence/online');
      if (res.ok) {
        const data = await res.json();
        setOnlineCount(data.count);
      }
    } catch {
      // silenzioso: badge informativo, mai stato di errore visibile
    }
  };
```

(Nota: `fetchRecentActivity` verrà aggiunta nel Task 6 — questo step aggiunge solo `fetchOnlineCount`.)

- [ ] **Step 3: Aggiungere l'effetto heartbeat globale**

Subito dopo la definizione di `apiFetch` (la funzione che centralizza le chiamate autenticate), aggiungi:

```tsx
  useEffect(() => {
    if (!token) return;
    const sendHeartbeat = () => {
      apiFetch('/presence/heartbeat', { method: 'POST' }).catch(() => {});
    };
    sendHeartbeat();
    const timer = setInterval(sendHeartbeat, 60000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
```

- [ ] **Step 4: Chiamare `fetchOnlineCount` nell'effetto di ingresso dashboard e nel polling 5s**

Trova l'effetto:

```tsx
  useEffect(() => {
    if (view === 'statistiche' && token) {
      fetchGlobalStats();
    }
    if (view === 'dashboard' && token) {
      fetchDashboardStats();
      fetchEngines();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
```

Sostituisci il blocco `if (view === 'dashboard' ...)` con:

```tsx
    if (view === 'dashboard' && token) {
      fetchDashboardStats();
      fetchEngines();
      fetchOnlineCount();
    }
```

Trova l'effetto di polling 5s della dashboard:

```tsx
  useEffect(() => {
    if (!token || view !== 'dashboard') return;
    const timer = setInterval(() => {
      fetchDashboardStats();
      fetchEngines();
    }, 5000);
    return () => clearInterval(timer);
  }, [token, view]);
```

Sostituisci il corpo del `setInterval` con:

```tsx
    const timer = setInterval(() => {
      fetchDashboardStats();
      fetchEngines();
      fetchOnlineCount();
    }, 5000);
```

- [ ] **Step 5: Sostituire il badge statico "Operativo" nell'header dashboard**

Trova (nella sezione header della dashboard):

```tsx
                          <span className="badge bg-success-subtle text-success border border-success-subtle rounded-pill px-2 py-1 small d-inline-flex align-items-center gap-1">
                            <span className="spinner-grow spinner-grow-sm text-success" style={{ width: '6px', height: '6px' }} /> Operativo
                          </span>
```

Sostituiscilo con:

```tsx
                          <span className="badge bg-success-subtle text-success border border-success-subtle rounded-pill px-2 py-1 small d-inline-flex align-items-center gap-1">
                            <span className="spinner-grow spinner-grow-sm text-success" style={{ width: '6px', height: '6px' }} />
                            {onlineCount !== null
                              ? `${onlineCount} ${onlineCount === 1 ? 'operatore online' : 'operatori online'}`
                              : 'Operativo'}
                          </span>
```

- [ ] **Step 6: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Apri due sessioni admin (es. finestra normale + finestra in incognito), fai login su entrambe, apri la dashboard: verifica che il badge mostri "2 operatori online" entro 60s. Chiudi una sessione: verifica che il conteggio scenda a "1 operatore online" entro ~90s dal suo ultimo heartbeat.

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(dashboard): badge operatori online (heartbeat 60s)"
```

---

### Task 5: Backend — `GET /admin/campaigns/recent-activity`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Create: `apps/backend/src/campaigns/campaigns.service.recent-activity.spec.ts`

**Interfaces:**
- Produces: `CampaignsService.getRecentActivity(): Promise<Array<{ id: string; name: string; channelType: string; status: string; totalRecipients: number; sentCount: number; failedCount: number; lastActivityAt: string }>>`. Endpoint `GET /admin/campaigns/recent-activity`.

- [ ] **Step 1: Scrivere il test fallente per `CampaignsService.getRecentActivity`**

Crea `apps/backend/src/campaigns/campaigns.service.recent-activity.spec.ts` (file dedicato, non la mega-spec esistente — vedi CLAUDE.md sui builder multipli in `campaigns.service.spec.ts`):

```ts
import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignsService } from './campaigns.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { ConfigService } from '@nestjs/config';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { InadService } from '../channels/inad/inad.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { RegistroImpreseService } from '../channels/registro-imprese/registro-imprese.service.js';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';

function makeQb(rawMany: any[]) {
  const qb: any = {};
  ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'limit'].forEach((m) => {
    qb[m] = vi.fn().mockReturnValue(qb);
  });
  qb.getRawMany = vi.fn().mockResolvedValue(rawMany);
  return qb;
}

describe('CampaignsService - getRecentActivity', () => {
  let service: CampaignsService;
  let campaignRepo: any;

  beforeEach(async () => {
    campaignRepo = { createQueryBuilder: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: PostalAuthorizedUsersService, useValue: {} },
        { provide: SignatureVerificationBulkService, useValue: {} },
        { provide: SignatureVerificationService, useValue: {} },
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: InadService, useValue: {} },
        { provide: PostalStatusSyncService, useValue: {} },
        { provide: RegistroImpreseService, useValue: {} },
        { provide: RegistroImpreseVerifyQueueService, useValue: {} },
      ],
    }).compile();

    service = module.get(CampaignsService);
  });

  it('mappa le righe raw convertendo i campi numerici', async () => {
    campaignRepo.createQueryBuilder.mockReturnValue(
      makeQb([
        {
          id: 'c1',
          name: 'Tari 2026',
          channelType: 'PEC',
          status: 'running',
          totalRecipients: '100',
          sentCount: '80',
          failedCount: '5',
          lastActivityAt: '2026-09-15T10:00:00.000Z',
        },
      ]),
    );

    const result = await service.getRecentActivity();

    expect(result).toEqual([
      {
        id: 'c1',
        name: 'Tari 2026',
        channelType: 'PEC',
        status: 'running',
        totalRecipients: 100,
        sentCount: 80,
        failedCount: 5,
        lastActivityAt: '2026-09-15T10:00:00.000Z',
      },
    ]);
  });

  it('ritorna array vuoto se nessuna campagna è attiva o aggiornata di recente', async () => {
    campaignRepo.createQueryBuilder.mockReturnValue(makeQb([]));

    const result = await service.getRecentActivity();

    expect(result).toEqual([]);
  });

  it('applica il filtro isTest, lo stato attivo e il limite 15 alla query', async () => {
    const qb = makeQb([]);
    campaignRepo.createQueryBuilder.mockReturnValue(qb);

    await service.getRecentActivity();

    expect(campaignRepo.createQueryBuilder).toHaveBeenCalledWith('c');
    expect(qb.where).toHaveBeenCalledWith('c.isTest = false');
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('c.status IN (:...activeStatuses)'),
      expect.objectContaining({ activeStatuses: ['queued', 'running'] }),
    );
    expect(qb.limit).toHaveBeenCalledWith(15);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.recent-activity -v`
Expected: FAIL con `service.getRecentActivity is not a function`

- [ ] **Step 3: Implementare `getRecentActivity` in `CampaignsService`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi vicino a `getGlobalStats`:

```ts
  async getRecentActivity(): Promise<Array<{
    id: string;
    name: string;
    channelType: string;
    status: string;
    totalRecipients: number;
    sentCount: number;
    failedCount: number;
    lastActivityAt: string;
  }>> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.campaignRepo
      .createQueryBuilder('c')
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .addSelect('c.channelType', 'channelType')
      .addSelect('c.status', 'status')
      .addSelect('c.totalRecipients', 'totalRecipients')
      .addSelect('c.sentCount', 'sentCount')
      .addSelect('c.failedCount', 'failedCount')
      .addSelect(
        `GREATEST(
          c.updatedAt,
          COALESCE((SELECT MAX(na.send_status_updated_at) FROM notification_attempts na
                      INNER JOIN recipients r ON r.id = na.recipient_id WHERE r.campaign_id = c.id), c.updatedAt),
          COALESCE((SELECT MAX(na.postal_status_updated_at) FROM notification_attempts na
                      INNER JOIN recipients r ON r.id = na.recipient_id WHERE r.campaign_id = c.id), c.updatedAt)
        )`,
        'lastActivityAt',
      )
      .where('c.isTest = false')
      .andWhere(
        `(c.status IN (:...activeStatuses) OR EXISTS (
          SELECT 1 FROM notification_attempts na
          INNER JOIN recipients r ON r.id = na.recipient_id
          WHERE r.campaign_id = c.id
            AND (na.send_status_updated_at >= :since OR na.postal_status_updated_at >= :since)
        ))`,
        { activeStatuses: [CampaignStatus.QUEUED, CampaignStatus.RUNNING], since },
      )
      .orderBy('"lastActivityAt"', 'DESC')
      .limit(15)
      .getRawMany();

    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      channelType: r.channelType,
      status: r.status,
      totalRecipients: Number(r.totalRecipients),
      sentCount: Number(r.sentCount),
      failedCount: Number(r.failedCount),
      lastActivityAt: r.lastActivityAt,
    }));
  }
```

Verifica che `CampaignStatus` sia già importato in cima al file (lo è: usato da altri metodi dello stesso service).

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.recent-activity -v`
Expected: PASS

- [ ] **Step 5: Aggiungere l'endpoint al controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, inserisci **prima** di `@Get(':id')` (fondamentale: un `@Get('recent-activity')` dopo `@Get(':id')` verrebbe intercettato da quest'ultimo come `id === 'recent-activity'`):

```ts
  @Get('recent-activity')
  getRecentActivity() {
    return this.campaignsService.getRecentActivity();
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CampaignWithOwnerDisplay> {
```

- [ ] **Step 6: Verifica manuale contro il DB reale**

```bash
docker compose up -d --build backend
```

Con il token JWT di debug (vedi CLAUDE.md):

```bash
docker compose exec backend node -e "
const token = '<TOKEN_GENERATO>';
fetch('http://localhost:8080/api/admin/campaigns/recent-activity', { headers: { Authorization: 'Bearer ' + token } })
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d, null, 2)));
"
```

Expected: array di campagne (max 15), ordinate per `lastActivityAt` decrescente, nessuna con `status` terminale più vecchia di 7gg senza aggiornamenti recenti.

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit && docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun errore

- [ ] **Step 8: Eseguire l'intera suite backend**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: stesso failure set noto (1 fallimento pre-esistente), nessuna nuova regressione — verifica in particolare che l'inserimento della nuova rotta prima di `:id` non abbia rotto `campaigns.controller.spec.ts` (se esiste un test su `findOne`/route matching).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.recent-activity.spec.ts
git commit -m "feat(campaigns): endpoint GET recent-activity, campagne attive o aggiornate negli ultimi 7gg"
```

---

### Task 6: Frontend — widget "Campagne recenti" sostituisce "Attività Recenti"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET /admin/campaigns/recent-activity` → array di `{ id, name, channelType, status, totalRecipients, sentCount, failedCount, lastActivityAt }` (Task 5).

- [ ] **Step 1: Aggiungere lo stato per l'elenco**

Vicino a `onlineCount` (aggiunto nel Task 4), aggiungi:

```tsx
  const [recentActivityCampaigns, setRecentActivityCampaigns] = useState<any[]>([]);
  const [recentActivityLoading, setRecentActivityLoading] = useState(false);
  const [recentActivityError, setRecentActivityError] = useState<string | null>(null);
```

- [ ] **Step 2: Aggiungere `fetchRecentActivity` vicino a `fetchOnlineCount`**

```tsx
  const fetchRecentActivity = async () => {
    setRecentActivityLoading(true);
    setRecentActivityError(null);
    try {
      const res = await apiFetch('/campaigns/recent-activity');
      if (!res.ok) throw new Error('Impossibile caricare le campagne recenti.');
      setRecentActivityCampaigns(await res.json());
    } catch (err) {
      if (!(err instanceof ApiAuthError)) setRecentActivityError('Impossibile caricare le campagne recenti.');
    } finally {
      setRecentActivityLoading(false);
    }
  };
```

- [ ] **Step 3: Chiamare `fetchRecentActivity` nell'effetto di ingresso dashboard e nel polling 5s**

Nell'effetto di ingresso dashboard (già modificato nel Task 4):

```tsx
    if (view === 'dashboard' && token) {
      fetchDashboardStats();
      fetchEngines();
      fetchOnlineCount();
      fetchRecentActivity();
    }
```

Nel polling 5s (già modificato nel Task 4):

```tsx
    const timer = setInterval(() => {
      fetchDashboardStats();
      fetchEngines();
      fetchOnlineCount();
      fetchRecentActivity();
    }, 5000);
```

- [ ] **Step 4: Sostituire il blocco "Attività Recenti"**

Trova il blocco (card con `<History className="me-2 text-primary" />Attività Recenti`):

```tsx
              <div className="row g-3">
                <div className="col-lg-8">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h3 className="h6 mb-0 fw-bold text-dark"><History className="me-2 text-primary" />Attività Recenti</h3>
                      <div className="d-flex align-items-center gap-2">
                        <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchCampaigns}><RefreshCw /></button>
                        <button className="btn btn-link btn-sm" onClick={() => setView('invio-massivo')}>Vedi tutte</button>
                      </div>
                    </div>
                    <div className="card-body p-0">
                      {campaigns.length === 0 ? (
                        <div className="text-center py-5 text-muted">Nessuna attività registrata.</div>
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-hover align-middle mb-0" style={{ fontSize: '0.84rem' }}>
                            <thead className="table-light">
                              <tr>
                                <th>Nome Campagna</th>
                                <th>Canale</th>
                                <th>Stato</th>
                                <th className="text-end">Successi</th>
                              </tr>
                            </thead>
                            <tbody>
                              {campaigns.filter(c => !c.isTest).slice(0, 5).map((c) => (
                                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                                  <td className="fw-bold text-primary">{c.name}</td>
                                  <td><ChannelBadge channel={c.channelType} /></td>
                                  <td><StatusBadge status={c.status} /></td>
                                  <td className="text-end fw-bold">{c.sentCount} / {c.totalRecipients}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
```

Sostituiscilo con:

```tsx
              <div className="row g-3">
                <div className="col-lg-8">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h3 className="h6 mb-0 fw-bold text-dark"><History className="me-2 text-primary" />Campagne recenti</h3>
                      <div className="d-flex align-items-center gap-2">
                        <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchRecentActivity}><RefreshCw /></button>
                        <button className="btn btn-link btn-sm" onClick={() => setView('invio-massivo')}>Vedi tutte</button>
                      </div>
                    </div>
                    <div className="card-body p-0">
                      {recentActivityError ? (
                        <div className="text-center py-5 text-danger small">
                          {recentActivityError}
                          <div className="mt-2">
                            <button className="btn btn-sm btn-outline-secondary" onClick={fetchRecentActivity}>Riprova</button>
                          </div>
                        </div>
                      ) : recentActivityLoading && recentActivityCampaigns.length === 0 ? (
                        <div className="text-center py-5 text-muted"><Loader2 className="icon-spin" size={20} /></div>
                      ) : recentActivityCampaigns.length === 0 ? (
                        <div className="text-center py-5 text-muted">Nessuna campagna attiva o aggiornata negli ultimi 7 giorni.</div>
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-hover align-middle mb-0" style={{ fontSize: '0.84rem' }}>
                            <thead className="table-light">
                              <tr>
                                <th>Nome Campagna</th>
                                <th>Canale</th>
                                <th>Stato</th>
                                <th className="text-end">Successi</th>
                                <th>Ultimo aggiornamento</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentActivityCampaigns.map((c) => (
                                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                                  <td className="fw-bold text-primary">{c.name}</td>
                                  <td><ChannelBadge channel={c.channelType} /></td>
                                  <td><StatusBadge status={c.status} /></td>
                                  <td className="text-end fw-bold">{c.sentCount} / {c.totalRecipients}</td>
                                  <td className="text-muted small">{new Date(c.lastActivityAt).toLocaleString('it-IT')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
```

Nota: il resto della card (chiusura tag) resta invariato — modifica solo fino alla chiusura del `table-responsive`/ternario mostrato sopra.

- [ ] **Step 5: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Apri la dashboard: verifica che la card "Campagne recenti" mostri la nuova colonna "Ultimo aggiornamento", che una campagna con status terminale ma senza attività negli ultimi 7gg NON compaia più, e che una campagna `queued`/`running` compaia sempre anche se creata da tempo. Verifica lo stato vuoto e — scollegando temporaneamente la rete in devtools — lo stato di errore con bottone "Riprova".

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(dashboard): sostituisce Attività Recenti con Campagne recenti (attività reale, non creazione)"
```

---

## Self-Review

**Copertura spec:**
- Finestra 7gg alert motori → Task 1 (backend `lastFailedAt`) + Task 2 (frontend filtro). ✓
- Widget Arricchimento → Task 1 (entry `ENRICHMENT` in `GET /admin/engines`) + Task 2 (label, conteggio "Stato Connettori" automatico perché legge `engines.length`). ✓
- Utenti online (heartbeat) → Task 3 (backend) + Task 4 (frontend). ✓
- Campagne recenti basate su attività reale, sostituisce "Attività Recenti" → Task 5 (backend) + Task 6 (frontend). ✓
- Error handling per ogni fetch (silenzioso per heartbeat/online, fail-open per engines, retry esplicito per recent-activity) → coperto nei rispettivi task. ✓
- Route `recent-activity` prima di `:id` per evitare collisione → Task 5 Step 5, esplicitamente motivato. ✓

**Scansione placeholder:** nessun TBD/TODO residuo, tutti gli step hanno codice completo.

**Coerenza tipi:** `lastFailedAt: string | null` usato identicamente in Task 1 (backend) e Task 2 (frontend, confronto `new Date(e.lastFailedAt).getTime()`). `getRecentActivity()` ritorna esattamente i campi consumati da Task 6 (`id, name, channelType, status, totalRecipients, sentCount, failedCount, lastActivityAt`) — nessun campo extra o mancante tra produttore e consumatore.
