# Correzione contenuto campagna + resend sicuro (errata corrige) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** permettere di correggere `subject`/`body` di una campagna già lanciata (storicizzando la versione precedente) e rimandare il contenuto corretto SOLO ai destinatari per cui è sicuro farlo — mai un secondo invio POSTAL/SEND.

**Architecture:** la logica di invio App IO (oggi privata dentro `NotificationProcessor`) viene estratta in `AppIoDeliveryService`, condiviso tra il processor esistente (co-consegna inline) e un nuovo `CampaignContentCorrectionService` che classifica ogni destinatario in base al canale effettivo del suo ultimo attempt e decide l'azione sicura: canale già "sicuro" (PEC/EMAIL/APP_IO) → riusa `retryRecipient()` esistente; canale POSTAL/SEND con co-consegna App IO pregressa → richiama solo `AppIoDeliveryService`, merge sul `responsePayload` esistente, mai un secondo invio del canale primario.

**Tech Stack:** NestJS 10, TypeORM 0.3, Jest (`--maxWorkers=2`), React 19 (frontend-admin, `App.tsx`).

## Global Constraints

- Backend gira SOLO in Docker — `docker compose exec backend ...`, nessun comando `node`/`pnpm` sull'host.
- Test: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2 <pattern>`; suite COMPLETA obbligatoria dopo ogni modifica a firma di costruttore (vedi Task 2).
- Type-check: `docker compose exec backend node_modules/.bin/tsc --noEmit` / `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`.
- **Nessuna azione di questa feature accoda mai un job sul canale POSTAL o SEND** — vincolo non negoziabile, verificato esplicitamente nei test del Task 5.
- Mai un update che sovrascrive l'intero `responsePayload`/`channelConfig` quando serve solo aggiornare una parte — sempre merge esplicito (`{ ...existing, chiave: nuovoValore }`).
- Ogni nuovo parametro di costruttore va accompagnato dall'audit degli spec file che istanziano quella classe (CLAUDE.md, "Nuova dependency in un costruttore").

---

## File Structure

**Nuovi file:**
- `apps/backend/src/channels/app-io/app-io-delivery.service.ts` + `.spec.ts`
- `apps/backend/src/campaigns/channel-outcome.util.ts` + `.spec.ts`
- `apps/backend/src/campaigns/campaign-content-correction.service.ts` + `.spec.ts`
- `apps/backend/src/campaigns/dto/update-campaign-content.dto.ts`

**File modificati:**
- `apps/backend/src/queue/notification.processor.ts` — usa `AppIoDeliveryService` invece dei metodi privati.
- `apps/backend/src/queue/notification.processor.spec.ts` — nuovo provider nel testing module.
- `apps/backend/src/channels/channel.module.ts` — esporta `AppIoDeliveryService`.
- `apps/backend/src/campaigns/campaigns.service.ts` — estrae `getChannelBreakdown` sul nuovo util, aggiunge `getRecipientIdsByChannelOutcome`, `updateCampaignContent`.
- `apps/backend/src/campaigns/campaigns.module.ts` — importa `ChannelModule`, registra `CampaignContentCorrectionService`.
- `apps/backend/src/campaigns/campaigns.controller.ts` — 3 nuovi endpoint.
- `apps/backend/src/campaigns/campaigns.controller.spec.ts` / `campaigns.service.spec.ts` — nuovi test.
- `apps/frontend-admin/src/App.tsx` — form correzione contenuto + storico + bottoni "Rimanda a questi N".

---

### Task 1: `AppIoDeliveryService` — estrazione da `NotificationProcessor`

**Files:**
- Create: `apps/backend/src/channels/app-io/app-io-delivery.service.ts`
- Test: `apps/backend/src/channels/app-io/app-io-delivery.service.spec.ts`
- Modify: `apps/backend/src/channels/channel.module.ts`

**Interfaces:**
- Produces:
  - `class AppIoDeliveryService { constructor(config: ConfigService<AppConfiguration, true>, settings: AppSettingsService) }`
  - `checkProfile(baseUrl: string, apiKey: string, fiscalCode: string, onLog?: ChannelLogFn): Promise<boolean>`
  - `sendMessage(campaign: Campaign, recipient: Recipient, appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string }, onLog?: ChannelLogFn, parallelPrimaryChannel?: NotificationChannel): Promise<{ success: boolean; messageId?: string; error?: string }>`
- Consumes: `ChannelLogFn`/`IChannelStrategy` da `../channel.interface`, `processTemplate`/`buildParallelChannelNotice`/`formatAppIoMarkdown`/`resolveCitizenPortalUrl` da `../template.helper`, `resolveAttachmentsConfig`/`resolveAttachmentLabel` da `../../attachments/attachment.service`, `getEffectiveRetentionDays` da `../../campaigns/retention.util`, `resolvePaymentData` da `../payment-config.util`.

Usata da: Task 2 (`NotificationProcessor`), Task 5 (`CampaignContentCorrectionService`).

- [ ] **Step 1: Scrivere i test**

```ts
import { ConfigService } from '@nestjs/config';
import { AppIoDeliveryService } from './app-io-delivery.service';

