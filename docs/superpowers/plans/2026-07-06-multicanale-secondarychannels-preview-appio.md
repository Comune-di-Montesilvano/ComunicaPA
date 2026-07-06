# Notifica Multicanale (secondaryChannels) e Anteprima App IO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oggi la co-consegna App IO è configurata in `channelConfig.appIo = {mode, ioServiceId}`, un campo scalare pensato solo per App IO agganciata a EMAIL/PEC, senza possibilità di differenziare oggetto/testo per il canale secondario e senza anteprima dedicata. Questo piano introduce **una notifica, due canali**: generalizza la chiave di configurazione in `channelConfig.secondaryChannels` (array, chiave = tipo canale), pronta ad accogliere in futuro altri canali secondari oltre App IO senza nuova migration, aggiunge la possibilità di differenziare oggetto/corpo per App IO, e aggiunge una tab "Anteprima App IO" nello Step 4 del wizard che mostra il rendering reale (markdown) tramite l'endpoint `POST /campaigns/preview` introdotto nel piano "Fix Anteprima Email/PEC".

**Architettura:** `resolveSecondaryAppIoConfig(channelConfig)` legge preferibilmente `channelConfig.secondaryChannels` (nuovo formato, array), con fallback al vecchio `channelConfig.appIo` (retrocompatibilità totale con le campagne esistenti e con la test suite di `notification.processor.spec.ts`, che non viene toccata). `sendAppIoMessage` in `notification.processor.ts` accetta ora `subjectOverride`/`bodyOverride` opzionali. Il wizard scrive il nuovo formato array; l'anteprima App IO nello Step 4 riusa l'endpoint del piano precedente passando `channelType: 'APP_IO'`, `format: 'markdown'`.

