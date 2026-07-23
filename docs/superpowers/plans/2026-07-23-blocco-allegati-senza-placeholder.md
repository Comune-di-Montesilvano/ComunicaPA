# Blocco lancio campagna: allegati senza placeholder nel template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bloccare il lancio di una campagna EMAIL/PEC/APP_IO che ha allegati configurati ma il cui template non contiene né `%%elenco_allegati%%` né tutti i `%%allegatoN%%` corrispondenti — sia in fase di navigazione wizard (client) sia in `launch()` (server, fonte di verità).

**Architecture:** Funzione pura `hasValidAttachmentPlaceholders(body, count)` duplicata (backend `template.helper.ts`, frontend `App.tsx` — bundle separati, nessun codice condiviso per questa logica) usata in due punti: `CampaignsService.checkAttachmentsBlocking()` lato server (pattern esistente `{blocked:true, message}`, mai eccezione non-2xx) e nel gating dei due bottoni "Riepilogo" del wizard step4 lato client.

**Tech Stack:** NestJS/TypeScript (backend), React 19/TypeScript (frontend-admin), Jest.

## Global Constraints

- Delimitatore placeholder è `%%chiave%%` (doppio `%`), mai eccezione non-2xx per errori "previsti" lato server — sempre `{blocked:true, message}` (proxy esterno di produzione sostituisce il body delle risposte non-2xx).
- Canali coinvolti nella regola: solo EMAIL, PEC, APP_IO (corpo primario) + corpo App IO differenziato di co-consegna (`secondaryChannels`/`appIo.bodyOverride`), indipendentemente dal canale primario. POSTAL (corpo primario) e SEND esclusi.
- Regola: `count === 0` → sempre valido; altrimenti valido se `%%elenco_allegati%%` presente OPPURE tutti i `%%allegatoN%%` da 1 a `count` presenti; altrimenti bloccato.
- Suite backend sempre con `--maxWorkers=2`.
- Spec di riferimento: `docs/superpowers/specs/2026-07-23-blocco-allegati-senza-placeholder-design.md`.

---

### Task 1: Helper `hasValidAttachmentPlaceholders` nel backend

**Files:**
- Modify: `apps/backend/src/channels/template.helper.ts`
- Test: `apps/backend/src/channels/template.helper.spec.ts`

**Interfaces:**
- Produces: `hasValidAttachmentPlaceholders(body: string, count: number): boolean` — esportata da `template.helper.ts`, usata da `campaigns.service.ts` (Task 2).

- [ ] **Step 1: Scrivere i test falliti**

Aggiungere in fondo a `apps/backend/src/channels/template.helper.spec.ts`:

```ts
describe('hasValidAttachmentPlaceholders', () => {
  it('è sempre valido se non ci sono allegati (count 0)', () => {
    expect(hasValidAttachmentPlaceholders('Nessun placeholder qui', 0)).toBe(true);
    expect(hasValidAttachmentPlaceholders('', 0)).toBe(true);
  });

  it('è valido se il body contiene %%elenco_allegati%%', () => {
    expect(hasValidAttachmentPlaceholders('Vedi %%elenco_allegati%% in fondo', 2)).toBe(true);
  });

  it('è valido se il body contiene TUTTI i singoli %%allegatoN%% richiesti', () => {
    expect(hasValidAttachmentPlaceholders('%%allegato1%% e %%allegato2%%', 2)).toBe(true);
  });

  it('non è valido se manca anche un solo %%allegatoN%% (singoli parziali)', () => {
    expect(hasValidAttachmentPlaceholders('Solo %%allegato1%%', 2)).toBe(false);
  });

  it('non è valido se il body non contiene né elenco né singoli', () => {
    expect(hasValidAttachmentPlaceholders('Gentile %%nominativo%%, saluti.', 1)).toBe(false);
  });
});
```

Aggiungere l'import in cima al file (riga 1 esistente):

```ts
import { processTemplate, wrapInHtmlLayout, hasValidAttachmentPlaceholders } from './template.helper';
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: FAIL — `hasValidAttachmentPlaceholders is not a function` (o `undefined`, non esportata).

- [ ] **Step 3: Implementare la funzione**

In `apps/backend/src/channels/template.helper.ts`, aggiungere dopo la fine di `processTemplate` (dopo la riga `}` che chiude la funzione, prima di `function htmlToMarkdown`):

```ts
/**
 * Verifica che `body` referenzi correttamente gli allegati configurati:
 * valido se contiene %%elenco_allegati%% OPPURE tutti gli %%allegatoN%%
 * da 1 a `count` — un sottoinsieme di singoli non basta. `count === 0`
 * è sempre valido (nessun allegato, nessun vincolo).
 */