describe('AppIoDeliveryService', () => {
  let config: any;
  let settings: any;
  let service: AppIoDeliveryService;
  const originalFetch = global.fetch;

  const campaign = {
    id: 'camp-1', name: 'TARI', channelType: 'POSTAL',
    channelConfig: { subject: 'Oggetto campagna', body: 'Corpo campagna' },
  } as any;
  const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi' } as any;

  beforeEach(() => {
    config = { get: jest.fn(() => 'secret') };
    settings = {
      get: jest.fn(async (key: string) => {
        if (key === 'system.publicUrl') return 'https://example.it';
        if (key === 'retention.maxDays') return 30;
        return null;
      }),
    };
    service = new AppIoDeliveryService(config, settings);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('checkProfile', () => {
    it('sender_allowed true → true', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ sender_allowed: true }) }) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(true);
    });

    it('404 (profilo mai attivato) → false, nessun log di errore rumoroso', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(false);
    });

    it('eccezione di rete → false, non propaga', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
      await expect(service.checkProfile('https://api.io', 'key', 'RSSMRA85M01H501Z')).resolves.toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('successo: usa subjectOverride/bodyOverride quando presenti', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-1' }) }) as any;
      const result = await service.sendMessage(campaign, recipient, {
        apiKey: 'key', baseUrl: 'https://api.io', subjectOverride: 'Oggetto App IO', bodyOverride: 'Testo App IO markdown lungo abbastanza per superare il minimo di ottanta caratteri richiesto da PagoPA.',
      });
      expect(result).toEqual({ success: true, messageId: 'io-msg-1' });
      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.content.subject).toBe('Oggetto App IO');
      expect(body.content.markdown).toContain('Testo App IO markdown');
    });

    it('senza override: fallback su channelConfig.subject/body', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-2' }) }) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(true);
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.content.subject).toBe('Oggetto campagna');
      expect(body.content.markdown).toContain('Corpo campagna');
    });

    it('HTTP non-ok da PagoPA → success:false con dettaglio errore', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid message structure' }) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    it('parallelPrimaryChannel: inserisce il notice di cortesia nel markdown', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'io-msg-3' }) }) as any;
      await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' }, undefined, 'PEC');
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.content.markdown.toLowerCase()).toContain('pec');
    });

    it('eccezione di rete → success:false, non propaga', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
      const result = await service.sendMessage(campaign, recipient, { apiKey: 'key', baseUrl: 'https://api.io' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNRESET');
    });
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest app-io-delivery --maxWorkers=2`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Creare il service (copia dei due metodi privati esistenti, resi pubblici)**

Copiare in `app-io-delivery.service.ts` il corpo di `checkAppIoProfile` (righe 311-349 di `notification.processor.ts`, rinominato `checkProfile`, log via `this.logger` locale invece del logger del processor) e di `sendAppIoMessage` (righe 351-438, rinominato `sendMessage`) **verbatim** — nessuna modifica di comportamento, solo spostamento + firma pubblica:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@comunicapa/shared-types';
import type { ChannelLogFn } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import type { AppConfiguration } from '../../config/configuration';
import { processTemplate, buildParallelChannelNotice, formatAppIoMarkdown, resolveCitizenPortalUrl } from '../template.helper';
import { resolveAttachmentsConfig, resolveAttachmentLabel } from '../../attachments/attachment.service';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
import { AppSettingsService } from '../../settings/app-settings.service';
import { resolvePaymentData } from '../payment-config.util';

@Injectable()
export class AppIoDeliveryService {
  private readonly logger = new Logger(AppIoDeliveryService.name);

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
  ) {}

  async checkProfile(
    baseUrl: string,
    apiKey: string,
    fiscalCode: string,
    onLog?: ChannelLogFn,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/v1/profiles/${fiscalCode}`, {
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      });
      if (!res.ok) {
        const detail = res.status === 404 ? '' : await res.text().catch(() => '');
        const msg = `Profilo App IO non disponibile per CF ${fiscalCode}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        this.logger.debug(msg);
        onLog?.(msg);
        return false;
      }
      const data = (await res.json()) as { sender_allowed: boolean };
      if (!data?.sender_allowed) {
        const msg = `Cittadino CF ${fiscalCode} ha disabilitato i messaggi da questo servizio App IO`;
        this.logger.debug(msg);
        onLog?.(msg);
      }
      return !!data?.sender_allowed;
    } catch (err: any) {
      const msg = `Verifica profilo App IO fallita per CF ${fiscalCode}: ${err?.message ?? err}`;
      this.logger.warn(msg);
      onLog?.(msg);
      return false;
    }
  }

  async sendMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
    onLog?: ChannelLogFn,
    parallelPrimaryChannel?: NotificationChannel,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const publicApiUrl = await this.settings.get<string>('system.publicUrl');
      const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
      const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
      const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
      const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => resolveAttachmentLabel(a, recipient));
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'APP_IO',
      );
      const rawMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'markdown', 'APP_IO',
      );

      const portalUrl = await resolveCitizenPortalUrl(this.settings);
      const parallelNotice = parallelPrimaryChannel
        ? buildParallelChannelNotice(recipient, parallelPrimaryChannel, campaign.channelConfig?.['physicalAddressConfig'] as Record<string, unknown> | undefined)
        : undefined;
      const processedMarkdown = formatAppIoMarkdown(rawMarkdown, { parallelNotice, portalUrl });

      const contentPayload: Record<string, any> = { subject: processedSubject, markdown: processedMarkdown };

      const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
      const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
      if (resolvedPayment?.noticeCode && resolvedPayment.amountCents != null) {
        const paymentData: Record<string, any> = {
          amount: resolvedPayment.amountCents,
          notice_number: resolvedPayment.noticeCode,
          invalid_after_due_date: true,
        };
        if (resolvedPayment.creditorTaxId) paymentData.payee = { fiscal_code: resolvedPayment.creditorTaxId };
        contentPayload.payment_data = paymentData;
      }
      if (resolvedPayment?.dueDateIso) contentPayload.due_date = resolvedPayment.dueDateIso;

      onLog?.(`Invio App IO (co-delivery) a CF ${recipient.codiceFiscale}: markdown length=${processedMarkdown.length}`);
      const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
        body: JSON.stringify({ fiscal_code: recipient.codiceFiscale, content: contentPayload }),
      });
      onLog?.(`Risposta App IO (co-delivery) per CF ${recipient.codiceFiscale}: HTTP ${appIoRes.status}`);

      if (!appIoRes.ok) {
        const detail = await appIoRes.text().catch(() => '');
        const error = `App IO status: ${appIoRes.status}${detail ? ` — ${detail}` : ''}`;
        onLog?.(error);
        return { success: false, error };
      }
      const appIoData = (await appIoRes.json()) as { id: string };
      return { success: true, messageId: appIoData.id };
    } catch (err: any) {
      onLog?.(`Eccezione invio App IO (co-delivery) per CF ${recipient.codiceFiscale}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest app-io-delivery --maxWorkers=2`
Expected: PASS (8 test).

- [ ] **Step 5: Esportare il service da `ChannelModule`**

In `apps/backend/src/channels/channel.module.ts`: import `AppIoDeliveryService` da `./app-io/app-io-delivery.service`, aggiungerlo a `providers: [...]` e a `exports: [CHANNEL_STRATEGIES, CampaignCompletionService, AppIoDeliveryService]`.

- [ ] **Step 6: Type-check e commit**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

```bash
git add apps/backend/src/channels/app-io/app-io-delivery.service.ts apps/backend/src/channels/app-io/app-io-delivery.service.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(app-io): estrae AppIoDeliveryService, riusabile fuori dal processor"
```

---

### Task 2: `NotificationProcessor` — consuma `AppIoDeliveryService`

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Modify: `apps/backend/src/queue/notification.processor.spec.ts`

**Interfaces:**
- Consumes: `AppIoDeliveryService.checkProfile`/`sendMessage` (Task 1).
- Produces: `new NotificationProcessor(attemptRepo, campaignRepo, recipientRepo, strategies, config, settings, redis, mailConfigs, ioServices, campaignCompletion, appIoDelivery)` — **11° parametro nuovo**.

Nessun cambio di comportamento: il processor delega, stesso identico output. I test esistenti mockano `global.fetch` direttamente (integrazione con la vera implementazione, non con un mock del service) — restano validi registrando il **vero** `AppIoDeliveryService` nel testing module (non un mock), zero modifiche al corpo degli oltre 15 test App IO già presenti.

- [ ] **Step 1: Aggiungere il provider nello spec esistente**

In `apps/backend/src/queue/notification.processor.spec.ts`, import in testa:
```ts
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
```
Nel `providers: [...]` del `Test.createTestingModule` (dentro `beforeEach`), aggiungere:
```ts
        AppIoDeliveryService,
```
(provider reale, non `useValue` — usa gli stessi `mockConfig`/`mockSettings` già forniti come `ConfigService`/`AppSettingsService`, risolti automaticamente da Nest DI).

- [ ] **Step 2: Eseguire la suite, verificare che fallisca (metodi privati ancora presenti, nessun uso del nuovo service)**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: PASS ancora (il processor non è stato toccato) — questo step è solo per confermare che il nuovo provider non rompe nulla prima di modificare l'implementazione. Se fallisce, controllare che `mockConfig`/`mockSettings` implementino l'interfaccia minima usata da `AppIoDeliveryService` (`get()`).

- [ ] **Step 3: Modificare il processor per usare il service**

In `apps/backend/src/queue/notification.processor.ts`:

Import: rimuovere `processTemplate, buildParallelChannelNotice, formatAppIoMarkdown, resolveCitizenPortalUrl` se non più usati altrove nel file (verificare con grep prima di rimuovere — `processTemplate` potrebbe servire altrove nel file per altri canali; se sì, lasciare l'import e rimuovere solo quanto diventa inutilizzato), `resolveAttachmentsConfig, resolveAttachmentLabel` idem, `resolvePaymentData` idem. Aggiungere:
```ts
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
```

Costruttore: aggiungere `private readonly appIoDelivery: AppIoDeliveryService,` come ultimo parametro.

Sostituire le 2 chiamate a `this.checkAppIoProfile(...)` (righe 178, 234) con `this.appIoDelivery.checkProfile(...)` (stessi argomenti, `APP_IO_BASE_URL` resta locale al processor — nessun cambio di firma).

Sostituire le 2 chiamate a `this.sendAppIoMessage(...)` (righe 182, 240) con `this.appIoDelivery.sendMessage(...)` (stessi argomenti).

Rimuovere i due metodi privati `checkAppIoProfile` (righe 311-349) e `sendAppIoMessage` (righe 351-438) dalla classe — spostati in `AppIoDeliveryService`.

- [ ] **Step 4: Eseguire la suite, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: PASS, stesso numero di test di prima (zero test rimossi, zero comportamento diverso).

- [ ] **Step 5: Suite completa + type-check (audit costruttore modificato)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (`app.controller.spec.ts` `isLdapMock`), nessuna regressione — confermare con `grep -rn "new NotificationProcessor(" apps/backend/src` che non esistano altre istanziazioni dirette da aggiornare.

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts
git commit -m "refactor(queue): NotificationProcessor usa AppIoDeliveryService condiviso"
```

---

### Task 3: `channel-outcome.util.ts` — classificazione estratta e riusabile

**Files:**
- Create: `apps/backend/src/campaigns/channel-outcome.util.ts`
- Test: `apps/backend/src/campaigns/channel-outcome.util.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`getChannelBreakdown` usa il nuovo util)

**Interfaces:**
- Produces:
  - `type ChannelOutcome = 'primaryOnly' | 'both' | 'appIoOnly' | 'appIoDespitePrimaryFail' | 'neither'`
  - `classifyChannelOutcome(recipientStatus: RecipientStatus, responsePayload: Record<string, unknown> | null | undefined): ChannelOutcome | null` (ritorna `null` se il destinatario non è in uno stato classificabile, cioè non `SENT`/`FAILED` — stesso filtro già presente in `getChannelBreakdown`)
- Consumes: `RecipientStatus` da `../entities/recipient.entity`.

Usata da: `getChannelBreakdown` (refactor, Task 3), `getRecipientIdsByChannelOutcome` (Task 4).

- [ ] **Step 1: Scrivere i test (stessa logica già verificata in `campaigns.service.spec.ts` per `getChannelBreakdown`, isolata sulla funzione pura)**

```ts
import { RecipientStatus } from '../entities/recipient.entity';
import { classifyChannelOutcome } from './channel-outcome.util';

describe('classifyChannelOutcome', () => {
  it('primario riuscito, nessun appIo → primaryOnly', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, {})).toBe('primaryOnly');
  });

  it('primario riuscito + appIo riuscito → both', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, { appIo: { success: true } })).toBe('both');
  });

  it('consegnato SOLO via appIo esclusiva (deliveredVia) → appIoOnly', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, { deliveredVia: 'APP_IO', appIo: { success: true } })).toBe('appIoOnly');
  });

  it('primario fallito ma appIo riuscito → appIoDespitePrimaryFail', () => {
    expect(classifyChannelOutcome(RecipientStatus.FAILED, { appIo: { success: true } })).toBe('appIoDespitePrimaryFail');
  });

  it('nessuno dei due riuscito → neither', () => {
    expect(classifyChannelOutcome(RecipientStatus.FAILED, {})).toBe('neither');
  });

  it('stato non classificabile (PENDING/QUEUED) → null', () => {
    expect(classifyChannelOutcome(RecipientStatus.PENDING, {})).toBeNull();
    expect(classifyChannelOutcome(RecipientStatus.QUEUED, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest channel-outcome --maxWorkers=2`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Implementare l'util (stessa logica già in `getChannelBreakdown`, righe 1173-1185)**

```ts
import { RecipientStatus } from '../entities/recipient.entity';

export type ChannelOutcome = 'primaryOnly' | 'both' | 'appIoOnly' | 'appIoDespitePrimaryFail' | 'neither';

export function classifyChannelOutcome(
  recipientStatus: RecipientStatus,
  responsePayload: Record<string, unknown> | null | undefined,
): ChannelOutcome | null {
  if (recipientStatus !== RecipientStatus.SENT && recipientStatus !== RecipientStatus.FAILED) return null;

  const appIo = responsePayload?.['appIo'] as { success?: boolean } | undefined;
  const deliveredViaAppIo = responsePayload?.['deliveredVia'] === 'APP_IO';
  const appIoSucceeded = !!appIo?.success;
  const primarySucceeded = recipientStatus === RecipientStatus.SENT && !deliveredViaAppIo;

  if (primarySucceeded && appIoSucceeded) return 'both';
  if (primarySucceeded) return 'primaryOnly';
  if (deliveredViaAppIo && appIoSucceeded) return 'appIoOnly';
  if (recipientStatus === RecipientStatus.FAILED && appIoSucceeded) return 'appIoDespitePrimaryFail';
  return 'neither';
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest channel-outcome --maxWorkers=2`
Expected: PASS (6 test).

- [ ] **Step 5: Refactor `getChannelBreakdown` per usare l'util**

In `apps/backend/src/campaigns/campaigns.service.ts`, import `classifyChannelOutcome` da `./channel-outcome.util`. Sostituire il corpo del loop (righe 1173-1185):

```ts
    for (const r of toClassify) {
      const payload = payloadByRecipient.get(r.id);
      const outcome = classifyChannelOutcome(r.status, payload);
      if (outcome) breakdown[outcome]++;
    }
    return breakdown;
```

(rimuovere le variabili locali `payload`/`appIo`/`deliveredViaAppIo`/`appIoSucceeded`/`primarySucceeded` ora inutilizzate in questo metodo).

- [ ] **Step 6: Eseguire la suite `campaigns.service.spec.ts` esistente sui test di `getChannelBreakdown`, verificare che passi senza modifiche**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getChannelBreakdown" --maxWorkers=2`
Expected: PASS, stesso comportamento — nessuna modifica ai test esistenti necessaria (refactor puro).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/channel-outcome.util.ts apps/backend/src/campaigns/channel-outcome.util.spec.ts apps/backend/src/campaigns/campaigns.service.ts
git commit -m "refactor(campaigns): estrae classifyChannelOutcome, riusabile fuori da getChannelBreakdown"
```

---

### Task 4: `getRecipientIdsByChannelOutcome` — lista ID per categoria

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `classifyChannelOutcome` (Task 3).
- Produces: `CampaignsService.getRecipientIdsByChannelOutcome(campaignId: string, outcome: ChannelOutcome): Promise<string[]>`, endpoint `GET admin/campaigns/:id/recipients-by-channel-outcome?outcome=<key>`.

Usato da: UI (Task 8), non necessario dal resto del backend.

- [ ] **Step 1: Scrivere i test del service**

Aggiungere in `campaigns.service.spec.ts`, vicino ai test esistenti di `getChannelBreakdown`:

```ts
describe('getRecipientIdsByChannelOutcome', () => {
  it('ritorna solo gli id dei destinatari che matchano la categoria richiesta', async () => {
    recipientRepo.find.mockResolvedValue([
      { id: 'r1', status: RecipientStatus.SENT },
      { id: 'r2', status: RecipientStatus.SENT },
      { id: 'r3', status: RecipientStatus.FAILED },
    ]);
    attemptRepo.find.mockResolvedValue([
      { recipientId: 'r1', responsePayload: { appIo: { success: true } } },
      { recipientId: 'r2', responsePayload: {} },
      { recipientId: 'r3', responsePayload: { appIo: { success: true } } },
    ]);

    const ids = await service.getRecipientIdsByChannelOutcome('camp-1', 'both');

    expect(ids).toEqual(['r1']);
  });

  it('campagna inesistente → NotFoundException', async () => {
    campaignRepo.findOneBy.mockResolvedValue(null);
    await expect(service.getRecipientIdsByChannelOutcome('camp-x', 'both')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getRecipientIdsByChannelOutcome" --maxWorkers=2`
Expected: FAIL — metodo non esiste.

- [ ] **Step 3: Implementare il metodo**

In `campaigns.service.ts`, subito dopo `getChannelBreakdown` (dopo la sua chiusura):

```ts
  async getRecipientIdsByChannelOutcome(campaignId: string, outcome: ChannelOutcome): Promise<string[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'status'],
    });
    const toClassify = recipients.filter(
      (r) => r.status === RecipientStatus.SENT || r.status === RecipientStatus.FAILED,
    );
    if (toClassify.length === 0) return [];

    const firstAttempts = await this.attemptRepo.find({
      where: { recipientId: In(toClassify.map((r) => r.id)), attemptNumber: 1 },
      select: ['recipientId', 'responsePayload'],
    });
    const payloadByRecipient = new Map(firstAttempts.map((a) => [a.recipientId, a.responsePayload]));

    return toClassify
      .filter((r) => classifyChannelOutcome(r.status, payloadByRecipient.get(r.id)) === outcome)
      .map((r) => r.id);
  }
```

Import `ChannelOutcome` come type da `./channel-outcome.util` in testa al file.

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getRecipientIdsByChannelOutcome" --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Endpoint controller**

In `campaigns.controller.ts`, dopo `getChannelBreakdown` (`@Get(':id/channel-stats')`):

```ts
  @Get(':id/recipients-by-channel-outcome')
  getRecipientIdsByChannelOutcome(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('outcome') outcome: string,
  ) {
    const valid: ChannelOutcome[] = ['primaryOnly', 'both', 'appIoOnly', 'appIoDespitePrimaryFail', 'neither'];
    if (!valid.includes(outcome as ChannelOutcome)) {
      throw new BadRequestException(`outcome deve essere uno tra: ${valid.join(', ')}`);
    }
    return this.campaignsService
      .getRecipientIdsByChannelOutcome(id, outcome as ChannelOutcome)
      .then((recipientIds) => ({ recipientIds }));
  }
```

Import `ChannelOutcome` come type da `./channel-outcome.util` (nuovo import in testa al controller).

- [ ] **Step 6: Test controller**

Aggiungere in `campaigns.controller.spec.ts`:

```ts
it('recipients-by-channel-outcome: outcome non valido → BadRequestException', () => {
  expect(() => controller.getRecipientIdsByChannelOutcome('camp-1', 'invalid' as any)).toThrow(BadRequestException);
});

it('recipients-by-channel-outcome: delega al service con outcome valido', async () => {
  campaignsService.getRecipientIdsByChannelOutcome = jest.fn(async () => ['r1', 'r2']);
  const result = await controller.getRecipientIdsByChannelOutcome('camp-1', 'both');
  expect(campaignsService.getRecipientIdsByChannelOutcome).toHaveBeenCalledWith('camp-1', 'both');
  expect(result).toEqual({ recipientIds: ['r1', 'r2'] });
});
```

- [ ] **Step 7: Eseguire, type-check, commit**

Run: `docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2`
Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(campaigns): endpoint recipients-by-channel-outcome"
```

---

### Task 5: Correzione contenuto con storico — `updateCampaignContent`

**Files:**
- Create: `apps/backend/src/campaigns/dto/update-campaign-content.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Produces:
  - `UpdateCampaignContentDto { subject?: string; body?: string }`
  - `CampaignsService.updateCampaignContent(campaignId: string, dto: UpdateCampaignContentDto, changedBy: string): Promise<Campaign>`
  - `PATCH admin/campaigns/:id/content`

- [ ] **Step 1: DTO**

```ts
import { IsOptional, IsString } from 'class-validator';

export class UpdateCampaignContentDto {
  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  body?: string;
}
```

- [ ] **Step 2: Scrivere i test del service**

Aggiungere in `campaigns.service.spec.ts`:

```ts
describe('updateCampaignContent', () => {
  it('campagna non terminale → BadRequestException', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', status: CampaignStatus.RUNNING, channelConfig: {} });
    await expect(service.updateCampaignContent('camp-1', { body: 'nuovo' }, 'op')).rejects.toThrow(BadRequestException);
  });

  it('né subject né body → BadRequestException', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', status: CampaignStatus.COMPLETED, channelConfig: {} });
    await expect(service.updateCampaignContent('camp-1', {}, 'op')).rejects.toThrow(BadRequestException);
  });

  it('storicizza la versione precedente prima di sovrascrivere, merge senza toccare altre chiavi', async () => {
    const campaign = {
      id: 'camp-1', status: CampaignStatus.COMPLETED,
      channelConfig: { subject: 'Vecchio oggetto', body: '', postalServiceType: 'RaccomandataMarket4' },
    };
    campaignRepo.findOneBy.mockResolvedValue(campaign);
    campaignRepo.save.mockImplementation(async (c: any) => c);

    const saved = await service.updateCampaignContent('camp-1', { subject: 'Nuovo oggetto', body: 'Nuovo testo' }, 'admin1');

    expect(saved.channelConfig.subject).toBe('Nuovo oggetto');
    expect(saved.channelConfig.body).toBe('Nuovo testo');
    expect(saved.channelConfig.postalServiceType).toBe('RaccomandataMarket4'); // non toccato
    expect(saved.channelConfig.contentHistory).toEqual([
      expect.objectContaining({ subject: 'Vecchio oggetto', body: '', changedBy: 'admin1' }),
    ]);
  });

  it('seconda correzione: accoda in history senza perdere la prima voce', async () => {
    const campaign = {
      id: 'camp-1', status: CampaignStatus.COMPLETED,
      channelConfig: {
        subject: 'Secondo oggetto', body: 'Secondo testo',
        contentHistory: [{ subject: 'Primo oggetto', body: 'Primo testo', changedBy: 'admin1', changedAt: '2026-07-28T10:00:00.000Z' }],
      },
    };
    campaignRepo.findOneBy.mockResolvedValue(campaign);
    campaignRepo.save.mockImplementation(async (c: any) => c);

    const saved = await service.updateCampaignContent('camp-1', { body: 'Terzo testo' }, 'admin2');

    expect(saved.channelConfig.contentHistory).toHaveLength(2);
    expect(saved.channelConfig.contentHistory[0].subject).toBe('Primo oggetto');
    expect(saved.channelConfig.contentHistory[1]).toEqual(
      expect.objectContaining({ subject: 'Secondo oggetto', body: 'Secondo testo', changedBy: 'admin2' }),
    );
  });
});
```

- [ ] **Step 3: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "updateCampaignContent" --maxWorkers=2`
Expected: FAIL — metodo non esiste.

- [ ] **Step 4: Implementare il metodo**

In `campaigns.service.ts`:

```ts
  async updateCampaignContent(
    campaignId: string,
    dto: UpdateCampaignContentDto,
    changedBy: string,
  ): Promise<Campaign> {
    if (dto.subject === undefined && dto.body === undefined) {
      throw new BadRequestException('Specificare almeno subject o body da correggere');
    }
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const terminal = [CampaignStatus.COMPLETED, CampaignStatus.FAILED, CampaignStatus.CANCELLED];
    if (!terminal.includes(campaign.status)) {
      throw new BadRequestException('Il contenuto si può correggere solo su una campagna già conclusa (completata, fallita o annullata)');
    }

    const cfg = campaign.channelConfig as Record<string, any>;
    const previousEntry = {
      subject: (cfg['subject'] as string) ?? null,
      body: (cfg['body'] as string) ?? null,
      changedBy,
      changedAt: new Date().toISOString(),
    };
    const history = Array.isArray(cfg['contentHistory']) ? cfg['contentHistory'] : [];

    campaign.channelConfig = {
      ...cfg,
      contentHistory: [...history, previousEntry],
      ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
    };
    return this.campaignRepo.save(campaign);
  }
```

Import `UpdateCampaignContentDto` come type da `./dto/update-campaign-content.dto`.

- [ ] **Step 5: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "updateCampaignContent" --maxWorkers=2`
Expected: PASS (4 test).

- [ ] **Step 6: Endpoint controller**

In `campaigns.controller.ts`:

```ts
  @Patch(':id/content')
  async updateCampaignContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignContentDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const campaign = await this.campaignsService.updateCampaignContent(id, dto, req.user.username);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign.name,
      operator: req.user.username,
      action: 'CONTENT_CORRECTION',
      details: { subjectChanged: dto.subject !== undefined, bodyChanged: dto.body !== undefined },
    });
    return campaign;
  }
```

Import `UpdateCampaignContentDto` in testa al controller.

- [ ] **Step 7: Test controller**

```ts
it('PATCH content: delega al service e loggua audit', async () => {
  campaignsService.updateCampaignContent = jest.fn(async () => ({ id: 'camp-1', name: 'TARI' } as any));
  auditLogsService.log = jest.fn(async () => ({} as any));
  const result = await controller.updateCampaignContent('camp-1', { body: 'nuovo' }, { user: { username: 'admin1' } } as any);
  expect(campaignsService.updateCampaignContent).toHaveBeenCalledWith('camp-1', { body: 'nuovo' }, 'admin1');
  expect(auditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CONTENT_CORRECTION' }));
  expect(result).toEqual({ id: 'camp-1', name: 'TARI' });
});
```

- [ ] **Step 8: Eseguire, type-check, commit**

Run: `docker compose exec backend node_modules/.bin/jest campaigns --maxWorkers=2`
Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

```bash
git add apps/backend/src/campaigns/dto/update-campaign-content.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(campaigns): PATCH content con storicizzazione subject/body"
```

---

### Task 6: `CampaignContentCorrectionService` — resend sicuro per destinatario

**Files:**
- Create: `apps/backend/src/campaigns/campaign-content-correction.service.ts`
- Test: `apps/backend/src/campaigns/campaign-content-correction.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.module.ts`

**Interfaces:**
- Consumes: `CampaignsService.retryRecipient` (esistente, invariato), `AppIoDeliveryService.checkProfile`/`sendMessage` (Task 1), `resolveSecondaryAppIoConfig` (esistente, `../channels/secondary-channels.util`), `IoServicesService.resolveApiKey` (esistente).
- Produces:
  - `class CampaignContentCorrectionService { constructor(attemptRepo, recipientRepo, campaignRepo, campaignsService, appIoDelivery, ioServices) }`
  - `resendSafe(campaignId: string, recipientId: string): Promise<'resent' | 'skipped'>`
  - `resendSafeBulk(campaignId: string, recipientIds: string[]): Promise<Array<{ recipientId: string; result: 'resent' | 'skipped' | 'error'; message?: string }>>`

Il vincolo di sicurezza ("mai POSTAL/SEND") è imposto qui: `resendSafe` non accoda MAI un job su quei due canali — se l'ultimo attempt è su uno di quei due, l'unica azione possibile è il resend App IO (se già tentato), altrimenti `'skipped'`.

- [ ] **Step 1: Scrivere i test**

```ts
import { NotFoundException } from '@nestjs/common';
import { AttemptStatus } from '../entities/notification-attempt.entity';
import { RecipientStatus } from '../entities/recipient.entity';
import { CampaignContentCorrectionService } from './campaign-content-correction.service';

describe('CampaignContentCorrectionService', () => {
  let attemptRepo: any;
  let recipientRepo: any;
  let campaignRepo: any;
  let campaignsService: any;
  let appIoDelivery: any;
  let ioServices: any;
  let service: CampaignContentCorrectionService;

  const campaign = {
    id: 'camp-1', name: 'TARI', channelType: 'POSTAL',
    channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1' }] },
  };
  const recipient = { id: 'rec-1', codiceFiscale: 'RSSMRA85M01H501Z', status: RecipientStatus.SENT };

  beforeEach(() => {
    attemptRepo = { findOne: jest.fn(), update: jest.fn(async () => undefined) };
    recipientRepo = { findOne: jest.fn(async () => recipient), update: jest.fn(async () => undefined) };
    campaignRepo = { findOneBy: jest.fn(async () => campaign) };
    campaignsService = { retryRecipient: jest.fn(async () => ({ requeued: true, attemptId: 'att-new' })) };
    appIoDelivery = { checkProfile: jest.fn(async () => true), sendMessage: jest.fn(async () => ({ success: true, messageId: 'io-2' })) };
    ioServices = { resolveApiKey: jest.fn(async () => ({ apiKey: 'key', idService: 'svc-1' })) };
    service = new CampaignContentCorrectionService(attemptRepo, recipientRepo, campaignRepo, campaignsService, appIoDelivery, ioServices);
  });

  describe('resendSafe', () => {
    it('canale effettivo PEC (dirottato INAD): forza FAILED se necessario e riusa retryRecipient esistente', async () => {
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('resent');
      expect(recipientRepo.update).toHaveBeenCalledWith('rec-1', { status: RecipientStatus.FAILED });
      expect(campaignsService.retryRecipient).toHaveBeenCalledWith('camp-1', 'rec-1');
    });

    it('canale effettivo già FAILED: non tocca lo stato una seconda volta, poi retry', async () => {
      recipientRepo.findOne.mockResolvedValue({ ...recipient, status: RecipientStatus.FAILED });
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'EMAIL', attemptNumber: 1, responsePayload: {} });

      await service.resendSafe('camp-1', 'rec-1');

      expect(recipientRepo.update).not.toHaveBeenCalled();
      expect(campaignsService.retryRecipient).toHaveBeenCalled();
    });

    it('canale effettivo POSTAL con co-consegna App IO pregressa: richiama solo AppIoDeliveryService, mai retryRecipient', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
        responsePayload: { appIo: { success: true, messageId: 'io-1' }, envelope: { to: ['x'] } },
      });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('resent');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      expect(appIoDelivery.sendMessage).toHaveBeenCalled();
      // merge, non replace: envelope del canale primario resta
      expect(attemptRepo.update).toHaveBeenCalledWith('att-1', {
        responsePayload: expect.objectContaining({ envelope: { to: ['x'] }, appIo: { success: true, messageId: 'io-2' } }),
      });
    });

    it('canale effettivo SEND con co-consegna App IO pregressa: richiama solo AppIoDeliveryService, mai retryRecipient', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'SEND', attemptNumber: 1,
        responsePayload: { appIo: { success: true } },
      });
      const result = await service.resendSafe('camp-1', 'rec-1');
      expect(result).toBe('resent');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
    });

    it('canale effettivo POSTAL SENZA co-consegna App IO pregressa: skipped, nessuna azione', async () => {
      attemptRepo.findOne.mockResolvedValue({ id: 'att-1', channelType: 'POSTAL', attemptNumber: 1, responsePayload: {} });

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('skipped');
      expect(campaignsService.retryRecipient).not.toHaveBeenCalled();
      expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
    });

    it('POSTAL con appIo pregresso ma cittadino ha disattivato App IO nel frattempo: skipped', async () => {
      attemptRepo.findOne.mockResolvedValue({
        id: 'att-1', channelType: 'POSTAL', attemptNumber: 1,
        responsePayload: { appIo: { success: true } },
      });
      appIoDelivery.checkProfile.mockResolvedValue(false);

      const result = await service.resendSafe('camp-1', 'rec-1');

      expect(result).toBe('skipped');
      expect(appIoDelivery.sendMessage).not.toHaveBeenCalled();
    });

    it('nessun attempt trovato → skipped', async () => {
      attemptRepo.findOne.mockResolvedValue(null);
      const result = await service.resendSafe('camp-1', 'rec-1');
      expect(result).toBe('skipped');
    });
  });

  describe('resendSafeBulk', () => {
    it('più di 500 recipientIds → throw', async () => {
      const many = Array.from({ length: 501 }, (_, i) => `r${i}`);
      await expect(service.resendSafeBulk('camp-1', many)).rejects.toThrow();
    });

    it('un errore su un recipientId non abortisce gli altri', async () => {
      attemptRepo.findOne
        .mockResolvedValueOnce({ id: 'att-1', channelType: 'PEC', attemptNumber: 1, responsePayload: {} })
        .mockRejectedValueOnce(new Error('DB down'));

      const results = await service.resendSafeBulk('camp-1', ['rec-1', 'rec-2']);

      expect(results).toEqual([
        { recipientId: 'rec-1', result: 'resent' },
        { recipientId: 'rec-2', result: 'error', message: 'DB down' },
      ]);
    });
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaign-content-correction --maxWorkers=2`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Implementare il service**

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { CampaignsService } from './campaigns.service';
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';

const MAX_BULK_RESEND_SIZE = 500;
// Mai questi due canali: spedizione fisica/legale irreversibile — vedi spec.
const UNSAFE_TO_RESEND: readonly string[] = ['POSTAL', 'SEND'];

export interface ResendResult {
  recipientId: string;
  result: 'resent' | 'skipped' | 'error';
  message?: string;
}

@Injectable()
export class CampaignContentCorrectionService {
  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly campaignsService: CampaignsService,
    private readonly appIoDelivery: AppIoDeliveryService,
    private readonly ioServices: IoServicesService,
  ) {}

  async resendSafe(campaignId: string, recipientId: string): Promise<'resent' | 'skipped'> {
    const lastAttempt = await this.attemptRepo.findOne({
      where: { recipientId },
      order: { attemptNumber: 'DESC' },
    });
    if (!lastAttempt) return 'skipped';

    if (!UNSAFE_TO_RESEND.includes(lastAttempt.channelType)) {
      // Canale già sicuro (PEC/EMAIL/APP_IO, es. dirottato INAD): stesso
      // pattern di updateRecipientAddressAndRetry, forza FAILED solo se
      // necessario poi riusa il retry esistente, invariato.
      const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
      if (recipient && recipient.status !== RecipientStatus.FAILED) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
      }
      await this.campaignsService.retryRecipient(campaignId, recipientId);
      return 'resent';
    }

    // POSTAL/SEND: mai un secondo invio del canale primario. Unica azione
    // sicura possibile: rimandare SOLO la co-consegna App IO, se già tentata.
    const appIoPayload = lastAttempt.responsePayload?.['appIo'] as { success?: boolean } | undefined;
    if (!appIoPayload?.success) return 'skipped';

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!campaign || !recipient) return 'skipped';

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig);
    const resolved = appIoConfig ? await this.ioServices.resolveApiKey(appIoConfig.ioServiceId) : null;
    if (!resolved) return 'skipped';

    const hasProfile = await this.appIoDelivery.checkProfile(APP_IO_BASE_URL, resolved.apiKey, recipient.codiceFiscale);
    if (!hasProfile) return 'skipped';

    const newAppIoResult = await this.appIoDelivery.sendMessage(campaign, recipient, {
      apiKey: resolved.apiKey,
      baseUrl: APP_IO_BASE_URL,
      subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
      bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
    });
    if (!newAppIoResult.success) return 'skipped';

    // Merge, mai replace: envelope/dati del canale primario già scritti restano.
    await this.attemptRepo.update(lastAttempt.id, {
      responsePayload: { ...lastAttempt.responsePayload, appIo: newAppIoResult },
    });
    return 'resent';
  }

  async resendSafeBulk(campaignId: string, recipientIds: string[]): Promise<ResendResult[]> {
    if (recipientIds.length > MAX_BULK_RESEND_SIZE) {
      throw new BadRequestException(
        `Impossibile rimandare più di ${MAX_BULK_RESEND_SIZE} destinatari in una sola richiesta (richiesti: ${recipientIds.length}).`,
      );
    }
    const results: ResendResult[] = [];
    for (const recipientId of recipientIds) {
      try {
        const result = await this.resendSafe(campaignId, recipientId);
        results.push({ recipientId, result });
      } catch (e) {
        results.push({ recipientId, result: 'error', message: e instanceof Error ? e.message : 'Errore sconosciuto' });
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaign-content-correction --maxWorkers=2`
Expected: PASS (11 test).

- [ ] **Step 5: Wiring del modulo**

In `apps/backend/src/campaigns/campaigns.module.ts`: importare `ChannelModule` da `../channels/channel.module` in `imports: [...]`, aggiungere `CampaignContentCorrectionService` a `providers: [...]`.

- [ ] **Step 6: Type-check e commit**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

```bash
git add apps/backend/src/campaigns/campaign-content-correction.service.ts apps/backend/src/campaigns/campaign-content-correction.service.spec.ts apps/backend/src/campaigns/campaigns.module.ts
git commit -m "feat(campaigns): CampaignContentCorrectionService, resend sicuro mai su POSTAL/SEND"
```

---

### Task 7: Endpoint `POST admin/campaigns/:id/resend-content`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `CampaignContentCorrectionService.resendSafeBulk` (Task 6).
- Produces: `POST admin/campaigns/:id/resend-content`, body `{ recipientIds: string[] }`.

- [ ] **Step 1: Scrivere i test**

```ts
it('resend-content: recipientIds vuoto/assente → BadRequestException', () => {
  expect(() => controller.resendContent('camp-1', [], { user: { username: 'admin1' } } as any)).toThrow(BadRequestException);
  expect(() => controller.resendContent('camp-1', undefined as any, { user: { username: 'admin1' } } as any)).toThrow(BadRequestException);
});

it('resend-content: delega al service e loggua audit con il conteggio', async () => {
  contentCorrectionService.resendSafeBulk = jest.fn(async () => [
    { recipientId: 'r1', result: 'resent' },
    { recipientId: 'r2', result: 'skipped' },
  ]);
  campaignsService.findOne = jest.fn(async () => ({ id: 'camp-1', name: 'TARI' } as any));
  auditLogsService.log = jest.fn(async () => ({} as any));

  const result = await controller.resendContent('camp-1', ['r1', 'r2'], { user: { username: 'admin1' } } as any);

  expect(contentCorrectionService.resendSafeBulk).toHaveBeenCalledWith('camp-1', ['r1', 'r2']);
  expect(auditLogsService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESEND_CONTENT', details: { count: 2 } }));
  expect(result).toEqual([{ recipientId: 'r1', result: 'resent' }, { recipientId: 'r2', result: 'skipped' }]);
});
```

Nel `beforeEach` dello spec, aggiungere `contentCorrectionService` mock e passarlo al costruttore di `CampaignsController` (verificare l'ordine parametri reale nel controller dopo lo Step 2).

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller -t "resend-content" --maxWorkers=2`
Expected: FAIL — metodo/dipendenza non esiste.

- [ ] **Step 3: Implementare l'endpoint**

In `campaigns.controller.ts`, aggiungere `CampaignContentCorrectionService` al costruttore (nuovo parametro, ultimo — audit di questo file già coperto dal Task 5/7 essendo lo stesso file):

```ts
    private readonly contentCorrectionService: CampaignContentCorrectionService,
```

Import in testa. Poi il metodo (dopo `updateCampaignContent`):

```ts
  @Post(':id/resend-content')
  async resendContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('recipientIds') recipientIds: string[],
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      throw new BadRequestException('recipientIds deve essere un array non vuoto');
    }
    const results = await this.contentCorrectionService.resendSafeBulk(id, recipientIds);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RESEND_CONTENT',
      details: { count: recipientIds.length },
    });
    return results;
  }
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Suite completa, type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (`isLdapMock`), nessuna regressione.

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(campaigns): endpoint resend-content"
```

---

### Task 8: Frontend — form correzione contenuto + storico

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `PATCH admin/campaigns/:id/content` (Task 5).

- [ ] **Step 1: Stato locale**

Vicino alle altre variabili di stato del dettaglio campagna (cercare `enrichAddressEdit*`-style o `addressEditForm` per posizionamento coerente):

```ts
  const [contentCorrectionOpen, setContentCorrectionOpen] = useState(false);
  const [contentCorrectionSubject, setContentCorrectionSubject] = useState('');
  const [contentCorrectionBody, setContentCorrectionBody] = useState('');
  const [contentCorrectionSaving, setContentCorrectionSaving] = useState(false);
  const [contentCorrectionError, setContentCorrectionError] = useState<string | null>(null);
```

- [ ] **Step 2: Handler**

```ts
  const openContentCorrection = (campaign: { channelConfig?: Record<string, any> }) => {
    setContentCorrectionSubject((campaign.channelConfig?.subject as string) || '');
    setContentCorrectionBody((campaign.channelConfig?.body as string) || '');
    setContentCorrectionError(null);
    setContentCorrectionOpen(true);
  };

  const handleSaveContentCorrection = async (campaignId: string) => {
    setContentCorrectionSaving(true);
    setContentCorrectionError(null);
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/content`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: contentCorrectionSubject, body: contentCorrectionBody }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setContentCorrectionError(body.message || 'Errore durante il salvataggio');
        return;
      }
      setContentCorrectionOpen(false);
      await fetchCampaignDetail(campaignId);
    } catch {
      setContentCorrectionError('Errore di connessione durante il salvataggio');
    } finally {
      setContentCorrectionSaving(false);
    }
  };
```

- [ ] **Step 3: JSX — bottone + form + storico**

Nel dettaglio campagna, subito prima del blocco `{channelBreakdown && (...)}` (riga ~13799 in `App.tsx` prima di questo piano — verificare il numero di riga corrente dopo i task precedenti), per campagne in stato terminale:

```tsx
{['completed', 'failed', 'cancelled'].includes(campaign.status) && (
  <div className="mt-4 border-top pt-3">
    <div className="d-flex justify-content-between align-items-center mb-2">
      <h4 className="small fw-bold mb-0"><Pencil className="me-1 text-primary" size={16} />Contenuto (Oggetto/Testo)</h4>
      {!contentCorrectionOpen && (
        <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openContentCorrection(campaign)}>
          Correggi
        </button>
      )}
    </div>
    {contentCorrectionOpen ? (
      <div className="border rounded p-3 bg-light">
        <div className="mb-2">
          <label className="form-label small fw-bold">Oggetto</label>
          <input type="text" className="form-control form-control-sm" value={contentCorrectionSubject}
            onChange={(e) => setContentCorrectionSubject(e.target.value)} />
        </div>
        <div className="mb-2">
          <label className="form-label small fw-bold">Testo</label>
          <textarea className="form-control form-control-sm" rows={4} value={contentCorrectionBody}
            onChange={(e) => setContentCorrectionBody(e.target.value)} />
        </div>
        {contentCorrectionError && <div className="alert alert-danger small">{contentCorrectionError}</div>}
        <div className="d-flex gap-2">
          <button className="btn btn-sm btn-primary" type="button" disabled={contentCorrectionSaving}
            onClick={() => handleSaveContentCorrection(campaign.id)}>
            {contentCorrectionSaving ? <><Loader2 className="icon-spin me-1" size={16} />Salvataggio...</> : 'Salva correzione'}
          </button>
          <button className="btn btn-sm btn-outline-secondary" type="button" disabled={contentCorrectionSaving}
            onClick={() => setContentCorrectionOpen(false)}>
            Annulla
          </button>
        </div>
      </div>
    ) : (
      <div className="small text-muted">
        <div><strong>Oggetto:</strong> {(campaign.channelConfig?.subject as string) || <em>vuoto</em>}</div>
      </div>
    )}
    {Array.isArray(campaign.channelConfig?.contentHistory) && campaign.channelConfig.contentHistory.length > 0 && (
      <details className="mt-2 small">
        <summary className="text-muted" style={{ cursor: 'pointer' }}>Storico contenuto ({campaign.channelConfig.contentHistory.length} versioni precedenti)</summary>
        <ul className="list-unstyled mt-2">
          {campaign.channelConfig.contentHistory.map((h: any, i: number) => (
            <li key={i} className="border-bottom pb-1 mb-1">
              <div className="text-muted">{new Date(h.changedAt).toLocaleString('it-IT')} — {h.changedBy}</div>
              <div><strong>Oggetto:</strong> {h.subject || <em>vuoto</em>}</div>
              <div><strong>Testo:</strong> {h.body || <em>vuoto</em>}</div>
            </li>
          ))}
        </ul>
      </details>
    )}
  </div>
)}
```

- [ ] **Step 4: Verifica type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(campaigns-ui): form correzione contenuto con storico versioni"
```

---

### Task 9: Frontend — bottoni "Rimanda a questi N" sul widget multicanale

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET admin/campaigns/:id/recipients-by-channel-outcome?outcome=<key>` (Task 4), `POST admin/campaigns/:id/resend-content` (Task 7).

- [ ] **Step 1: Handler**

Vicino a `handleSaveContentCorrection`:

```ts
  const [resendingOutcome, setResendingOutcome] = useState<string | null>(null);

  const handleResendByOutcome = async (campaignId: string, outcome: 'both' | 'inadDiverted', count: number) => {
    if (!confirm(`Rimandare il contenuto corretto a ${count} destinatari? Il canale primario POSTAL/SEND non verrà mai ripetuto.`)) return;
    setResendingOutcome(outcome);
    try {
      // 'inadDiverted' non è una categoria di classifyChannelOutcome (è un
      // flag INAD indipendente, vedi getChannelBreakdown) — per questa
      // categoria l'elenco destinatari si ottiene filtrando lato client
      // sui destinatari con inadCheck.diverted true, non dal nuovo endpoint
      // recipients-by-channel-outcome (che copre solo le 5 categorie
      // primaryOnly/both/appIoOnly/appIoDespitePrimaryFail/neither).
      let recipientIds: string[] = [];
      if (outcome === 'both') {
        const res = await apiFetch(`/campaigns/${campaignId}/recipients-by-channel-outcome?outcome=both`);
        const body = await res.json();
        recipientIds = body.recipientIds || [];
      } else {
        recipientIds = (recipientsPage?.items || [])
          .filter((r: any) => r.inadCheck?.diverted)
          .map((r: any) => r.id);
      }
      if (recipientIds.length === 0) {
        alert('Nessun destinatario trovato per questa categoria.');
        return;
      }
      const res = await apiFetch(`/campaigns/${campaignId}/resend-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientIds }),
      });
      const results = await res.json();
      const resent = results.filter((r: any) => r.result === 'resent').length;
      const skipped = results.filter((r: any) => r.result === 'skipped').length;
      const errored = results.filter((r: any) => r.result === 'error').length;
      alert(`Rimandati: ${resent}. Saltati: ${skipped}. Errori: ${errored}.`);
    } catch {
      alert('Errore durante il resend.');
    } finally {
      setResendingOutcome(null);
    }
  };
```

Nota per l'implementatore: `recipientsPage` pagina solo 50 righe alla volta (`RECIPIENTS_PAGE_SIZE`) — il filtro client-side su `inadDiverted` sopra è corretto SOLO se la pagina corrente contiene già tutti i destinatari dirottati della campagna. Se la campagna ha più di 50 destinatari, aggiungere lato backend un endpoint equivalente `recipients-by-channel-outcome?outcome=inadDiverted` (stessa forma della Task 4, filtro su `recipient.inadCheck.diverted` invece che su `classifyChannelOutcome`) prima di questo step, per non perdere destinatari dirottati fuori dalla pagina corrente.

- [ ] **Step 2: JSX — bottoni sulle righe `both`/`inadDiverted` del widget esistente**

Nel blocco `{channelBreakdown && (...)}` (già esistente, vedi Task 8 per il riferimento di riga), modificare le righe "Anche App IO (parallela)" e "Dirottato su PEC (INAD)":

```tsx
                              <div className="d-flex justify-content-between align-items-center mb-1">
                                <span><CheckCheck className="text-success me-1" />Anche App IO (parallela)</span>
                                <span className="d-flex align-items-center gap-2">
                                  <span className="fw-bold">{channelBreakdown.both}</span>
                                  {channelBreakdown.both > 0 && (
                                    <button className="btn btn-sm btn-link p-0" type="button"
                                      disabled={resendingOutcome === 'both'}
                                      onClick={() => handleResendByOutcome(campaign.id, 'both', channelBreakdown.both)}>
                                      {resendingOutcome === 'both' ? 'Invio...' : `Rimanda a questi ${channelBreakdown.both}`}
                                    </button>
                                  )}
                                </span>
                              </div>
```

```tsx
                              <div className="d-flex justify-content-between align-items-center">
                                <span><ShieldCheck className="text-primary me-1" />Dirottato su PEC (INAD)</span>
                                <span className="d-flex align-items-center gap-2">
                                  <span className="fw-bold">{channelBreakdown.inadDiverted}</span>
                                  {channelBreakdown.inadDiverted > 0 && (
                                    <button className="btn btn-sm btn-link p-0" type="button"
                                      disabled={resendingOutcome === 'inadDiverted'}
                                      onClick={() => handleResendByOutcome(campaign.id, 'inadDiverted', channelBreakdown.inadDiverted)}>
                                      {resendingOutcome === 'inadDiverted' ? 'Invio...' : `Rimanda a questi ${channelBreakdown.inadDiverted}`}
                                    </button>
                                  )}
                                </span>
                              </div>
```

- [ ] **Step 3: Verifica type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`

- [ ] **Step 4: Verifica manuale in browser (Docker)**

```bash
docker compose build backend frontend-admin
docker compose up -d backend frontend-admin
```

Sulla campagna locale già usata per verificare i fix v1.4.8 (`059455db-2afe-4e63-8da4-a21181a9e4f4` o analoga):
1. "Correggi" contenuto, salvare un nuovo subject/body, verificare "Storico contenuto" mostri la versione precedente.
2. "Rimanda a questi N" sulla riga "Dirottato su PEC (INAD)" — confermare, verificare risultato (`resent`/`skipped`/`error`).
3. "Rimanda a questi N" sulla riga "Anche App IO (parallela)" — confermare.
4. **Verifica critica**: controllare i log backend (`docker compose logs backend | grep -i "canale POSTAL\|canale SEND"`) e confermare che NESSUN nuovo job sia stato accodato su quei due canali per questi destinatari durante l'operazione.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(campaigns-ui): resend sicuro per categoria dal widget multicanale"
```

---

## Post-implementazione

- Se la campagna reale in oggetto ha più di 50 destinatari dirottati INAD, implementare la nota del Task 9 Step 1 (endpoint `outcome=inadDiverted` lato backend) prima di usare il bottone su quella campagna specifica.
- Valutare, in una sessione successiva separata, se `@Roles('admin')` debba essere applicato esplicitamente a `PATCH content`/`POST resend-content` — oggi il controller non ha altri endpoint con override per-metodo del ruolo di classe (`@Roles('user','admin')`), la restrizione a 'admin' è enforced solo lato UI (frontend). Deviazione consapevole dallo spec originale per restare coerenti con il pattern già in uso nel resto di questo controller.