**Tech Stack:** NestJS (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- **Dipendenza:** questo piano richiede che il piano "Fix Anteprima Email/PEC (endpoint di rendering reale)" sia già implementato — usa `POST /campaigns/preview` e il suo supporto a `format: 'markdown'`.
- Solo App IO è implementato come canale secondario in questo piano. La forma `secondaryChannels: Array<{channel, mode, ...}>` è generica (il campo `channel` accetta qualunque `NotificationChannel`), ma **solo `channel: 'APP_IO'` viene letto e gestito** da `notification.processor.ts` — altri valori nell'array sono ignorati silenziosamente (comportamento esplicito, non un bug: serve a non foreclose l'estensione futura senza dover fare un'altra migration, dato che resta comunque una colonna JSONB).
- La semantica di `mode: 'parallel' | 'exclusive'` resta quella di App IO oggi (verifica profilo IO attivo). Se in futuro si aggiungerà un canale secondario diverso da App IO, la semantica di `mode` per quel canale andrà definita in quel momento — non è generalizzata da questo piano.
- Nessuna migration DB: `channelConfig` resta una colonna `jsonb` libera, come oggi.
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend.

---

### Task 1: Generalizza la config App IO in `secondaryChannels` con retrocompatibilità

**Files:**
- Create: `apps/backend/src/channels/secondary-channels.util.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Test: Create `apps/backend/src/channels/secondary-channels.util.spec.ts`
- Test: Modify `apps/backend/src/queue/notification.processor.spec.ts`

**Interfaces:**
- Produces: `resolveSecondaryAppIoConfig(channelConfig): { mode?: 'parallel' | 'exclusive'; ioServiceId?: string; subjectOverride?: string; bodyOverride?: string } | undefined` — usata da `notification.processor.ts` (questo task) e dal wizard indirettamente tramite la forma dati che scrive (Task 2).
- Consumes: nessuna nuova dipendenza esterna.

- [ ] **Step 1: Scrivi il test per il resolver (fallisce: file non esiste)**

```ts
// apps/backend/src/channels/secondary-channels.util.spec.ts
import { resolveSecondaryAppIoConfig } from './secondary-channels.util';

describe('resolveSecondaryAppIoConfig', () => {
  it('legge dal nuovo formato secondaryChannels quando presente', () => {
    const result = resolveSecondaryAppIoConfig({
      secondaryChannels: [
        { channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1', subjectOverride: 'Ciao', bodyOverride: 'Corpo IO' },
      ],
    });
    expect(result).toEqual({
      channel: 'APP_IO',
      mode: 'parallel',
      ioServiceId: 'svc-1',
      subjectOverride: 'Ciao',
      bodyOverride: 'Corpo IO',
    });
  });

  it('ignora entry di secondaryChannels per canali diversi da APP_IO', () => {
    const result = resolveSecondaryAppIoConfig({
      secondaryChannels: [{ channel: 'POSTAL', mode: 'parallel' }],
    });
    expect(result).toBeUndefined();
  });

  it('fa fallback al vecchio formato channelConfig.appIo se secondaryChannels è assente', () => {
    const result = resolveSecondaryAppIoConfig({
      appIo: { mode: 'exclusive', ioServiceId: 'svc-legacy' },
    });
    expect(result).toEqual({ mode: 'exclusive', ioServiceId: 'svc-legacy' });
  });

  it('ritorna undefined se non è configurato alcun canale secondario', () => {
    expect(resolveSecondaryAppIoConfig({})).toBeUndefined();
    expect(resolveSecondaryAppIoConfig(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest secondary-channels --maxWorkers=2`
Expected: FAIL — `Cannot find module './secondary-channels.util'`.

- [ ] **Step 3: Implementa il resolver**

```ts
// apps/backend/src/channels/secondary-channels.util.ts
import type { NotificationChannel } from '@comunicapa/shared-types';

export interface SecondaryChannelConfig {
  channel: NotificationChannel;
  mode: 'parallel' | 'exclusive';
  ioServiceId?: string;
  subjectOverride?: string;
  bodyOverride?: string;
}

/**
 * Risolve la configurazione del canale secondario App IO. Preferisce il
 * nuovo formato array `channelConfig.secondaryChannels` (chiave = tipo
 * canale, pronto per canali secondari futuri oltre App IO), con fallback
 * al vecchio campo scalare `channelConfig.appIo` per le campagne create
 * prima di questa generalizzazione. Solo APP_IO è gestito oggi: altre
 * entry dell'array sono ignorate (nessun canale secondario diverso da
 * App IO è implementato lato invio).
 */
export function resolveSecondaryAppIoConfig(
  channelConfig: Record<string, unknown> | undefined,
): SecondaryChannelConfig | { mode?: 'parallel' | 'exclusive'; ioServiceId?: string } | undefined {
  const secondaryChannels = channelConfig?.['secondaryChannels'] as SecondaryChannelConfig[] | undefined;
  const fromArray = secondaryChannels?.find((c) => c.channel === 'APP_IO');
  if (fromArray) return fromArray;

  return channelConfig?.['appIo'] as { mode?: 'parallel' | 'exclusive'; ioServiceId?: string } | undefined;
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest secondary-channels --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Scrivi il test per l'override di subject/body in `sendAppIoMessage` (fallisce)**

Aggiungi in `apps/backend/src/queue/notification.processor.spec.ts`, dentro `describe('App IO indipendente dal canale primario', ...)`, dopo il test `'appIo assente: nessuna chiamata a fetch App IO'`:

```ts
    it('usa subjectOverride/bodyOverride di secondaryChannels quando presenti (invece di subject/body principali)', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: {
          subject: 'Oggetto principale',
          body: 'Corpo principale',
          secondaryChannels: [
            { channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1', subjectOverride: 'Oggetto IO', bodyOverride: 'Corpo IO differenziato' },
          ],
        },
      });
      let capturedBody: any;
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockImplementationOnce((_url: string, init: any) => {
          capturedBody = JSON.parse(init.body);
          return Promise.resolve({ ok: true, json: async () => ({ id: 'io-1' }) });
        });

      await processor.process(mockJob(baseData));

      expect(capturedBody.content.subject).toBe('Oggetto IO');
      expect(capturedBody.content.markdown).toBe('Corpo IO differenziato');
    });
```

- [ ] **Step 6: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: FAIL — `capturedBody.content.subject` sarà `'Oggetto principale'` invece di `'Oggetto IO'` (oggi `sendAppIoMessage` non conosce gli override).

- [ ] **Step 7: Usa il resolver e propaga gli override**

In `apps/backend/src/queue/notification.processor.ts`, sostituisci l'import diretto del vecchio accesso a `channelConfig.appIo` con il resolver. Aggiungi in cima al file, accanto agli altri import:

```ts
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
```

Sostituisci (righe 92-95 attuali):

```ts
    const appIoConfig = campaign.channelConfig?.['appIo'] as
      | { mode?: 'parallel' | 'exclusive'; ioServiceId?: string }
      | undefined;
```

con:

```ts
    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig);
```

Poi, nelle due chiamate esistenti a `this.sendAppIoMessage(...)` (nel branch `exclusive` e nel branch `parallel`), aggiungi `subjectOverride`/`bodyOverride` presi da `appIoConfig`:

```ts
        const appIoResult = await this.sendAppIoMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        });
```

(sostituisci entrambe le occorrenze — una nel blocco `if (appIoMode === 'exclusive' ...)`, una nel blocco `if (appIoMode === 'parallel' ...)` — con questa stessa forma).

Infine, aggiorna la firma e il corpo di `sendAppIoMessage` (righe 215-263):

```ts
  private async sendAppIoMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const publicApiUrl = await this.settings.get<string>('system.publicUrl');
      const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
      const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
      const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
      const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
      );
      const processedMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
      );

      const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
        body: JSON.stringify({
          fiscal_code: recipient.codiceFiscale,
          content: { subject: processedSubject, markdown: processedMarkdown },
        }),
      });

      if (!appIoRes.ok) {
        return { success: false, error: `App IO status: ${appIoRes.status}` };
      }
      const appIoData = (await appIoRes.json()) as { id: string };
      return { success: true, messageId: appIoData.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
```

- [ ] **Step 8: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: PASS su tutti i test del file, inclusi i test preesistenti sul formato legacy `channelConfig.appIo` (che non hanno `subjectOverride`/`bodyOverride`, quindi continuano a usare `campaign.channelConfig['subject']`/`['body']` come prima — nessuna regressione).

- [ ] **Step 9: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/channels/secondary-channels.util.ts apps/backend/src/channels/secondary-channels.util.spec.ts apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts
git commit -m "feat(backend): generalizza config App IO in channelConfig.secondaryChannels con override oggetto/corpo"
```

---

### Task 2: Il wizard scrive `secondaryChannels` e permette di differenziare oggetto/corpo per App IO

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna nuova chiamata API in questo task (solo cambia la forma di `channelConfig` inviata a `POST /campaigns` / `PATCH /campaigns/:id`, già esistenti).
- Produces: nuovo state `wizAppIoDifferentiate: boolean`, `wizAppIoSubjectOverride: string`, `wizAppIoBodyOverride: string`, usati dal Task 3 per l'anteprima.

- [ ] **Step 1: Aggiungi lo state per la differenziazione**

In `apps/frontend-admin/src/App.tsx`, subito dopo `const [wizAppIoMode, setWizAppIoMode] = useState<'none' | 'parallel' | 'exclusive'>('parallel');` (circa riga 250), aggiungi:

```tsx
  const [wizAppIoDifferentiate, setWizAppIoDifferentiate] = useState(false);
  const [wizAppIoSubjectOverride, setWizAppIoSubjectOverride] = useState('');
  const [wizAppIoBodyOverride, setWizAppIoBodyOverride] = useState('');
```

- [ ] **Step 2: Aggiungi i campi di differenziazione nella card "Co-consegna su App IO"**

Nel blocco Step 1 del wizard, dentro la card `Co-consegna su App IO` (`{(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (<div className="card mb-3 ...">...)}`), subito dopo il blocco che mostra il select "Servizio App IO *" (quello con `{wizAppIoMode !== 'none' && (...)}`), aggiungi un nuovo blocco condizionale sullo stesso livello:

```tsx
                        {wizAppIoMode !== 'none' && (
                          <div className="mt-3 pt-3 border-top">
                            <div className="form-check mb-2">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                id="wiz-appio-differentiate"
                                checked={wizAppIoDifferentiate}
                                onChange={e => setWizAppIoDifferentiate(e.target.checked)}
                              />
                              <label className="form-check-label small" htmlFor="wiz-appio-differentiate">
                                Differenzia oggetto e testo per App IO (altrimenti usa lo stesso di {wizChannel})
                              </label>
                            </div>
                            {wizAppIoDifferentiate && (
                              <>
                                <div className="mb-2">
                                  <label className="form-label small fw-bold">Oggetto App IO *</label>
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    value={wizAppIoSubjectOverride}
                                    onChange={e => setWizAppIoSubjectOverride(e.target.value)}
                                    placeholder="Es: Avviso TARI - %nominativo%"
                                    required
                                  />
                                </div>
                                <div className="mb-0">
                                  <label className="form-label small fw-bold">Testo App IO * (markdown)</label>
                                  <textarea
                                    className="form-control form-control-sm"
                                    rows={3}
                                    value={wizAppIoBodyOverride}
                                    onChange={e => setWizAppIoBodyOverride(e.target.value)}
                                    placeholder="Testo dedicato per il messaggio App IO..."
                                    required
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        )}
```

- [ ] **Step 3: Scrivi `secondaryChannels` invece di `appIo` in `handleWizLaunch`**

In `handleWizLaunch`, sostituisci il blocco:

```tsx
        if (wizAppIoMode !== 'none') {
          const defaultSvc = ioServices.find(s => s.id === wizAppIoServiceId) || ioServices.find(s => s.isDefault) || ioServices[0];
          if (defaultSvc) {
            channelConfig.appIo = {
              mode: wizAppIoMode,
              ioServiceId: defaultSvc.id,
            };
          }
        }
```

con:

```tsx
        if (wizAppIoMode !== 'none') {
          const defaultSvc = ioServices.find(s => s.id === wizAppIoServiceId) || ioServices.find(s => s.isDefault) || ioServices[0];
          if (defaultSvc) {
            channelConfig.secondaryChannels = [{
              channel: 'APP_IO',
              mode: wizAppIoMode,
              ioServiceId: defaultSvc.id,
              ...(wizAppIoDifferentiate ? { subjectOverride: wizAppIoSubjectOverride, bodyOverride: wizAppIoBodyOverride } : {}),
            }];
          }
        }
```

- [ ] **Step 4: Aggiungi il reset dei nuovi state dopo il lancio riuscito**

Nel blocco di reset a fine `handleWizLaunch` (dopo `setWizAppIoMode('parallel');`), aggiungi:

```tsx
      setWizAppIoDifferentiate(false);
      setWizAppIoSubjectOverride('');
      setWizAppIoBodyOverride('');
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): wizard scrive channelConfig.secondaryChannels con differenziazione oggetto/testo App IO"
```

---

### Task 3: Tab "Anteprima App IO" nello Step 4

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST /campaigns/preview` (piano "Fix Anteprima Email/PEC"), risposta `{ subject, bodyHtml?, bodyMarkdown? }`. `wizPreviewResult`/`wizPreviewLoading` (già introdotti da quel piano). `MDEditor` da `@uiw/react-md-editor` (già importato in cima al file, riga 2) — usato in sola lettura tramite `MDEditor.Markdown` per renderizzare il markdown.

> **Prerequisito:** questo task presuppone che il Task 2 del piano "Fix Anteprima Email/PEC" sia già stato applicato (stato `wizPreviewResult`/`wizPreviewLoading` e l'effect di fetch esistono già in `App.tsx`).

- [ ] **Step 1: Aggiungi lo state per la tab attiva**

Subito dopo `const [wizPreviewLoading, setWizPreviewLoading] = useState(false);`, aggiungi:

```tsx
  const [wizPreviewChannelTab, setWizPreviewChannelTab] = useState<'MAIN' | 'APP_IO'>('MAIN');
```

- [ ] **Step 2: Estendi l'effect di preview per considerare la tab App IO**

Modifica l'effect introdotto nel piano precedente (quello con `fetch(\`${API_BASE}/campaigns/preview\`, ...)`), sostituendo il corpo della `body: JSON.stringify({...})` per calcolare subject/body/channelType in base alla tab attiva. Sostituisci:

```tsx
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
```

con:

```tsx
        body: JSON.stringify({
          channelType: wizPreviewChannelTab === 'APP_IO' ? 'APP_IO' : wizChannel,
          subject: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoSubjectOverride : wizSubject)
            : wizSubject,
          body: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoBodyOverride : wizBody)
            : wizBody,
          attachments: wizAttachments,
          recipient: {
            codiceFiscale: row[wizMapping.codice_fiscale] || '',
            fullName: getWizRowFullName(row),
            email: row[wizMapping.email] || undefined,
            pec: row[wizMapping.pec] || undefined,
            extraData: row,
          },
        }),
```

E aggiungi `wizPreviewChannelTab, wizAppIoDifferentiate, wizAppIoSubjectOverride, wizAppIoBodyOverride` all'array delle dipendenze dello `useEffect` (accanto a `wizStep, wizPreviewIndex, wizSubject, wizBody, wizChannel, wizAttachments, wizValidRows, wizMapping, token`).

- [ ] **Step 3: Aggiungi i pulsanti tab e il rendering markdown nel pannello di anteprima**

Nel blocco Step 4, subito dopo il commento `{/* Right Column: Live Preview with Paging */}` e il titolo `<h4 className="h6 fw-bold text-dark mb-2">Anteprima Live Destinatari...`, prima del blocco `<div className="d-flex align-items-center justify-content-between p-2 border rounded bg-light mb-3">` (i pulsanti Prec./Succ.), aggiungi:

```tsx
                    {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && wizAppIoMode !== 'none' && (
                      <div className="btn-group btn-group-sm mb-3" role="group">
                        <button
                          type="button"
                          className={`btn ${wizPreviewChannelTab === 'MAIN' ? 'btn-primary' : 'btn-outline-secondary'}`}
                          onClick={() => setWizPreviewChannelTab('MAIN')}
                        >
                          <i className="fas fa-envelope me-1"></i> {wizChannel}
                        </button>
                        <button
                          type="button"
                          className={`btn ${wizPreviewChannelTab === 'APP_IO' ? 'btn-primary' : 'btn-outline-secondary'}`}
                          onClick={() => setWizPreviewChannelTab('APP_IO')}
                        >
                          <i className="fas fa-mobile-screen me-1"></i> App IO
                        </button>
                      </div>
                    )}
```

Poi, nel blocco che renderizza il contenuto (`{wizValidRows[wizPreviewIndex] && (...)}`), sostituisci la parte che mostra il corpo:

```tsx
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
```

con:

```tsx
                        {wizPreviewLoading && !wizPreviewResult ? (
                          <div className="text-center text-muted small py-4">
                            <i className="fas fa-spinner fa-spin me-1"></i> Rendering anteprima...
                          </div>
                        ) : wizPreviewChannelTab === 'APP_IO' ? (
                          <div className="bg-white border rounded p-3" data-color-mode="light">
                            <MDEditor.Markdown source={wizPreviewResult?.bodyMarkdown ?? ''} />
                          </div>
                        ) : (
                          <div
                            className="bg-white border rounded overflow-hidden"
                            style={{ padding: '4px' }}
                            dangerouslySetInnerHTML={{ __html: wizPreviewResult?.bodyHtml ?? '' }}
                          />
                        )}
```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore. Se `MDEditor.Markdown` non è riconosciuto dal tipo importato, verifica in `apps/frontend-admin/node_modules/@uiw/react-md-editor/esm/Markdown` che il named export esista (è parte dell'API pubblica del pacchetto già in uso da `TemplateEditor`); in caso contrario usa `import MarkdownPreview from '@uiw/react-md-editor/markdown-preview'` con `<MarkdownPreview source={...} />` come alternativa equivalente.

- [ ] **Step 5: Verifica manuale nel browser**

Crea una campagna EMAIL con co-consegna App IO in modalità "parallela", abilita "Differenzia oggetto e testo per App IO", compila un testo diverso, arriva allo Step 4: verifica che appaiano le due tab "EMAIL" e "App IO" sopra l'anteprima, e che passando a "App IO" il contenuto mostrato sia quello differenziato, renderizzato come markdown (non come HTML con logo/footer, dato che App IO non usa `wrapInHtmlLayout`).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): tab anteprima App IO nello step 4, derivata dal template mail con differenziazione"
```
