# Fix Anteprima Email/PEC (endpoint di rendering reale) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'anteprima "Record N di M" nel wizard (Step 4) oggi è una copia JSX del motore di template del backend, ed è divergente dal messaggio realmente inviato: manca il logo, il footer ha un testo diverso, i link agli allegati sono finti (`href="#"` o URL fittizi). Questo piano introduce un endpoint backend `POST /campaigns/preview` che riusa il vero motore di rendering (`processTemplate` + `wrapInHtmlLayout`), e riscrive lo Step 4 del wizard per chiamarlo invece di duplicare la logica in JSX.

**Architettura:** Nuovo metodo `CampaignsService.previewMessage(dto)` che costruisce un `Recipient` transitorio (non persistito, id casuale) a partire dai dati che il wizard ha già in memoria (subject/body template, allegati mappati, riga CSV corrente), e lo passa alle stesse funzioni pure usate da `EmailStrategy`/`sendAppIoMessage` in produzione. Il frontend sostituisce il blocco `dangerouslySetInnerHTML` fatto a mano con una chiamata a questo endpoint (debounced), e mostra `bodyHtml` così com'è: l'endpoint restituisce già l'HTML completo con header/logo/footer, quindi il wrapper di stile duplicato nel wizard va rimosso.

**Tech Stack:** NestJS (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- Nessuna riga viene realmente persistita per la preview: il `Recipient` usato è transitorio, costruito in memoria con `crypto.randomUUID()` come id.
- Il link di download nella preview è firmato con `signDownloadLink` reale (stessa firma HMAC del flusso di invio), ma punta a un id che non esiste in DB: è un link non funzionante per design (mostra all'operatore la *forma* del link, non un download reale). Questo va scritto in un commento nel codice del service, non serve avvisare l'utente in UI in questo piano.
- Il body markdown per App IO (`format: 'markdown'`) è già supportato da `processTemplate` (parametro esistente) — questo piano lo espone nell'endpoint ma il consumo per la preview App IO combinata è responsabilità di un piano successivo (multicanale). Qui basta che l'endpoint accetti `format` e lo passi.
- **Fuori scope esplicito:** l'endpoint `POST /campaigns/preview` usa `processTemplate` (sintassi `%placeholder%`) per ogni canale, incluso `APP_IO`. Questo è corretto per la co-consegna App IO (che nel flusso di invio reale usa anch'essa `processTemplate`, vedi `sendAppIoMessage` in `notification.processor.ts`). Ma per una campagna con `wizChannel === 'APP_IO'` **diretto** (canale primario, non co-consegna), l'invio reale passa da `AppIoStrategy.send()` (`apps/backend/src/channels/app-io/app-io.strategy.ts`), che usa una sintassi diversa (`{{fullName}}`/`{{codiceFiscale}}`, mustache) e ignora del tutto `%allegatoN%`/`%elenco_allegati%`. Questo piano **non** copre la preview per il canale App IO diretto: se usato in quel contesto, l'endpoint mostrerebbe placeholder risolti che l'invio reale non processerà mai. Non è un problema per lo Step 4 attuale (che oggi usa comunque una preview email-style anche per `wizChannel === 'APP_IO'`), ma è un gap noto da non richiudere silenziosamente in un piano futuro senza prima allineare `AppIoStrategy` a `processTemplate`.
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend. `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` per il type-check frontend.

---

### Task 1: Endpoint backend `POST /campaigns/preview`

**Files:**
- Create: `apps/backend/src/campaigns/dto/preview-message.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (aggiungere DI + metodo `previewMessage`)
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (aggiungere route `POST preview`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, format)` e `wrapInHtmlLayout(bodyContent, brandName, options)` da `apps/backend/src/channels/template.helper.ts` (esistenti, invariati). `getEffectiveRetentionDays(campaign, maxDays)` da `apps/backend/src/campaigns/retention.util.ts` (esistente, invariato). `AppSettingsService.get<T>(key)` (esistente).
- Produces: `CampaignsService.previewMessage(dto: PreviewMessageDto): Promise<PreviewMessageResult>` dove `PreviewMessageResult = { subject: string; bodyHtml?: string; bodyMarkdown?: string }`. Usato dal Task 2 (frontend) e da un piano futuro per la preview App IO combinata.

- [ ] **Step 1: Scrivi il DTO**

```ts
// apps/backend/src/campaigns/dto/preview-message.dto.ts
import type { NotificationChannel } from '@comunicapa/shared-types';

export class PreviewRecipientDto {
  codiceFiscale!: string;
  fullName?: string;
  email?: string;
  pec?: string;
  extraData?: Record<string, string>;
}

export class PreviewMessageDto {
  channelType!: NotificationChannel;
  subject!: string;
  body!: string;
  attachments?: Array<{ key: string; label: string }>;
  recipient!: PreviewRecipientDto;
  format?: 'html' | 'markdown';
}

export interface PreviewMessageResult {
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
}
```

- [ ] **Step 2: Scrivi il test che fallisce per `previewMessage`**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.service.spec.ts` (dentro il blocco `describe('CampaignsService', ...)`, dopo i test esistenti — vedi Step 3 per il setup dei mock aggiuntivi):

```ts
  describe('previewMessage', () => {
    const mockSettings = {
      get: jest.fn(async (key: string) => {
        const values: Record<string, unknown> = {
          'brand.name': 'Comune di Montesilvano',
          'brand.logo': null,
          'system.publicUrl': 'http://localhost:8080',
          'system.citizenPublicUrl': 'http://localhost:3001',
          'retention.maxDays': 30,
        };
        return values[key];
      }),
    };
    const mockConfig = {
      get: jest.fn(() => 'test-secret'),
    };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CampaignsService,
          { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
          { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
          { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
          { provide: NotificationQueuesService, useValue: mockQueue },
          { provide: AppSettingsService, useValue: mockSettings },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();
      service = module.get<CampaignsService>(CampaignsService);
    });

    it('renders subject and full HTML body with brand name and no fake links', async () => {
      const result = await service.previewMessage({
        channelType: 'EMAIL',
        subject: 'Avviso per %nominativo%',
        body: 'Gentile %nominativo%, scarica %allegato1%',
        attachments: [{ key: 'file', label: 'Avviso TARI' }],
        recipient: { codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' },
      });

      expect(result.subject).toBe('Avviso per Mario Rossi');
      expect(result.bodyHtml).toContain('Comune di Montesilvano');
      expect(result.bodyHtml).toContain('/public/download/');
      expect(result.bodyHtml).toContain('Questa è una comunicazione ufficiale');
      expect(result.bodyMarkdown).toBeUndefined();
    });

    it('renders markdown body when format is markdown, without HTML wrapper', async () => {
      const result = await service.previewMessage({
        channelType: 'APP_IO',
        subject: 'Avviso',
        body: 'Elenco: %elenco_allegati%',
        attachments: [{ key: 'file', label: 'Avviso TARI' }],
        recipient: { codiceFiscale: 'RSSMRA80A01H501U' },
        format: 'markdown',
      });

      expect(result.bodyMarkdown).toContain('- **Avviso TARI**');
      expect(result.bodyHtml).toBeUndefined();
    });
  });
```

Aggiungi in cima al file gli import mancanti (accanto agli import esistenti):

```ts
import { ConfigService } from '@nestjs/config';
import { AppSettingsService } from '../settings/app-settings.service';
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — `previewMessage is not a function` (il metodo non esiste ancora) e/o errore di DI perché `CampaignsService` non accetta ancora `AppSettingsService`/`ConfigService` nel costruttore.

- [ ] **Step 4: Implementa `previewMessage` in `CampaignsService`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi agli import in cima al file:

```ts
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { AppSettingsService } from '../settings/app-settings.service';
import { processTemplate, wrapInHtmlLayout } from '../channels/template.helper';
import { getEffectiveRetentionDays } from './retention.util';
import type { PreviewMessageDto, PreviewMessageResult } from './dto/preview-message.dto';
```

Modifica il costruttore esistente (circa righe 22-32) aggiungendo i due nuovi parametri:

```ts
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly notificationQueues: NotificationQueuesService,
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}
```

Aggiungi il nuovo metodo pubblico (es. subito dopo `getDuplicateSource`):

```ts
  /**
   * Rende oggetto+corpo di un messaggio usando lo stesso motore di template
   * (processTemplate/wrapInHtmlLayout) usato realmente in invio, per un
   * destinatario transitorio (mai persistito: id casuale, usato solo per
   * firmare il link di download nello stesso formato di produzione — il
   * link non risolve realmente perché nessun allegato è associato a
   * quell'id in DB). Usata dal wizard per l'anteprima live.
   */
  async previewMessage(dto: PreviewMessageDto): Promise<PreviewMessageResult> {
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays({ retentionDays: null }, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const previewRecipient = {
      id: randomUUID(),
      codiceFiscale: dto.recipient.codiceFiscale,
      fullName: dto.recipient.fullName ?? null,
      email: dto.recipient.email ?? null,
      pec: dto.recipient.pec ?? null,
      extraData: dto.recipient.extraData ?? {},
    } as unknown as Recipient;

    const attachmentLabels = (dto.attachments ?? []).map((a) => a.label);
    const format: 'html' | 'markdown' = dto.format ?? (dto.channelType === 'APP_IO' ? 'markdown' : 'html');

    const subject = processTemplate(dto.subject, previewRecipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, format);
    const body = processTemplate(dto.body, previewRecipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, format);

    if (format === 'markdown') {
      return { subject, bodyMarkdown: body };
    }

    const brandLogo = await this.settings.get<string>('brand.logo');
    const logoUrl = brandLogo ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`) : null;
    const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;
    const bodyHtml = wrapInHtmlLayout(body, brandName, { logoUrl, portalUrl });

    return { subject, bodyHtml };
  }
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi quelli preesistenti — nessuna regressione sul costruttore).

