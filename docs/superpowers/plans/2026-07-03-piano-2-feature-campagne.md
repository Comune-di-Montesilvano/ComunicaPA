# Piano 2 — Feature campagne, notifiche e template

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere duplicazione campagna, pannello errori/retry nel dettaglio campagna, ricerca notifiche con filtri, salvataggio bozza ad ogni passo del wizard, e una dashboard per creare template riusabili (PEC/Email con l'editor Tiptap esistente, App IO con editor Markdown dedicato).

**Architecture:** Stesso impianto di Piano 1 — NestJS/TypeORM lato backend, un unico `App.tsx` monolitico lato frontend (nessun componente separato per wizard/dashboard). Introduce una nuova entity `Template` (oggi il corpo/oggetto di un invio vive solo dentro `Campaign.channelConfig`, non è riutilizzabile). Questo piano dipende da Piano 1 Task 6 (`IoServiceConfig`) per collegare i template App IO a un servizio: se Piano 1 non è ancora stato eseguito, i task 1 e 5 di questo piano vanno adattati a usare ancora `ioServices` da `localStorage` (meno pulito ma non bloccante).

**Tech Stack:** NestJS 10, TypeORM, class-validator, React 19, Tiptap (già presente), nuova dipendenza `@uiw/react-md-editor` per il markdown App IO.

## Global Constraints

- Ogni comando gira in Docker, mai Node/pnpm sull'host — vedi CLAUDE.md.
- Test backend SEMPRE con `--maxWorkers=2`.
- Baseline nota: 7 test falliscono già prima di questo piano (email.strategy, pec.strategy, notification.processor). Criterio: "failure set identico o migliorato".
- Nessuna suite di test frontend: ogni task frontend termina con verifica manuale in browser.
- Aggiungere una dipendenza a `apps/frontend-admin/package.json` richiede rigenerare `pnpm-lock.yaml` e ricreare il volume `node_modules` — procedura in CLAUDE.md, sezione "Rebuild obbligatorio".
- Dopo modifica a un'entity: generare la migration con il DB temporaneo `migration_gen` (procedura in CLAUDE.md).

---

### Task 1: Duplica campagna

**Contesto:** dalla lista campagne (`apps/frontend-admin/src/App.tsx`, vista `invio-massivo`) serve un tasto "Duplica" che apra il wizard al passo 1 con TUTTI i dati precompilati (nome con suffisso, canale, mittente, template oggetto/corpo, mappatura CSV, allegati esclusi — l'utente ricarica il CSV se vuole destinatari nuovi). Oggi non esiste alcun endpoint di duplicazione; il bottone "Riprendi" esistente (righe 2382-2395) è uno stub che precarica solo `wizName` — non riusarlo per questo scopo, va sostituito da una vera funzione di prefill completo che serve sia a "Riprendi bozza" (Task 4) sia a "Duplica" (questo task).

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (nuovo endpoint `GET /campaigns/:id/duplicate-source`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (nuovo metodo `getDuplicateSource`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/frontend-admin/src/App.tsx` (bottone "Duplica" in lista campagne + funzione `prefillWizardFrom`)

**Interfaces:**
- Produce: `CampaignsService.getDuplicateSource(id): Promise<DuplicateSourceDto>` dove `DuplicateSourceDto = { name, description, channelType, channelConfig, csvMappingHint: { headers: string[] } }` — NON copia i destinatari (l'utente ricarica il CSV).
- Produce: `GET /campaigns/:id/duplicate-source` → stesso shape.
- Consuma (frontend): funzione `prefillWizardFrom(source: DuplicateSourceDto)` che scrive su tutti i `wiz*` setter rilevanti.

- [ ] **Step 1: Test del nuovo metodo service**

Se `apps/backend/src/campaigns/campaigns.service.spec.ts` non esiste ancora, crearlo con questo primo blocco (altrimenti aggiungere il `describe`):

```ts
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { NotificationQueuesService } from '../queue/notification-queues.service';

describe('CampaignsService.getDuplicateSource', () => {
  const campaignRepoMock = { findOneBy: jest.fn() };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
      ],
    }).compile();

  it('lancia NotFoundException se la campagna non esiste', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue(null);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.getDuplicateSource('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ritorna nome/canale/config della campagna sorgente, senza destinatari', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({
      id: 'c1',
      name: 'Avviso TARI 2026',
      description: 'Descrizione originale',
      channelType: 'EMAIL',
      channelConfig: { subject: 'Oggetto %nominativo%', body: '<p>Corpo</p>', mailConfigId: 'mc1' },
      status: CampaignStatus.COMPLETED,
    });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getDuplicateSource('c1');

    expect(result).toEqual({
      name: 'Avviso TARI 2026',
      description: 'Descrizione originale',
      channelType: 'EMAIL',
      channelConfig: { subject: 'Oggetto %nominativo%', body: '<p>Corpo</p>', mailConfigId: 'mc1' },
    });
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: FAIL (`getDuplicateSource is not a function`).

- [ ] **Step 3: Implementare il metodo**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungere dopo `findOne`:

```ts
  async getDuplicateSource(id: string): Promise<{
    name: string;
    description: string | null;
    channelType: Campaign['channelType'];
    channelConfig: Record<string, unknown>;
  }> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return {
      name: campaign.name,
      description: campaign.description,
      channelType: campaign.channelType,
      channelConfig: campaign.channelConfig,
    };
  }
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 5: Endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungere dopo `findOne`:

```ts
  @Get(':id/duplicate-source')
  getDuplicateSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getDuplicateSource(id);
  }
```

- [ ] **Step 6: Frontend — funzione di prefill condivisa**

In `apps/frontend-admin/src/App.tsx`, aggiungere (accanto a `handleWizLaunch` o alle altre funzioni wizard) una funzione unica di prefill, riusata sia da Duplica che dal Task 4 (Riprendi bozza):

```tsx
  const prefillWizardFrom = (source: {
    name: string;
    description: string | null;
    channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
    channelConfig: Record<string, any>;
  }, opts: { isDuplicate: boolean }) => {
    setWizName(opts.isDuplicate ? `${source.name} (Copia)` : source.name);
    setWizDesc(source.description || '');
    setWizChannel(source.channelType);
    setWizSubject(source.channelConfig?.subject || '');
    setWizBody(source.channelConfig?.body || '');
    setWizMailConfigId(source.channelConfig?.mailConfigId || '');
    setWizAppIoServiceId(source.channelConfig?.serviceId || source.channelConfig?.ioServiceId || '');
    setWizAppIoMode(source.channelConfig?.appIo ? 'parallel' : 'none');
    setWizBlockedChannels(source.channelConfig?.blockedChannels || []);
    // Il CSV NON viene precaricato: l'utente ricarica un file al passo 2.
    setWizCsvFile(null);
    setWizCsvHeaders([]);
    setWizCsvRows([]);
    setWizValidRows([]);
    setWizStep(1);
    setView('invio-massivo-wizard');
  };

  const handleDuplicateCampaign = async (campaignId: string) => {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/duplicate-source`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert('Impossibile leggere i dati della campagna da duplicare.');
      return;
    }
    const source = await res.json();
    prefillWizardFrom(source, { isDuplicate: true });
  };
```

- [ ] **Step 7: Bottone "Duplica" in lista campagne**

In `apps/frontend-admin/src/App.tsx`, nella riga della tabella campagne (righe 2381-2396), aggiungere il bottone accanto a "Riprendi" (disponibile per QUALSIASI stato, non solo draft):

```tsx
                                <td className="text-end" onClick={(e) => e.stopPropagation()}>
                                  {c.status === 'draft' && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-primary d-flex align-items-center gap-1 mb-1"
                                      title="Riprendi wizard campagna"
                                      onClick={() => handleResumeDraft(c.id)}
                                    >
                                      <i className="fas fa-edit"></i> Riprendi
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                                    title="Duplica campagna in un nuovo wizard"
                                    onClick={() => handleDuplicateCampaign(c.id)}
                                  >
                                    <i className="fas fa-copy"></i> Duplica
                                  </button>
                                </td>
```

(`handleResumeDraft` viene introdotta nel Task 4 — per ora, se questo task viene eseguito da solo, lasciare il vecchio handler inline di riga 2387-2391 al posto di `handleResumeDraft(c.id)`.)

- [ ] **Step 8: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
In "Invio Massivo", su una campagna già completata, cliccare "Duplica": il wizard si apre al passo 1 con nome (+ "(Copia)"), canale, mittente e — passando al passo 4 — oggetto/corpo già precompilati. Caricare un nuovo CSV al passo 2 e verificare che il flusso arrivi fino al lancio.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): duplica campagna precompilando il wizard da una campagna esistente"
```

---

### Task 2: Dettaglio campagna — riquadro errori con retry

**Contesto:** il dettaglio campagna (`apps/frontend-admin/src/App.tsx`, vista `campaign-detail`, da riga 3940) mostra solo contatori aggregati `sentCount`/`failedCount`. Serve un elenco dei destinatari falliti con il motivo dell'errore (`NotificationAttempt.errorMessage`, entity `apps/backend/src/entities/notification-attempt.entity.ts:44-45`) e un bottone "Rimetti in coda" per destinatario.

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produce: `CampaignsService.getFailures(campaignId): Promise<FailureRowDto[]>` dove `FailureRowDto = { recipientId, codiceFiscale, fullName, errorMessage, attemptNumber, lastAttemptAt }`.
- Produce: `CampaignsService.retryRecipient(campaignId, recipientId): Promise<{ requeued: true; attemptId: string }>`.
- Produce: `GET /campaigns/:id/failures`, `POST /campaigns/:id/recipients/:recipientId/retry`.
- Consuma: `NotificationQueuesService.addBulk` (Piano 1/esistente, `apps/backend/src/queue/notification-queues.service.ts:33-35`), `NOTIFICATION_JOB_SEND` da `apps/backend/src/queue/notification-job.types.ts`.

- [ ] **Step 1: Test di `getFailures` e `retryRecipient`**

Aggiungere in `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```ts
describe('CampaignsService.getFailures / retryRecipient', () => {
  const campaignRepoMock = { findOneBy: jest.fn() };
  const recipientRepoMock = { findOne: jest.fn(), update: jest.fn() };
  const attemptRepoMock = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const queuesMock = { addBulk: jest.fn() };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: NotificationQueuesService, useValue: queuesMock },
      ],
    }).compile();

  it('getFailures ritorna i destinatari con ultimo tentativo fallito', async () => {
    recipientRepoMock.findOne = undefined as any; // non usato in questo metodo
    attemptRepoMock.find.mockResolvedValue([
      {
        recipientId: 'r1',
        errorMessage: 'SMTP timeout',
        attemptNumber: 2,
        createdAt: new Date('2026-07-01T10:00:00Z'),
        recipient: { codiceFiscale: 'RSSMRA80A01H501X', fullName: 'Mario Rossi' },
      },
    ]);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(attemptRepoMock.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { recipient: { campaignId: 'c1' }, status: 'failed' },
    }));
    expect(result).toEqual([{
      recipientId: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      errorMessage: 'SMTP timeout',
      attemptNumber: 2,
      lastAttemptAt: '2026-07-01T10:00:00.000Z',
    }]);
  });

  it('retryRecipient crea un nuovo attempt e riaccoda il job', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL' });
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: () => ({ into: () => ({ values: () => ({ returning: () => ({ execute: insertExec }) }) }) }),
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.retryRecipient('c1', 'r1');

    expect(recipientRepoMock.update).toHaveBeenCalledWith({ id: 'r1' }, { status: 'queued' });
    expect(queuesMock.addBulk).toHaveBeenCalledWith('EMAIL', [
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'EMAIL' } },
    ]);
    expect(result).toEqual({ requeued: true, attemptId: 'attempt-2' });
  });
});
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: FAIL (`getFailures`/`retryRecipient` non esistono).

- [ ] **Step 3: Implementare i due metodi**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungere:

```ts
  async getFailures(campaignId: string): Promise<Array<{
    recipientId: string;
    codiceFiscale: string;
    fullName: string | null;
    errorMessage: string | null;
    attemptNumber: number;
    lastAttemptAt: string;
  }>> {
    const attempts = await this.attemptRepo.find({
      where: { recipient: { campaignId }, status: AttemptStatus.FAILED },
      relations: ['recipient'],
      order: { createdAt: 'DESC' },
    });
    return attempts.map((a) => ({
      recipientId: a.recipientId,
      codiceFiscale: a.recipient.codiceFiscale,
      fullName: a.recipient.fullName,
      errorMessage: a.errorMessage,
      attemptNumber: a.attemptNumber,
      lastAttemptAt: a.createdAt.toISOString(),
    }));
  }

  async retryRecipient(campaignId: string, recipientId: string): Promise<{ requeued: true; attemptId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const lastAttempt = await this.attemptRepo.findOne({
      where: { recipientId },
      order: { attemptNumber: 'DESC' },
    });
    const nextAttemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

    const result = await this.attemptRepo
      .createQueryBuilder()
      .insert()
      .into(NotificationAttempt)
      .values({ recipientId, channelType: campaign.channelType, status: AttemptStatus.QUEUED, attemptNumber: nextAttemptNumber })
      .returning('id')
      .execute();
    const attemptId = (result.raw as Array<{ id: string }>)[0].id;

    await this.recipientRepo.update({ id: recipientId }, { status: RecipientStatus.QUEUED });

    await this.notificationQueues.addBulk(campaign.channelType, [
      { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType } },
    ]);

    return { requeued: true, attemptId };
  }
```

Nota: il test mockato per `getFailures` non passa `attemptNumber`/`order` reali per `retryRecipient`'s `lastAttempt` — verificare in Step 4 se serve aggiungere anche il mock di `attemptRepo.findOne` nel test (`findOne: jest.fn().mockResolvedValue({ attemptNumber: 1 })`), altrimenti `nextAttemptNumber` sarà `NaN`. Aggiungere quel mock nel blocco test del Step 1 prima di eseguire.

- [ ] **Step 4: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: PASS (aggiustare il mock `attemptRepoMock.findOne` come da nota sopra se il primo run fallisce su `nextAttemptNumber`).

- [ ] **Step 5: Endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungere:

```ts
  @Get(':id/failures')
  getFailures(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailures(id);
  }

  @Post(':id/recipients/:recipientId/retry')
  retryRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.campaignsService.retryRecipient(id, recipientId);
  }
```

- [ ] **Step 6: UI — riquadro errori nel dettaglio campagna**

In `apps/frontend-admin/src/App.tsx`, aggiungere state e fetch accanto a `campaign`/`loadingCampaignDetail`:

```tsx
  const [campaignFailures, setCampaignFailures] = useState<Array<{ recipientId: string; codiceFiscale: string; fullName: string | null; errorMessage: string | null; attemptNumber: number; lastAttemptAt: string }>>([]);
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);

  const fetchCampaignFailures = async (campaignId: string) => {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/failures`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setCampaignFailures(await res.json());
  };

  const handleRetryRecipient = async (campaignId: string, recipientId: string) => {
    setRetryBusyId(recipientId);
    try {
      await fetch(`${API_BASE}/campaigns/${campaignId}/recipients/${recipientId}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchCampaignFailures(campaignId);
    } finally {
      setRetryBusyId(null);
    }
  };
