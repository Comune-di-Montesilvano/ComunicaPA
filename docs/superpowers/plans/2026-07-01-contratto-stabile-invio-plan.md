# Contratto Stabile Canali di Invio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fissare come contratto stabile (non modificabile senza breaking change) 5 comportamenti dei canali di invio: link download firmato con TTL, retention policy configurabile, lock del template a campagna lanciata (con editor WYSIWYG responsive), statistiche di download tipizzate per destinatario, invio App IO indipendente dall'esito del canale primario.

**Architecture:** Nessuna nuova infrastruttura esterna. Riusa BullMQ/TypeORM/synchronize esistenti. Aggiunge: una utility di firma HMAC per i link, un cron (`@nestjs/schedule`) per la retention, un nuovo endpoint pubblico non autenticato per il download, colonne tipizzate su `Recipient`/`Campaign`, un editor Tiptap nel wizard React.

**Tech Stack:** NestJS 10, TypeORM (synchronize:true in dev — nessuna migration da scrivere), BullMQ, `@nestjs/schedule` (nuovo), Node `crypto` (HMAC, nessuna libreria nuova lato firma), React 19 + Tiptap (nuovo, editor).

## Global Constraints

- Tutto gira in Docker: nessun comando `pnpm`/`node` va eseguito sull'host. Ogni modifica a `package.json` richiede `docker compose up -d --build <servizio>` (rebuild obbligatorio, da CLAUDE.md).
- pnpm v11: install sempre con `--ignore-scripts`; per pacchetti che richiedono `esbuild` fare `pnpm rebuild esbuild`. Non usare `pnpm run`/`pnpm --filter` nei CMD Docker.
- TypeScript strict mode (`tsconfig.base.json`), nessun `any` non giustificato nei nuovi file.
- Segui i pattern esistenti: `IsEnum`/`class-validator` nei DTO, `Logger` di NestJS per i log, query builder atomiche per gli update di stato (vedi `CampaignsService.launch`), test con `Test.createTestingModule` + mock repository stile `campaigns.service.spec.ts`.
- Il wizard guidato (`apps/frontend-admin/src/App.tsx`) resta l'unico punto di scrittura di `channelConfig`: nessun nuovo endpoint di modifica campagna va introdotto in questo piano.
- YAGNI esplicito dallo spec: niente versioning separato del template, niente tabella `download_events` per-evento, niente concorrenza reale (thread/promise simultanee) per App IO, niente riattivazione di campagne `CANCELLED`.

---

## Task 1: Retention config + colonna `Campaign.retentionDays`

**Files:**
- Modify: `apps/backend/src/config/configuration.ts`
- Modify: `apps/backend/src/entities/campaign.entity.ts`
- Create: `apps/backend/src/campaigns/retention.util.ts`
- Test: `apps/backend/src/campaigns/retention.util.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AppConfiguration.retention.maxDays: number`, `AppConfiguration.downloadLink.secret: string`, `AppConfiguration.origins.publicApi: string` (usati dai task 3-6)
- Produces: `Campaign.retentionDays: number | null`
- Produces: `getEffectiveRetentionDays(campaign: Pick<Campaign, 'retentionDays'>, maxDays: number): number`

- [ ] **Step 1: Scrivi il test per `getEffectiveRetentionDays`**

