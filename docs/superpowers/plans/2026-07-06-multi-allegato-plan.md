# Multi-allegato per destinatario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere a ogni destinatario di avere N allegati (non più 1), mappati manualmente nel wizard da colonne CSV con etichetta libera, con un nuovo placeholder macro `%elenco_allegati%` che genera automaticamente il blocco standard (tabella HTML per EMAIL/PEC, elenco Markdown per App IO) nel template.

**Architecture:** `campaign.channelConfig.attachments: {key,label}[]` sostituisce il singolo `allegatoKey` (retrocompatibile). Link di download firmati includono un indice (`/public/download/:recipientId/:index`) così ogni allegato ha un URL indipendente e non falsificabile. `processTemplate` genera sia i placeholder individuali `%allegatoN%` sia la macro `%elenco_allegati%`, in formato HTML o Markdown a seconda del canale.

**Tech Stack:** NestJS 10 + TypeORM (backend, jsonb `channelConfig` — nessuna migration DB), React 19 + TipTap (frontend wizard).

## Global Constraints

- Nessuna migration DB: `channelConfig` è già `jsonb`. Retrocompatibilità dei dati esistenti tramite fallback in codice (`allegatoKey` singolo → `attachments: [{key, label: 'Allegato 1'}]`), non tramite backfill.
- Canale SEND non supporta allegati oggi (`SendStrategy` non usa `processTemplate`) — resta fuori scope, nessun task lo tocca.
- Canale POSTAL non toccato — usa PDF stampato server-side, non un allegato mappato da CSV.
- Breaking change accettato: i link di download già inviati PRIMA di questo piano smettono di validare dopo il deploy (nuova firma include l'indice). Non gestire retrocompatibilità dual-scheme per le firme — è una nota di rilascio, non un requisito di questo piano.
- Backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza `--maxWorkers=2`, satura la RAM). Baseline nota: 7 test falliscono da prima (email.strategy, pec.strategy, notification.processor — template vecchi con sintassi `{{var}}` e messaggi d'errore diversi). Il criterio per ogni task è "failure set identico" a quello riportato in ciascun task — non cercare di far passare quei 7 test, non sono in scope.
- Frontend: `apps/frontend-admin` non ha test runner (`"test": "echo 'no tests'"`) — verifica tramite `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`) + test manuale in browser.
- TypeScript strict mode ovunque (vedi `tsconfig.base.json`).

---

### Task 1: Firma download con indice allegato

**Files:**
- Modify: `apps/backend/src/channels/download-link.util.ts`
- Create: `apps/backend/src/channels/download-link.util.spec.ts`

**Interfaces:**
- Produces: `signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string): string`
- Produces: `verifyDownloadLink(recipientId: string, index: number, expiresAtUnix: number, signature: string, secret: string): boolean`

- [ ] **Step 1: Scrivi i test per la firma con indice**

Crea `apps/backend/src/channels/download-link.util.spec.ts`:

```ts
import { signDownloadLink, verifyDownloadLink } from './download-link.util';

describe('download-link.util con indice allegato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('genera una firma valida per recipientId+index+exp', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret)).toBe(true);
  });

  it('una firma generata per index 0 NON è valida per index 1', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 1, exp, sig, secret)).toBe(false);
  });

  it('una firma generata per un recipientId NON è valida per un altro', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-2', 0, exp, sig, secret)).toBe(false);
  });

  it('rifiuta una firma malformata senza lanciare eccezioni', () => {
    expect(verifyDownloadLink('r-1', 0, exp, 'non-esadecimale-!!!', secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest download-link.util --maxWorkers=2`
Expected: FAIL — `signDownloadLink`/`verifyDownloadLink` attualmente accettano solo `(recipientId, expiresAtUnix, secret)`, 3 argomenti, non 4/5. TypeScript darà errore di compilazione sul numero di argomenti.

- [ ] **Step 3: Estendi la firma con l'indice**

Sostituisci il contenuto di `apps/backend/src/channels/download-link.util.ts`:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function computeSignature(recipientId: string, index: number, expiresAtUnix: number, secret: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${index}:${expiresAtUnix}`).digest('hex');
}

export function signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string): string {
  return computeSignature(recipientId, index, expiresAtUnix, secret);
}

export function verifyDownloadLink(
  recipientId: string,
  index: number,
  expiresAtUnix: number,
  signature: string,
  secret: string,
): boolean {
  const expected = computeSignature(recipientId, index, expiresAtUnix, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest download-link.util --maxWorkers=2`
Expected: PASS — 4/4 test verdi.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/download-link.util.ts apps/backend/src/channels/download-link.util.spec.ts
git commit -m "feat(backend): includi indice allegato nella firma del link di download"
```

---

### Task 2: Configurazione multi-allegato e risoluzione file per indice

**Files:**
- Modify: `apps/backend/src/attachments/attachment.service.ts`
- Modify: `apps/backend/src/attachments/attachment.service.spec.ts`

**Interfaces:**
- Consumes: nessuna dipendenza da Task 1.
- Produces: `resolveAttachmentsConfig(channelConfig: Record<string, unknown> | undefined): Array<{ key: string; label: string }>`
- Produces: `resolveCustomAttachmentFilename(recipient: Recipient, index?: number): string | undefined` (firma cambiata: nuovo secondo parametro opzionale, default `0`)
- Produces: `AttachmentService.generatePdfBuffer(recipient: Recipient, index?: number): Promise<Buffer>` (firma cambiata: nuovo secondo parametro opzionale, default `0`)

- [ ] **Step 1: Scrivi i test per la nuova risoluzione multi-allegato**

Sostituisci `apps/backend/src/attachments/attachment.service.spec.ts`:

```ts
import { AttachmentService, resolveAttachmentsConfig, resolveCustomAttachmentFilename } from './attachment.service';
import type { Recipient } from '../entities/recipient.entity';

describe('resolveAttachmentsConfig', () => {
  it('legge channelConfig.attachments quando presente', () => {
    const cfg = { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] };
    expect(resolveAttachmentsConfig(cfg)).toEqual([
      { key: 'tassa', label: 'Tassa' },
      { key: 'ruolo', label: 'Ruolo' },
    ]);
  });

  it('ricostruisce un singolo attachment da allegatoKey legacy quando attachments è assente', () => {
    const cfg = { allegatoKey: 'documento' };
    expect(resolveAttachmentsConfig(cfg)).toEqual([{ key: 'documento', label: 'Allegato 1' }]);
  });

  it('ritorna array vuoto se non c\'è né attachments né allegatoKey', () => {
    expect(resolveAttachmentsConfig({})).toEqual([]);
    expect(resolveAttachmentsConfig(undefined)).toEqual([]);
  });
});

