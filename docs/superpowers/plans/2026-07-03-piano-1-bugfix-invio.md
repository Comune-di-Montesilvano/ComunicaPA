# Piano 1 — Bugfix invio (SMTP/PEC/App IO) e log motori

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sistemare i bug segnalati sul flusso di invio (form SMTP/PEC che condividono stato, errore JSON in modifica config, log mancante sui motori BullMQ, canale App IO rotto/non sicuro) e chiudere il caso "associazione notifiche portale cittadino".

**Architecture:** Backend NestJS + TypeORM (Postgres), frontend React monolitico (`App.tsx`, niente componenti separati per queste sezioni). L'intervento più grosso è una nuova entity `IoServiceConfig` (stesso pattern di `MailServerConfig`) perché oggi i "servizi App IO" e le loro API key vivono SOLO in `localStorage` del browser — nessuna persistenza server-side, nessuna cifratura del secret, chiave API inviata in chiaro nel `channelConfig` della campagna.

**Tech Stack:** NestJS 10, TypeORM, class-validator, BullMQ, React 19 (no build tool per test frontend — verifica manuale in browser via Docker, non esiste suite di test per `apps/frontend-admin`).

## Global Constraints

- Ogni comando gira in Docker (`docker compose exec backend ...`), mai Node/pnpm sull'host — vedi CLAUDE.md.
- Test backend SEMPRE con `--maxWorkers=2`.
- Baseline nota: 7 test falliscono già prima di questo piano (email.strategy, pec.strategy, notification.processor). Il criterio per ogni task è "failure set identico o migliorato", non zero-fail.
- Dopo modifica a un'entity: generare la migration con il DB temporaneo `migration_gen` (procedura in CLAUDE.md), MAI affidarsi a `synchronize` per il changeset che finirà in produzione.
- Nessuna suite di test automatici esiste per `apps/frontend-admin`: ogni task frontend termina con verifica manuale in browser (build-in Docker + click reali), non con `npm test`.
- Non toccare `apps/backend/src/mail-configs/**` per la logica di invio PEC/Email: è verificata corretta in questo piano (vedi Task 3), non va "sistemata" di nuovo.

---

### Task 1: Fix stato condiviso tra form SMTP e PEC

**Contesto:** in Impostazioni → Mail Server (SMTP) / PEC Server, aprendo "Modifica" (o "Nuovo") su un tab e poi cliccando l'altro tab, il form resta aperto con gli stessi dati ma cambia etichetta. Causa: un solo state `editingMailConfig` (App.tsx:240) condiviso da `renderMailConfigTab('EMAIL')` e `renderMailConfigTab('PEC')` (chiamate a riga ~3800/3803), il click sui tab (righe 3226-3239) non lo resetta mai.

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:3226-3239` (handler click tab `smtp`/`pec`)
- Modify: `apps/frontend-admin/src/App.tsx:962,1086` (guardia extra difensiva nel form)

**Interfaces:**
- Consume: `activeSettingsTab` (state esistente, valori `'smtp' | 'pec' | ...`), `editingMailConfig` (state esistente, `(Partial<MailConfigItem> & { type: 'EMAIL'|'PEC' }) | null`), `setEditingMailConfig`.
- Produce: nessuna nuova interfaccia — comportamento: `editingMailConfig` sempre `null` quando si cambia tab impostazioni.

- [ ] **Step 1: Reset esplicito di `editingMailConfig` al cambio tab**

In `apps/frontend-admin/src/App.tsx`, sostituire i due handler dei tab SMTP e PEC:

```tsx
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'smtp' ? 'active' : ''}`}
                      onClick={() => { setEditingMailConfig(null); setActiveSettingsTab('smtp'); }}
                    >
                      <i className="fas fa-envelope me-2"></i>Mail Server (SMTP)
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'pec' ? 'active' : ''}`}
                      onClick={() => { setEditingMailConfig(null); setActiveSettingsTab('pec'); }}
                    >
                      <i className="fas fa-envelope-open-text me-2"></i>PEC Server
                    </button>