```

Nel `useEffect` esistente che carica il dettaglio campagna (individuare il punto che imposta `campaign`/`loadingCampaignDetail` quando `selectedCampaignId` cambia), aggiungere la chiamata `fetchCampaignFailures(selectedCampaignId)` accanto al fetch principale.

Nel render, dopo il blocco "Stato dell'Invio" (righe 4003-4023), aggiungere:

```tsx
                        {campaignFailures.length > 0 && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2 text-danger">
                              <i className="fas fa-triangle-exclamation me-1"></i>
                              Destinatari con invio fallito ({campaignFailures.length})
                            </h4>
                            <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                              <table className="table table-sm">
                                <thead><tr><th>CF</th><th>Nome</th><th>Tentativi</th><th>Motivo</th><th></th></tr></thead>
                                <tbody>
                                  {campaignFailures.map(f => (
                                    <tr key={f.recipientId}>
                                      <td className="font-monospace small">{f.codiceFiscale}</td>
                                      <td className="small">{f.fullName || '—'}</td>
                                      <td className="small">{f.attemptNumber}</td>
                                      <td className="small text-danger">{f.errorMessage || '—'}</td>
                                      <td>
                                        <button
                                          className="btn btn-sm btn-outline-primary"
                                          disabled={retryBusyId === f.recipientId}
                                          onClick={() => handleRetryRecipient(campaign.id, f.recipientId)}
                                        >
                                          <i className="fas fa-rotate-right me-1"></i>Rimetti in coda
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
```

- [ ] **Step 7: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
Su una campagna con almeno un destinatario fallito (es. dopo test con SMTP non raggiungibile), aprire il dettaglio: verificare che il riquadro errori mostri CF/nome/motivo, cliccare "Rimetti in coda" e verificare che il job torni in coda BullMQ (controllabile dal tab Motori di Invio del Piano 1 Task 4).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): riquadro errori invio con retry singolo destinatario nel dettaglio campagna"
```

---

### Task 3: Pannello ricerca notifiche con filtri

**Contesto:** non esiste alcun endpoint globale per cercare notifiche/destinatari across-campagna. Serve una nuova vista admin con filtri per stato, canale, campagna e codice fiscale.

**Files:**
- Create: `apps/backend/src/notifications-search/notifications-search.module.ts`
- Create: `apps/backend/src/notifications-search/notifications-search.controller.ts`
- Create: `apps/backend/src/notifications-search/notifications-search.service.ts`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`
- Modify: `apps/backend/src/app.module.ts`
- Modify: `apps/frontend-admin/src/App.tsx` (nuova vista `notifiche-ricerca`)

**Interfaces:**
- Produce: `NotificationsSearchService.search(filters): Promise<{ rows: SearchRowDto[]; total: number }>` dove `filters = { codiceFiscale?, campaignId?, channelType?, status?, page, pageSize }` e `SearchRowDto = { recipientId, campaignId, campaignName, codiceFiscale, fullName, channelType, status, createdAt }`.
- Produce: `GET /notifications-search?codiceFiscale=&campaignId=&channelType=&status=&page=&pageSize=`.

- [ ] **Step 1: Test del service**

```ts
// apps/backend/src/notifications-search/notifications-search.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsSearchService } from './notifications-search.service';
import { Recipient } from '../entities/recipient.entity';

describe('NotificationsSearchService.search', () => {
  const qbMock = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const recipientRepoMock = { createQueryBuilder: jest.fn(() => qbMock) };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    qbMock.leftJoinAndSelect.mockReturnThis();
    qbMock.andWhere.mockReturnThis();
    qbMock.orderBy.mockReturnThis();
    qbMock.skip.mockReturnThis();
    qbMock.take.mockReturnThis();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('applica il filtro codiceFiscale quando presente', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ codiceFiscale: 'rssmra80a01h501x', page: 1, pageSize: 20 });

    expect(qbMock.andWhere).toHaveBeenCalledWith('recipient.codiceFiscale = :cf', { cf: 'RSSMRA80A01H501X' });
  });

  it('mappa i risultati nel formato atteso', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[
      {
        id: 'r1',
        campaignId: 'c1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        status: 'sent',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        campaign: { name: 'Avviso TARI', channelType: 'EMAIL' },
      },
    ], 1]);

    const result = await service.search({ page: 1, pageSize: 20 });

    expect(result).toEqual({
      rows: [{
        recipientId: 'r1',
        campaignId: 'c1',
        campaignName: 'Avviso TARI',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      total: 1,
    });
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest notifications-search --maxWorkers=2
```
Atteso: FAIL (modulo non esiste).

- [ ] **Step 3: Implementare il service**

```ts
// apps/backend/src/notifications-search/notifications-search.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';

export interface SearchFilters {
  codiceFiscale?: string;
  campaignId?: string;
  channelType?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export interface SearchRowDto {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  codiceFiscale: string;
  fullName: string | null;
  channelType: string;
  status: string;
  createdAt: string;
}

@Injectable()
export class NotificationsSearchService {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  async search(filters: SearchFilters): Promise<{ rows: SearchRowDto[]; total: number }> {
    const qb = this.recipientRepo
      .createQueryBuilder('recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign');

    if (filters.codiceFiscale) {
      qb.andWhere('recipient.codiceFiscale = :cf', { cf: filters.codiceFiscale.toUpperCase().trim() });
    }
    if (filters.campaignId) {
      qb.andWhere('recipient.campaignId = :campaignId', { campaignId: filters.campaignId });
    }
    if (filters.status) {
      qb.andWhere('recipient.status = :status', { status: filters.status });
    }
    if (filters.channelType) {
      qb.andWhere('campaign.channelType = :channelType', { channelType: filters.channelType });
    }

    qb.orderBy('recipient.createdAt', 'DESC')
      .skip((filters.page - 1) * filters.pageSize)
      .take(filters.pageSize);

    const [rows, total] = await qb.getManyAndCount();

    return {
      rows: rows.map((r) => ({
        recipientId: r.id,
        campaignId: r.campaignId,
        campaignName: r.campaign.name,
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        channelType: r.campaign.channelType,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    };
  }
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest notifications-search --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 5: Controller e modulo**

```ts
// apps/backend/src/notifications-search/notifications-search.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsSearchService } from './notifications-search.service';

@Controller('notifications-search')
@Roles('user', 'admin')
export class NotificationsSearchController {
  constructor(private readonly svc: NotificationsSearchService) {}

  @Get()
  search(
    @Query('codiceFiscale') codiceFiscale?: string,
    @Query('campaignId') campaignId?: string,
    @Query('channelType') channelType?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.svc.search({
      codiceFiscale,
      campaignId,
      channelType,
      status,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20)),
    });
  }
}
```

```ts
// apps/backend/src/notifications-search/notifications-search.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient])],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
```

Registrare in `apps/backend/src/app.module.ts` (import + `imports:` array).

- [ ] **Step 6: Nuova vista frontend**

In `apps/frontend-admin/src/App.tsx`:

Estendere il tipo `view` (riga 121) aggiungendo `'notifiche-ricerca'`, e aggiungere una voce di navigazione nella sidebar (individuare il blocco `<nav>` principale della SPA, accanto a "Statistiche"/"Impostazioni").

Aggiungere gli state e la funzione di ricerca:

```tsx
  const [searchCf, setSearchCf] = useState('');
  const [searchCampaignId, setSearchCampaignId] = useState('');
  const [searchChannel, setSearchChannel] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ recipientId: string; campaignId: string; campaignName: string; codiceFiscale: string; fullName: string | null; channelType: string; status: string; createdAt: string }>>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);

  const runNotificationSearch = async () => {
    setSearchLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchCf) params.set('codiceFiscale', searchCf);
      if (searchCampaignId) params.set('campaignId', searchCampaignId);
      if (searchChannel) params.set('channelType', searchChannel);
      if (searchStatus) params.set('status', searchStatus);
      const res = await fetch(`${API_BASE}/notifications-search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setSearchResults(data.rows || []);
      setSearchTotal(data.total || 0);
    } finally {
      setSearchLoading(false);
    }
  };
```

Aggiungere il blocco vista:

```tsx
          {view === 'notifiche-ricerca' && (
            <div>
              <h3 className="h5 fw-bold text-dark mb-3"><i className="fas fa-magnifying-glass me-2"></i>Ricerca Notifiche</h3>
              <div className="card shadow-sm p-3 mb-3">
                <div className="row g-2">
                  <div className="col-md-3">
                    <input className="form-control form-control-sm" placeholder="Codice Fiscale" value={searchCf} onChange={e => setSearchCf(e.target.value)} />
                  </div>
                  <div className="col-md-3">
                    <select className="form-select form-select-sm" value={searchChannel} onChange={e => setSearchChannel(e.target.value)}>
                      <option value="">Tutti i canali</option>
                      <option value="EMAIL">EMAIL</option>
                      <option value="PEC">PEC</option>
                      <option value="APP_IO">APP IO</option>
                      <option value="SEND">SEND</option>
                      <option value="POSTAL">POSTAL</option>
                    </select>
                  </div>
                  <div className="col-md-3">
                    <select className="form-select form-select-sm" value={searchStatus} onChange={e => setSearchStatus(e.target.value)}>
                      <option value="">Tutti gli stati</option>
                      <option value="pending">In attesa</option>
                      <option value="queued">In coda</option>
                      <option value="sent">Inviato</option>
                      <option value="failed">Fallito</option>
                      <option value="skipped">Saltato</option>
                    </select>
                  </div>
                  <div className="col-md-3">
                    <button className="btn btn-primary btn-sm w-100" onClick={runNotificationSearch} disabled={searchLoading}>
                      <i className="fas fa-search me-1"></i>Cerca
                    </button>
                  </div>
                </div>
              </div>
              <div className="card shadow-sm">
                <div className="table-responsive">
                  <table className="table table-sm mb-0">
                    <thead><tr><th>CF</th><th>Nome</th><th>Campagna</th><th>Canale</th><th>Stato</th><th>Data</th></tr></thead>
                    <tbody>
                      {searchResults.map(r => (
                        <tr key={r.recipientId}>
                          <td className="font-monospace small">{r.codiceFiscale}</td>
                          <td className="small">{r.fullName || '—'}</td>
                          <td className="small">{r.campaignName}</td>
                          <td className="small">{r.channelType}</td>
                          <td><span className="badge bg-light text-dark border">{r.status}</span></td>
                          <td className="small text-muted">{new Date(r.createdAt).toLocaleString('it-IT')}</td>
                        </tr>
                      ))}
                      {searchResults.length === 0 && <tr><td colSpan={6} className="text-center text-muted py-3">Nessun risultato — {searchTotal} totali</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 7: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
Aprire la nuova voce di menu, cercare per CF di un destinatario noto, verificare risultati filtrati per canale/stato.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/notifications-search apps/backend/src/app.module.ts apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): pannello ricerca notifiche con filtri CF/canale/stato/campagna"
```

---

### Task 4: Salva bozza in ogni step del wizard

**Contesto:** oggi la campagna viene creata SOLO al lancio finale (`handleWizLaunch`, `App.tsx:1502`, chiama `POST /campaigns` al passo 5). Il bottone "Riprendi" in lista (righe 2382-2395) è già uno stub rotto che precarica solo il nome. Serve: creare la campagna come DRAFT appena l'utente lo richiede (a qualunque step), aggiornarla (`PATCH`) ad ogni step successivo, e un vero "Riprendi" che rilegga tutti i dati.

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (nuovo `PATCH /campaigns/:id`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (nuovo metodo `updateDraft`)
- Create: `apps/backend/src/campaigns/dto/update-campaign.dto.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/frontend-admin/src/App.tsx` (bottone "Salva bozza" per ogni step, `handleResumeDraft`)

**Interfaces:**
- Produce: `CampaignsService.updateDraft(id, dto): Promise<Campaign>` — aggiorna `name/description/channelConfig` SOLO se `status === DRAFT` (altrimenti `BadRequestException`).
- Produce: `PATCH /campaigns/:id` con body `UpdateCampaignDto = { name?, description?, channelConfig? }`.
- Consuma (frontend): stato `wizCampaignId: string | null` — se `null` "Salva bozza" fa `POST`, altrimenti fa `PATCH` sullo stesso id.

- [ ] **Step 1: DTO**

```ts
// apps/backend/src/campaigns/dto/update-campaign.dto.ts
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(255)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsObject()
  channelConfig?: Record<string, unknown>;
}
```

- [ ] **Step 2: Test di `updateDraft`**

Aggiungere in `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```ts
describe('CampaignsService.updateDraft', () => {
  const campaignRepoMock = { findOneBy: jest.fn(), save: jest.fn((x) => x) };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
      ],
    }).compile();

  it('aggiorna una campagna in stato draft', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', status: CampaignStatus.DRAFT, name: 'Vecchio nome', channelConfig: {} });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.updateDraft('c1', { name: 'Nuovo nome', channelConfig: { subject: 'X' } });

    expect(result.name).toBe('Nuovo nome');
    expect(result.channelConfig).toEqual({ subject: 'X' });
  });

  it('rifiuta l aggiornamento se la campagna non e in draft', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', status: CampaignStatus.RUNNING });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.updateDraft('c1', { name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

(Aggiungere `BadRequestException` all'import `@nestjs/common` in cima al file spec se non già presente.)

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: FAIL.

- [ ] **Step 4: Implementare `updateDraft`**

In `apps/backend/src/campaigns/campaigns.service.ts`:

```ts
  async updateDraft(id: string, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Solo le campagne in bozza possono essere modificate');
    }
    if (dto.name !== undefined) campaign.name = dto.name;
    if (dto.description !== undefined) campaign.description = dto.description;
    if (dto.channelConfig !== undefined) campaign.channelConfig = dto.channelConfig;
    return this.campaignRepo.save(campaign);
  }
```

Aggiungere `import type { UpdateCampaignDto } from './dto/update-campaign.dto';` in cima al file.

- [ ] **Step 5: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 6: Endpoint controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungere `Patch` all'import e:

```ts
  @Patch(':id')
  updateDraft(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaignsService.updateDraft(id, dto);
  }
```

- [ ] **Step 7: Wizard — stato `wizCampaignId` e "Salva bozza" su ogni step**

In `apps/frontend-admin/src/App.tsx`, aggiungere accanto agli altri state wizard (riga ~222):

```tsx
  const [wizCampaignId, setWizCampaignId] = useState<string | null>(null);
  const [wizDraftSaving, setWizDraftSaving] = useState(false);
```

Aggiungere la funzione di salvataggio bozza (accanto a `handleWizLaunch`), che costruisce lo stesso `channelConfig` parziale disponibile allo step corrente:

```tsx
  const buildWizChannelConfigDraft = (): Record<string, any> => {
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId };
    if (wizChannel === 'APP_IO') {
      cfg.ioServiceId = wizAppIoServiceId;
    }
    if (wizAppIoMode !== 'none' && wizAppIoServiceId) {
      cfg.appIo = { mode: wizAppIoMode, ioServiceId: wizAppIoServiceId };
    }
    if (wizBlockedChannels.length > 0) cfg.blockedChannels = wizBlockedChannels;
    return cfg;
  };

  const handleSaveWizardDraft = async () => {
    if (!wizName) {
      alert('Inserisci almeno il nome della campagna prima di salvare la bozza.');
      return;
    }
    setWizDraftSaving(true);
    try {
      if (!wizCampaignId) {
        const res = await fetch(`${API_BASE}/campaigns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelType: wizChannel,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
        const created = await res.json();
        setWizCampaignId(created.id);
      } else {
        const res = await fetch(`${API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
      }
      fetchCampaigns();
      alert('Bozza salvata.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setWizDraftSaving(false);
    }
  };
```

Aggiungere il bottone "Salva bozza" nella barra di navigazione del wizard, che è comune a tutti gli step (righe 2413-2420, subito dopo il titolo "Procedura Guidata Campagna"):

```tsx
                <div className="d-flex align-items-center gap-2">
                  <h3 className="h5 mb-0 fw-bold text-dark"><i className="fas fa-magic me-2 text-primary"></i>Procedura Guidata Campagna</h3>
                </div>
                <div className="d-flex gap-2">
                  <button className="btn btn-outline-primary btn-sm" onClick={handleSaveWizardDraft} disabled={wizDraftSaving}>
                    <i className="fas fa-floppy-disk me-1"></i>{wizDraftSaving ? 'Salvataggio...' : 'Salva bozza'}
                  </button>
                  <button className="btn btn-outline-secondary btn-sm" onClick={() => setView('invio-massivo')}>
                    <i className="fas fa-times me-1"></i> Annulla
                  </button>
                </div>
```

(questo sostituisce il singolo bottone "Annulla" preesistente a riga 2417-2419, mettendolo in un `d-flex gap-2` insieme al nuovo bottone — la struttura `d-flex justify-content-between` del contenitore padre, riga 2413, resta invariata.)

- [ ] **Step 8: Riprendi bozza — vero prefill completo**

In `apps/frontend-admin/src/App.tsx`, sostituire l'handler stub "Riprendi" (righe 2382-2395, già toccato al Task 1 Step 7 se eseguito in sequenza) con una funzione che riusa `prefillWizardFrom` del Task 1 e imposta anche `wizCampaignId`:

```tsx
  const handleResumeDraft = async (campaignId: string) => {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/duplicate-source`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert('Impossibile leggere i dati della bozza.');
      return;
    }
    const source = await res.json();
    prefillWizardFrom(source, { isDuplicate: false });
    setWizCampaignId(campaignId);
  };
```

Nel bottone "Riprendi" della tabella (riga 2387), sostituire l'`onClick` inline con `() => handleResumeDraft(c.id)` (se non già fatto al Task 1).

Aggiungere il reset di `wizCampaignId` quando si esce dal wizard o si lancia con successo: in `handleWizLaunch`, dopo `setWizStep(1);` (riga 1631), aggiungere `setWizCampaignId(null);`; e nell'`onClick` del bottone "Annulla" del wizard, cambiare in `() => { setWizCampaignId(null); setView('invio-massivo'); }`.

- [ ] **Step 9: `handleWizLaunch` deve riusare `wizCampaignId` se presente**

Il metodo attuale (`App.tsx:1549-1564`) crea SEMPRE una nuova campagna con `POST /campaigns`. Se l'utente ha già salvato una bozza (`wizCampaignId` valorizzato) e arriva al lancio, va aggiornata quella campagna invece di crearne una seconda. Modificare l'inizio di `handleWizLaunch` (dopo la costruzione di `channelConfig`, riga 1547):

```tsx
      let campaignObj: { id: string };
      if (wizCampaignId) {
        const patchRes = await fetch(`${API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: wizName, description: wizDesc || wizSubject || wizName, channelConfig }),
        });
        if (!patchRes.ok) throw new Error('Errore durante l\'aggiornamento della bozza');
        campaignObj = { id: wizCampaignId };
      } else {
        const res = await fetch(`${API_BASE}/campaigns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: wizName, description: wizDesc || wizSubject || wizName, channelType: wizChannel, channelConfig }),
        });
        if (!res.ok) throw new Error('Errore durante la creazione della campagna');
        campaignObj = await res.json();
      }
```

(questo sostituisce il blocco `const res = await fetch(...)` + `if (!res.ok) ...` + `const campaignObj = await res.json();` esistente alle righe 1549-1564.)

- [ ] **Step 10: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
Aprire il wizard, compilare solo il passo 1, cliccare "Salva bozza", verificare in lista campagne che compaia una riga DRAFT. Cliccare "Riprendi": verificare che nome/canale/mittente siano precompilati. Completare fino al passo 5 e lanciare: verificare che NON si crei una seconda campagna duplicata (controllare `GET /campaigns` conta invariata rispetto a prima del lancio).

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/campaigns apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): salva bozza campagna ad ogni step del wizard, riprendi con prefill completo"
```

---

### Task 5: Dashboard creazione Template

**Contesto:** oggi non esiste alcuna persistenza di "template" riusabili — oggetto/corpo vivono solo dentro `Campaign.channelConfig` di ogni singola campagna (nessun riuso). Serve una entity `Template` con due tipologie: `MAIL` (oggetto+corpo HTML, editor Tiptap già usato nel wizard) e `APP_IO` (corpo Markdown, nuovo editor dedicato). I template di tipo `MAIL` possono opzionalmente essere associati a un template `APP_IO` "gemello" per invii combinati mail+AppIO.

**Files:**
- Create: `apps/backend/src/entities/template.entity.ts`
- Create: `apps/backend/src/templates/templates.module.ts`
- Create: `apps/backend/src/templates/templates.service.ts`
- Create: `apps/backend/src/templates/templates.controller.ts`
- Create: `apps/backend/src/templates/dto/template.dto.ts`
- Create: `apps/backend/src/templates/templates.service.spec.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Modify: `apps/backend/src/app.module.ts`
- Modify: `apps/frontend-admin/package.json` (nuova dipendenza `@uiw/react-md-editor`)
- Modify: `apps/frontend-admin/src/App.tsx` (nuova vista `template-dashboard`)

**Interfaces:**
- Produce: `Template` entity (`id, type: 'MAIL'|'APP_IO', name, subject, bodyHtml, bodyMarkdown, pairedTemplateId, createdAt, updatedAt`).
- Produce: `TemplatesService.list()`, `.create(dto)`, `.update(id, dto)`, `.remove(id)`, `.findOne(id)`.
- Produce: `GET/POST/PUT/DELETE /templates`.

- [ ] **Step 1: Entity**

```ts
// apps/backend/src/entities/template.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type TemplateType = 'MAIL' | 'APP_IO';

@Entity('templates')
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 10 })
  type!: TemplateType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  subject!: string;

  /** Popolato solo per type='MAIL' — HTML prodotto dall'editor Tiptap. */
  @Column({ name: 'body_html', type: 'text', default: '' })
  bodyHtml!: string;

  /** Popolato solo per type='APP_IO' — Markdown secondo le regole App IO. */
  @Column({ name: 'body_markdown', type: 'text', default: '' })
  bodyMarkdown!: string;

  @Column({ name: 'paired_template_id', type: 'uuid', nullable: true })
  pairedTemplateId!: string | null;

  @ManyToOne('Template', { nullable: true, onDelete: 'SET NULL' })
  pairedTemplate!: Template | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
```

- [ ] **Step 2: DTO**

```ts
// apps/backend/src/templates/dto/template.dto.ts
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { TemplateType } from '../../entities/template.entity';

export class CreateTemplateDto {
  @IsIn(['MAIL', 'APP_IO'])
  type!: TemplateType;

  @IsString() @MinLength(1) @MaxLength(128)
  name!: string;

  @IsString() @MaxLength(255)
  subject!: string;

  @ValidateIf((o) => o.type === 'MAIL')
  @IsString()
  bodyHtml?: string;

  @ValidateIf((o) => o.type === 'APP_IO')
  @IsString()
  bodyMarkdown?: string;

  @IsOptional() @IsUUID()
  pairedTemplateId?: string;
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MaxLength(255)
  subject?: string;

  @IsOptional() @IsString()
  bodyHtml?: string;

  @IsOptional() @IsString()
  bodyMarkdown?: string;

  @IsOptional() @IsUUID()
  pairedTemplateId?: string;
}
```

- [ ] **Step 3: Test del service**

```ts
// apps/backend/src/templates/templates.service.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TemplatesService } from './templates.service';
import { Template } from '../entities/template.entity';

describe('TemplatesService', () => {
  const repoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'gen-id', createdAt: new Date(), updatedAt: new Date(), ...x })),
    find: jest.fn(),
    findOneBy: jest.fn(),
  };

  let service: TemplatesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [TemplatesService, { provide: getRepositoryToken(Template), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(TemplatesService);
  });

  it('rifiuta un template MAIL senza bodyHtml', async () => {
    await expect(service.create({ type: 'MAIL', name: 'X', subject: 'Y', bodyHtml: '' } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rifiuta un template APP_IO senza bodyMarkdown', async () => {
    await expect(service.create({ type: 'APP_IO', name: 'X', subject: 'Y', bodyMarkdown: '' } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea un template MAIL valido', async () => {
    const result = await service.create({ type: 'MAIL', name: 'Avviso TARI', subject: 'Scadenza', bodyHtml: '<p>Corpo</p>' } as any);
    expect(result.type).toBe('MAIL');
    expect(result.bodyHtml).toBe('<p>Corpo</p>');
  });

  it('accoppia un template MAIL a un template APP_IO esistente', async () => {
    repoMock.findOneBy.mockResolvedValue({ id: 'io-1', type: 'APP_IO' });
    const result = await service.create({
      type: 'MAIL', name: 'Avviso TARI', subject: 'Scadenza', bodyHtml: '<p>Corpo</p>', pairedTemplateId: 'io-1',
    } as any);
    expect(result.pairedTemplateId).toBe('io-1');
  });

  it('rifiuta l accoppiamento se il template gemello non esiste', async () => {
    repoMock.findOneBy.mockResolvedValue(null);
    await expect(service.create({
      type: 'MAIL', name: 'X', subject: 'Y', bodyHtml: '<p>Z</p>', pairedTemplateId: 'missing',
    } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 4: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest templates.service --maxWorkers=2
```
Atteso: FAIL.

- [ ] **Step 5: Implementare il service**

```ts
// apps/backend/src/templates/templates.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from '../entities/template.entity';
import type { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';

@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(Template)
    private readonly repo: Repository<Template>,
  ) {}

  list(): Promise<Template[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Template> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Template ${id} non trovato`);
    return entity;
  }

  private async assertValidPairing(dto: { type: string; pairedTemplateId?: string }): Promise<void> {
    if (!dto.pairedTemplateId) return;
    const paired = await this.repo.findOneBy({ id: dto.pairedTemplateId });
    if (!paired) throw new BadRequestException('Template gemello non trovato');
    const expectedPairedType = dto.type === 'MAIL' ? 'APP_IO' : 'MAIL';
    if (paired.type !== expectedPairedType) {
      throw new BadRequestException(`Un template ${dto.type} puo essere accoppiato solo a un template ${expectedPairedType}`);
    }
  }

  async create(dto: CreateTemplateDto): Promise<Template> {
    if (dto.type === 'MAIL' && !dto.bodyHtml) {
      throw new BadRequestException('bodyHtml richiesto per template di tipo MAIL');
    }
    if (dto.type === 'APP_IO' && !dto.bodyMarkdown) {
      throw new BadRequestException('bodyMarkdown richiesto per template di tipo APP_IO');
    }
    await this.assertValidPairing(dto);

    const entity = this.repo.create({
      type: dto.type,
      name: dto.name,
      subject: dto.subject,
      bodyHtml: dto.type === 'MAIL' ? dto.bodyHtml! : '',
      bodyMarkdown: dto.type === 'APP_IO' ? dto.bodyMarkdown! : '',
      pairedTemplateId: dto.pairedTemplateId ?? null,
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<Template> {
    const entity = await this.findOne(id);
    if (dto.pairedTemplateId !== undefined) {
      await this.assertValidPairing({ type: entity.type, pairedTemplateId: dto.pairedTemplateId });
      entity.pairedTemplateId = dto.pairedTemplateId;
    }
    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.subject !== undefined) entity.subject = dto.subject;
    if (dto.bodyHtml !== undefined && entity.type === 'MAIL') entity.bodyHtml = dto.bodyHtml;
    if (dto.bodyMarkdown !== undefined && entity.type === 'APP_IO') entity.bodyMarkdown = dto.bodyMarkdown;
    return this.repo.save(entity);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException(`Template ${id} non trovato`);
  }
}
```

- [ ] **Step 6: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest templates.service --maxWorkers=2
```
Atteso: PASS.

- [ ] **Step 7: Controller e modulo**

```ts
// apps/backend/src/templates/templates.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';

@Controller('templates')
@Roles('user', 'admin')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  list() {
    return this.svc.list().then((templates) => ({ templates }));
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTemplateDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
```

```ts
// apps/backend/src/templates/templates.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template } from '../entities/template.entity';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Template])],
  controllers: [TemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
```

Registrare `TemplatesModule` in `apps/backend/src/app.module.ts` e `Template` in `apps/backend/src/database/database.module.ts` (array `entities`).

- [ ] **Step 8: Generare la migration**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddTemplates -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Registrare la migration generata in `database.module.ts` (import + array `migrations`).

- [ ] **Step 9: Aggiungere la dipendenza markdown editor**

In `apps/frontend-admin/package.json`, aggiungere in `dependencies`:

```json
    "@uiw/react-md-editor": "^4.0.4",
```

Poi seguire la procedura CLAUDE.md per nuove dipendenze:

```bash
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build frontend-admin
docker compose rm -sf frontend-admin && docker volume rm comunicapa_frontend-admin_node_modules && docker compose up -d frontend-admin
```

(verificare il nome esatto del volume `node_modules` di `frontend-admin` con `docker volume ls | grep frontend-admin` prima del comando `docker volume rm`, potrebbe differire dal nome ipotizzato qui.)

- [ ] **Step 10: Dashboard Template — lista e form**

In `apps/frontend-admin/src/App.tsx`:

Estendere `view` (riga 121) con `'template-dashboard'` e aggiungere voce di navigazione.

Aggiungere l'import in cima al file:

```tsx
import MDEditor from '@uiw/react-md-editor';
```

Aggiungere gli state:

```tsx
  interface TemplateItem {
    id: string;
    type: 'MAIL' | 'APP_IO';
    name: string;
    subject: string;
    bodyHtml: string;
    bodyMarkdown: string;
    pairedTemplateId: string | null;
  }
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<Partial<TemplateItem> & { type: 'MAIL' | 'APP_IO' } | null>(null);

  const fetchTemplates = async () => {
    const res = await fetch(`${API_BASE}/templates`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setTemplates(data.templates || []);
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTemplate) return;
    const method = editingTemplate.id ? 'PUT' : 'POST';
    const url = editingTemplate.id ? `${API_BASE}/templates/${editingTemplate.id}` : `${API_BASE}/templates`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(editingTemplate),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      alert(body?.message || 'Errore durante il salvataggio del template');
      return;
    }
    setEditingTemplate(null);
    fetchTemplates();
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('Eliminare questo template?')) return;
    await fetch(`${API_BASE}/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchTemplates();
  };
```

Aggiungere `useEffect(() => { if (token) fetchTemplates(); }, [token]);` accanto agli altri effect di caricamento.

Render della vista:

```tsx
          {view === 'template-dashboard' && (
            <div>
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h3 className="h5 fw-bold text-dark"><i className="fas fa-file-lines me-2"></i>Template</h3>
                {!editingTemplate && (
                  <div className="btn-group">
                    <button className="btn btn-sm btn-primary" onClick={() => setEditingTemplate({ type: 'MAIL', name: '', subject: '', bodyHtml: '', bodyMarkdown: '', pairedTemplateId: null })}>
                      <i className="fas fa-plus me-1"></i>Nuovo Template Mail/PEC
                    </button>
                    <button className="btn btn-sm btn-outline-primary" onClick={() => setEditingTemplate({ type: 'APP_IO', name: '', subject: '', bodyHtml: '', bodyMarkdown: '', pairedTemplateId: null })}>
                      <i className="fas fa-plus me-1"></i>Nuovo Template App IO
                    </button>
                  </div>
                )}
              </div>

              {!editingTemplate ? (
                <div className="card shadow-sm">
                  <table className="table table-sm mb-0">
                    <thead><tr><th>Nome</th><th>Tipo</th><th>Oggetto</th><th>Gemello</th><th className="text-end">Azioni</th></tr></thead>
                    <tbody>
                      {templates.map(t => (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td><span className="badge bg-light text-dark border">{t.type}</span></td>
                          <td className="small text-muted">{t.subject}</td>
                          <td className="small">{t.pairedTemplateId ? templates.find(x => x.id === t.pairedTemplateId)?.name || '—' : '—'}</td>
                          <td className="text-end">
                            <button className="btn btn-sm btn-outline-primary me-1" onClick={() => setEditingTemplate(t)}><i className="fas fa-edit"></i></button>
                            <button className="btn btn-sm btn-outline-danger" onClick={() => handleDeleteTemplate(t.id)}><i className="fas fa-trash"></i></button>
                          </td>
                        </tr>
                      ))}
                      {templates.length === 0 && <tr><td colSpan={5} className="text-center text-muted py-3">Nessun template creato</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : (
                <form onSubmit={handleSaveTemplate} className="card shadow-sm p-4">
                  <h5 className="fw-bold mb-3">{editingTemplate.id ? 'Modifica' : 'Nuovo'} Template ({editingTemplate.type === 'MAIL' ? 'Mail/PEC' : 'App IO'})</h5>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Nome</label>
                    <input className="form-control form-control-sm" required value={editingTemplate.name || ''} onChange={e => setEditingTemplate({ ...editingTemplate, name: e.target.value })} />
                  </div>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Oggetto</label>
                    <input className="form-control form-control-sm" required value={editingTemplate.subject || ''} onChange={e => setEditingTemplate({ ...editingTemplate, subject: e.target.value })} />
                  </div>
                  {editingTemplate.type === 'MAIL' ? (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Corpo (HTML)</label>
                      <TemplateEditor
                        value={editingTemplate.bodyHtml || ''}
                        onChange={(v) => setEditingTemplate({ ...editingTemplate, bodyHtml: v })}
                        placeholders={[
                          { label: 'Nominativo', token: '%nominativo%' },
                          { label: 'Codice Fiscale', token: '%codice_fiscale%' },
                        ]}
                      />
                    </div>
                  ) : (
                    <div className="mb-3" data-color-mode="light">
                      <label className="form-label small fw-bold">Corpo (Markdown App IO)</label>
                      <MDEditor
                        value={editingTemplate.bodyMarkdown || ''}
                        onChange={(v) => setEditingTemplate({ ...editingTemplate, bodyMarkdown: v || '' })}
                        height={300}
                      />
                      <div className="form-text small text-muted">
                        Sintassi supportata: grassetto, corsivo, elenchi, link. Vedi la guida ufficiale App IO al markdown.
                      </div>
                    </div>
                  )}
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Template gemello (invio combinato)</label>
                    <select className="form-select form-select-sm" value={editingTemplate.pairedTemplateId || ''} onChange={e => setEditingTemplate({ ...editingTemplate, pairedTemplateId: e.target.value || null })}>
                      <option value="">Nessuno</option>
                      {templates.filter(t => t.type !== editingTemplate.type).map(t => (
                        <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
                      ))}
                    </select>
                  </div>
                  <div className="d-flex justify-content-end gap-2">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setEditingTemplate(null)}>Annulla</button>
                    <button type="submit" className="btn btn-primary">Salva Template</button>
                  </div>
                </form>
              )}
            </div>
          )}
```

- [ ] **Step 11: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 12: Verifica manuale**

```bash
docker compose up -d --build backend frontend-admin
```
Creare un template Mail/PEC con Tiptap, un template App IO con Markdown, accoppiarli come gemelli, verificare che ricompaiano correttamente dopo un F5 (persistiti su DB, non su localStorage).

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/entities/template.entity.ts apps/backend/src/templates apps/backend/src/database apps/backend/src/app.module.ts apps/frontend-admin/package.json apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): dashboard template Mail/PEC (Tiptap) e App IO (Markdown) con accoppiamento gemello"
```