describe('resolveCustomAttachmentFilename con indice', () => {
  const baseRecipient = (channelConfig: Record<string, unknown>, extraData: Record<string, unknown>) =>
    ({ extraData, campaign: { channelConfig } } as unknown as Recipient);

  it('risolve il file del primo allegato (index 0) da attachments[0].key', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] },
      { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 0)).toBe('TASSA.pdf');
  });

  it('risolve il file del secondo allegato (index 1) da attachments[1].key', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] },
      { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 1)).toBe('RUOLO.pdf');
  });

  it('ritorna undefined per un indice fuori range', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }] },
      { tassa: 'TASSA.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 5)).toBeUndefined();
  });

  it('usa il fallback legacy di scansione .pdf per index 0 quando non c\'è alcuna configurazione', () => {
    const r = baseRecipient({}, { qualcheAltroCampo: 'valore', documentoAllegato: 'PREAVVISO.PDF' });
    expect(resolveCustomAttachmentFilename(r, 0)).toBe('PREAVVISO.PDF');
  });

  it('il fallback legacy NON si applica per index diverso da 0', () => {
    const r = baseRecipient({}, { documentoAllegato: 'PREAVVISO.PDF' });
    expect(resolveCustomAttachmentFilename(r, 1)).toBeUndefined();
  });

  it('index di default è 0 quando omesso (retrocompatibilità chiamanti esistenti)', () => {
    const r = baseRecipient({ allegatoKey: 'doc' }, { doc: 'X.pdf' });
    expect(resolveCustomAttachmentFilename(r)).toBe('X.pdf');
  });
});