```

Questo copre anche il caso "Nuovo Server" lasciato aperto: cambiare tab lo chiude sempre.

- [ ] **Step 2: Guardia difensiva in `renderMailConfigTab`**

Anche con il reset al click, ogni altro punto che in futuro cambiasse `activeSettingsTab` senza passare da quei due handler (es. un link diretto, o un redirect da un altro flusso) lascerebbe lo stesso bug latente. Aggiungere un controllo di coerenza tipo/tab dentro `renderMailConfigTab` stessa, in `apps/frontend-admin/src/App.tsx:949`:

```tsx
  const renderMailConfigTab = (type: 'EMAIL' | 'PEC') => {
    const list = mailConfigs.filter((c) => c.type === type);
    const label = type === 'EMAIL' ? 'SMTP' : 'PEC';
    const editing = editingMailConfig && editingMailConfig.type === type ? editingMailConfig : null;

    return (
      <div className="d-flex flex-column gap-4">
```

Poi sostituire, nello stesso blocco, ogni occorrenza di `editingMailConfig` con `editing` SOLO all'interno di `renderMailConfigTab` (righe 962, 971 `{ ...EMPTY_MAIL_CONFIG, type }` resta invariato, 1086-1233 leggono/scrivono lo stato — mantenerle su `setEditingMailConfig` per la scrittura, ma la condizione di apertura form e i `value={}` letti da `editing` invece di `editingMailConfig`):

```tsx
        {!editing && (
          <div>
```
```tsx
        {editing && (
          <form onSubmit={handleSaveMailConfig} className="border rounded bg-white p-4 shadow-sm">
            <h5 className="text-dark fw-bold mb-4">
              {editing.id ? `Modifica Server ${label}` : `Nuovo Server ${label}`}
            </h5>
```

E per ogni `value={editingMailConfig.XXX || ...}` dentro il form (righe 1100-1214), sostituire `editingMailConfig` con `editing` mantenendo `onChange` che scrive su `setEditingMailConfig({ ...editing, XXX: ... })` (non più `...editingMailConfig`, per evitare di riportare in vita campi del tipo sbagliato se mai capitasse).

- [ ] **Step 3: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Aprire http://localhost:3000, login admin/admin (richiede `LDAP_HOST=mock` in `.env`), andare in Impostazioni → Mail Server (SMTP) → "Modifica" su un server esistente (o "Nuovo Server SMTP" se lista vuota) → senza salvare, cliccare tab "PEC Server". Atteso: form si chiude, tab PEC mostra la lista PEC pulita, non il form aperto con dati SMTP.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend): reset form condiviso SMTP/PEC al cambio tab impostazioni"
```

---

### Task 2: Diagnosi errore "Unexpected token '<'" in modifica server SMTP/PEC

**Contesto:** l'agent di ricerca ha verificato che `handleSaveMailConfig` (App.tsx:826-870) chiama `PUT ${API_BASE}/mail-configs/${id}`, che combacia esattamente con `MailConfigsController.update` (`apps/backend/src/mail-configs/mail-configs.controller.ts:41-45`). Path e metodo sono corretti: l'errore "Unexpected token '<', \"<!DOCTYPE\"... is not valid JSON" indica che il fetch ha ricevuto una pagina HTML (fallback SPA di nginx, o pagina di errore) invece di JSON — il sospetto principale è che fosse un sintomo del bug del Task 1 (form che invia `id` di una config del tipo sbagliato/stale). Questo task NON scrive un fix per un'ipotesi non confermata: verifica prima, poi decide.

**Files:**
- Nessuna modifica di codice pianificata a priori.
- Se riprodotto: file coinvolto sarà `apps/frontend-admin/src/App.tsx` (funzione `handleSaveMailConfig`, righe 826-870) o config nginx (`apps/frontend-admin/nginx/` prod) a seconda della causa reale.

**Interfaces:** nessuna — task diagnostico.

- [ ] **Step 1: Riprodurre DOPO il fix del Task 1**

Con Task 1 già applicato, in browser (DevTools → Network aperto) ripetere lo scenario originale: Impostazioni → PEC Server → Modifica su un server esistente → cambiare un campo → Salva.

- [ ] **Step 2a: Se l'errore NON si ripresenta**

Era un sintomo del bug del Task 1 (id/type stale). Chiudere il task, annotare nel commit di questo task che è stato "verificato assente dopo Task 1", nessun altro codice da toccare.

```bash
git commit --allow-empty -m "chore: verificato che errore JSON in edit mail-config non si riproduce dopo fix Task 1"
```

- [ ] **Step 2b: Se l'errore SI ripresenta**

Nel tab Network del browser, cliccare sulla richiesta PUT fallita e leggere:
1. L'URL effettivo chiamato (deve iniziare per `http://localhost:8080/mail-configs/...` in dev, oppure `/api/mail-configs/...` in prod dietro nginx).
2. Lo status HTTP della risposta.
3. Il primo blocco di Response body (deve iniziare con `<!DOCTYPE`).

Se l'URL è malformato (es. `undefined` al posto dell'id, o manca `API_BASE`), il fix è in `apps/frontend-admin/src/App.tsx` — la funzione `handleSaveMailConfig` deve validare `editingMailConfig.id` prima di costruire l'URL. Se l'URL è corretto ma risponde 404/500 con HTML, il problema è nel proxy nginx di produzione (fuori scope dev) — annotare come issue separata, non tentare un fix speculativo in questo piano.

- [ ] **Step 3: Commit (solo se è stato applicato un fix concreto nello step 2b)**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend): valida id config prima di costruire URL PUT mail-configs"
```

---

### Task 3: Verifica mittente PEC dopo Task 1 (niente fix di codice)

**Contesto:** ricerca nel codice ha ESCLUSO l'ipotesi "mittente calcolato come server@username": `apps/backend/src/channels/pec/pec.strategy.ts:66` e `email.strategy.ts:66` usano sempre `smtp.fromAddress`/`config.channelConfig['from']`, mai concatenazioni con host/username. Nessuna occorrenza della stringa `server@mittente` in tutto `apps/frontend-admin/src`. L'ipotesi più probabile, vista la scoperta del Task 1, è che il valore "server@mittente" visto dall'utente fosse il `fromAddress` della config SMTP che era rimasta aperta nel form (bug Task 1) mentre credeva di guardare la config PEC.

**Files:** nessuna modifica di codice pianificata a priori.

**Interfaces:** nessuna — task diagnostico.

- [ ] **Step 1: Ispezionare il valore reale in DB, dopo il fix del Task 1**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "SELECT id, type, name, from_address, host, username FROM mail_server_configs ORDER BY type, name;"
```

- [ ] **Step 2a: Se il `from_address` della config PEC "Tributi PEC" è già corretto (es. `tributi@comune.it`)**

Confermato: era un artefatto del bug Task 1. Nessun'altra azione.

- [ ] **Step 2b: Se il `from_address` della config PEC è letteralmente sbagliato/segnaposto**

È un dato di configurazione da correggere da UI (Impostazioni → PEC Server → Modifica → campo "Mittente"), non un bug di codice. Aggiungere una validazione HTML lato form per prevenire valori palesemente segnaposto: in `apps/frontend-admin/src/App.tsx`, nell'input "Mittente (From Address)" (riga ~1107-1114), il campo è già `type="email" required` — sufficiente, nessuna modifica di codice necessaria oltre l'aggiornamento del dato.

- [ ] **Step 3: Timeout sul test PEC — aggiungere connectionTimeout esplicito**

Il log `Test PEC "Tributi PEC" fallito: Connection timeout` è un problema di rete/config (host/porta/firewall verso il server PEC reale), non di codice — ma il messaggio di errore attuale è generico. Migliorare la diagnosticabilità in `apps/backend/src/mail-configs/mail-configs.service.ts:156-164`:

```ts
    const transporter = nodemailer.createTransport({
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      auth: entity.authEnabled && entity.username
        ? { user: entity.username, pass: this.decryptPassword(entity) }
        : undefined,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
```

Questo fa fallire il test in 10s invece di attendere il timeout TCP di sistema (spesso 60-120s), rendendo più chiaro all'operatore che è un problema di raggiungibilità del server PEC configurato.

- [ ] **Step 4: Verifica**

```bash
docker compose exec backend node_modules/.bin/jest mail-configs --maxWorkers=2
```
Atteso: stesso set di test già passanti prima (nessuna regressione), nessun nuovo test richiesto per un timeout esplicito su una option di libreria.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/mail-configs/mail-configs.service.ts
git commit -m "fix(backend): timeout esplicito 10s su test connessione SMTP/PEC per errore più chiaro"
```

---

### Task 4: Log job nei "Motori di Invio"

**Contesto:** il tab "Motori di Invio" (introdotto da commit `f64584d`) mostra solo contatori aggregati (`waiting/active/completed/failed/delayed`) via `GET /engines` (`apps/backend/src/engines/engines.controller.ts:11-29`). Manca la possibilità di vedere QUALI job sono falliti e perché.

**Files:**
- Modify: `apps/backend/src/engines/engines.controller.ts`
- Modify: `apps/backend/src/queue/notification-queues.service.ts`
- Test: `apps/backend/src/engines/engines.controller.spec.ts` (nuovo)
- Modify: `apps/frontend-admin/src/App.tsx` (sezione tab motori, righe ~3806-3890)

**Interfaces:**
- Consuma: `NotificationQueuesService.getQueue(channel)` (esistente, righe 27-31 di `notification-queues.service.ts`), tipo `NotificationChannel` da `@comunicapa/shared-types`.
- Produce: `NotificationQueuesService.getJobsDetail(channel, status, limit)` → `Promise<EngineJobDetail[]>`; nuovo endpoint `GET /engines/:channel/jobs?status=failed&limit=50`.

- [ ] **Step 1: Scrivere il test del nuovo metodo `getJobsDetail`**

Creare `apps/backend/src/queue/notification-queues.service.spec.ts` (se non esiste, altrimenti aggiungere un blocco `describe`):

```ts
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { NotificationQueuesService } from './notification-queues.service';
import { CHANNEL_QUEUES } from './notification-job.types';

describe('NotificationQueuesService.getJobsDetail', () => {
  const mockJob = {
    id: 'job-1',
    data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'a1', channel: 'EMAIL' },
    failedReason: 'SMTP timeout',
    attemptsMade: 3,
    timestamp: 1700000000000,
    finishedOn: 1700000005000,
  };

  it('ritorna i job nello stato richiesto con dati normalizzati', async () => {
    const getJobs = jest.fn().mockResolvedValue([mockJob]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationQueuesService,
        { provide: getQueueToken(CHANNEL_QUEUES.EMAIL), useValue: { getJobs } },
        { provide: getQueueToken(CHANNEL_QUEUES.PEC), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.APP_IO), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.SEND), useValue: {} },
        { provide: getQueueToken(CHANNEL_QUEUES.POSTAL), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(NotificationQueuesService);
    const result = await service.getJobsDetail('EMAIL', 'failed', 50);

    expect(getJobs).toHaveBeenCalledWith(['failed'], 0, 49);
    expect(result).toEqual([
      {
        jobId: 'job-1',
        campaignId: 'c1',
        recipientId: 'r1',
        attemptId: 'a1',
        failedReason: 'SMTP timeout',
        attemptsMade: 3,
        timestamp: 1700000000000,
        finishedOn: 1700000005000,
      },
    ]);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest notification-queues.service --maxWorkers=2
```
Atteso: FAIL con `getJobsDetail is not a function`.

- [ ] **Step 3: Implementare `getJobsDetail` in `NotificationQueuesService`**

In `apps/backend/src/queue/notification-queues.service.ts`, aggiungere dopo `resume`:

```ts
  async getJobsDetail(
    channel: NotificationChannel,
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
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest notification-queues.service --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 5: Nuovo endpoint controller**

In `apps/backend/src/engines/engines.controller.ts`, aggiungere import `Query` e il nuovo metodo:

```ts
import { Controller, Get, Post, Param, Query, HttpStatus, HttpCode, BadRequestException } from '@nestjs/common';
```

```ts
  @Get(':channel/jobs')
  @Roles('admin', 'user')
  async jobs(
    @Param('channel') channel: string,
    @Query('status') status = 'failed',
    @Query('limit') limit = '50',
  ) {
    const uc = channel.toUpperCase() as NotificationChannel;
    if (!ALL_CHANNELS.includes(uc)) {
      throw new BadRequestException(`Canale ${channel} non supportato`);
    }
    const allowedStatuses = ['failed', 'completed', 'active', 'waiting', 'delayed'] as const;
    if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
      throw new BadRequestException(`Status ${status} non supportato`);
    }
    const parsedLimit = parseInt(limit, 10);
    const jobs = await this.queues.getJobsDetail(
      uc,
      status as (typeof allowedStatuses)[number],
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    );
    return { channel: uc, status, jobs };
  }
```

- [ ] **Step 6: Test controller**

Creare `apps/backend/src/engines/engines.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EnginesController } from './engines.controller';
import { NotificationQueuesService } from '../queue/notification-queues.service';

describe('EnginesController.jobs', () => {
  const queuesMock = {
    getJobsDetail: jest.fn().mockResolvedValue([{ jobId: 'j1' }]),
  };

  let controller: EnginesController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [{ provide: NotificationQueuesService, useValue: queuesMock }],
    }).compile();
    controller = moduleRef.get(EnginesController);
  });

  it('ritorna i job del canale richiesto', async () => {
    const result = await controller.jobs('email', 'failed', '10');
    expect(queuesMock.getJobsDetail).toHaveBeenCalledWith('EMAIL', 'failed', 10);
    expect(result).toEqual({ channel: 'EMAIL', status: 'failed', jobs: [{ jobId: 'j1' }] });
  });

  it('rifiuta un canale sconosciuto', async () => {
    await expect(controller.jobs('fax', 'failed', '10')).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

```bash
docker compose exec backend node_modules/.bin/jest engines.controller --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 7: UI — tabella job nel tab Motori di Invio**

In `apps/frontend-admin/src/App.tsx`, individuare il blocco del tab motori (introdotto da `f64584d`, contatori aggregati) e aggiungere, per ciascun canale, un pulsante "Vedi job falliti" che apre una tabella sotto i contatori esistenti. Aggiungere lo state e il fetch accanto agli altri state dei motori:

```tsx
  const [engineJobsChannel, setEngineJobsChannel] = useState<string | null>(null);
  const [engineJobs, setEngineJobs] = useState<Array<{ jobId: string; campaignId: string; recipientId: string; failedReason?: string; attemptsMade: number }>>([]);

  const handleViewEngineJobs = async (channel: string) => {
    setEngineJobsChannel(channel);
    const res = await fetch(`${API_BASE}/engines/${channel.toLowerCase()}/jobs?status=failed&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setEngineJobs(data.jobs || []);
  };
```

E nel render, accanto ai contatori di ogni motore, aggiungere il pulsante e la tabella condizionale:

```tsx
<button className="btn btn-sm btn-outline-secondary" onClick={() => handleViewEngineJobs(engine.channel)}>
  <i className="fas fa-list me-1"></i>Vedi job falliti
</button>
{engineJobsChannel === engine.channel && (
  <table className="table table-sm mt-2">
    <thead><tr><th>Job</th><th>Campagna</th><th>Destinatario</th><th>Tentativi</th><th>Motivo</th></tr></thead>
    <tbody>
      {engineJobs.map(j => (
        <tr key={j.jobId}>
          <td className="font-monospace small">{j.jobId}</td>
          <td className="font-monospace small">{j.campaignId}</td>
          <td className="font-monospace small">{j.recipientId}</td>
          <td>{j.attemptsMade}</td>
          <td className="small text-danger">{j.failedReason || '—'}</td>
        </tr>
      ))}
      {engineJobs.length === 0 && <tr><td colSpan={5} className="text-center text-muted">Nessun job fallito</td></tr>}
    </tbody>
  </table>
)}
```

- [ ] **Step 8: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
In Impostazioni → Motori di Invio, cliccare "Vedi job falliti" su un canale con job falliti presenti (o lanciare una campagna con un mail server rotto per generarne uno) e verificare che la tabella mostri i dati.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/engines apps/backend/src/queue apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): log job falliti nel tab Motori di Invio"
```

---

### Task 5: URL App IO hardcoded (rimozione dalla configurabilità)

**Contesto:** l'utente ha chiesto esplicitamente di hardcodare l'URL API IO (non di correggere solo il default): oggi `appIo.baseUrl` è una setting configurabile da env/UI con default sbagliato `https://api.io.italia.it` (dominio legacy) in `apps/backend/src/settings/settings.registry.ts:36`, letta a runtime in `apps/backend/src/channels/app-io/app-io.strategy.ts:20`. L'URL ufficiale corrente è `https://api.io.pagopa.it`. Rimuoviamo la setting e mettiamo la costante nel codice.

**Files:**
- Modify: `apps/backend/src/channels/app-io/app-io.strategy.ts`
- Modify: `apps/backend/src/settings/settings.registry.ts:36` (rimuovere `appIo.baseUrl`)
- Modify: `apps/frontend-admin/src/App.tsx` (rimuovere campo URL App IO dalle Impostazioni, righe che usano `settIoUrl`/`setSettIoUrl`)
- Test: `apps/backend/src/channels/app-io/app-io.strategy.spec.ts`

**Interfaces:**
- Produce: costante esportata `APP_IO_BASE_URL = 'https://api.io.pagopa.it'` da `apps/backend/src/channels/app-io/app-io.strategy.ts`.
- Consuma: nessuna dipendenza da `AppSettingsService` per l'URL (resta solo per l'API key finché il Task 6 non la sposta sull'entity `IoServiceConfig`).

- [ ] **Step 1: Scrivere/aggiornare il test che verifica l'URL hardcoded**

Se `apps/backend/src/channels/app-io/app-io.strategy.spec.ts` non esiste, crearlo:

```ts
import { Test } from '@nestjs/testing';
import { AppIoStrategy } from './app-io.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { Campaign } from '../../entities/campaign.entity';
import type { Recipient } from '../../entities/recipient.entity';

describe('AppIoStrategy', () => {
  const settingsMock = { get: jest.fn().mockResolvedValue('test-api-key') };
  let strategy: AppIoStrategy;

  beforeEach(async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg-1' }),
    }) as unknown as typeof fetch;

    const moduleRef = await Test.createTestingModule({
      providers: [AppIoStrategy, { provide: AppSettingsService, useValue: settingsMock }],
    }).compile();
    strategy = moduleRef.get(AppIoStrategy);
  });

  it('chiama sempre https://api.io.pagopa.it, mai un URL configurabile', async () => {
    const recipient = { fullName: 'Mario Rossi', codiceFiscale: 'RSSMRA80A01H501X' } as Recipient;
    const campaign = { name: 'Test', channelConfig: { subject: 'Oggetto', body: 'Corpo' } } as Campaign;

    await strategy.send(recipient, campaign);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.io.pagopa.it/api/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest app-io.strategy --maxWorkers=2
```
Atteso: FAIL (oggi chiama `api.io.italia.it` da settings, non l'URL atteso).

- [ ] **Step 3: Hardcodare l'URL nella strategy**

Sostituire `apps/backend/src/channels/app-io/app-io.strategy.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';

/** Endpoint ufficiale App IO (PagoPA). Non configurabile: cambia solo con una nuova release. */
export const APP_IO_BASE_URL = 'https://api.io.pagopa.it';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(private readonly settings: AppSettingsService) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const apiKey = await this.settings.get<string>('appIo.apiKey');

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const cfg = campaign.channelConfig as Record<string, string>;
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const markdown = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
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

(Nota: `apiKey` resta da `AppSettingsService` per ora — il Task 6 lo sposta su `IoServiceConfig` per servizio. Non anticipare quel cambio qui.)

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest app-io.strategy --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 5: Rimuovere `appIo.baseUrl` dalla registry**

In `apps/backend/src/settings/settings.registry.ts:36`, eliminare la riga:

```ts
  'appIo.baseUrl': { env: 'APP_IO_BASE_URL', type: 'string', default: 'https://api.io.italia.it' },
```

- [ ] **Step 6: Rimuovere il campo URL dalla UI Impostazioni**

In `apps/frontend-admin/src/App.tsx`, rimuovere lo state `settIoUrl`/`setSettIoUrl` (riga 247) e il relativo input nel form Impostazioni → App IO, e tutte le letture `baseUrl: settIoUrl` nei costruttori di `channelConfig` (righe 482, 523, 537, 575, 589) — questi campi diventano inutili lato client dato che il backend non li legge più (rimarranno come dati morti nel jsonb finché il Task 6 non ripulisce la struttura di `channelConfig` per App IO).

Per questo task, il minimo che rimuove la fonte di confusione in UI:

```tsx
  // RIMOSSA: const [settIoUrl, setSettIoUrl] = useState('https://api.io.italia.it');
```

e nel form Impostazioni → App IO, rimuovere l'eventuale `<input>` legato a `settIoUrl` (se presente nel blocco `activeSettingsTab === 'app-io'`).

- [ ] **Step 7: Type-check backend e frontend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Atteso: nessun nuovo errore (occhio ai riferimenti residui a `settIoUrl` da ripulire finché tsc non segnala più nulla).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/channels/app-io apps/backend/src/settings/settings.registry.ts apps/frontend-admin/src/App.tsx
git commit -m "fix(backend): hardcode url ufficiale App IO (api.io.pagopa.it), rimossa configurabilita"
```

---

### Task 6: Entity `IoServiceConfig` persistita (sostituisce il localStorage)

**Contesto:** i "servizi App IO" (nome, id_service, api key primaria/secondaria, codice catalogo, default) vivono SOLO in `localStorage` del browser (`apps/frontend-admin/src/App.tsx:94-115` `DEFAULT_IO_SERVICES`, righe 248-251 lettura, righe 664/684/699/706 scrittura). Nessuna entity/migration backend. Conseguenze concrete: (1) "non posso modificare una configurazione già fatta" — non esiste un bottone Modifica, solo Elimina/Imposta predefinito; (2) l'API key viene spedita in chiaro al browser e salvata in chiaro dentro `campaign.channelConfig` (jsonb) — un secret esposto lato client e persistito senza cifratura; (3) `app-io.strategy.ts` legge SEMPRE la singola `appIo.apiKey` globale dai settings, ignorando quale servizio è stato scelto per la campagna — se ci sono più servizi con chiavi diverse, l'invio parte sempre con la chiave sbagliata (spiega "i log dicono OK ma non arriva nulla": la chiamata HTTP riesce ma autentica il servizio/fiscal-code sbagliato). Questo task introduce l'entity lato server, modellata 1:1 su `MailServerConfig` (`apps/backend/src/entities/mail-server-config.entity.ts`), con CRUD + cifratura della API key.

**Files:**
- Create: `apps/backend/src/entities/io-service-config.entity.ts`
- Create: `apps/backend/src/io-services/io-services.module.ts`
- Create: `apps/backend/src/io-services/io-services.service.ts`
- Create: `apps/backend/src/io-services/io-services.controller.ts`
- Create: `apps/backend/src/io-services/dto/io-service.dto.ts`
- Create: `apps/backend/src/io-services/io-services.service.spec.ts`
- Modify: `apps/backend/src/database/database.module.ts` (registrare entity + nuova migration)
- Modify: `apps/backend/src/app.module.ts` (importare `IoServicesModule`)
- Modify: `apps/backend/src/channels/app-io/app-io.strategy.ts` (risolvere apiKey per servizio invece che globale)
- Modify: `apps/frontend-admin/src/App.tsx` (sostituire CRUD localStorage con chiamate API)

**Interfaces:**
- Produce: `IoServiceConfig` entity (`id, nome, idService, descrizione, apiKeyPrimariaEnc, apiKeySecondariaEnc, codiceCatalogo, isDefault, testedAt, createdAt, updatedAt`).
- Produce: `IoServicesService.listMasked(): Promise<IoServiceMaskedDto[]>`, `.create(dto)`, `.update(id, dto)`, `.remove(id)`, `.setDefault(id)`, `.test(id, codiceFiscale): Promise<{success:true; message:string}>`, `.resolveApiKey(idOrDefault?: string): Promise<{apiKey:string; idService:string} | null>`.
- Consuma (in `app-io.strategy.ts`): `IoServicesService.resolveApiKey(campaign.channelConfig['ioServiceId'] as string | undefined)`.

- [ ] **Step 1: Entity**

```ts
// apps/backend/src/entities/io-service-config.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('io_service_configs')
export class IoServiceConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  nome!: string;

  @Column({ name: 'id_service', type: 'varchar', length: 64 })
  idService!: string;

  @Column({ type: 'text', default: '' })
  descrizione!: string;

  /** Cifrata AES-256-GCM, stessa chiave derivata dei settings/mail-configs. */
  @Column({ name: 'api_key_primaria_enc', type: 'text', default: '' })
  apiKeyPrimariaEnc!: string;

  @Column({ name: 'api_key_secondaria_enc', type: 'text', default: '' })
  apiKeySecondariaEnc!: string;

  @Column({ name: 'codice_catalogo', type: 'varchar', length: 32, default: '' })
  codiceCatalogo!: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ name: 'tested_at', type: 'timestamptz', nullable: true })
  testedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
```

- [ ] **Step 2: DTO**

```ts
// apps/backend/src/io-services/dto/io-service.dto.ts
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateIoServiceDto {
  @IsString() @MinLength(1) @MaxLength(128)
  nome!: string;

  @IsString() @MinLength(1) @MaxLength(64)
  idService!: string;

  @IsOptional() @IsString()
  descrizione?: string;

  @IsString() @MinLength(1)
  apiKeyPrimaria!: string;

  @IsOptional() @IsString()
  apiKeySecondaria?: string;

  @IsOptional() @IsString() @MaxLength(32)
  codiceCatalogo?: string;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;
}

export class UpdateIoServiceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  nome?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  idService?: string;

  @IsOptional() @IsString()
  descrizione?: string;

  @IsOptional() @IsString()
  apiKeyPrimaria?: string;

  @IsOptional() @IsString()
  apiKeySecondaria?: string;

  @IsOptional() @IsString() @MaxLength(32)
  codiceCatalogo?: string;
}

export interface IoServiceMaskedDto {
  id: string;
  nome: string;
  idService: string;
  descrizione: string;
  apiKeyPrimaria: string; // MASKED_VALUE se impostata
  apiKeySecondaria: string;
  codiceCatalogo: string;
  isDefault: boolean;
  testedAt: string | null;
}
```

- [ ] **Step 3: Test del service (TDD prima dell'implementazione)**

```ts
// apps/backend/src/io-services/io-services.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IoServicesService } from './io-services.service';
import { IoServiceConfig } from '../entities/io-service-config.entity';

describe('IoServicesService', () => {
  let service: IoServicesService;
  const repoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'gen-id', testedAt: null, isDefault: false, ...x })),
    find: jest.fn(),
    findOneBy: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IoServicesService,
        { provide: getRepositoryToken(IoServiceConfig), useValue: repoMock },
        { provide: ConfigService, useValue: { get: () => 'test-jwt-secret-min-32-chars-long!!' } },
      ],
    }).compile();
    service = moduleRef.get(IoServicesService);
  });

  it('cifra la api key primaria alla creazione e la maschera in output', async () => {
    const result = await service.create({
      nome: 'TARI', idService: 'SVC1', apiKeyPrimaria: 'segreto123', isDefault: true,
    } as any);

    expect(repoMock.save).toHaveBeenCalled();
    const savedArg = repoMock.create.mock.calls[0][0];
    expect(savedArg.apiKeyPrimariaEnc).not.toBe('segreto123');
    expect(savedArg.apiKeyPrimariaEnc).toMatch(/^enc:v1:/);
    expect(result.apiKeyPrimaria).toBe('••••••••');
  });

  it('resolveApiKey ritorna la chiave in chiaro del servizio richiesto', async () => {
    const encrypted = (await service.create({
      nome: 'TARI', idService: 'SVC1', apiKeyPrimaria: 'segreto123',
    } as any));
    repoMock.findOneBy.mockResolvedValue({
      id: encrypted.id,
      idService: 'SVC1',
      apiKeyPrimariaEnc: repoMock.create.mock.calls[0][0].apiKeyPrimariaEnc,
    });

    const resolved = await service.resolveApiKey(encrypted.id);

    expect(resolved).toEqual({ apiKey: 'segreto123', idService: 'SVC1' });
  });

  it('resolveApiKey senza id usa il servizio default', async () => {
    repoMock.find.mockResolvedValue([{
      id: 'def-id',
      idService: 'SVC-DEFAULT',
      apiKeyPrimariaEnc: repoMock.create.mock.calls[0]?.[0]?.apiKeyPrimariaEnc ?? '',
      isDefault: true,
    }]);

    const resolved = await service.resolveApiKey(undefined);

    expect(repoMock.find).toHaveBeenCalledWith({ where: { isDefault: true } });
    expect(resolved?.idService).toBe('SVC-DEFAULT');
  });
});
```

- [ ] **Step 4: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest io-services.service --maxWorkers=2
```
Atteso: FAIL (`IoServicesService` non esiste ancora).

- [ ] **Step 5: Implementare il service**

```ts
// apps/backend/src/io-services/io-services.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto';
import { MASKED_VALUE } from '../settings/settings.registry';
import type { AppConfiguration } from '../config/configuration';
import type { CreateIoServiceDto, IoServiceMaskedDto, UpdateIoServiceDto } from './dto/io-service.dto';

@Injectable()
export class IoServicesService {
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(IoServiceConfig)
    private readonly repo: Repository<IoServiceConfig>,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  private toMasked(entity: IoServiceConfig): IoServiceMaskedDto {
    return {
      id: entity.id,
      nome: entity.nome,
      idService: entity.idService,
      descrizione: entity.descrizione,
      apiKeyPrimaria: entity.apiKeyPrimariaEnc ? MASKED_VALUE : '',
      apiKeySecondaria: entity.apiKeySecondariaEnc ? MASKED_VALUE : '',
      codiceCatalogo: entity.codiceCatalogo,
      isDefault: entity.isDefault,
      testedAt: entity.testedAt ? entity.testedAt.toISOString() : null,
    };
  }

  async listMasked(): Promise<IoServiceMaskedDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toMasked(r));
  }

  async create(dto: CreateIoServiceDto): Promise<IoServiceMaskedDto> {
    if (dto.isDefault) {
      await this.repo.update({ isDefault: true }, { isDefault: false });
    }
    const entity = this.repo.create({
      nome: dto.nome,
      idService: dto.idService,
      descrizione: dto.descrizione ?? '',
      apiKeyPrimariaEnc: encryptValue(dto.apiKeyPrimaria, this.cryptoKey),
      apiKeySecondariaEnc: dto.apiKeySecondaria ? encryptValue(dto.apiKeySecondaria, this.cryptoKey) : '',
      codiceCatalogo: dto.codiceCatalogo ?? '',
      isDefault: dto.isDefault ?? false,
      testedAt: null,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async update(id: string, dto: UpdateIoServiceDto): Promise<IoServiceMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);

    if (dto.nome !== undefined) entity.nome = dto.nome;
    if (dto.idService !== undefined) entity.idService = dto.idService;
    if (dto.descrizione !== undefined) entity.descrizione = dto.descrizione;
    if (dto.apiKeyPrimaria !== undefined && dto.apiKeyPrimaria !== MASKED_VALUE) {
      entity.apiKeyPrimariaEnc = encryptValue(dto.apiKeyPrimaria, this.cryptoKey);
    }
    if (dto.apiKeySecondaria !== undefined && dto.apiKeySecondaria !== MASKED_VALUE) {
      entity.apiKeySecondariaEnc = dto.apiKeySecondaria ? encryptValue(dto.apiKeySecondaria, this.cryptoKey) : '';
    }
    if (dto.codiceCatalogo !== undefined) entity.codiceCatalogo = dto.codiceCatalogo;

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async remove(id: string): Promise<void> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    if (entity.isDefault) {
      const count = await this.repo.count();
      if (count > 1) {
        throw new BadRequestException('Imposta un altro servizio come predefinito prima di eliminare questo.');
      }
    }
    await this.repo.delete({ id });
  }

  async setDefault(id: string): Promise<IoServiceMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    await this.repo.update({ isDefault: true }, { isDefault: false });
    entity.isDefault = true;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async test(id: string, codiceFiscale: string): Promise<{ success: true; message: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    if (!codiceFiscale) throw new BadRequestException('Codice fiscale di test richiesto');

    const apiKey = decryptValue(entity.apiKeyPrimariaEnc, this.cryptoKey);
    const { APP_IO_BASE_URL } = await import('../channels/app-io/app-io.strategy');
    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': apiKey },
      body: JSON.stringify({
        fiscal_code: codiceFiscale,
        content: { subject: `Test ComunicaPA - ${entity.nome}`, markdown: `Messaggio di test dal servizio **${entity.nome}**.` },
      }),
    });

    if (!response.ok) {
      throw new BadRequestException(`Errore App IO: HTTP ${response.status}`);
    }

    entity.testedAt = new Date();
    await this.repo.save(entity);
    return { success: true, message: 'Messaggio di test inviato con successo.' };
  }

  async resolveApiKey(idOrUndefined?: string): Promise<{ apiKey: string; idService: string } | null> {
    let entity: IoServiceConfig | null = null;
    if (idOrUndefined) {
      entity = await this.repo.findOneBy({ id: idOrUndefined });
    }
    if (!entity) {
      const defaults = await this.repo.find({ where: { isDefault: true } });
      entity = defaults[0] ?? null;
    }
    if (!entity || !entity.apiKeyPrimariaEnc) return null;
    return { apiKey: decryptValue(entity.apiKeyPrimariaEnc, this.cryptoKey), idService: entity.idService };
  }
}
```

- [ ] **Step 6: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest io-services.service --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 7: Controller**

```ts
// apps/backend/src/io-services/io-services.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { IoServicesService } from './io-services.service';
import { CreateIoServiceDto, UpdateIoServiceDto } from './dto/io-service.dto';

@Controller('io-services')
export class IoServicesController {
  constructor(private readonly svc: IoServicesService) {}

  @Get()
  @Roles('user', 'admin')
  list() {
    return this.svc.listMasked().then((configs) => ({ configs }));
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateIoServiceDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIoServiceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Patch(':id/default')
  @Roles('admin')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: { codiceFiscale: string }) {
    return this.svc.test(id, body?.codiceFiscale ?? '');
  }
}
```

- [ ] **Step 8: Modulo**

```ts
// apps/backend/src/io-services/io-services.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { IoServicesService } from './io-services.service';
import { IoServicesController } from './io-services.controller';

@Module({
  imports: [TypeOrmModule.forFeature([IoServiceConfig])],
  controllers: [IoServicesController],
  providers: [IoServicesService],
  exports: [IoServicesService],
})
export class IoServicesModule {}
```

- [ ] **Step 9: Registrare modulo ed entity**

In `apps/backend/src/app.module.ts`, aggiungere import e voce in `imports:` accanto a `MailConfigsModule`:
```ts
import { IoServicesModule } from './io-services/io-services.module';
```
```ts
    IoServicesModule,
```

In `apps/backend/src/database/database.module.ts`, aggiungere `IoServiceConfig` all'array `entities`:
```ts
import { IoServiceConfig } from '../entities/io-service-config.entity';
```
```ts
        entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig],
```

- [ ] **Step 10: Aggiornare `app-io.strategy.ts` per risolvere la chiave per servizio**

```ts
// apps/backend/src/channels/app-io/app-io.strategy.ts
import { Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { IoServicesService } from '../../io-services/io-services.service';

export const APP_IO_BASE_URL = 'https://api.io.pagopa.it';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'APP_IO';

  constructor(private readonly ioServices: IoServicesService) {}

  async send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult> {
    const cfg = campaign.channelConfig as Record<string, string>;
    const resolved = await this.ioServices.resolveApiKey(cfg['ioServiceId']);
    if (!resolved) {
      throw new Error('Nessun servizio App IO configurato (né specifico né predefinito)');
    }

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const subject = interpolate(cfg['subject'] ?? campaign.name, vars);
    const markdown = interpolate(cfg['body'] ?? '', vars);

    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': resolved.apiKey,
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

Aggiornare `apps/backend/src/channels/app-io/app-io.strategy.spec.ts` (Task 5) sostituendo il mock `AppSettingsService` con un mock di `IoServicesService.resolveApiKey` che ritorna `{ apiKey: 'test-api-key', idService: 'SVC1' }`.

Rimuovere anche la chiave `appIo.apiKey` da `settings.registry.ts` (non serve più: la chiave ora vive cifrata per-servizio in `IoServiceConfig`), e rimuovere il campo "API Key" globale dalle Impostazioni → App IO in `App.tsx` se presente (stato `settIoApiKey`/`setSettIoApiKey`, riga 246).

- [ ] **Step 11: Generare la migration**

Seguire la procedura da CLAUDE.md con DB temporaneo:

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddIoServiceConfigs -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Registrare la migration generata in `apps/backend/src/database/database.module.ts` (import + array `migrations`), seguendo lo stesso pattern di `AddMailServerConfigs1783071728873`.

- [ ] **Step 12: Sostituire il CRUD localStorage in frontend con chiamate API**

In `apps/frontend-admin/src/App.tsx`:

Sostituire la lettura iniziale (righe 248-251):
```tsx
  const [ioServices, setIoServices] = useState<IoService[]>([]);
```

Aggiungere un fetch all'avvio (accanto agli altri `useEffect` di caricamento dati, es. vicino a `fetchMailConfigs`):
```tsx
  const fetchIoServices = async () => {
    const res = await fetch(`${API_BASE}/io-services`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setIoServices(data.configs || []);
  };
```
e chiamarla in `useEffect(() => { if (token) fetchIoServices(); }, [token])` accanto agli altri effect equivalenti (`fetchMailConfigs` ecc.).

Sostituire `handleAddIoService` (righe 639-676):
```tsx
  const handleAddIoService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSvcNome || !newSvcIdService || !newSvcApiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }
    await fetch(`${API_BASE}/io-services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        nome: newSvcNome,
        idService: newSvcIdService.toUpperCase().trim(),
        descrizione: newSvcDesc,
        apiKeyPrimaria: newSvcApiKeyPrimaria,
        apiKeySecondaria: newSvcApiKeySecondaria,
        codiceCatalogo: newSvcCodiceCatalogo,
        isDefault: newSvcIsDefault || ioServices.length === 0,
      }),
    });
    await fetchIoServices();
    setNewSvcNome(''); setNewSvcIdService(''); setNewSvcDesc('');
    setNewSvcApiKeyPrimaria(''); setNewSvcApiKeySecondaria(''); setNewSvcCodiceCatalogo('');
    setNewSvcIsDefault(false); setShowNewSvcForm(false);
    alert('Servizio creato con successo!');
  };

  const handleSetDefaultIoService = async (id: string) => {
    await fetch(`${API_BASE}/io-services/${id}/default`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetchIoServices();
  };

  const handleDeleteIoService = async (id: string) => {
    const svcToDelete = ioServices.find(s => s.id === id);
    if (!svcToDelete) return;
    if (!confirm(`Sei sicuro di voler eliminare il servizio "${svcToDelete.nome}"?`)) return;
    const res = await fetch(`${API_BASE}/io-services/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => null);
      alert(body?.message || 'Impossibile eliminare il servizio.');
      return;
    }
    await fetchIoServices();
  };
```

Rimuovere `localStorage.setItem('sett_io_services', ...)` dalla riga 706 di `handleSaveSettings` (il canale App IO è ora persistito lato server, non serve più il salvataggio manuale).

Aggiornare `interface IoService` (riga 60-69) per riflettere i campi mascherati che arrivano dall'API (`apiKeyPrimaria`/`apiKeySecondaria` sono stringhe mascherate `••••••••` in lista, non i valori reali — coerente con `MailConfigItem`).

Aggiornare i tre punti che costruiscono `channelConfig` per campagne App IO (righe 476-483, 517-524, 569-576): non inviare più `apiKey` in chiaro dal client, inviare solo l'id del servizio:
```tsx
        } else if (channelVal === 'APP_IO') {
          channelConfig = { ioServiceId: selectedAppIoServiceId };
```
(applicare lo stesso pattern minimale alle altre due occorrenze, rimuovendo `apiKey:` e `baseUrl:` da tutti e tre i blocchi, e dal blocco "Bundle default App IO" per invii combinati mail+AppIO, righe 530-539 e 582-591 — lì basta `appIo: { ioServiceId: defaultSvc.id }`).

Nota: `selectedAppIoServiceId` nel client oggi è popolato da `s.id_service` (l'ID esterno IO, non l'id riga DB) — verificare durante la Step 13 che il select nel wizard usi `s.id` (chiave primaria UUID della nuova entity) come value, non più `s.id_service`, perché è quello che il backend userà per il lookup.

- [ ] **Step 13: Rimuovere `DEFAULT_IO_SERVICES` e ripulire i tipi**

Eliminare la costante `DEFAULT_IO_SERVICES` (righe 94-115, non più necessaria: la lista è vuota finché l'admin non crea servizi da UI, niente più seed fittizio con api key finte nel bundle JS).

- [ ] **Step 14: Fix obbligatorio — le select del wizard usano `id_service` (esterno) invece di `id` (UUID DB)**

Le select "Servizio App IO" nel wizard e nell'invio singolo usano oggi `value={s.id_service}` (l'ID esterno PagoPA, es. `01ARZ3NDEKTSN4FFFSUQFW0C5`), NON `value={s.id}` (la UUID della riga `IoServiceConfig` appena introdotta). Se questa select non viene corretta, `wizAppIoServiceId`/`singleAppIoServiceId`/`selectedAppIoServiceId` contengono l'ID esterno, `channelConfig.ioServiceId` (Step 12) spedisce quell'ID esterno al backend, e `IoServicesService.resolveApiKey(idOrUndefined)` (Step 5, cerca per `id` UUID) non trova mai corrispondenza — ricade sempre sul servizio predefinito, **riproducendo esattamente il bug che questo task doveva risolvere** ("invii OK nei log ma verso il servizio/chiave sbagliata").

Correggere le tre occorrenze in `apps/frontend-admin/src/App.tsx`:

Riga 2270 (select App IO nel form "Invio Singolo"):
```tsx
                            <option key={s.id} value={s.id}>
```
Riga 2549 (select App IO co-consegna nel wizard step 1, canale EMAIL/PEC):
```tsx
                                <option key={s.id} value={s.id}>
```
Riga 2571 (select App IO nel wizard step 1, canale APP_IO):
```tsx
                          <option key={s.id} value={s.id}>
```

Eseguire poi:
```bash
docker compose exec frontend-admin grep -n "s.id_service}" src/App.tsx
```
Atteso: nessun output rimasto per attributi `value=` (le colonne `id_service` mostrate in tabella, es. riga 3518/3506, restano invariate — sono solo visualizzazione, non `value` di select).

- [ ] **Step 15: Type-check e verifica manuale**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose up -d --build backend frontend-admin
```

In browser: Impostazioni → App IO (Servizi) → creare un nuovo servizio con una API key di test, verificare che appaia nella lista con key mascherata, ricaricare la pagina (F5) e verificare che il servizio sia ancora lì (prova che non è più in localStorage-only ma persistito lato server).

- [ ] **Step 16: Commit**

```bash
git add apps/backend/src/entities/io-service-config.entity.ts apps/backend/src/io-services apps/backend/src/database apps/backend/src/app.module.ts apps/backend/src/channels/app-io apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): persisti servizi App IO in DB con api key cifrate, sostituisce localStorage"
```

---

### Task 7: Bottone "Test" su elenco servizi App IO

**Contesto:** dipende dal Task 6 (endpoint `POST /io-services/:id/test` già implementato lì). Manca solo l'innesto UI nella tabella servizi (`apps/frontend-admin/src/App.tsx:3501-3546`), accanto ai bottoni "Imposta predefinito"/"Elimina" esistenti (righe 3520-3541), analogo al pattern già presente per i mail server (`renderMailConfigTab`, form di test righe 1054-1075).

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consuma: `POST /io-services/:id/test` (Task 6, Step 7), body `{ codiceFiscale: string }`.

- [ ] **Step 1: State per il form di test inline**

Accanto agli altri state dei servizi IO (riga ~259):
```tsx
  const [ioTestCf, setIoTestCf] = useState('');
  const [ioTestBusyId, setIoTestBusyId] = useState<string | null>(null);
  const [ioTestMsg, setIoTestMsg] = useState<{ id: string; text: string; error: boolean } | null>(null);
```

- [ ] **Step 2: Handler**

```tsx
  const handleTestIoService = async (id: string) => {
    if (!ioTestCf) {
      alert('Inserisci un codice fiscale di test.');
      return;
    }
    setIoTestBusyId(id);
    setIoTestMsg(null);
    try {
      const res = await fetch(`${API_BASE}/io-services/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ codiceFiscale: ioTestCf.toUpperCase().trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Test fallito');
      setIoTestMsg({ id, text: data.message, error: false });
    } catch (err: any) {
      setIoTestMsg({ id, text: err.message, error: true });
    } finally {
      setIoTestBusyId(null);
    }
  };
```

- [ ] **Step 3: Riga di test nella tabella servizi**

In `apps/frontend-admin/src/App.tsx`, dentro il `<tbody>` della tabella servizi (righe 3512-3543), estendere ogni `<tr>` con una seconda riga sotto (o una cella espansa) per il test — pattern coerente con la card dei mail-config (righe 1054-1075):

```tsx
                                      {ioServices.map(s => (
                                        <React.Fragment key={s.id}>
                                        <tr>
                                          <td>
                                            <strong>{s.nome}</strong>
                                            {s.is_default && <span className="badge bg-success ms-2">Predefinito</span>}
                                          </td>
                                          <td className="font-monospace small">{s.id_service}</td>
                                          <td>{s.codice_catalogo || <span className="text-muted">—</span>}</td>
                                          <td className="text-end">
                                            <div className="btn-group">
                                              {!s.is_default && (
                                                <button type="button" className="btn btn-sm btn-outline-info border-0" onClick={() => handleSetDefaultIoService(s.id)} title="Imposta come predefinito">
                                                  <i className="fas fa-star"></i>
                                                </button>
                                              )}
                                              <button type="button" className="btn btn-sm btn-outline-danger border-0" onClick={() => handleDeleteIoService(s.id)} title="Elimina">
                                                <i className="fas fa-trash"></i>
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                        <tr>
                                          <td colSpan={4} className="pt-0">
                                            <form onSubmit={(e) => { e.preventDefault(); handleTestIoService(s.id); }} className="d-flex align-items-center gap-2 pb-2">
                                              <span className="text-muted small fw-semibold">Test invio:</span>
                                              <input
                                                type="text"
                                                className="form-control form-control-sm"
                                                placeholder="RSSMRA80A01H501X"
                                                required
                                                value={ioTestCf}
                                                onChange={(e) => setIoTestCf(e.target.value)}
                                                style={{ maxWidth: 200 }}
                                              />
                                              <button type="submit" className="btn btn-sm btn-outline-secondary" disabled={ioTestBusyId === s.id}>
                                                <i className="fas fa-paper-plane"></i> Invia Test
                                              </button>
                                              {ioTestMsg?.id === s.id && (
                                                <span className={`small ${ioTestMsg.error ? 'text-danger' : 'text-success'}`}>{ioTestMsg.text}</span>
                                              )}
                                            </form>
                                          </td>
                                        </tr>
                                        </React.Fragment>
                                      ))}
```

(`React.Fragment` con `key` richiede `import React from 'react'` già presente nel file — verificare in cima al file, altrimenti aggiungere l'import.)

- [ ] **Step 4: Verifica manuale**

```bash
docker compose up -d --build frontend-admin
```
Impostazioni → App IO → creare/usare un servizio esistente → inserire un CF di test → "Invia Test" → verificare messaggio di successo/errore inline.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): bottone test invio con codice fiscale su elenco servizi App IO"
```

---

### Task 8: Diagnosi associazione notifiche portale cittadino per CF

**Contesto:** l'utente segnala che dopo login SPID con un CF che ha almeno 2 notifiche nel sistema, il portale cittadino non mostra nulla. La ricerca nel codice NON ha trovato un bug evidente: sia l'estrazione del CF da OIDC (`apps/backend/src/auth/strategies/oidc-citizen.strategy.ts:112-125`, strip del prefisso `TINIT-` già gestito) sia il matching in query (`apps/backend/src/citizen/citizen.service.ts:15-21`, `.toUpperCase().trim()`) sia la normalizzazione all'import CSV (`apps/backend/src/campaigns/campaigns.service.ts:82`, `.toUpperCase().trim()`) sono coerenti tra loro. Il bug è quindi o un problema di dati reali (CF salvato diversamente da come arriva dal token) o un anello della catena non ancora ispezionato (guardia JWT del portale cittadino, cache Redis dei claims OIDC). Non si scrive un fix speculativo: si isola la causa reale con dati di produzione/staging.

**Files:** nessuna modifica di codice pianificata a priori.

**Interfaces:** nessuna — task diagnostico.

- [ ] **Step 1: Verificare cosa c'è davvero nel JWT del cittadino loggato**

Con l'utente che riproduce il problema (o un account di test con lo stesso CF), aprire DevTools → Application → Local Storage sul portale cittadino, copiare il token, e decodificarlo (es. su jwt.io o `node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64')))" <token>`). Verificare il campo `codiceFiscale`: deve essere il CF in maiuscolo, 16 caratteri, senza prefissi.

- [ ] **Step 2: Verificare cosa c'è davvero nella tabella recipients**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "SELECT id, campaign_id, codice_fiscale, LENGTH(codice_fiscale), status FROM recipients WHERE codice_fiscale ILIKE '%<ultime6cifredelCF>%';"
```

Confrontare byte-per-byte (attenzione a spazi invisibili, o CF salvato con lunghezza diversa da 16 per accenti/refusi nel CSV originale) con il valore del token allo Step 1.

- [ ] **Step 3a: Se i due valori NON combaciano esattamente**

Causa identificata: il CSV caricato aveva un CF diverso da quello reale del cittadino (typo, o partita IVA al posto del CF — vedi Step 4) oppure la cache Redis (`oidc:claims:<sub>`, popolata da `oidc-flow.service.ts:246`) contiene un CF diverso da quello effettivamente nel token corrente (stale cache da un login precedente con provider diverso). Verificare con:

```bash
docker compose exec redis redis-cli KEYS "oidc:claims:*"
docker compose exec redis redis-cli GET "oidc:claims:<sub-del-token>"
```

Se la cache è stale, il fix è invalidarla al logout/nuovo login in `apps/backend/src/auth/oidc/oidc-flow.service.ts` (non implementare qui speculativamente — aprire un secondo giro di lavoro mirato solo su quello, con test).

- [ ] **Step 3b: Se i due valori combaciano esattamente**

Il bug non è nel matching CF: verificare il guard che protegge `citizen.controller.ts` (`OidcAuthGuard`, riga 8) — controllare che stia effettivamente validando il JWT emesso da `AuthService.generateCitizenToken` (`apps/backend/src/auth/auth.service.ts:42-57`) e non un altro schema di token. Aggiungere temporaneamente un log in `citizen.service.ts:findAllForCitizen` per stampare il CF ricevuto dal controller e confrontarlo in tempo reale con quello in DB.

- [ ] **Step 4: Partita IVA — verificare se il caso reale dell'utente è proprio questo**

`Recipient.codiceFiscale` (`apps/backend/src/entities/recipient.entity.ts:28-29`) è `varchar(16)` — una Partita IVA (11 cifre) ci entra ma non è un vero CF. Se l'utente segnalante ha effettivamente notifiche associate a una P.IVA (non CF persona fisica) e il claim OIDC ritorna il CF persona fisica, il matching fallisce per costruzione: sono due valori diversi che non devono combaciare. Va chiarito con l'utente se il caso reale è "stesso soggetto, CF vs PIVA" (in tal caso serve un secondo campo/matching per PIVA, fuori scope di questo piano — proporlo come task separato) o "stesso CF, dati non combacianti per un bug" (coperto dagli step precedenti).

- [ ] **Step 5: Commit (documentazione dell'esito, non necessariamente codice)**

```bash
git commit --allow-empty -m "chore: diagnosi associazione CF portale cittadino - vedi note task 8 piano bugfix"
```
(Se dallo Step 3a/3b emerge un fix concreto e circoscritto, implementarlo con test dedicato e commit separato prima di questo commit di chiusura.)