- [ ] **Step 6: Aggiungi la route nel controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi l'import del DTO in cima:

```ts
import { PreviewMessageDto } from './dto/preview-message.dto';
```

Aggiungi il metodo nella classe `CampaignsController` (es. subito dopo `updateDraft`, prima di `uploadCsv` — nessun conflitto di path essendo `POST preview` una route statica distinta da `POST :id/...`):

```ts
  @Post('preview')
  previewMessage(@Body() dto: PreviewMessageDto) {
    return this.campaignsService.previewMessage(dto);
  }
```

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/dto/preview-message.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): endpoint POST /campaigns/preview per rendering reale anteprima"
```

---

### Task 2: Il wizard usa l'endpoint reale per l'anteprima Step 4

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (blocco Step 4 preview, righe ~3295-3346 nello stato corrente; stato del wizard righe ~228-258)

**Interfaces:**
- Consumes: `POST ${API_BASE}/campaigns/preview` (Task 1), risposta `{ subject: string; bodyHtml?: string; bodyMarkdown?: string }`.
- Produces: nuovo state `wizPreviewResult: { subject: string; bodyHtml?: string; bodyMarkdown?: string } | null` e `wizPreviewLoading: boolean`, utilizzabili da un piano futuro per la tab di anteprima App IO.

- [ ] **Step 1: Aggiungi lo state per il risultato della preview**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga `const [wizPreviewIndex, setWizPreviewIndex] = useState(0);` (circa riga 248), aggiungi:

```tsx
  const [wizPreviewResult, setWizPreviewResult] = useState<{ subject: string; bodyHtml?: string; bodyMarkdown?: string } | null>(null);
  const [wizPreviewLoading, setWizPreviewLoading] = useState(false);