describe('AttachmentService.generatePdfBuffer', () => {
  let service: AttachmentService;

  beforeEach(() => {
    service = new AttachmentService();
  });

  it('genera un buffer PDF quando non c\'è allegato personalizzato per l\'indice richiesto', async () => {
    const recipient = {
      id: 'r-1',
      campaignId: 'c-1',
      codiceFiscale: 'RSSMRA85M01H501Z',
      fullName: 'Mario Rossi',
      email: 'mario@example.com',
      pec: null,
      extraData: {},
      createdAt: new Date('2026-06-25'),
      campaign: { name: 'TARI 2026', description: 'Acconto', channelType: 'EMAIL', channelConfig: {} },
    } as unknown as Recipient;

    const buffer = await service.generatePdfBuffer(recipient);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest attachment.service --maxWorkers=2`
Expected: FAIL — `resolveAttachmentsConfig` non esiste ancora, `resolveCustomAttachmentFilename` non accetta un secondo parametro.

- [ ] **Step 3: Implementa la risoluzione multi-allegato**

Sostituisci il contenuto di `apps/backend/src/attachments/attachment.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'fs';
import { join } from 'path';
import type { Recipient } from '../entities/recipient.entity';
import { getUploadsDir } from './attachment-paths';

/**
 * Risolve la lista di allegati configurati per una campagna. `attachments`
 * (nuovo formato) ha priorità; se assente si ricostruisce un singolo
 * allegato dal vecchio `allegatoKey` per retrocompatibilità con campagne
 * create prima del supporto multi-allegato.
 */
export function resolveAttachmentsConfig(
  channelConfig: Record<string, unknown> | undefined,
): Array<{ key: string; label: string }> {
  const configured = channelConfig?.['attachments'] as Array<{ key: string; label: string }> | undefined;
  if (configured && configured.length > 0) return configured;

  const legacyKey = channelConfig?.['allegatoKey'] as string | undefined;
  if (legacyKey) return [{ key: legacyKey, label: 'Allegato 1' }];

  return [];
}

/**
 * Risolve il nome del file dell'allegato PDF personalizzato per un destinatario,
 * per l'allegato all'indice `index` (0-based) fra quelli configurati sulla campagna.
 *
 * Fallback legacy: se non c'è ALCUNA configurazione allegati (né `attachments`
 * né `allegatoKey`) e `index` è 0, scansiona `extraData` e usa il primo valore
 * che termina con `.pdf` (comportamento pre-esistente per campagne molto vecchie).
 *
 * Usata sia da `AttachmentService` (per servire il download) sia da
 * `RetentionCleanupService` (per individuare i file da eliminare alla scadenza),
 * in modo che entrambi concordino su quali destinatari hanno un allegato personalizzato.
 */
export function resolveCustomAttachmentFilename(recipient: Recipient, index = 0): string | undefined {
  const attachments = resolveAttachmentsConfig(recipient.campaign?.channelConfig);
  const entry = attachments[index];

  if (entry && recipient.extraData?.[entry.key]) {
    return String(recipient.extraData[entry.key]);
  }

  if (index === 0 && attachments.length === 0) {
    for (const val of Object.values(recipient.extraData ?? {})) {
      if (typeof val === 'string' && val.toLowerCase().endsWith('.pdf')) {
        return val;
      }
    }
  }

  return undefined;
}

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  async generatePdfBuffer(recipient: Recipient, index = 0): Promise<Buffer> {
    const customFilename = resolveCustomAttachmentFilename(recipient, index);

    if (customFilename) {
      const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
      if (fs.existsSync(filePath)) {
        this.logger.log(`Serving custom uploaded PDF attachment: ${filePath}`);
        return fs.readFileSync(filePath);
      }
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    page.drawText('COMUNE DI MONTESILVANO', { x: 50, y: 750, size: 16, font: fontBold, color: rgb(0, 0.2, 0.4) });
    page.drawText('ComunicaPA — Hub di Trasmissione Comunicazioni', { x: 50, y: 730, size: 10, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawLine({ start: { x: 50, y: 715 }, end: { x: 550, y: 715 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    page.drawText(`Destinatario: ${recipient.fullName || 'N/D'}`, { x: 50, y: 680, size: 11, font: fontBold });
    page.drawText(`Codice Fiscale: ${recipient.codiceFiscale}`, { x: 50, y: 660, size: 11, font: fontRegular });
    if (recipient.email) {
      page.drawText(`Email: ${recipient.email}`, { x: 50, y: 645, size: 11, font: fontRegular });
    }
    if (recipient.pec) {
      page.drawText(`PEC: ${recipient.pec}`, { x: 50, y: 630, size: 11, font: fontRegular });
    }
    page.drawText("Oggetto dell'avviso:", { x: 50, y: 580, size: 11, font: fontBold, color: rgb(0, 0.2, 0.4) });
    page.drawText(recipient.campaign.name, { x: 50, y: 560, size: 12, font: fontBold });
    page.drawText('Dettaglio comunicazione:', { x: 50, y: 520, size: 11, font: fontBold });
    const description = recipient.campaign.description || 'Nessuna descrizione specificata.';
    page.drawText(description, { x: 50, y: 500, size: 11, font: fontRegular, maxWidth: 500, lineHeight: 14 });
    page.drawText(`PROTOCOLLO GENERALE - N. COM_${recipient.id.slice(0, 8).toUpperCase()}`, { x: 310, y: 750, size: 8, font: fontBold, color: rgb(0.8, 0.1, 0.1) });
    page.drawLine({ start: { x: 50, y: 150 }, end: { x: 550, y: 150 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    page.drawText(`Identificativo notifica: ${recipient.id}`, { x: 50, y: 130, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawText(`Data invio: ${recipient.createdAt.toLocaleDateString('it-IT')}`, { x: 50, y: 115, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawText(`Canale di trasmissione: ${recipient.campaign.channelType}`, { x: 50, y: 100, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest attachment.service --maxWorkers=2`
Expected: PASS — 9/9 test verdi.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/attachments/attachment.service.ts apps/backend/src/attachments/attachment.service.spec.ts
git commit -m "feat(backend): risolvi allegati multipli per indice con fallback legacy"
```

---

### Task 3: Placeholder multi-allegato e macro %elenco_allegati% in processTemplate

**Files:**
- Modify: `apps/backend/src/channels/template.helper.ts`
- Modify: `apps/backend/src/channels/template.helper.spec.ts`

**Interfaces:**
- Consumes: `signDownloadLink(recipientId, index, expiresAtUnix, secret)` da Task 1.
- Produces: `processTemplate(bodyTemplate: string, recipient: Recipient, publicApiUrl: string, downloadLinkSecret: string, expiresAtUnix: number, attachmentLabels?: string[], format?: 'html' | 'markdown'): string` (firma cambiata: 2 nuovi parametri opzionali in coda, default `[]` e `'html'`)

- [ ] **Step 1: Scrivi i test per multi-placeholder e macro**

Sostituisci `apps/backend/src/channels/template.helper.spec.ts`:

```ts
import { processTemplate, wrapInHtmlLayout } from './template.helper';
import type { Recipient } from '../entities/recipient.entity';

const baseRecipient = {
  id: 'r-123',
  codiceFiscale: 'RSSMRA85M01H501Z',
  fullName: 'Mario Rossi',
  email: 'mario@example.com',
  pec: null,
  extraData: {},
} as Recipient;

describe('processTemplate — link firmato con indice allegato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('sostituisce %allegato1% con un link all\'indice 0 quando c\'è un allegato configurato', () => {
    const result = processTemplate('Scarica qui: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).toContain(`http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
  });

  it('sostituisce %allegato1% e %allegato2% con link a indici distinti', () => {
    const result = processTemplate('%allegato1% e %allegato2%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo']);
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
  });

  it('senza attachmentLabels, %allegato1% NON viene sostituito (nessun allegato configurato)', () => {
    const result = processTemplate('Link: %allegato1%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Link: %allegato1%');
  });

  it('continua a sostituire %nominativo% come prima', () => {
    const result = processTemplate('Gentile %nominativo%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Gentile Mario Rossi');
  });
});

describe('processTemplate — macro %elenco_allegati%', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('formato html: genera una tabella con etichetta e link per ogni allegato', () => {
    const result = processTemplate('%elenco_allegati%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo'], 'html');
    expect(result).toContain('<table');
    expect(result).toContain('Tassa');
    expect(result).toContain('Ruolo');
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
  });

  it('formato markdown: genera un elenco puntato senza tag HTML', () => {
    const result = processTemplate('%elenco_allegati%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'markdown');
    expect(result).toBe(`- **Tassa**: [Scarica](http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=${result.match(/sig=([a-f0-9]+)/)?.[1]})`);
    expect(result).not.toContain('<table');
    expect(result).not.toContain('<td');
  });

  it('nessun allegato configurato: la macro si espande in stringa vuota', () => {
    const result = processTemplate('Prima %elenco_allegati% Dopo', baseRecipient, 'http://api.test', secret, exp, []);
    expect(result).toBe('Prima  Dopo');
  });
});

describe('wrapInHtmlLayout con logo e portale', () => {
  it('inserisce il logo quando logoUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { logoUrl: 'https://ente.it/api/branding/logo' });
    expect(html).toContain('<img src="https://ente.it/api/branding/logo"');
    expect(html).toContain('alt="Comune Test"');
  });

  it('non inserisce img senza logoUrl', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('<img');
  });

  it('inserisce il link al portale nel footer quando portalUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { portalUrl: 'https://portale.ente.it' });
    expect(html).toContain('href="https://portale.ente.it"');
    expect(html).toContain('Portale del Cittadino');
  });

  it('senza portalUrl il footer resta quello standard', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('Portale del Cittadino');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: FAIL — `processTemplate` sostituisce solo il vecchio `%allegato1%` fisso, non genera link con indice, non conosce `%elenco_allegati%`.

- [ ] **Step 3: Implementa multi-placeholder e macro**

Sostituisci in `apps/backend/src/channels/template.helper.ts` la funzione `processTemplate` (righe 9-60), lasciando invariato il resto del file (`HtmlLayoutOptions`, `wrapInHtmlLayout`):

```ts
import type { Recipient } from '../entities/recipient.entity';
import { signDownloadLink } from './download-link.util';

/**
 * Replaces fixed placeholders (%allegato1%, %allegato2%, ...), the standard
 * "elenco allegati" macro (%elenco_allegati%), standard fields (%nominativo%,
 * %nome%, %cf%, etc.), and dynamic CSV variables (both direct %chiave% and
 * %parametro1(mappato"chiave")%) with the corresponding recipient values.
 *
 * `attachmentLabels` è l'elenco delle etichette configurate sulla campagna
 * (in ordine: indice 0 → %allegato1%, indice 1 → %allegato2%, ...). Ogni
 * etichetta produce un link di download firmato per quell'indice specifico.
 */
export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
  attachmentLabels: string[] = [],
  format: 'html' | 'markdown' = 'html',
): string {
  let content = bodyTemplate;

  const buildDownloadUrl = (index: number): string => {
    const sig = signDownloadLink(recipient.id, index, expiresAtUnix, downloadLinkSecret);
    return `${publicApiUrl}/public/download/${recipient.id}/${index}?exp=${expiresAtUnix}&sig=${sig}`;
  };

  // 1. Placeholder individuali %allegato1%, %allegato2%, ... (uno per etichetta configurata)
  attachmentLabels.forEach((_, index) => {
    const placeholder = new RegExp(`%allegato${index + 1}%`, 'g');
    content = content.replace(placeholder, buildDownloadUrl(index));
  });

  // 2. Macro %elenco_allegati%: blocco con etichetta+link per ogni allegato
  if (content.includes('%elenco_allegati%')) {
    const block = attachmentLabels.length === 0
      ? ''
      : format === 'markdown'
        ? attachmentLabels
            .map((label, index) => `- **${label}**: [Scarica](${buildDownloadUrl(index)})`)
            .join('\n')
        : `<table style="width:100%; border-collapse: collapse;">${attachmentLabels
            .map(
              (label, index) =>
                `<tr><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;">${label}</td><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;"><a href="${buildDownloadUrl(index)}">Scarica</a></td></tr>`,
            )
            .join('')}</table>`;
    content = content.replace(/%elenco_allegati%/g, block);
  }

  // 3. Helper to get recipient value case-insensitively
  const getVal = (key: string): string => {
    const k = key.toLowerCase().trim();
    if (k === 'codice_fiscale' || k === 'codicefiscale' || k === 'cf') {
      return recipient.codiceFiscale;
    }
    if (k === 'full_name' || k === 'fullname' || k === 'nome' || k === 'nominativo') {
      return recipient.fullName || '';
    }
    if (k === 'email') {
      return recipient.email || '';
    }
    if (k === 'pec') {
      return recipient.pec || '';
    }
    if (recipient.extraData) {
      for (const [exKey, exVal] of Object.entries(recipient.extraData)) {
        if (exKey.toLowerCase() === k) {
          return String(exVal ?? '');
        }
      }
    }
    return '';
  };

  // 4. Replace %parametro\d+(mappato"key")%
  content = content.replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (_match, key) => {
    return getVal(key);
  });

  // 5. Replace %key%
  content = content.replace(/%([^%()]+)%/gi, (_match, key) => {
    return getVal(key);
  });

  return content;
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: PASS — 11/11 test verdi.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/template.helper.ts apps/backend/src/channels/template.helper.spec.ts
git commit -m "feat(backend): supporta N allegati e macro elenco_allegati in processTemplate"
```

---

### Task 4: Endpoint di download per indice allegato

**Files:**
- Modify: `apps/backend/src/public-download/public-download.controller.ts`
- Modify: `apps/backend/src/public-download/public-download.controller.spec.ts`

**Interfaces:**
- Consumes: `verifyDownloadLink(recipientId, index, expiresAtUnix, signature, secret)` da Task 1; `AttachmentService.generatePdfBuffer(recipient, index)` da Task 2.
- Produces: rotta `GET /public/download/:recipientId/:index` (sostituisce `GET /public/download/:recipientId`).

- [ ] **Step 1: Scrivi i test per la rotta con indice**

Sostituisci `apps/backend/src/public-download/public-download.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { GoneException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PublicDownloadController } from './public-download.controller';
import { AttachmentService } from '../attachments/attachment.service';
import { Recipient } from '../entities/recipient.entity';
import { signDownloadLink } from '../channels/download-link.util';

describe('PublicDownloadController', () => {
  let controller: PublicDownloadController;
  const secret = 'test-secret';
  const recipientId = 'r-1';
  const futureExp = Math.floor(Date.now() / 1000) + 3600;

  const mockRecipient = {
    id: recipientId,
    attachmentDeletedAt: null,
    downloadCount: 0,
    firstDownloadedAt: null,
    lastDownloadedAt: null,
    campaign: { channelConfig: {} },
    extraData: {},
  };

  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockAttachmentService = {
    generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
  };
  const mockConfig = { get: () => secret };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(mockRecipient);
    const module = await Test.createTestingModule({
      controllers: [PublicDownloadController],
      providers: [
        { provide: getRepositoryToken(Recipient), useValue: mockRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    controller = module.get(PublicDownloadController);
  });

  it('rifiuta con 403 se la firma non è valida', async () => {
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), 'firma-non-valida', res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se l\'indice non corrisponde alla firma (firma dell\'indice 0 usata per l\'indice 1)', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '1', String(futureExp), sig, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 410 se il link è scaduto', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const sig = signDownloadLink(recipientId, 0, pastExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(pastExp), sig, res)).rejects.toThrow(GoneException);
  });

  it('rifiuta con 410 se l\'allegato è già stato eliminato per retention', async () => {
    mockRepo.findOne.mockResolvedValueOnce({ ...mockRecipient, attachmentDeletedAt: new Date() });
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(futureExp), sig, res)).rejects.toThrow(GoneException);
  });

  it('serve il PDF dell\'indice richiesto e incrementa downloadCount con firma valida', async () => {
    const sig = signDownloadLink(recipientId, 1, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await controller.download(recipientId, '1', String(futureExp), sig, res);
    expect(mockAttachmentService.generatePdfBuffer).toHaveBeenCalledWith(mockRecipient, 1);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
    expect(mockRepo.update).toHaveBeenCalledWith(
      recipientId,
      expect.objectContaining({ downloadCount: 1 }),
    );
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest public-download.controller --maxWorkers=2`
Expected: FAIL — `controller.download` accetta ancora solo 4 argomenti (senza `index`).

- [ ] **Step 3: Implementa la rotta con indice**

Sostituisci il contenuto di `apps/backend/src/public-download/public-download.controller.ts`:

```ts
import { Controller, ForbiddenException, Get, GoneException, Param, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AppConfiguration } from '../config/configuration';
import { Public } from '../auth/decorators/public.decorator';
import { Recipient } from '../entities/recipient.entity';
import { AttachmentService } from '../attachments/attachment.service';
import { verifyDownloadLink } from '../channels/download-link.util';

@Controller('public/download')
@Public()
export class PublicDownloadController {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly attachmentService: AttachmentService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @Get(':recipientId/:index')
  async download(
    @Param('recipientId') recipientId: string,
    @Param('index') indexParam: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    const index = parseInt(indexParam, 10);
    const expiresAtUnix = parseInt(exp, 10);
    const secret = this.config.get('downloadLink.secret', { infer: true });

    if (
      !Number.isFinite(index) ||
      index < 0 ||
      !Number.isFinite(expiresAtUnix) ||
      !verifyDownloadLink(recipientId, index, expiresAtUnix, sig, secret)
    ) {
      throw new ForbiddenException('Link non valido');
    }
    if (Math.floor(Date.now() / 1000) > expiresAtUnix) {
      throw new GoneException('Link scaduto');
    }

    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId },
      relations: ['campaign'],
    });
    if (!recipient || recipient.attachmentDeletedAt) {
      throw new GoneException('Allegato non più disponibile');
    }

    const pdfBuffer = await this.attachmentService.generatePdfBuffer(recipient, index);

    await this.recipientRepo.update(recipientId, {
      downloadCount: recipient.downloadCount + 1,
      firstDownloadedAt: recipient.firstDownloadedAt ?? new Date(),
      lastDownloadedAt: new Date(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avviso_${recipientId.slice(0, 8)}_${index + 1}.pdf"`);
    res.end(pdfBuffer);
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest public-download.controller --maxWorkers=2`
Expected: PASS — 5/5 test verdi.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/public-download/public-download.controller.ts apps/backend/src/public-download/public-download.controller.spec.ts
git commit -m "feat(backend): rotta download pubblica per indice allegato"
```

---

### Task 5: Retention cleanup per N allegati

**Files:**
- Modify: `apps/backend/src/campaigns/retention-cleanup.service.ts`
- Modify: `apps/backend/src/campaigns/retention-cleanup.service.spec.ts`

**Interfaces:**
- Consumes: `resolveAttachmentsConfig`, `resolveCustomAttachmentFilename(recipient, index)` da Task 2.

- [ ] **Step 1: Aggiungi il test per la cancellazione di più allegati per lo stesso destinatario**

In `apps/backend/src/campaigns/retention-cleanup.service.spec.ts`, aggiungi in coda al `describe('RetentionCleanupService', ...)` (prima della chiusura finale `});`):

```ts
  it('elimina TUTTI gli allegati configurati per un destinatario con più attachments', async () => {
    const recipientMultiAttach = {
      id: 'r-multi',
      campaignId: 'c-multi',
      extraData: { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' },
      campaign: {
        channelConfig: {
          attachments: [
            { key: 'tassa', label: 'Tassa' },
            { key: 'ruolo', label: 'Ruolo' },
          ],
        },
      },
    };
    mockQb.getMany.mockReset();
    mockQb.getMany.mockResolvedValueOnce([recipientMultiAttach]).mockResolvedValueOnce([]);

    await service.runCleanup();

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('TASSA.pdf'));
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('RUOLO.pdf'));
    expect(fs.unlink).toHaveBeenCalledTimes(2);
    expect(mockRepo.update).toHaveBeenCalledWith('r-multi', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });
```

- [ ] **Step 2: Esegui i test e verifica che il nuovo fallisca**

Run: `docker compose exec backend node_modules/.bin/jest retention-cleanup.service --maxWorkers=2`
Expected: FAIL sul nuovo test — `runCleanup` oggi cancella un solo file per destinatario (`resolveCustomAttachmentFilename(recipient)` senza indice), non itera su tutti gli allegati configurati. Gli altri test esistenti (righe 43-102 del file originale) devono continuare a passare.

- [ ] **Step 3: Itera su tutti gli allegati configurati**

In `apps/backend/src/campaigns/retention-cleanup.service.ts`, sostituisci l'import e il blocco del loop interno:

```ts
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service';
```

Sostituisci il blocco `for (const recipient of batch) { ... }` (righe 49-62 dell'originale) con:

```ts
      for (const recipient of batch) {
        const attachmentsConfig = resolveAttachmentsConfig(recipient.campaign.channelConfig);
        const totalSlots = Math.max(attachmentsConfig.length, 1); // almeno un tentativo per il fallback legacy

        for (let index = 0; index < totalSlots; index++) {
          const customFilename = resolveCustomAttachmentFilename(recipient, index);
          if (customFilename) {
            const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
            try {
              await unlink(filePath);
            } catch (err) {
              this.logger.warn(`File già assente o non eliminabile: ${filePath}`);
            }
          }
        }

        await this.recipientRepo.update(recipient.id, { attachmentDeletedAt: new Date() });
      }
```

- [ ] **Step 4: Esegui i test e verifica che passino tutti**

Run: `docker compose exec backend node_modules/.bin/jest retention-cleanup.service --maxWorkers=2`
Expected: PASS — 6/6 test verdi (5 esistenti + 1 nuovo).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/retention-cleanup.service.ts apps/backend/src/campaigns/retention-cleanup.service.spec.ts
git commit -m "feat(backend): retention cleanup elimina tutti gli allegati configurati, non solo il primo"
```

---

### Task 6: Passa gli allegati configurati ai canali di invio (EMAIL, PEC, App IO)

**Files:**
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts`

**Interfaces:**
- Consumes: `resolveAttachmentsConfig` da Task 2; `processTemplate(..., attachmentLabels, format)` da Task 3.

- [ ] **Step 1: Aggiorna EmailStrategy**

In `apps/backend/src/channels/email/email.strategy.ts`, aggiungi l'import e modifica le righe 45-50:

```ts
import { processTemplate, wrapInHtmlLayout } from '../template.helper';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
```

Sostituisci:

```ts
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
```

con:

```ts
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
```

- [ ] **Step 2: Aggiorna PecStrategy nello stesso modo**

In `apps/backend/src/channels/pec/pec.strategy.ts`, aggiungi l'import e applica la stessa modifica (righe 45-50, identiche a EmailStrategy):

```ts
import { processTemplate, wrapInHtmlLayout } from '../template.helper';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
```

```ts
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica PEC ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica PEC.';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
```

- [ ] **Step 3: Aggiorna sendAppIoMessage nel processor (formato markdown)**

In `apps/backend/src/queue/notification.processor.ts`, aggiungi l'import:

```ts
import { resolveAttachmentsConfig } from '../attachments/attachment.service';
```

Nel metodo `sendAppIoMessage` (righe 226-239 dell'originale), sostituisci:

```ts
      const processedSubject = processTemplate(
        (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
      );
      const processedMarkdown = processTemplate(
        (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
      );
```

con:

```ts
      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);
      const processedSubject = processTemplate(
        (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
      );
      const processedMarkdown = processTemplate(
        (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
      );
```

- [ ] **Step 4: Esegui l'intera suite backend e verifica il failure set**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso numero di test falliti della baseline nota (7, in `email.strategy`, `pec.strategy`, `notification.processor` — sintassi template vecchia `{{var}}` nei test, non correlata a questa modifica). Nessun NUOVO test rotto rispetto a prima di questo task. Se il conteggio dei falliti cambia, indaga prima di proseguire (non è atteso che questo task tocchi quei 7 test).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/email/email.strategy.ts apps/backend/src/channels/pec/pec.strategy.ts apps/backend/src/queue/notification.processor.ts
git commit -m "feat(backend): passa etichette allegati configurati a EMAIL, PEC e App IO"
```

---

### Task 7: Wizard — selezione multipla colonne allegato con etichetta (Passo 3)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `wizCsvHeaders: string[]`, `wizColumnOptionLabel(h: string): string` (esistenti).
- Produces: stato `wizAttachments: Array<{ key: string; label: string }>` — sostituisce `wizMapping.allegato1`. Consumato da Task 8 per costruire `channelConfig.attachments` e i placeholder del `TemplateEditor`.

- [ ] **Step 1: Aggiungi lo stato `wizAttachments` e rimuovi `allegato1` da `wizMapping`**

In `apps/frontend-admin/src/App.tsx`, trova la dichiarazione di `wizMapping` (riga 239-246):

```tsx
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
    allegato1: '',
  });
```

Sostituisci con (rimuovi `allegato1`, aggiungi nuovo stato accanto):

```tsx
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
  });
  const [wizAttachments, setWizAttachments] = useState<Array<{ key: string; label: string }>>([]);
```

- [ ] **Step 2: Rimuovi `allegato1` dal guess-mapping automatico e dai reset**

In `parseCsvFile` (riga 1493-1501), rimuovi `allegato1: ''` dall'oggetto `newMapping` e la riga di guess corrispondente (riga 1514):

Trova:
```tsx
      const newMapping = {
        codice_fiscale: '',
        full_name: '',
        full_name_2: '',
        email: '',
        pec: '',
        allegato1: '',
      };
      headers.forEach(h => {
        const hLower = h.toLowerCase().replace(/[\s_-]/g, '');
        if (hLower === 'cf' || hLower === 'codicefiscale') newMapping.codice_fiscale = h;
        else if (hLower === 'cognome' || hLower === 'nominativo' || hLower === 'fullname' || hLower === 'nomecompleto' || hLower === 'nome') {
          if (!newMapping.full_name) {
            newMapping.full_name = h;
          } else {
            newMapping.full_name_2 = h;
          }
        }
        else if (hLower === 'email' || hLower === 'mail') newMapping.email = h;
        else if (hLower === 'pec') newMapping.pec = h;
        else if (hLower === 'allegato1' || hLower === 'documento' || hLower === 'avviso' || hLower === 'pdf') newMapping.allegato1 = h;
      });
```

Sostituisci con:

```tsx
      const newMapping = {
        codice_fiscale: '',
        full_name: '',
        full_name_2: '',
        email: '',
        pec: '',
      };
      headers.forEach(h => {
        const hLower = h.toLowerCase().replace(/[\s_-]/g, '');
        if (hLower === 'cf' || hLower === 'codicefiscale') newMapping.codice_fiscale = h;
        else if (hLower === 'cognome' || hLower === 'nominativo' || hLower === 'fullname' || hLower === 'nomecompleto' || hLower === 'nome') {
          if (!newMapping.full_name) {
            newMapping.full_name = h;
          } else {
            newMapping.full_name_2 = h;
          }
        }
        else if (hLower === 'email' || hLower === 'mail') newMapping.email = h;
        else if (hLower === 'pec') newMapping.pec = h;
      });
```

Nella stessa funzione, trova la riga `setWizMapping(newMapping);` (riga 1516) e aggiungi subito dopo il reset degli allegati (nuovo CSV caricato = niente allegati mappati ancora):

```tsx
      setWizMapping(newMapping);
      setWizAttachments([]);
```

Trova il reset del mapping alla rimozione del file CSV (riga ~2940, dentro l'handler "Rimuovi file"):

```tsx
                            setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', allegato1: '' });
```

Sostituisci con:

```tsx
                            setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '' });
                            setWizAttachments([]);
```

- [ ] **Step 3: Sostituisci il dropdown singolo con multi-select + etichette**

Trova (righe 3065-3075, il blocco "Campo Speciale Allegato"):

```tsx
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted">Campo Speciale Allegato (es: Tassa, Ruolo)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.allegato1}
                        onChange={e => handleWizMappingChange('allegato1', e.target.value)}
                      >
                        <option value="">-- Seleziona Colonna Speciale --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>
                  </div>
```

Sostituisci con:

```tsx
                    <div className="col-12">
                      <label className="form-label small fw-semibold text-muted">Colonne Allegato (una o più, con etichetta)</label>
                      <div className="border rounded p-2" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                        {wizCsvHeaders.map(h => {
                          const existingIndex = wizAttachments.findIndex(a => a.key === h);
                          const isSelected = existingIndex !== -1;
                          return (
                            <div key={h} className="d-flex align-items-center gap-2 mb-1">
                              <div className="form-check mb-0">
                                <input
                                  type="checkbox"
                                  className="form-check-input"
                                  id={`wiz-attach-${h}`}
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setWizAttachments(prev => [...prev, { key: h, label: '' }]);
                                    } else {
                                      setWizAttachments(prev => prev.filter(a => a.key !== h));
                                    }
                                  }}
                                />
                                <label htmlFor={`wiz-attach-${h}`} className="form-check-label small" style={{ cursor: 'pointer' }}>
                                  {wizColumnOptionLabel(h)}
                                </label>
                              </div>
                              {isSelected && (
                                <input
                                  type="text"
                                  className="form-control form-control-sm"
                                  style={{ maxWidth: '220px' }}
                                  placeholder="Etichetta (es: Tassa, Ruolo)"
                                  value={wizAttachments[existingIndex].label}
                                  onChange={(e) => {
                                    const label = e.target.value;
                                    setWizAttachments(prev => prev.map(a => (a.key === h ? { ...a, label } : a)));
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="form-text small text-muted">
                        Ordine di selezione = %allegato1%, %allegato2%, ... nel template. Etichetta obbligatoria per usare il blocco "Elenco Allegati".
                      </div>
                    </div>
                  </div>
```

- [ ] **Step 4: Verifica compilazione TypeScript**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale nel browser**

Login (admin/admin, `LDAP_HOST=mock`), wizard invio massivo, carica un CSV multi-colonna (Passo 2), vai al Passo 3: seleziona 2 colonne come allegato, scrivi un'etichetta per ciascuna, verifica che l'ordine di selezione sia rispettato (deseleziona e riseleziona per controllare che l'array si aggiorni correttamente, non solo il flag).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): selezione multipla colonne allegato con etichetta nel wizard"
```

---

### Task 8: Placeholder dinamici nel template, macro Elenco Allegati e invio del payload

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `wizAttachments` da Task 7.
- Produces: `channelConfig.attachments` inviato al backend (consumato da `resolveAttachmentsConfig` lato backend, Task 2/6).

- [ ] **Step 1: Includi `attachments` nel payload di bozza e di lancio**

In `apps/frontend-admin/src/App.tsx`, trova `buildWizChannelConfigDraft` (righe 1706-1716):

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
```

Sostituisci con:

```tsx
  const buildWizChannelConfigDraft = (): Record<string, any> => {
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId };
    if (wizAttachments.length > 0) cfg.attachments = wizAttachments;
    if (wizChannel === 'APP_IO') {
      cfg.ioServiceId = wizAppIoServiceId;
    }
    if (wizAppIoMode !== 'none' && wizAppIoServiceId) {
      cfg.appIo = { mode: wizAppIoMode, ioServiceId: wizAppIoServiceId };
    }
    if (wizBlockedChannels.length > 0) cfg.blockedChannels = wizBlockedChannels;
    return cfg;
  };
```

Trova in `handleWizLaunch` (riga 1775-1781):

```tsx
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          allegatoKey: wizMapping.allegato1,
          mailConfigId: wizMailConfigId,
          from: activeCfg?.fromAddress || '',
        };
```

Sostituisci con:

```tsx
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          attachments: wizAttachments,
          mailConfigId: wizMailConfigId,
          from: activeCfg?.fromAddress || '',
        };
```

- [ ] **Step 2: Aggiungi i placeholder dinamici e la macro nel TemplateEditor**

Trova (righe 3204-3218, blocco "Corpo del Messaggio (Template)"):

```tsx
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Corpo del Messaggio (Template)</label>
                      <TemplateEditor
                        value={wizBody}
                        onChange={setWizBody}
                        placeholders={[
                          { label: 'Link Allegato', token: '%allegato1%' },
                          { label: 'Nominativo', token: '%nominativo%' },
                          { label: 'Codice Fiscale', token: '%codice_fiscale%' },
                          ...wizCsvHeaders
                            .filter(h => h !== wizMapping.codice_fiscale && h !== wizMapping.full_name && h !== wizMapping.email && h !== wizMapping.pec)
                            .map(h => ({ label: `Colonna: ${h}`, token: `%${h}%` })),
                        ]}
                      />
                    </div>
```

Sostituisci con:

```tsx
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Corpo del Messaggio (Template)</label>
                      <TemplateEditor
                        value={wizBody}
                        onChange={setWizBody}
                        placeholders={[
                          ...(wizAttachments.length > 0 ? [{ label: 'Elenco Allegati', token: '%elenco_allegati%' }] : []),
                          ...wizAttachments.map((a, idx) => ({ label: `Link: ${a.label || `Allegato ${idx + 1}`}`, token: `%allegato${idx + 1}%` })),
                          { label: 'Nominativo', token: '%nominativo%' },
                          { label: 'Codice Fiscale', token: '%codice_fiscale%' },
                          ...wizCsvHeaders
                            .filter(h => h !== wizMapping.codice_fiscale && h !== wizMapping.full_name && h !== wizMapping.email && h !== wizMapping.pec && !wizAttachments.some(a => a.key === h))
                            .map(h => ({ label: `Colonna: ${h}`, token: `%${h}%` })),
                        ]}
                      />
                    </div>
```

- [ ] **Step 3: Estendi la simulazione dell'anteprima live (Passo 4)**

Trova (righe 3272-3285, blocco `dangerouslySetInnerHTML` dell'anteprima):

```tsx
                          <div
                            style={{ padding: '20px', fontSize: '0.9rem', color: '#333', lineHeight: '1.5', minHeight: '150px' }}
                            dangerouslySetInnerHTML={{
                              __html: wizBody
                                .replace(/%allegato1%/g, 'http://localhost:3001/?notificationId=TEST-UUID-SIMULAZIONE')
                                .replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (match, key) => escapeHtml(wizValidRows[wizPreviewIndex][key] || ''))
                                .replace(/%([^%()]+)%/gi, (match, key) => {
                                  const k = key.toLowerCase().trim();
                                  if (k === 'nominativo' || k === 'full_name') return escapeHtml(getWizRowFullName(wizValidRows[wizPreviewIndex]));
                                  if (k === 'codice_fiscale' || k === 'cf') return escapeHtml(wizValidRows[wizPreviewIndex][wizMapping.codice_fiscale] || '');
                                  return wizValidRows[wizPreviewIndex][key] ? escapeHtml(wizValidRows[wizPreviewIndex][key]) : match;
                                }),
                            }}
                          />
```

Sostituisci con:

```tsx
                          <div
                            style={{ padding: '20px', fontSize: '0.9rem', color: '#333', lineHeight: '1.5', minHeight: '150px' }}
                            dangerouslySetInnerHTML={{
                              __html: (() => {
                                let preview = wizBody;
                                wizAttachments.forEach((a, idx) => {
                                  const placeholder = new RegExp(`%allegato${idx + 1}%`, 'g');
                                  preview = preview.replace(placeholder, `http://localhost:3001/?notificationId=TEST-UUID-SIMULAZIONE-${idx}`);
                                });
                                if (preview.includes('%elenco_allegati%')) {
                                  const block = wizAttachments.length === 0
                                    ? ''
                                    : `<table style="width:100%; border-collapse: collapse;">${wizAttachments
                                        .map((a, idx) => `<tr><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;">${escapeHtml(a.label || `Allegato ${idx + 1}`)}</td><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;"><a href="#">Scarica</a></td></tr>`)
                                        .join('')}</table>`;
                                  preview = preview.replace(/%elenco_allegati%/g, block);
                                }
                                return preview
                                  .replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (match, key) => escapeHtml(wizValidRows[wizPreviewIndex][key] || ''))
                                  .replace(/%([^%()]+)%/gi, (match, key) => {
                                    const k = key.toLowerCase().trim();
                                    if (k === 'nominativo' || k === 'full_name') return escapeHtml(getWizRowFullName(wizValidRows[wizPreviewIndex]));
                                    if (k === 'codice_fiscale' || k === 'cf') return escapeHtml(wizValidRows[wizPreviewIndex][wizMapping.codice_fiscale] || '');
                                    return wizValidRows[wizPreviewIndex][key] ? escapeHtml(wizValidRows[wizPreviewIndex][key]) : match;
                                  });
                              })(),
                            }}
                          />
```

- [ ] **Step 4: Verifica compilazione TypeScript**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale end-to-end nel browser**

Login, wizard invio massivo, CSV con almeno 2 colonne allegato mappate con etichetta (Passo 3), al Passo 4: verifica che i pulsanti placeholder "Elenco Allegati" e "Link: <etichetta>" compaiano nella toolbar del `TemplateEditor`; clicca "Elenco Allegati" e verifica che l'anteprima a destra mostri una tabella con le etichette configurate; salva la campagna come bozza e verifica (via `docker compose exec backend psql` o riaprendo la bozza) che `channelConfig.attachments` sia stato salvato correttamente.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): placeholder dinamici allegati, macro elenco_allegati e payload multi-allegato"
```

---

## Note per piani futuri (fuori scope qui)

- Redesign del template App IO (editor dedicato, non riuso dell'HTML email) — spec separata già concordata con l'utente, da fare come piano successivo.
- Supporto allegati sul canale SEND — gap pre-esistente, non affrontato in questo piano.
- Riordino drag-and-drop delle colonne allegato nel wizard — non richiesto, aggiungibile in futuro se serve cambiare l'ordine senza deselezionare/riselezionare.