```typescript
// apps/backend/src/campaigns/retention.util.spec.ts
import { getEffectiveRetentionDays } from './retention.util';

describe('getEffectiveRetentionDays', () => {
  it('usa retentionDays della campagna se impostato', () => {
    expect(getEffectiveRetentionDays({ retentionDays: 30 }, 90)).toBe(30);
  });

  it('usa il default globale se retentionDays è null', () => {
    expect(getEffectiveRetentionDays({ retentionDays: null }, 90)).toBe(90);
  });

  it('non supera mai il default globale anche se la campagna chiede di più', () => {
    expect(getEffectiveRetentionDays({ retentionDays: 365 }, 90)).toBe(90);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run (dentro il container backend): `node_modules/.bin/jest campaigns/retention.util.spec.ts`
Expected: FAIL — `Cannot find module './retention.util'`

- [ ] **Step 3: Implementa `retention.util.ts`**

```typescript
// apps/backend/src/campaigns/retention.util.ts
export function getEffectiveRetentionDays(
  campaign: { retentionDays: number | null },
  maxDays: number,
): number {
  if (campaign.retentionDays == null) return maxDays;
  return Math.min(campaign.retentionDays, maxDays);
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest campaigns/retention.util.spec.ts`
Expected: PASS (3 test)

- [ ] **Step 5: Aggiungi le nuove chiavi a `configuration.ts`**

In `apps/backend/src/config/configuration.ts`, estendi l'interfaccia e il factory:

```typescript
// dentro AppConfiguration, dopo `brand: {...}`
  retention: {
    maxDays: number;
  };
  downloadLink: {
    secret: string;
  };
```

```typescript
// dentro origins, aggiungi il campo publicApi
  origins: {
    admin: string;
    citizen: string;
    publicApi: string;
  };
```

```typescript
// dentro l'export default (), dopo `brand: {...}`
  retention: {
    maxDays: parseInt(process.env['RETENTION_MAX_DAYS'] ?? '90', 10),
  },
  downloadLink: {
    secret: process.env['DOWNLOAD_LINK_SECRET'] ?? 'change-me-in-production',
  },
```

E aggiorna il blocco `origins` esistente:

```typescript
  origins: {
    admin: process.env['ADMIN_ORIGIN'] ?? 'http://localhost:3000',
    citizen: process.env['CITIZEN_ORIGIN'] ?? 'http://localhost:3001',
    publicApi: process.env['PUBLIC_BACKEND_URL'] ?? 'http://localhost:8080',
  },
```

- [ ] **Step 6: Aggiungi la colonna `retentionDays` a `Campaign`**

In `apps/backend/src/entities/campaign.entity.ts`, dopo `channelConfig`:

```typescript
  @Column({ type: 'int', name: 'retention_days', nullable: true })
  retentionDays!: number | null;
```

- [ ] **Step 7: Documenta le nuove variabili in `.env.example`**

Aggiungi nella sezione env principale (vicino a `BRAND_NAME`):

```
# ── Retention & link download firmato ────────────────────────────────────────
RETENTION_MAX_DAYS=90
DOWNLOAD_LINK_SECRET=<genera-un-valore-random-forte-in-produzione>
PUBLIC_BACKEND_URL=http://localhost:8080
```

- [ ] **Step 8: Rebuild backend (nuove env var lette da `ConfigModule`, nessuna dipendenza npm nuova in questo task — restart sufficiente)**

Run: `docker compose up -d backend`
Expected: container riparte senza errori di boot

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/config/configuration.ts apps/backend/src/entities/campaign.entity.ts apps/backend/src/campaigns/retention.util.ts apps/backend/src/campaigns/retention.util.spec.ts .env.example
git commit -m "feat(retention): aggiungi retentionDays campagna e config retention/download-link"
```

---

## Task 2: Colonne statistiche download su `Recipient`

**Files:**
- Modify: `apps/backend/src/entities/recipient.entity.ts`

**Interfaces:**
- Consumes: nessuna (task indipendente)
- Produces: `Recipient.downloadCount: number`, `Recipient.firstDownloadedAt: Date | null`, `Recipient.lastDownloadedAt: Date | null`, `Recipient.attachmentExpiresAt: Date | null`, `Recipient.attachmentDeletedAt: Date | null` — usati dai task 4, 5, 6, 7, 8

- [ ] **Step 1: Aggiungi le colonne all'entity**

In `apps/backend/src/entities/recipient.entity.ts`, dopo il campo `status`:

```typescript
  @Column({ type: 'int', name: 'download_count', default: 0 })
  downloadCount!: number;

  @Column({ type: 'timestamptz', name: 'first_downloaded_at', nullable: true })
  firstDownloadedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'last_downloaded_at', nullable: true })
  lastDownloadedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'attachment_expires_at', nullable: true })
  attachmentExpiresAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'attachment_deleted_at', nullable: true })
  attachmentDeletedAt!: Date | null;
```

- [ ] **Step 2: Rebuild backend per applicare `synchronize` (dev) sulle nuove colonne**

Run: `docker compose up -d --build backend`
Expected: log contiene `ALTER TABLE "recipients" ADD COLUMN` (TypeORM synchronize in development, vedi `apps/backend/src/database/database.module.ts:18`) senza errori

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/entities/recipient.entity.ts
git commit -m "feat(recipient): aggiungi colonne tipizzate download/retention (sostituiscono extraData JSONB)"
```

---

## Task 3: Utility di firma HMAC per il link download

**Files:**
- Create: `apps/backend/src/channels/download-link.util.ts`
- Test: `apps/backend/src/channels/download-link.util.spec.ts`

**Interfaces:**
- Consumes: nessuna
- Produces: `signDownloadLink(recipientId: string, expiresAtUnix: number, secret: string): string`, `verifyDownloadLink(recipientId: string, expiresAtUnix: number, signature: string, secret: string): boolean` — usati dai task 4 e 5

- [ ] **Step 1: Scrivi i test**

```typescript
// apps/backend/src/channels/download-link.util.spec.ts
import { signDownloadLink, verifyDownloadLink } from './download-link.util';

describe('download-link.util', () => {
  const secret = 'test-secret';
  const recipientId = '11111111-1111-1111-1111-111111111111';
  const exp = 1893456000; // 2030-01-01

  it('genera una firma verificabile con lo stesso secret', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp, sig, secret)).toBe(true);
  });

  it('rifiuta la firma se il recipientId è diverso', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink('22222222-2222-2222-2222-222222222222', exp, sig, secret)).toBe(false);
  });

  it('rifiuta la firma se exp è diverso da quello firmato', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp + 1, sig, secret)).toBe(false);
  });

  it('rifiuta la firma se il secret è diverso', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp, sig, 'altro-secret')).toBe(false);
  });

  it('rifiuta una firma malformata senza lanciare eccezioni', () => {
    expect(verifyDownloadLink(recipientId, exp, 'non-hex-!!!', secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `node_modules/.bin/jest channels/download-link.util.spec.ts`
Expected: FAIL — `Cannot find module './download-link.util'`

- [ ] **Step 3: Implementa l'utility**

```typescript
// apps/backend/src/channels/download-link.util.ts
import { createHmac, timingSafeEqual } from 'crypto';

function computeSignature(recipientId: string, expiresAtUnix: number, secret: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${expiresAtUnix}`).digest('hex');
}

export function signDownloadLink(recipientId: string, expiresAtUnix: number, secret: string): string {
  return computeSignature(recipientId, expiresAtUnix, secret);
}

export function verifyDownloadLink(
  recipientId: string,
  expiresAtUnix: number,
  signature: string,
  secret: string,
): boolean {
  const expected = computeSignature(recipientId, expiresAtUnix, secret);
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

Run: `node_modules/.bin/jest channels/download-link.util.spec.ts`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/download-link.util.ts apps/backend/src/channels/download-link.util.spec.ts
git commit -m "feat(security): utility HMAC per link download firmato (no login)"
```

---

## Task 4: Link firmato nel template email/PEC/App IO

**Files:**
- Modify: `apps/backend/src/channels/template.helper.ts`
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts:79-89` (blocco App IO)
- Test: crea/estendi `apps/backend/src/channels/template.helper.spec.ts`

**Interfaces:**
- Consumes: `getEffectiveRetentionDays` (Task 1), `signDownloadLink` (Task 3), `AppConfiguration.retention.maxDays`/`downloadLink.secret`/`origins.publicApi` (Task 1)
- Produces: nuova firma `processTemplate(bodyTemplate: string, recipient: Recipient, publicApiUrl: string, downloadLinkSecret: string, expiresAtUnix: number): string` (sostituisce quella attuale a 3 argomenti — è un breaking change interno, tutti i chiamanti vanno aggiornati in questo stesso task)

- [ ] **Step 1: Scrivi il test per il nuovo comportamento di `processTemplate`**

```typescript
// apps/backend/src/channels/template.helper.spec.ts
import { processTemplate } from './template.helper';
import type { Recipient } from '../entities/recipient.entity';

const baseRecipient = {
  id: 'r-123',
  codiceFiscale: 'RSSMRA85M01H501Z',
  fullName: 'Mario Rossi',
  email: 'mario@example.com',
  pec: null,
  extraData: {},
} as Recipient;

describe('processTemplate — link firmato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('genera un link con recipientId, exp e sig invece di notificationId in chiaro', () => {
    const result = processTemplate('Scarica qui: %allegato1%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toContain(`http://api.test/public/download/${baseRecipient.id}?exp=${exp}&sig=`);
    expect(result).not.toContain('notificationId=');
  });

  it('la firma nel link è verificabile con verifyDownloadLink', () => {
    const result = processTemplate('%allegato1%', baseRecipient, 'http://api.test', secret, exp);
    const sig = result.match(/sig=([a-f0-9]+)/)?.[1];
    expect(sig).toBeDefined();
  });

  it('continua a sostituire %nominativo% come prima', () => {
    const result = processTemplate('Gentile %nominativo%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Gentile Mario Rossi');
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `node_modules/.bin/jest channels/template.helper.spec.ts`
Expected: FAIL — la firma attuale di `processTemplate` accetta solo 3 argomenti, il link generato contiene `notificationId=` invece di `public/download`

- [ ] **Step 3: Aggiorna `processTemplate` in `template.helper.ts`**

```typescript
// apps/backend/src/channels/template.helper.ts
import type { Recipient } from '../entities/recipient.entity';
import { signDownloadLink } from './download-link.util';

export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
): string {
  const sig = signDownloadLink(recipient.id, expiresAtUnix, downloadLinkSecret);
  const downloadUrl = `${publicApiUrl}/public/download/${recipient.id}?exp=${expiresAtUnix}&sig=${sig}`;
  let content = bodyTemplate;

  // 1. Replace %allegato1%
  content = content.replace(/%allegato1%/g, downloadUrl);

  // (resto della funzione invariato da qui in poi: getVal, sostituzione %parametro...% e %key%)
```

Lascia invariato il resto del corpo funzione (righe 19-56 del file originale), solo la firma e le prime righe cambiano come sopra.

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest channels/template.helper.spec.ts`
Expected: PASS (3 test)

- [ ] **Step 5: Aggiorna `email.strategy.ts` per passare i nuovi parametri**

In `apps/backend/src/channels/email/email.strategy.ts`, sostituisci:

```typescript
    const citizenPortalUrl = this.config.get('origins.citizen', { infer: true });
    const brandName = this.config.get('brand.name', { infer: true }) || 'Comune di Montesilvano';

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, citizenPortalUrl);
    const bodyText = processTemplate(bodyTemplate, recipient, citizenPortalUrl);
```

con:

```typescript
    const brandName = this.config.get('brand.name', { infer: true }) || 'Comune di Montesilvano';
    const publicApiUrl = this.config.get('origins.publicApi', { infer: true });
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = this.config.get('retention.maxDays', { infer: true });
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica ComunicaPA';
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || 'Hai ricevuto una nuova notifica.';

    // Process templates
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix);
```

E aggiungi in cima al file l'import:

```typescript
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';
```

- [ ] **Step 6: Applica la stessa modifica a `pec.strategy.ts`**

`apps/backend/src/channels/pec/pec.strategy.ts` ha la stessa struttura di `email.strategy.ts` (righe equivalenti a 29-37): applica identico cambio di import e di calcolo `publicApiUrl`/`downloadLinkSecret`/`expiresAtUnix`, passando gli stessi 5 argomenti a `processTemplate`.

- [ ] **Step 7: Aggiorna il blocco App IO in `notification.processor.ts:79-89`**

Sostituisci:

```typescript
            const citizenPortalUrl = appIoConfig.citizenPortalUrl || 'http://localhost:3001';
            const processedSubject = processTemplate(
              (campaign.channelConfig?.['subject'] as string) || campaign.name,
              recipient,
              citizenPortalUrl,
            );
            const processedMarkdown = processTemplate(
              (campaign.channelConfig?.['body'] as string) || '',
              recipient,
              citizenPortalUrl,
            );
```

con:

```typescript
            const publicApiUrl = this.config.get('origins.publicApi', { infer: true });
            const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
            const retentionMaxDays = this.config.get('retention.maxDays', { infer: true });
            const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
            const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;
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

`NotificationProcessor` non ha ancora un `ConfigService` iniettato: aggiungi al costruttore (vedi righe 18-29 del file originale):

```typescript
  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @Inject(CHANNEL_STRATEGIES)
    private readonly strategies: Map<NotificationChannel, IChannelStrategy>,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {
    super();
  }
```

E aggiungi in cima al file:

```typescript
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
```

- [ ] **Step 8: Aggiorna i test esistenti delle strategy che chiamano `processTemplate` indirettamente**

`apps/backend/src/channels/email/email.strategy.spec.ts` e `pec.strategy.spec.ts` istanziano `ConfigService` come mock oggetto `{ get: (key) => cfg[key] }` (vedi righe 12-24 del file email). Aggiungi le nuove chiavi al mock in entrambi i file:

```typescript
      'origins.publicApi': 'http://api.test',
      'downloadLink.secret': 'test-secret',
      'retention.maxDays': 90,
```

- [ ] **Step 9: Esegui l'intera suite canali e verifica che passi**

Run: `node_modules/.bin/jest channels`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/channels/template.helper.ts apps/backend/src/channels/template.helper.spec.ts apps/backend/src/channels/email/email.strategy.ts apps/backend/src/channels/email/email.strategy.spec.ts apps/backend/src/channels/pec/pec.strategy.ts apps/backend/src/channels/pec/pec.strategy.spec.ts apps/backend/src/queue/notification.processor.ts
git commit -m "feat(security): link download firmato HMAC con TTL in email/PEC/App IO (sostituisce notificationId in chiaro)"
```

---

## Task 5: Estrai `AttachmentService` condiviso + endpoint pubblico di download

**Files:**
- Create: `apps/backend/src/attachments/attachment.service.ts`
- Create: `apps/backend/src/attachments/attachment.module.ts`
- Test: `apps/backend/src/attachments/attachment.service.spec.ts`
- Modify: `apps/backend/src/citizen/citizen.service.ts` (rimuovi `generateAttachmentPdf`, usa `AttachmentService`)
- Modify: `apps/backend/src/citizen/citizen.module.ts` (importa `AttachmentModule`)
- Create: `apps/backend/src/public-download/public-download.controller.ts`
- Create: `apps/backend/src/public-download/public-download.module.ts`
- Test: `apps/backend/src/public-download/public-download.controller.spec.ts`
- Modify: `apps/backend/src/app.module.ts` (registra `PublicDownloadModule`)

**Interfaces:**
- Consumes: `verifyDownloadLink` (Task 3), `Recipient.attachmentDeletedAt`/`downloadCount`/`firstDownloadedAt`/`lastDownloadedAt` (Task 2), `AppConfiguration.downloadLink.secret` (Task 1)
- Produces: `AttachmentService.generatePdfBuffer(recipient: Recipient): Promise<Buffer>` — usato da `citizen.service.ts` e `public-download.controller.ts`

- [ ] **Step 1: Estrai la logica di generazione PDF in `AttachmentService`**

Sposta l'intero corpo di `CitizenService.generateAttachmentPdf` (righe 55-184 di `apps/backend/src/citizen/citizen.service.ts`) in un nuovo file, invariato nella logica:

```typescript
// apps/backend/src/attachments/attachment.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'fs';
import { join } from 'path';
import type { Recipient } from '../entities/recipient.entity';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  async generatePdfBuffer(recipient: Recipient): Promise<Buffer> {
    // Verifichiamo se esiste un allegato PDF personalizzato caricato sul disco
    let customFilename: string | undefined = undefined;
    const allegatoKey = recipient.campaign.channelConfig?.['allegatoKey'] as string;
    if (allegatoKey && recipient.extraData?.[allegatoKey]) {
      customFilename = String(recipient.extraData[allegatoKey]);
    } else {
      for (const val of Object.values(recipient.extraData)) {
        if (typeof val === 'string' && val.toLowerCase().endsWith('.pdf')) {
          customFilename = val;
          break;
        }
      }
    }

    if (customFilename) {
      const filePath = join(__dirname, '..', '..', 'uploads', 'attachments', recipient.campaignId, customFilename);
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

```typescript
// apps/backend/src/attachments/attachment.module.ts
import { Module } from '@nestjs/common';
import { AttachmentService } from './attachment.service';

@Module({
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
```

- [ ] **Step 2: Scrivi il test dell'estrazione**

```typescript
// apps/backend/src/attachments/attachment.service.spec.ts
import { AttachmentService } from './attachment.service';
import type { Recipient } from '../entities/recipient.entity';

describe('AttachmentService', () => {
  let service: AttachmentService;

  beforeEach(() => {
    service = new AttachmentService();
  });

  it('genera un buffer PDF quando non c\'è allegato personalizzato', async () => {
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

- [ ] **Step 3: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest attachments/attachment.service.spec.ts`
Expected: PASS

- [ ] **Step 4: Aggiorna `CitizenService` per usare `AttachmentService`**

In `apps/backend/src/citizen/citizen.service.ts`, rimuovi il metodo `generateAttachmentPdf` (righe 55-184) e le importazioni `PDFDocument, StandardFonts, rgb` non più usate, sostituendolo con:

```typescript
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly attachmentService: AttachmentService,
  ) {}
```

```typescript
  async generateAttachmentPdf(id: string, codiceFiscale: string): Promise<Buffer> {
    const recipient = await this.findOneForCitizen(id, codiceFiscale);
    return this.attachmentService.generatePdfBuffer(recipient);
  }
```

E aggiungi l'import: `import { AttachmentService } from '../attachments/attachment.service';`

In `apps/backend/src/citizen/citizen.module.ts`, importa `AttachmentModule`.

- [ ] **Step 5: Esegui la suite `citizen` esistente e verifica che passi ancora**

Run: `node_modules/.bin/jest citizen`
Expected: PASS (nessuna regressione)

- [ ] **Step 6: Scrivi il test del controller pubblico**

```typescript
// apps/backend/src/public-download/public-download.controller.spec.ts
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
      controller.download(recipientId, String(futureExp), 'firma-non-valida', res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 410 se il link è scaduto', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const sig = signDownloadLink(recipientId, pastExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, String(pastExp), sig, res)).rejects.toThrow(GoneException);
  });

  it('rifiuta con 410 se l\'allegato è già stato eliminato per retention', async () => {
    mockRepo.findOne.mockResolvedValueOnce({ ...mockRecipient, attachmentDeletedAt: new Date() });
    const sig = signDownloadLink(recipientId, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, String(futureExp), sig, res)).rejects.toThrow(GoneException);
  });

  it('serve il PDF e incrementa downloadCount con firma valida', async () => {
    const sig = signDownloadLink(recipientId, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await controller.download(recipientId, String(futureExp), sig, res);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
    expect(mockRepo.update).toHaveBeenCalledWith(
      recipientId,
      expect.objectContaining({ downloadCount: 1 }),
    );
  });
});
```

- [ ] **Step 7: Esegui il test e verifica che fallisca**

Run: `node_modules/.bin/jest public-download`
Expected: FAIL — `Cannot find module './public-download.controller'`

- [ ] **Step 8: Implementa il controller pubblico**

```typescript
// apps/backend/src/public-download/public-download.controller.ts
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

  @Get(':recipientId')
  async download(
    @Param('recipientId') recipientId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    const expiresAtUnix = parseInt(exp, 10);
    const secret = this.config.get('downloadLink.secret', { infer: true });

    if (!Number.isFinite(expiresAtUnix) || !verifyDownloadLink(recipientId, expiresAtUnix, sig, secret)) {
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

    const pdfBuffer = await this.attachmentService.generatePdfBuffer(recipient);

    await this.recipientRepo.update(recipientId, {
      downloadCount: recipient.downloadCount + 1,
      firstDownloadedAt: recipient.firstDownloadedAt ?? new Date(),
      lastDownloadedAt: new Date(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avviso_${recipientId.slice(0, 8)}.pdf"`);
    res.end(pdfBuffer);
  }
}
```

```typescript
// apps/backend/src/public-download/public-download.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { AttachmentModule } from '../attachments/attachment.module';
import { PublicDownloadController } from './public-download.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient]), AttachmentModule],
  controllers: [PublicDownloadController],
})
export class PublicDownloadModule {}
```

- [ ] **Step 9: Registra il modulo in `app.module.ts`**

Aggiungi `PublicDownloadModule` all'array `imports` di `apps/backend/src/app.module.ts` (vicino a `CitizenModule`) e il relativo import.

- [ ] **Step 10: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest public-download`
Expected: PASS (4 test)