export function hasValidAttachmentPlaceholders(body: string, count: number): boolean {
  if (count === 0) return true;
  if (body.includes('%%elenco_allegati%%')) return true;
  for (let i = 1; i <= count; i++) {
    if (!body.includes(`%%allegato${i}%%`)) return false;
  }
  return true;
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: PASS — tutti i test verdi, inclusi quelli pre-esistenti del file.

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun nuovo errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/template.helper.ts apps/backend/src/channels/template.helper.spec.ts
git commit -m "feat(backend): hasValidAttachmentPlaceholders per validare template vs allegati"
```

---

### Task 2: Integrare il check in `CampaignsService.checkAttachmentsBlocking`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:14` (import), `:320-359` (`checkAttachmentsBlocking`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `hasValidAttachmentPlaceholders(body: string, count: number): boolean` da Task 1; `resolveAttachmentsConfig(channelConfig): Array<{key,label,labelColumn?}>` e `resolveSecondaryAppIoConfig(channelConfig): SecondaryChannelConfig | {mode?,ioServiceId?} | undefined` (già importate in `campaigns.service.ts`).
- Produces: nessuna nuova interfaccia pubblica — estende il comportamento esistente di `checkAttachmentsBlocking` (privato, chiamato da `launch()`).

- [ ] **Step 1: Scrivere i test falliti**

Aggiungere in `apps/backend/src/campaigns/campaigns.service.spec.ts`, dentro `describe('launch — validazione allegati bloccante', ...)` (dopo il test `'lancia normalmente se tutti gli allegati mappati sono presenti'`, riga ~669, prima della chiusura `});` del describe a riga 670):

```ts
    it('blocca EMAIL con allegati se il template non contiene alcun placeholder allegato', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-no-placeholder',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Gentile %%nominativo%%, saluti.',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-no-placeholder');
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('elenco_allegati');
      expect(result.launched).toBe(0);
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-no-placeholder' }, { status: CampaignStatus.DRAFT });
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it('lancia EMAIL con allegati se il template contiene %%elenco_allegati%%', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-elenco-ok',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Gentile %%nominativo%%, vedi %%elenco_allegati%%.',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-elenco-ok');
      expect(result.launched).toBe(1);
    });

    it('blocca EMAIL con 2 allegati se manca il link singolo per uno dei due', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-parziale',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file1', label: 'Avviso' }, { key: 'file2', label: 'Ruolo' }],
          body: 'Documenti: %%allegato1%%',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      fs.writeFileSync(join(tmpDir, 'yyy.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file1: 'xxx.pdf', file2: 'yyy.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-parziale');
      expect(result.blocked).toBe(true);
      expect(result.launched).toBe(0);
    });

    it('NON blocca POSTAL con allegati e body senza placeholder (corpo non è contenuto reale)', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-postal',
        channelType: 'POSTAL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Lettera' }],
          body: '',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-postal');
      expect(result.blocked).toBeUndefined();
      expect(result.launched).toBe(1);
    });

    it('blocca la co-consegna App IO differenziata se bodyOverride non ha placeholder, anche se il corpo primario è ok', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-appio-override',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Corpo primario con %%elenco_allegati%%.',
          secondaryChannels: [
            { channel: 'APP_IO', mode: 'parallel', bodyOverride: 'Testo App IO senza placeholder allegati.' },
          ],
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-appio-override');
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('App IO');
      expect(result.launched).toBe(0);
    });
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "validazione allegati bloccante"`
Expected: FAIL sui 4 test nuovi che si aspettano `blocked:true`/`launched:0` (il check non esiste ancora, oggi il lancio procede normalmente).

- [ ] **Step 3: Implementare il check**

In `apps/backend/src/campaigns/campaigns.service.ts:14`, estendere l'import esistente:

```ts
import { processTemplate, wrapInHtmlLayout, hasValidAttachmentPlaceholders } from '../channels/template.helper';
```

In `checkAttachmentsBlocking` (riga 320-359), aggiungere il nuovo check subito dopo il blocco `findMissingAttachments` esistente (dopo la riga `}` che chiude `if (missingAttachments.length > 0) { ... }`, prima di `return null;`):

```ts
    const attachmentCount = resolveAttachmentsConfig(campaign.channelConfig).length;

    if (
      ['EMAIL', 'PEC', 'APP_IO'].includes(campaign.channelType) &&
      !hasValidAttachmentPlaceholders((campaign.channelConfig?.['body'] as string) || '', attachmentCount)
    ) {
      return {
        blocked: true,
        message: `Impossibile avviare: il template non contiene il blocco "Elenco Allegati" (%%elenco_allegati%%) né tutti i link singoli (%%allegato1%%...%%allegato${attachmentCount}%%) per i ${attachmentCount} allegati configurati. Aggiungi il placeholder al Passo 4 prima di rilanciare.`,
      };
    }

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig) as { bodyOverride?: string } | undefined;
    if (
      appIoConfig?.bodyOverride &&
      !hasValidAttachmentPlaceholders(appIoConfig.bodyOverride, attachmentCount)
    ) {
      return {
        blocked: true,
        message: `Impossibile avviare: il testo App IO differenziato non contiene il blocco "Elenco Allegati" né tutti i link singoli per i ${attachmentCount} allegati configurati. Correggilo al Passo 4 prima di rilanciare.`,
      };
    }

    return null;
```

(Il `return null;` sostituisce quello esistente a fine funzione — la funzione ora ha 4 possibili `return` di blocco più il finale `return null`.)

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS — inclusi tutti i test pre-esistenti del file (nessuna regressione sul resto di `CampaignsService`).

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun nuovo errore.

- [ ] **Step 6: Eseguire l'intera suite backend (audit costruttori/regressioni)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set del baseline noto (solo `app.controller.spec.ts` / `isLdapMock`), nessun nuovo fallimento.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): blocca launch() se template EMAIL/PEC/APP_IO ha allegati senza placeholder"
```

---

### Task 3: Wizard frontend — helper, gating bottoni, alert

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna nuova dipendenza esterna — usa state wizard già esistente: `wizChannel`, `wizBody`, `wizAttachments`, `wizAppIoMode`, `wizAppIoDifferentiate`, `wizAppIoBodyOverride`.
- Produces: `hasValidAttachmentPlaceholders(body: string, count: number): boolean` (funzione modulo, non esportata — uso solo interno ad `App.tsx`); `wizAttachmentCount`, `wizPrimaryBodyMissingAttachmentPlaceholder`, `wizAppIoBodyMissingAttachmentPlaceholder` (const nel componente wizard, usate nei due bottoni "Riepilogo" e nei due alert).

- [ ] **Step 1: Aggiungere l'helper puro**

In `apps/frontend-admin/src/App.tsx`, subito dopo `isWizBodyEmpty` (righe 567-570, prima del commento `// Testo puro...` a riga 572):

```ts
// Valido se il body contiene %%elenco_allegati%% OPPURE TUTTI gli %%allegatoN%%
// da 1 a count (un sottoinsieme di singoli non basta) — altrimenti il
// destinatario non ha modo di scaricare uno o più allegati della campagna.
// count === 0 (nessun allegato configurato) è sempre valido.
function hasValidAttachmentPlaceholders(body: string, count: number): boolean {
  if (count === 0) return true;
  if (body.includes('%%elenco_allegati%%')) return true;
  for (let i = 1; i <= count; i++) {
    if (!body.includes(`%%allegato${i}%%`)) return false;
  }
  return true;
}
```

- [ ] **Step 2: Calcolare i flag nel componente wizard**

In `apps/frontend-admin/src/App.tsx`, dopo `wizAppIoSubjectLenInvalid` (righe 1401-1402, prima del commento `// Settings State` a riga 1404), aggiungere:

```ts
  // Se ci sono allegati configurati, il template deve poterli referenziare
  // (elenco o tutti i link singoli) — altrimenti il destinatario non ha modo
  // di scaricarli. POSTAL/SEND esclusi: per loro il body non è mai il
  // contenuto reale (vedi gotcha CLAUDE.md).
  const wizAttachmentCount = wizAttachments.filter(a => a.key).length;
  const wizPrimaryBodyMissingAttachmentPlaceholder =
    (wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel === 'APP_IO') &&
    !hasValidAttachmentPlaceholders(wizBody, wizAttachmentCount);
  const wizAppIoBodyMissingAttachmentPlaceholder =
    wizAppIoMode !== 'none' && wizAppIoDifferentiate &&
    !hasValidAttachmentPlaceholders(wizAppIoBodyOverride, wizAttachmentCount);
```

- [ ] **Step 3: Disabilitare il primo bottone "Riepilogo" (step4, header in alto, riga ~8267-8279)**

Sostituire il blocco `disabled={...}` del primo bottone (quello dentro l'header dello step4, subito dopo `onClick={handleWizAdvanceToStep5}` a riga 8266):

```tsx
                      disabled={
                        wizDraftSaving || (
                          wizChannel === 'POSTAL' && wizAppIoMode === 'none' && !settInadCheckEnabled
                            ? false
                            : (
                                !wizSubject ||
                                ((wizChannel !== 'SEND' && (wizChannel !== 'POSTAL' || settInadCheckEnabled)) && isWizBodyEmpty(wizBody)) ||
                                wizAppIoBodyLenInvalid ||
                                wizAppIoSubjectLenInvalid ||
                                wizPrimaryBodyMissingAttachmentPlaceholder ||
                                wizAppIoBodyMissingAttachmentPlaceholder ||
                                ((wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel === 'POSTAL') && wizAppIoMode !== 'none' && wizAppIoDifferentiate && (!wizAppIoSubjectOverride || !wizAppIoBodyOverride))
                              )
                        )
                      }
```

- [ ] **Step 4: Disabilitare il secondo bottone "Riepilogo" (step4, fondo pagina, riga ~8475-8487)**

Applicare la stessa modifica (aggiungere le due righe `wizPrimaryBodyMissingAttachmentPlaceholder ||` e `wizAppIoBodyMissingAttachmentPlaceholder ||`) al secondo blocco `disabled={...}` identico, quello dentro `<div className="mt-4 pt-3 border-top d-flex justify-content-between">` (riga 8468 in poi).

- [ ] **Step 5: Alert sotto il corpo primario**

In `apps/frontend-admin/src/App.tsx`, dentro il blocco `{wizChannel !== 'SEND' && (wizChannel !== 'POSTAL' || settInadCheckEnabled) && (...)}` (righe 8324-8393), subito dopo l'alert `wizAppIoBodyLenInvalid` (righe 8375-8384, prima del `</>` di chiusura a riga 8392):

```tsx
                        {wizPrimaryBodyMissingAttachmentPlaceholder && (
                          <div className="alert alert-warning py-2 small mb-0">
                            <AlertTriangle className="me-1" size={16} />
                            Ci sono {wizAttachmentCount} allegato/i configurato/i ma il template non contiene
                            il blocco "Elenco Allegati" né tutti i link singoli corrispondenti — usa i token
                            nella toolbar sopra per inserirli, altrimenti il destinatario non potrà scaricarli.
                          </div>
                        )}
```

- [ ] **Step 6: Alert sotto il corpo App IO differenziato**

Nello stesso file, dentro `{wizAppIoDifferentiate && (...)}` (righe 8417-8463), subito dopo la chiusura del `<div className="mb-0">` del textarea "Testo App IO" (righe 8451-8461, prima del `</>` di chiusura a riga 8462):

```tsx
                              {wizAppIoBodyMissingAttachmentPlaceholder && (
                                <div className="alert alert-warning py-2 small mb-0 mt-2">
                                  <AlertTriangle className="me-1" size={16} />
                                  Ci sono {wizAttachmentCount} allegato/i configurato/i ma il testo App IO
                                  differenziato non contiene "Elenco Allegati" né tutti i link singoli —
                                  il destinatario non potrà scaricarli dalla notifica App IO.
                                </div>
                              )}
```

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore.

- [ ] **Step 8: Verifica manuale nel browser (dev)**

1. Aprire il wizard "Invio Massivo" (canale EMAIL), avanzare fino allo Step 3, mappare un allegato (`labelColumn` o file statico), procedere a Step 4.
2. Lasciare il corpo senza placeholder allegato → verificare che entrambi i bottoni "Riepilogo" siano disabilitati e compaia l'alert giallo.
3. Inserire il token "Elenco Allegati" dalla toolbar (o `%%elenco_allegati%%` a mano) → verificare che l'alert sparisca e il bottone si riattivi.
4. Cancellare e inserire solo `%%allegato1%%` con 2 allegati configurati → verificare che resti bloccato (singolo parziale).
5. Attivare "Differenzia oggetto e testo per App IO" e lasciare il testo App IO senza placeholder → verificare alert e blocco indipendenti dal corpo primario (anche se quello ha già l'elenco allegati corretto).
6. Ripetere rapidamente con canale POSTAL (allegato obbligatorio) → verificare che l'assenza di placeholder nel corpo primario NON blocchi (comportamento POSTAL invariato).

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): blocca wizard se template EMAIL/PEC/APP_IO ha allegati senza placeholder"
```

---

### Task 4: Aggiornare la matrice comportamenti campagne

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`

**Interfaces:**
- Consumes: nessuna — solo documentazione.
- Produces: nessuna — solo documentazione.

- [ ] **Step 1: Aggiungere la nuova regola alla matrice**

Aprire `docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`, individuare la colonna "Allegato" nella tabella riassuntiva e nel dettaglio riga-per-riga per EMAIL/PEC/APP_IO, aggiungere una nota: se allegato configurato (opzionale per questi 3 canali), il template deve contenere `%%elenco_allegati%%` o tutti gli `%%allegatoN%%` corrispondenti, altrimenti `launch()` blocca (vedi `docs/superpowers/specs/2026-07-23-blocco-allegati-senza-placeholder-design.md`). Specificare che POSTAL/SEND sono esclusi da questa regola (corpo non è contenuto reale / allegato è l'unico contenuto).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md
git commit -m "docs: matrice comportamenti campagne, regola placeholder allegati EMAIL/PEC/APP_IO"
```