```

- [ ] **Step 2: Aggiungi l'effect che chiama l'endpoint (debounced)**

Individua un punto tra gli altri `useEffect` del componente (es. vicino a dove viene dichiarato `wizPreviewIndex`, o subito prima del `return` del componente) e aggiungi:

```tsx
  useEffect(() => {
    if (wizStep !== 4 || !wizValidRows[wizPreviewIndex]) {
      return;
    }
    const row = wizValidRows[wizPreviewIndex];
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setWizPreviewLoading(true);
      fetch(`${API_BASE}/campaigns/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
        body: JSON.stringify({
          channelType: wizChannel,
          subject: wizSubject,
          body: wizBody,
          attachments: wizAttachments,
          recipient: {
            codiceFiscale: row[wizMapping.codice_fiscale] || '',
            fullName: getWizRowFullName(row),
            email: row[wizMapping.email] || undefined,
            pec: row[wizMapping.pec] || undefined,
            extraData: row,
          },
        }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('preview failed'))))
        .then((data) => setWizPreviewResult(data))
        .catch((err) => {
          if (err.name !== 'AbortError') setWizPreviewResult(null);
        })
        .finally(() => setWizPreviewLoading(false));
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wizStep, wizPreviewIndex, wizSubject, wizBody, wizChannel, wizAttachments, wizValidRows, wizMapping, token]);
```

- [ ] **Step 3: Sostituisci il blocco di rendering hand-rolled con il risultato reale**

Nel blocco Step 4 (`{wizStep === 4 && (...)}`), sostituisci l'intero pannello "Right Column: Live Preview with Paging" — dal commento `{/* Right Column: Live Preview with Paging */}` fino alla chiusura del `div` che contiene l'header blu, il corpo `dangerouslySetInnerHTML` e il footer grigio — con:

```tsx
                  {/* Right Column: Live Preview with Paging */}
                  <div className="col-lg-6">
                    <h4 className="h6 fw-bold text-dark mb-2">Anteprima Live Destinatari ({wizValidRows.length} totali)</h4>
                    <p className="small text-muted mb-3">Sfoglia i record validi del CSV per vedere come verranno risolti i parametri Jolly. Anteprima renderizzata con lo stesso motore usato per l'invio reale (logo, footer e link inclusi).</p>

                    <div className="d-flex align-items-center justify-content-between p-2 border rounded bg-light mb-3">
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        disabled={wizPreviewIndex === 0}
                        onClick={() => setWizPreviewIndex(i => Math.max(0, i - 1))}
                      >
                        <i className="fas fa-chevron-left"></i> Prec.
                      </button>
                      <span className="small fw-bold">Record {wizPreviewIndex + 1} di {wizValidRows.length}</span>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        disabled={wizPreviewIndex >= wizValidRows.length - 1}
                        onClick={() => setWizPreviewIndex(i => Math.min(wizValidRows.length - 1, i + 1))}
                      >
                        Succ. <i className="fas fa-chevron-right"></i>
                      </button>
                    </div>

                    {wizValidRows[wizPreviewIndex] && (
                      <div className="border rounded p-3" style={{ background: '#f8fafc' }}>
                        <div className="mb-2 text-muted" style={{ fontSize: '0.8rem' }}>
                          <strong>A:</strong> {wizValidRows[wizPreviewIndex][wizMapping.email || ''] || wizValidRows[wizPreviewIndex][wizMapping.pec || ''] || 'N/A'}<br />
                          <strong>Oggetto:</strong> {wizPreviewLoading ? '...' : (wizPreviewResult?.subject ?? '')}
                        </div>
                        {wizPreviewLoading && !wizPreviewResult ? (
                          <div className="text-center text-muted small py-4">
                            <i className="fas fa-spinner fa-spin me-1"></i> Rendering anteprima...
                          </div>
                        ) : (
                          <div
                            className="bg-white border rounded overflow-hidden"
                            style={{ padding: '4px' }}
                            dangerouslySetInnerHTML={{ __html: wizPreviewResult?.bodyHtml ?? '' }}
                          />
                        )}
                      </div>
                    )}
                  </div>
```

Nota: l'HTML restituito da `wrapInHtmlLayout` include già il proprio bordo/stile (header blu con logo, footer grigio) — non serve più ricostruirlo a mano nel JSX. La funzione `escapeHtml` locale resta usata altrove nel file (non va rimossa in questo task).

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore. Se `useEffect` non è già importato in cima al file, aggiungilo (verifica riga 1: `import React, { useState, useEffect } from 'react';` — già presente, nessuna modifica necessaria).

- [ ] **Step 5: Verifica manuale nel browser**

Avvia (se non già in esecuzione): `docker compose up -d --build frontend-admin backend`. Apri il wizard, crea una campagna EMAIL con un CSV di test, arriva allo Step 4, verifica che l'anteprima mostri il logo ente (se configurato in Impostazioni → Branding) e il footer ufficiale "Questa è una comunicazione ufficiale inviata da ComunicaPA...".

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): anteprima wizard usa rendering reale (logo, footer, link) via /campaigns/preview"
```