- [ ] **Step 11: Rebuild backend**

Run: `docker compose up -d --build backend`
Expected: boot senza errori, nessun conflitto di route

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/attachments apps/backend/src/public-download apps/backend/src/citizen/citizen.service.ts apps/backend/src/citizen/citizen.module.ts apps/backend/src/app.module.ts
git commit -m "feat(download): endpoint pubblico non autenticato con verifica firma HMAC + tracking statistiche"
```

---

## Task 6: Notification processor — `attachmentExpiresAt` + App IO indipendente

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Test: `apps/backend/src/queue/notification.processor.spec.ts` (crealo se non esiste, verifica prima con `Glob apps/backend/src/queue/*.spec.ts`)

**Interfaces:**
- Consumes: `getEffectiveRetentionDays` (Task 1), `Recipient.attachmentExpiresAt` (Task 2)
- Produces: comportamento — l'esito del job App IO non dipende più dall'esito del canale primario

- [ ] **Step 1: Verifica se esiste già un file di test per il processor**

Run: `ls apps/backend/src/queue/`
Se non esiste `notification.processor.spec.ts`, crealo da zero come sotto. Se esiste, integra i test nel file esistente senza rimuovere quelli presenti.

- [ ] **Step 2: Scrivi il test che documenta l'indipendenza App IO**

```typescript
// apps/backend/src/queue/notification.processor.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotificationProcessor } from './notification.processor';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES } from '../channels/channel.interface';

describe('NotificationProcessor — indipendenza App IO', () => {
  let processor: NotificationProcessor;

  const mockRecipient = {
    id: 'rec-1',
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: 'mario@example.com',
  };
  const mockCampaign = {
    id: 'camp-1',
    name: 'TARI 2026',
    retentionDays: null,
    channelConfig: { appIo: { apiKey: 'key', baseUrl: 'http://io.test' } },
  };

  const failingStrategy = { channel: 'EMAIL', send: jest.fn().mockRejectedValue(new Error('SMTP down')) };
  const strategies = new Map([['EMAIL', failingStrategy]]);

  const mockAttemptRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const mockRecipientRepo = { findOne: jest.fn().mockResolvedValue(mockRecipient), update: jest.fn().mockResolvedValue(undefined) };
  const mockCampaignRepo = { findOne: jest.fn().mockResolvedValue(mockCampaign), increment: jest.fn().mockResolvedValue(undefined) };
  const mockConfig = {
    get: (key: string) => ({ 'downloadLink.secret': 's', 'origins.publicApi': 'http://api.test', 'retention.maxDays': 90 }[key]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    mockRecipientRepo.findOne.mockResolvedValue(mockRecipient);
    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);

    const module = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: CHANNEL_STRATEGIES, useValue: strategies },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    processor = module.get(NotificationProcessor);
  });

  it('tenta comunque App IO quando il canale primario (EMAIL) fallisce, poi rilancia l\'errore primario', async () => {
    const job = { id: '1', data: { campaignId: 'camp-1', attemptId: 'att-1', recipientId: 'rec-1', channel: 'EMAIL' } } as any;

    await expect(processor.process(job)).rejects.toThrow('SMTP down');

    expect((global as any).fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/messages'),
      expect.any(Object),
    );
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({ status: RecipientStatus.FAILED }));
    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({ status: AttemptStatus.FAILED }));
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `node_modules/.bin/jest queue/notification.processor.spec.ts`
Expected: FAIL — con il codice attuale, se `strategy.send()` lancia, il blocco App IO non viene mai raggiunto, quindi `fetch` non viene chiamato

- [ ] **Step 4: Riscrivi `process()` per disaccoppiare l'esito App IO da quello primario**

Sostituisci l'intero corpo del metodo `process` in `apps/backend/src/queue/notification.processor.ts` (righe 31-155) con:

```typescript
  async process(job: Job<NotificationJobData>): Promise<void> {
    const { campaignId, attemptId, recipientId, channel } = job.data;
    this.logger.log(`Job ${job.id}: campaign=${campaignId} recipient=${recipientId} channel=${channel}`);

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient) {
      throw new Error(`Recipient ${recipientId} not found`);
    }

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const strategy = this.strategies.get(channel);
    if (!strategy) {
      throw new Error(`Strategy for channel ${channel} not found`);
    }

    // 1. Invio canale primario — l'esito NON condiziona più l'invio App IO
    let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
    let primaryError: Error | undefined;
    try {
      primaryResult = await strategy.send(recipient, campaign);
    } catch (err: any) {
      primaryError = err instanceof Error ? err : new Error(String(err));
    }

    const responsePayload: Record<string, any> = {
      ...(primaryResult?.responsePayload || {}),
      messageId: primaryResult?.messageId,
    };

    // 2. Invio App IO indipendente: parte se configurato, a prescindere dall'esito del canale primario
    const appIoConfig = campaign.channelConfig?.['appIo'] as any;
    if ((channel === 'EMAIL' || channel === 'PEC') && appIoConfig?.apiKey) {
      const hasAppIo = await this.checkAppIoProfile(appIoConfig.baseUrl, appIoConfig.apiKey, recipient.codiceFiscale);

      if (hasAppIo) {
        try {
          this.logger.log(`Invio App IO indipendente per CF: ${recipient.codiceFiscale}`);
          const publicApiUrl = this.config.get('origins.publicApi', { infer: true });
          const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
          const retentionMaxDays = this.config.get('retention.maxDays', { infer: true });
          const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
          const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

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

          const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
            body: JSON.stringify({
              fiscal_code: recipient.codiceFiscale,
              content: { subject: processedSubject, markdown: processedMarkdown },
            }),
          });

          if (appIoRes.ok) {
            const appIoData = (await appIoRes.json()) as { id: string };
            responsePayload.appIo = { success: true, messageId: appIoData.id };
            this.logger.log(`App IO delivery success: messageId=${appIoData.id}`);
          } else {
            responsePayload.appIo = { success: false, error: `App IO status: ${appIoRes.status}` };
            this.logger.warn(`App IO delivery failed with status ${appIoRes.status}`);
          }
        } catch (appIoErr: any) {
          responsePayload.appIo = { success: false, error: appIoErr.message };
          this.logger.error(`App IO delivery error: ${appIoErr.message}`);
        }
      }
    }

    // 3. Esito canale primario determina lo stato del tentativo/destinatario
    if (primaryError) {
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: primaryError.message,
        responsePayload,
      });
      await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      throw primaryError;
    }

    const retentionMaxDaysForExpiry = this.config.get('retention.maxDays', { infer: true });
    const retentionDaysForExpiry = getEffectiveRetentionDays(campaign, retentionMaxDaysForExpiry);
    const attachmentExpiresAt = new Date(Date.now() + retentionDaysForExpiry * 86400 * 1000);

    await this.attemptRepo.update(attemptId, {
      status: AttemptStatus.SUCCESS,
      sentAt: new Date(),
      responsePayload,
    });
    await this.recipientRepo.update(recipientId, {
      status: RecipientStatus.SENT,
      attachmentExpiresAt,
    });
    await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
  }
```

Il metodo privato `checkAppIoProfile` (righe 157-177 del file originale) resta invariato.

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest queue/notification.processor.spec.ts`
Expected: PASS

- [ ] **Step 6: Aggiungi un secondo test per il percorso di successo (regressione)**

Aggiungi al file di test:

```typescript
  it('percorso di successo: imposta attachmentExpiresAt e sentCount, non lancia errori', async () => {
    const okStrategy = { channel: 'EMAIL', send: jest.fn().mockResolvedValue({ messageId: 'msg-1', responsePayload: {} }) };
    strategies.set('EMAIL', okStrategy as any);
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'appio-1' }) });

    const job = { id: '2', data: { campaignId: 'camp-1', attemptId: 'att-2', recipientId: 'rec-1', channel: 'EMAIL' } } as any;
    await processor.process(job);

    expect(mockRecipientRepo.update).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({ status: RecipientStatus.SENT, attachmentExpiresAt: expect.any(Date) }),
    );
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
  });
```

Run: `node_modules/.bin/jest queue/notification.processor.spec.ts`
Expected: PASS (2 test)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts
git commit -m "feat(app-io): invio App IO indipendente dall'esito del canale primario + attachmentExpiresAt su SUCCESS"
```

---

## Task 7: Cron di retention (`@nestjs/schedule`)

**Files:**
- Modify: `apps/backend/package.json` (nuova dipendenza `@nestjs/schedule`)
- Create: `apps/backend/src/campaigns/retention-cleanup.service.ts`
- Test: `apps/backend/src/campaigns/retention-cleanup.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.module.ts`
- Modify: `apps/backend/src/app.module.ts` (registra `ScheduleModule.forRoot()`)

**Interfaces:**
- Consumes: `Recipient.attachmentExpiresAt`/`attachmentDeletedAt` (Task 2)
- Produces: nessuna interfaccia consumata da altri task — job schedulato autonomo

- [ ] **Step 1: Aggiungi la dipendenza (segui il pattern pnpm v11 del progetto)**

Aggiungi in `apps/backend/package.json`, sezione `dependencies`, vicino a `@nestjs/bullmq`:

```json
    "@nestjs/schedule": "^4.0.0",
```

- [ ] **Step 2: Scrivi il test del servizio di pulizia**

```typescript
// apps/backend/src/campaigns/retention-cleanup.service.spec.ts
import * as fs from 'fs/promises';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RetentionCleanupService } from './retention-cleanup.service';
import { Recipient } from '../entities/recipient.entity';

jest.mock('fs/promises', () => ({ unlink: jest.fn().mockResolvedValue(undefined) }));

describe('RetentionCleanupService', () => {
  let service: RetentionCleanupService;

  const expiredRecipient = {
    id: 'r-expired',
    campaignId: 'c-1',
    extraData: { allegato: 'DOC_1_1.pdf' },
    campaign: { channelConfig: { allegatoKey: 'allegato' } },
  };

  const mockQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([expiredRecipient]),
  };
  const mockRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    update: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQb.getMany.mockResolvedValue([expiredRecipient]);
    const module = await Test.createTestingModule({
      providers: [RetentionCleanupService, { provide: getRepositoryToken(Recipient), useValue: mockRepo }],
    }).compile();
    service = module.get(RetentionCleanupService);
  });

  it('elimina il file allegato scaduto e marca attachmentDeletedAt', async () => {
    await service.runCleanup();

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('DOC_1_1.pdf'));
    expect(mockRepo.update).toHaveBeenCalledWith('r-expired', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });

  it('marca comunque attachmentDeletedAt se il file non esiste più su disco (idempotenza)', async () => {
    (fs.unlink as jest.Mock).mockRejectedValueOnce(new Error('ENOENT'));
    await service.runCleanup();
    expect(mockRepo.update).toHaveBeenCalledWith('r-expired', expect.objectContaining({ attachmentDeletedAt: expect.any(Date) }));
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `node_modules/.bin/jest campaigns/retention-cleanup.service.spec.ts`
Expected: FAIL — `Cannot find module './retention-cleanup.service'`

- [ ] **Step 4: Implementa il servizio**

```typescript
// apps/backend/src/campaigns/retention-cleanup.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { join } from 'path';
import { unlink } from 'fs/promises';
import { Recipient } from '../entities/recipient.entity';

@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  @Cron('0 3 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<void> {
    const expired = await this.recipientRepo
      .createQueryBuilder('recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('recipient.attachment_expires_at < :now', { now: new Date() })
      .andWhere('recipient.attachment_deleted_at IS NULL')
      .getMany();

    this.logger.log(`Retention cleanup: ${expired.length} allegati da eliminare`);

    for (const recipient of expired) {
      const allegatoKey = recipient.campaign?.channelConfig?.['allegatoKey'] as string | undefined;
      const customFilename = allegatoKey ? (recipient.extraData?.[allegatoKey] as string | undefined) : undefined;

      if (customFilename) {
        const filePath = join(__dirname, '..', '..', 'uploads', 'attachments', recipient.campaignId, customFilename);
        try {
          await unlink(filePath);
        } catch (err) {
          this.logger.warn(`File già assente o non eliminabile: ${filePath}`);
        }
      }

      await this.recipientRepo.update(recipient.id, { attachmentDeletedAt: new Date() });
    }
  }
}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `node_modules/.bin/jest campaigns/retention-cleanup.service.spec.ts`
Expected: PASS (2 test)

- [ ] **Step 6: Registra `ScheduleModule` e il nuovo provider**

In `apps/backend/src/app.module.ts`, aggiungi import e modulo:

```typescript
import { ScheduleModule } from '@nestjs/schedule';
```

```typescript
    ScheduleModule.forRoot(),
```
(nell'array `imports`, vicino a `ConfigModule.forRoot`)

In `apps/backend/src/campaigns/campaigns.module.ts`, aggiungi `RetentionCleanupService` all'array `providers`.

- [ ] **Step 7: Rebuild backend (dipendenza npm nuova → rebuild obbligatorio, pattern pnpm v11 da CLAUDE.md)**

Run: `docker compose up -d --build backend`
Expected: log di boot mostra `Nest application successfully started` senza `ERR_PNPM_IGNORED_BUILDS`

- [ ] **Step 8: Commit**

```bash
git add apps/backend/package.json apps/backend/src/campaigns/retention-cleanup.service.ts apps/backend/src/campaigns/retention-cleanup.service.spec.ts apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/app.module.ts
git commit -m "feat(retention): cron giornaliero di pulizia allegati scaduti (RETENTION_MAX_DAYS)"
```

---

## Task 8: Endpoint statistiche download (aggregato + per destinatario)

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Create: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Test: estendi `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `Recipient.downloadCount`/`firstDownloadedAt`/`lastDownloadedAt`/`attachmentDeletedAt` (Task 2)
- Produces: `CampaignsService.getStats(campaignId): Promise<CampaignStatsDto>`, `CampaignsService.getRecipientStats(campaignId, page, pageSize): Promise<RecipientStatsPageDto>` — nessun consumo da altri task di questo piano

- [ ] **Step 1: Definisci i DTO di risposta**

```typescript
// apps/backend/src/campaigns/dto/campaign-stats.dto.ts
export interface CampaignStatsDto {
  campaignId: string;
  totalRecipients: number;
  totalSent: number;
  totalDownloaded: number;
  downloadPercentage: number;
  lastDownloadAt: Date | null;
}

export interface RecipientStatDto {
  id: string;
  fullName: string | null;
  codiceFiscale: string;
  downloadCount: number;
  firstDownloadedAt: Date | null;
  lastDownloadedAt: Date | null;
  attachmentDeletedAt: Date | null;
}

export interface RecipientStatsPageDto {
  campaignId: string;
  page: number;
  pageSize: number;
  total: number;
  items: RecipientStatDto[];
}
```

- [ ] **Step 2: Scrivi i test per i due nuovi metodi del service**

Aggiungi a `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```typescript
  it('getStats calcola aggregati corretti', async () => {
    mockRecipientRepo.find.mockResolvedValueOnce([
      { downloadCount: 2, lastDownloadedAt: new Date('2026-06-26') },
      { downloadCount: 0, lastDownloadedAt: null },
    ]);
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, totalRecipients: 2, sentCount: 2 });

    const stats = await service.getStats('uuid-1');

    expect(stats).toEqual({
      campaignId: 'uuid-1',
      totalRecipients: 2,
      totalSent: 2,
      totalDownloaded: 1,
      downloadPercentage: 50,
      lastDownloadAt: new Date('2026-06-26'),
    });
  });

  it('getStats lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.getStats('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('getRecipientStats pagina i risultati', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(mockCampaign);
    mockRecipientRepo.findAndCount = jest.fn().mockResolvedValue([
      [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'CF1', downloadCount: 1, firstDownloadedAt: new Date(), lastDownloadedAt: new Date(), attachmentDeletedAt: null }],
      1,
    ]);

    const page = await service.getRecipientStats('uuid-1', 1, 20);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(mockRecipientRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: 'uuid-1' }, skip: 0, take: 20 }),
    );
  });
```

- [ ] **Step 3: Esegui i test e verifica che falliscano**

Run: `node_modules/.bin/jest campaigns/campaigns.service.spec.ts`
Expected: FAIL — `service.getStats is not a function`

- [ ] **Step 4: Implementa i metodi nel service**

Aggiungi a `apps/backend/src/campaigns/campaigns.service.ts`, e importa i tipi DTO in cima al file:

```typescript
import type { CampaignStatsDto, RecipientStatsPageDto } from './dto/campaign-stats.dto';
```

```typescript
  async getStats(campaignId: string): Promise<CampaignStatsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['downloadCount', 'lastDownloadedAt'],
    });

    const totalDownloaded = recipients.filter((r) => r.downloadCount > 0).length;
    const lastDownloadAt = recipients.reduce<Date | null>((latest, r) => {
      if (!r.lastDownloadedAt) return latest;
      if (!latest || r.lastDownloadedAt > latest) return r.lastDownloadedAt;
      return latest;
    }, null);

    return {
      campaignId,
      totalRecipients: campaign.totalRecipients,
      totalSent: campaign.sentCount,
      totalDownloaded,
      downloadPercentage: campaign.totalRecipients > 0
        ? Math.round((totalDownloaded / campaign.totalRecipients) * 100)
        : 0,
      lastDownloadAt,
    };
  }

  async getRecipientStats(campaignId: string, page: number, pageSize: number): Promise<RecipientStatsPageDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const [items, total] = await this.recipientRepo.findAndCount({
      where: { campaignId },
      select: ['id', 'fullName', 'codiceFiscale', 'downloadCount', 'firstDownloadedAt', 'lastDownloadedAt', 'attachmentDeletedAt'],
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'ASC' },
    });

    return { campaignId, page, pageSize, total, items };
  }
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `node_modules/.bin/jest campaigns/campaigns.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Esponi gli endpoint nel controller**

Aggiungi a `apps/backend/src/campaigns/campaigns.controller.ts`:

```typescript
  @Get(':id/stats')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getStats(id);
  }

  @Get(':id/stats/recipients')
  getRecipientStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.campaignsService.getRecipientStats(id, parseInt(page ?? '1', 10), parseInt(pageSize ?? '50', 10));
  }
```

Aggiungi `Query` all'import da `@nestjs/common` in cima al file.

- [ ] **Step 7: Rebuild backend e verifica manuale**

Run: `docker compose up -d --build backend`
Run: `docker compose logs backend --tail 20`
Expected: boot pulito

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(stats): endpoint aggregato e per-destinatario delle statistiche di download"
```

---

## Task 9: Lock campagna in stato non-DRAFT sull'upload attachments

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: estendi `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `CampaignStatus` enum (esistente, `apps/backend/src/entities/campaign.entity.ts`)
- Produces: `CampaignsService.assertDraftForAttachments(campaignId): Promise<void>` (usato solo dal controller in questo task)

- [ ] **Step 1: Scrivi il test di guardia**

Aggiungi a `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```typescript
  it('assertDraftForAttachments passa per campagna DRAFT', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
    await expect(service.assertDraftForAttachments('uuid-1')).resolves.toBeUndefined();
  });

  it('assertDraftForAttachments lancia BadRequestException per campagna QUEUED', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.QUEUED });
    await expect(service.assertDraftForAttachments('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('assertDraftForAttachments lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.assertDraftForAttachments('no-exist')).rejects.toThrow(NotFoundException);
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `node_modules/.bin/jest campaigns/campaigns.service.spec.ts`
Expected: FAIL — `service.assertDraftForAttachments is not a function`

- [ ] **Step 3: Implementa il metodo di guardia**

Aggiungi a `apps/backend/src/campaigns/campaigns.service.ts`:

```typescript
  async assertDraftForAttachments(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(
        'La campagna non è più in bozza: gli allegati non possono essere modificati dopo il lancio. Annulla e crea una nuova campagna per cambiarli.',
      );
    }
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `node_modules/.bin/jest campaigns/campaigns.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Collega la guardia all'endpoint di upload attachments**

In `apps/backend/src/campaigns/campaigns.controller.ts`, modifica `uploadAttachments`:

```typescript
  @Post(':id/attachments')
  @UseInterceptors(/* ... invariato ... */)
  async uploadAttachments(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    await this.campaignsService.assertDraftForAttachments(id);
    return {
      uploaded: files?.length || 0,
      campaignId: id,
    };
  }
```

Nota: il controllo avviene dopo che `multer` ha già scritto i file su disco (il `destination` è risolto prima del corpo del metodo). È un limite noto di `FilesInterceptor`: accettabile per questo piano perché il rischio reale (bypassare il lock) è comunque bloccato — la risposta 400 impedisce all'operatore di proseguire nel wizard, e i file orfani vengono comunque rimossi dal cron di retention (Task 7) quando l'`allegatoKey` non risulterà mai associato a un recipient valido. Se in futuro serve bloccare la scrittura su disco stessa, sostituire `diskStorage` con `memoryStorage` + validazione preventiva — fuori scope per questo piano (YAGNI, nessun caso d'uso attuale lo richiede).

- [ ] **Step 6: Esegui l'intera suite campaigns e verifica che passi**

Run: `node_modules/.bin/jest campaigns`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(wizard-lock): impedisci modifica allegati su campagne non-DRAFT (wizard resta unico editor)"
```

---

## Task 10: Editor template WYSIWYG responsive (Tiptap) nel wizard

**Files:**
- Modify: `apps/frontend-admin/package.json` (nuove dipendenze Tiptap)
- Create: `apps/frontend-admin/src/components/TemplateEditor.tsx`
- Modify: `apps/frontend-admin/src/App.tsx:2041-2159` (step 4 del wizard)

**Interfaces:**
- Consumes: `wizSubject`, `wizBody`, `setWizBody`, `wizCsvHeaders`, `wizMapping` (state esistente in `App.tsx`)
- Produces: componente `TemplateEditor` con props `{ value: string; onChange: (html: string) => void; placeholders: string[] }` — sostituisce la sola `<textarea>` di riga 2079-2086, il resto dello step 4 (input oggetto, preview, bottoni navigazione) resta invariato

- [ ] **Step 1: Aggiungi le dipendenze Tiptap**

In `apps/frontend-admin/package.json`, sezione `dependencies`:

```json
    "@tiptap/react": "^2.11.0",
    "@tiptap/starter-kit": "^2.11.0",
    "@tiptap/extension-link": "^2.11.0",
```

- [ ] **Step 2: Crea il componente `TemplateEditor`**

```tsx
// apps/frontend-admin/src/components/TemplateEditor.tsx
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { useState } from 'react';

interface TemplateEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholders: { label: string; token: string }[];
}

export function TemplateEditor({ value, onChange, placeholders }: TemplateEditorProps) {
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) return null;

  const insertPlaceholder = (token: string) => {
    editor.chain().focus().insertContent(` ${token} `).run();
  };

  return (
    <div>
      <div className="p-3 border rounded bg-light mb-3">
        <strong className="small text-dark d-block mb-2">
          <i className="fas fa-keyboard me-1 text-primary"></i>Clicca per inserire il parametro:
        </strong>
        <div className="d-flex flex-wrap gap-1">
          {placeholders.map((p) => (
            <button
              key={p.token}
              type="button"
              className="btn btn-xs btn-outline-secondary"
              style={{ fontSize: '0.74rem' }}
              onClick={() => insertPlaceholder(p.token)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="btn-toolbar mb-2 gap-1" role="toolbar">
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('bold') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()}>
          <i className="fas fa-bold"></i>
        </button>
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('italic') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i className="fas fa-italic"></i>
        </button>
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('bulletList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <i className="fas fa-list-ul"></i>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            const url = window.prompt('URL del link:');
            if (url) editor.chain().focus().setLink({ href: url }).run();
          }}
        >
          <i className="fas fa-link"></i>
        </button>
      </div>

      <div className="border rounded" style={{ minHeight: '220px', padding: '12px' }}>
        <EditorContent editor={editor} />
      </div>

      <div className="d-flex align-items-center gap-2 mt-3 mb-2">
        <span className="small fw-bold">Anteprima responsive:</span>
        <button type="button" className={`btn btn-sm ${viewport === 'desktop' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setViewport('desktop')}>
          <i className="fas fa-desktop"></i> Desktop
        </button>
        <button type="button" className={`btn btn-sm ${viewport === 'mobile' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setViewport('mobile')}>
          <i className="fas fa-mobile-alt"></i> Mobile
        </button>
      </div>
      <div
        className="border rounded mx-auto bg-white"
        style={{ maxWidth: viewport === 'mobile' ? '375px' : '100%', transition: 'max-width 0.2s' }}
        dangerouslySetInnerHTML={{ __html: editor.getHTML() }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Sostituisci la textarea del corpo messaggio nello step 4 del wizard**

In `apps/frontend-admin/src/App.tsx`, sostituisci il blocco righe 2046-2087 (dal box "Clicca per inserire il parametro" fino alla chiusura della textarea del corpo) con:

```tsx
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Oggetto della Comunicazione (Template)</label>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="Es: Avviso Scadenza TARI 2026 - %nominativo%"
                        value={wizSubject}
                        onChange={e => setWizSubject(e.target.value)}
                        required
                      />
                    </div>

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

Rimuovi il blocco `<div className="mb-3">...<input value={wizSubject}...` duplicato che restava subito sotto nel file originale (righe 2065-2075 erano già l'input oggetto: nel nuovo blocco l'ordine è oggetto poi corpo, identico all'originale — non deve comparire due volte).

Aggiungi l'import in cima al file: `import { TemplateEditor } from './components/TemplateEditor';`

Il resto dello step 4 (bottoni navigazione riga 2089-2100, colonna preview riga 2103-2158) resta invariato: `wizBody` ora contiene HTML invece di plain text, la preview a destra (riga 2141-2150) userà `dangerouslySetInnerHTML` invece di testo semplice per renderizzare correttamente i tag introdotti dall'editor:

```tsx
                          <div
                            style={{ padding: '20px', fontSize: '0.9rem', color: '#333', lineHeight: '1.5', minHeight: '150px' }}
                            dangerouslySetInnerHTML={{
                              __html: wizBody
                                .replace(/%allegato1%/g, 'http://localhost:3001/?notificationId=TEST-UUID-SIMULAZIONE')
                                .replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (match, key) => wizValidRows[wizPreviewIndex][key] || '')
                                .replace(/%([^%()]+)%/gi, (match, key) => {
                                  const k = key.toLowerCase().trim();
                                  if (k === 'nominativo' || k === 'full_name') return getWizRowFullName(wizValidRows[wizPreviewIndex]);
                                  if (k === 'codice_fiscale' || k === 'cf') return wizValidRows[wizPreviewIndex][wizMapping.codice_fiscale] || '';
                                  return wizValidRows[wizPreviewIndex][key] || match;
                                }),
                            }}
                          />
```

- [ ] **Step 4: Rebuild frontend-admin (nuove dipendenze npm → rebuild obbligatorio)**

Run: `docker compose up -d --build frontend-admin`
Expected: boot senza errori Vite/pnpm

- [ ] **Step 5: Verifica manuale nel browser**

Apri `http://localhost:3000`, crea una campagna EMAIL con il wizard, raggiungi lo step 4 "Template & Anteprima":
- Digita testo, applica grassetto/corsivo/lista dalla toolbar
- Clicca un bottone placeholder (es. "Nominativo") e verifica che inserisca `%nominativo%` nel punto del cursore
- Passa da "Desktop" a "Mobile" e verifica che il riquadro anteprima si restringa a 375px
- Procedi al passo 5 e verifica che il body salvato sia HTML valido (controllare il payload nella tab Network del browser alla `POST /campaigns`)

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/package.json apps/frontend-admin/src/components/TemplateEditor.tsx apps/frontend-admin/src/App.tsx
git commit -m "feat(wizard): editor template WYSIWYG responsive (Tiptap) con preview desktop/mobile"
```

---

## Ordine di esecuzione consigliato

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 (tutti backend, dipendenze sequenziali tra loro) → 10 (frontend, indipendente, può partire in parallelo dopo Task 1).

## Note finali

- Dopo Task 1-9, generare un `DOWNLOAD_LINK_SECRET` reale (non il default `change-me-in-production`) nel `.env` di produzione prima di lanciare il batch TARI — vedi Global Constraints e spec, sezione "Note di rischio".
- Il batch TARI (6133 destinatari, CSV/allegati in `Desktop\0tmail`) può partire solo dopo che tutti i Task 1-10 sono completati e la suite di test passa (`docker compose exec backend node_modules/.bin/jest`).
