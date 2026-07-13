# Invio SEND reale (payload v2.6/requests) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire l'invio SEND placeholder con il payload reale
`POST /delivery/v2.6/requests` (allegati multipli via preload S3, dati di
pagamento pagoPA, protocollo reale già cablato), e aggiungere un demone
schedulato che risolve IUN e stato reale per ogni invio SEND.

**Architecture:** `SendStrategy.send()` riscritta per costruire il payload
completo (documenti via nuovo `SendAttachmentUploadService`, pagamenti via
nuova utility condivisa `payment-config.util.ts`, protocollo già esistente).
Nuovo `SendStatusSyncService` schedulato (`@nestjs/schedule`, pattern
identico a `RetentionCleanupService`) risolve IUN e aggiorna lo stato reale
su due nuove colonne di `NotificationAttempt`. UI: Impostazioni (nuova
setting `send.senderTaxId`, editor lista tassonomie abilitate) e wizard
(checkbox pagamenti spostato allo step 1, nuove select tassonomia/tipo
comunicazione fisica).

**Tech Stack:** NestJS (backend), TypeORM, `@nestjs/schedule` (già
presente), `node:https`/`node:http` nativi per l'upload con trailer HTTP
(nessuna nuova dipendenza npm), React (frontend-admin), Jest.

## Global Constraints

- Nessun PDF bollettino pagoPA da generare: lo schema `PagoPaPayment` non
  richiede l'`attachment` (verificato riga per riga sullo YAML ufficiale,
  vedi spec) — bastano `noticeCode`/`creditorTaxId`/`applyCost`.
- Nessun codice tassonomia hardcoded nel software: la lista va inserita
  manualmente dall'operatore da Impostazioni (rischio di codici sbagliati
  in un sistema legale).
- Nessuna cifra di costo regionale hardcoded nella UI (il software è
  open-source, tariffe cartacee variano per regione/lotto) — solo
  struttura generica + link al listino ufficiale.
- L'upload allegati richiede un trailer HTTP reale
  (`x-amz-checksum-sha256`), non gestibile con `fetch`: va implementato
  con `http.request`/`https.request` nativi e `request.addTrailers()`.
- Il job di invio si considera riuscito già al `202 Accepted` di PN
  (`notificationRequestId` salvato) — la risoluzione IUN e l'aggiornamento
  di stato sono responsabilità del demone schedulato (`SendStatusSyncService`),
  non del job di invio sincrono.
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
  sempre con `--maxWorkers=2` (satura la RAM su WSL2 altrimenti).
- Nessun test end-to-end automatico contro l'ambiente reale PN (nessuna
  credenziale di collaudo disponibile in questa sessione) — solo unit
  test con `fetch`/HTTP server locale mockati.

---

### Task 1: `payment-config.util.ts` — estrazione logica condivisa

**Files:**
- Create: `apps/backend/src/channels/payment-config.util.ts`
- Create: `apps/backend/src/channels/payment-config.util.spec.ts`
- Modify: `apps/backend/src/channels/app-io/app-io.strategy.ts:81-124`
- Modify: `apps/backend/src/queue/notification.processor.ts:316-360`

**Interfaces:**
- Consumes: nessuna (utility pura, riceve `Recipient` e `paymentConfig`
  già tipizzati come in `app-io.strategy.ts`).
- Produces:
  ```ts
  export interface ResolvedPaymentData {
    noticeCode: string;
    amountCents: number;
    creditorTaxId: string;
    dueDateIso: string | null;
  }
  export function resolvePaymentData(
    recipient: Recipient,
    paymentConfig: Record<string, any> | undefined,
  ): ResolvedPaymentData | null
  ```
  Usato da Task 5 (`SendStrategy`).

- [ ] **Step 1: Scrivere il test fallimentare**

Crea `apps/backend/src/channels/payment-config.util.spec.ts`:

```ts
import { resolvePaymentData } from './payment-config.util';
import type { Recipient } from '../entities/recipient.entity';

function makeRecipient(extraData: Record<string, unknown> = {}): Recipient {
  return {
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData,
  } as unknown as Recipient;
}

describe('resolvePaymentData', () => {
  it('ritorna null se paymentConfig è undefined', () => {
    expect(resolvePaymentData(makeRecipient(), undefined)).toBeNull();
  });

  it('ritorna null se paymentConfig.enabled è false', () => {
    expect(resolvePaymentData(makeRecipient(), { enabled: false })).toBeNull();
  });

  it('risolve importo in euro, notice code, CF ente statico', () => {
    const recipient = makeRecipient({ importo: '120,50', avviso: '302000100000019421' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: '00223344556',
    });
    expect(result).toEqual({
      noticeCode: '302000100000019421',
      amountCents: 12050,
      creditorTaxId: '00223344556',
      dueDateIso: null,
    });
  });

  it('risolve importo in centesimi e CF ente da colonna', () => {
    const recipient = makeRecipient({ importo_cents: '5000', avviso: '111', cf_ente: '99988877766' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo_cents',
      amountType: 'cents',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'column',
      payeeFiscalCodeColumn: 'cf_ente',
    });
    expect(result).toEqual({
      noticeCode: '111',
      amountCents: 5000,
      creditorTaxId: '99988877766',
      dueDateIso: null,
    });
  });

  it('ritorna null se manca notice code o importo <= 0', () => {
    const recipient = makeRecipient({ importo: '0', avviso: '111' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: 'X',
    });
    expect(result).toBeNull();
  });

  it('risolve la data di scadenza se presente', () => {
    const recipient = makeRecipient({ importo: '10', avviso: '111', scadenza: '2026-12-31' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: 'X',
      dueDateColumn: 'scadenza',
    });
    expect(result?.dueDateIso).toBe('2026-12-31T23:59:59.000Z');
  });
});
```

- [ ] **Step 2: Eseguire il test per verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest payment-config.util --maxWorkers=2`
Expected: FAIL — `Cannot find module './payment-config.util'`

- [ ] **Step 3: Implementare `payment-config.util.ts`**

Crea `apps/backend/src/channels/payment-config.util.ts` (logica portata
1:1 da `app-io.strategy.ts:81-124`, unificando `getColumnValue`/
`parseDateToIso` già duplicate lì e in `notification.processor.ts`):

```ts
import type { Recipient } from '../entities/recipient.entity';

export interface ResolvedPaymentData {
  noticeCode: string;
  amountCents: number;
  creditorTaxId: string;
  dueDateIso: string | null;
}

export function getColumnValue(recipient: Recipient, columnName?: string): string {
  if (!columnName) return '';
  const col = columnName.toLowerCase().trim();
  if (col === 'codice_fiscale' || col === 'cf') return recipient.codiceFiscale;
  if (col === 'full_name' || col === 'nome' || col === 'nominativo') return recipient.fullName || '';
  if (col === 'email') return recipient.email || '';
  if (col === 'pec') return recipient.pec || '';

  if (recipient.extraData) {
    for (const [key, val] of Object.entries(recipient.extraData)) {
      if (key.toLowerCase().trim() === col) {
        return String(val ?? '');
      }
    }
  }
  return '';
}

export function parseDateToIso(dateStr?: string): string | null {
  if (!dateStr) return null;

  let match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T23:59:59.000Z`;
  }

  match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}T23:59:59.000Z`;
  }

  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {}

  return null;
}

/** Risolve i dati di pagamento pagoPA per un destinatario, o null se non applicabile. */
export function resolvePaymentData(
  recipient: Recipient,
  paymentConfig: Record<string, any> | undefined,
): ResolvedPaymentData | null {
  if (!paymentConfig || !paymentConfig.enabled) return null;

  const rawAmount = getColumnValue(recipient, paymentConfig.amountColumn);
  const noticeCode = getColumnValue(recipient, paymentConfig.noticeNumberColumn).replace(/\s+/g, '');

  let amountCents = 0;
  if (paymentConfig.amountType === 'cents') {
    amountCents = parseInt(rawAmount, 10) || 0;
  } else {
    const cleaned = (rawAmount || '').replace(',', '.');
    const parsed = parseFloat(cleaned) || 0;
    amountCents = Math.round(parsed * 100);
  }

  if (!noticeCode || amountCents <= 0) return null;

  let creditorTaxId = '';
  if (paymentConfig.payeeFiscalCodeType === 'static') {
    creditorTaxId = paymentConfig.payeeFiscalCodeStatic || '';
  } else if (paymentConfig.payeeFiscalCodeType === 'column') {
    creditorTaxId = getColumnValue(recipient, paymentConfig.payeeFiscalCodeColumn);
  }
  creditorTaxId = creditorTaxId.toUpperCase().trim();

  let dueDateIso: string | null = null;
  if (paymentConfig.dueDateColumn) {
    dueDateIso = parseDateToIso(getColumnValue(recipient, paymentConfig.dueDateColumn));
  }

  return { noticeCode, amountCents, creditorTaxId, dueDateIso };
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest payment-config.util --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 5: Refactor `app-io.strategy.ts` per usare l'utility**

In `apps/backend/src/channels/app-io/app-io.strategy.ts`:
- Sostituisci l'import `resolveAttachmentsConfig` con anche
  `resolvePaymentData` da `../payment-config.util`.
- Sostituisci il blocco righe 81-125 (da `const paymentConfig = ...` a
  la chiusura dell'`if (paymentConfig && paymentConfig.enabled)`) con:
  ```ts
    const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    if (resolvedPayment) {
      const paymentData: Record<string, any> = {
        amount: resolvedPayment.amountCents,
        notice_number: resolvedPayment.noticeCode,
        invalid_after_due_date: true,
      };
      if (resolvedPayment.creditorTaxId) {
        paymentData.payee = { fiscal_code: resolvedPayment.creditorTaxId };
      }
      contentPayload.payment_data = paymentData;
      if (resolvedPayment.dueDateIso) {
        contentPayload.due_date = resolvedPayment.dueDateIso;
      }
    }
  ```
- Rimuovi le funzioni ora inutilizzate `getColumnValue`/`parseDateToIso`
  in fondo al file (righe 152-196) — non più referenziate da questo file.

- [ ] **Step 6: Refactor `notification.processor.ts` per usare l'utility**

In `apps/backend/src/queue/notification.processor.ts`:
- Aggiungi import `resolvePaymentData` da `../channels/payment-config.util`.
- Sostituisci il blocco righe 316-360 con la stessa logica dello Step 5
  (stesso pattern, stessa variabile `contentPayload`).
- Rimuovi le funzioni `getColumnValue`/`parseDateToIso` duplicate in fondo
  al file (righe 388+) — non più referenziate.

- [ ] **Step 7: Eseguire l'intera suite backend e verificare nessuna regressione**

Run: `docker compose exec backend node_modules/.bin/jest app-io --maxWorkers=2`
Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: PASS, stesso comportamento di prima (i test esistenti di
App IO/notification.processor non cambiano — verificano solo l'esito del
payload, non l'implementazione interna).

- [ ] **Step 8: `tsc --noEmit`**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/channels/payment-config.util.ts apps/backend/src/channels/payment-config.util.spec.ts apps/backend/src/channels/app-io/app-io.strategy.ts apps/backend/src/queue/notification.processor.ts
git commit -m "refactor(backend): estrae resolvePaymentData in payment-config.util.ts condiviso"
```

---

### Task 2: Migration `NotificationAttempt` — colonne IUN/stato SEND

**Files:**
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts`
- Create: `apps/backend/src/database/migrations/1783700000000-AddSendStatusColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `NotificationAttempt.iun: string | null`,
  `NotificationAttempt.sendStatus: string | null`,
  `NotificationAttempt.sendStatusUpdatedAt: Date | null` — usati da
  Task 6 (`SendStatusSyncService`).

- [ ] **Step 1: Aggiungere le colonne all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, dopo il
campo `responsePayload` (riga 44), aggiungi:

```ts
  @Column({ type: 'varchar', length: 26, nullable: true })
  iun!: string | null;

  @Column({ name: 'send_status', type: 'varchar', length: 30, nullable: true })
  sendStatus!: string | null;

  @Column({ name: 'send_status_updated_at', type: 'timestamptz', nullable: true })
  sendStatusUpdatedAt!: Date | null;
```

- [ ] **Step 2: Generare e scrivere la migration su DB temporaneo**

Segui il pattern CLAUDE.md sez. "Migration DB":

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/AddSendStatusColumns -d src/database/data-source.ts
```

Rinomina il file generato in
`apps/backend/src/database/migrations/1783700000000-AddSendStatusColumns.ts`
e la classe in `AddSendStatusColumns1783700000000` (il generatore userà un
timestamp diverso — allinealo a questo per restare coerente con la
numerazione crescente esistente). Verifica che il contenuto generato sia
solo `ALTER TABLE "notification_attempts" ADD COLUMN ...` per le 3 colonne
(nessun altro diff inatteso — se il generatore produce altro, il resto
dello schema è cambiato accidentalmente, indagare prima di procedere).

- [ ] **Step 3: Registrare la migration**

In `apps/backend/src/database/database.module.ts`:
```ts
import { AddSendStatusColumns1783700000000 } from './migrations/1783700000000-AddSendStatusColumns';
```
e aggiungila in fondo all'array `migrations`.

- [ ] **Step 4: Eseguire la migration sul DB temporaneo e verificare**

```bash
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_gen -c "\d notification_attempts"
```
Expected: colonne `iun`, `send_status`, `send_status_updated_at` presenti.

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

- [ ] **Step 5: `tsc --noEmit`**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/1783700000000-AddSendStatusColumns.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): colonne iun/sendStatus/sendStatusUpdatedAt su NotificationAttempt"
```

---

### Task 3: Registry — `send.senderTaxId`, `send.enabledTaxonomyCodes`

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts`

**Interfaces:**
- Produces: chiavi `send.senderTaxId` (string), `send.enabledTaxonomyCodes`
  (string, JSON serializzato `Array<{code:string;label:string}>`) — usate
  da Task 5 (backend) e Task 7 (frontend).

- [ ] **Step 1: Aggiungere le chiavi**

In `apps/backend/src/settings/settings.registry.ts`, dopo
`'send.prod.purposeId': { type: 'string', default: '' },` (riga 39),
aggiungi:

```ts
  'send.senderTaxId': { type: 'string', default: '' },
  'send.enabledTaxonomyCodes': { type: 'string', default: '[]' },
```

- [ ] **Step 2: `tsc --noEmit`**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts
git commit -m "feat(backend): registry send.senderTaxId e send.enabledTaxonomyCodes"
```

---

### Task 4: `SendAttachmentUploadService` — preload + upload con trailer

**Files:**
- Create: `apps/backend/src/channels/send/send-attachment-upload.service.ts`
- Create: `apps/backend/src/channels/send/send-attachment-upload.service.spec.ts`

**Interfaces:**
- Consumes: nessuna.
- Produces:
  ```ts
  export interface UploadedDocument { key: string; versionToken: string; sha256Base64: string; }
  class SendAttachmentUploadService {
    preloadAndUpload(baseUrl: string, voucher: string, buffer: Buffer, contentType: 'application/pdf' | 'application/json', preloadIdx: string): Promise<UploadedDocument>
  }
  ```
  Usato da Task 5 (`SendStrategy`).

- [ ] **Step 1: Scrivere il test fallimentare**

Crea `apps/backend/src/channels/send/send-attachment-upload.service.spec.ts`
— usa un server HTTP locale reale per verificare che l'upload invii
davvero headers e trailer corretti (testare `http.request` con trailer
via mock è fragile: un server locale è il modo onesto di verificarlo):

```ts
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SendAttachmentUploadService', () => {
  let service: SendAttachmentUploadService;
  let server: http.Server;
  let serverPort: number;
  let receivedHeaders: http.IncomingHttpHeaders;
  let receivedTrailers: NodeJS.Dict<string>;
  let receivedBody: Buffer;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedHeaders = req.headers;
        receivedTrailers = req.trailers;
        receivedBody = Buffer.concat(chunks);
        res.setHeader('x-amz-version-id', 'version-abc-123');
        res.statusCode = 200;
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => server.close(done));

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({ providers: [SendAttachmentUploadService] }).compile();
    service = module.get(SendAttachmentUploadService);
  });

  it('chiama preload, poi carica il file con trailer sha256 corretto e ritorna key+versionToken', async () => {
    const buffer = Buffer.from('%PDF-1.4 contenuto di test');
    const expectedSha256 = createHash('sha256').update(buffer).digest('base64');

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 'my-secret', httpMethod: 'PUT', url: `http://127.0.0.1:${serverPort}/upload`, key: 'PN_ATTACHMENTS-0001' },
      ])),
    });

    const result = await service.preloadAndUpload('https://send.test', 'voucher-xyz', buffer, 'application/pdf', 'doc-0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/attachments/preload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer voucher-xyz' }),
      }),
    );
    const preloadBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(preloadBody).toEqual([{ preloadIdx: 'doc-0', contentType: 'application/pdf', sha256: expectedSha256 }]);

    expect(result).toEqual({ key: 'PN_ATTACHMENTS-0001', versionToken: 'version-abc-123', sha256Base64: expectedSha256 });
    expect(receivedHeaders['content-type']).toBe('application/pdf');
    expect(receivedHeaders['x-amz-meta-secret']).toBe('my-secret');
    expect(receivedHeaders['trailer']).toBe('x-amz-checksum-sha256');
    expect(receivedTrailers['x-amz-checksum-sha256']).toBe(expectedSha256);
    expect(receivedBody.equals(buffer)).toBe(true);
  });

  it('lancia errore leggibile se il preload fallisce', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"error":"bad request"}') });
    await expect(
      service.preloadAndUpload('https://send.test', 'voucher-xyz', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Preload allegato SEND fallito: HTTP 400/);
  });

  it('lancia errore se il server di upload risponde diverso da 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: `http://127.0.0.1:${serverPort}/fail-path-does-not-exist-but-server-always-200`, key: 'K' },
      ])),
    });
    // Nota: il server di test risponde sempre 200; questo test verifica solo
    // che il codice gestisca un mock diverso — copre il path via un secondo
    // server ad-hoc che risponde 500.
    const failServer = http.createServer((req, res) => { req.resume(); res.statusCode = 500; res.end('boom'); });
    await new Promise<void>((resolve) => failServer.listen(0, '127.0.0.1', resolve));
    const failPort = (failServer.address() as any).port;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: `http://127.0.0.1:${failPort}/upload`, key: 'K' },
      ])),
    });
    await expect(
      service.preloadAndUpload('https://send.test', 'voucher-xyz', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Upload allegato SEND fallito: HTTP 500/);
    failServer.close();
  });
});
```

- [ ] **Step 2: Eseguire il test per verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest send-attachment-upload --maxWorkers=2`
Expected: FAIL — `Cannot find module './send-attachment-upload.service'`

- [ ] **Step 3: Implementare il servizio**

Crea `apps/backend/src/channels/send/send-attachment-upload.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';

export interface UploadedDocument {
  key: string;
  versionToken: string;
  sha256Base64: string;
}

interface PreloadResponseEntry {
  preloadIdx: string;
  secret: string;
  httpMethod: 'PUT' | 'POST';
  url: string;
  key: string;
}

@Injectable()
export class SendAttachmentUploadService {
  private readonly logger = new Logger(SendAttachmentUploadService.name);

  async preloadAndUpload(
    baseUrl: string,
    voucher: string,
    buffer: Buffer,
    contentType: 'application/pdf' | 'application/json',
    preloadIdx: string,
  ): Promise<UploadedDocument> {
    const sha256Base64 = createHash('sha256').update(buffer).digest('base64');

    const preloadRes = await fetch(`${baseUrl}/delivery/attachments/preload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voucher}` },
      body: JSON.stringify([{ preloadIdx, contentType, sha256: sha256Base64 }]),
    });
    const preloadText = await preloadRes.text();
    if (!preloadRes.ok) {
      throw new Error(`Preload allegato SEND fallito: HTTP ${preloadRes.status} — ${preloadText.slice(0, 500)}`);
    }
    const preloadData = JSON.parse(preloadText) as PreloadResponseEntry[];
    const entry = preloadData.find((e) => e.preloadIdx === preloadIdx);
    if (!entry) {
      throw new Error(`Preload allegato SEND: risposta priva della entry per preloadIdx=${preloadIdx}`);
    }

    const versionToken = await this.uploadWithTrailer(entry.url, entry.httpMethod, entry.secret, contentType, buffer, sha256Base64);
    this.logger.log(`Allegato SEND caricato: key=${entry.key} versionToken=${versionToken}`);
    return { key: entry.key, versionToken, sha256Base64 };
  }

  private uploadWithTrailer(
    url: string,
    method: 'PUT' | 'POST',
    secret: string,
    contentType: string,
    buffer: Buffer,
    sha256Base64: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: {
            'content-type': contentType,
            'x-amz-meta-secret': secret,
            trailer: 'x-amz-checksum-sha256',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Upload allegato SEND fallito: HTTP ${res.statusCode} — ${body.slice(0, 500)}`));
              return;
            }
            const versionToken = res.headers['x-amz-version-id'];
            if (!versionToken || Array.isArray(versionToken)) {
              reject(new Error('Upload allegato SEND: header x-amz-version-id mancante nella risposta'));
              return;
            }
            resolve(versionToken);
          });
        },
      );
      req.on('error', reject);
      req.write(buffer);
      req.addTrailers({ 'x-amz-checksum-sha256': sha256Base64 });
      req.end();
    });
  }
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-attachment-upload --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: `tsc --noEmit`**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/send/send-attachment-upload.service.ts apps/backend/src/channels/send/send-attachment-upload.service.spec.ts
git commit -m "feat(backend): SendAttachmentUploadService — preload + upload con trailer sha256"
```

---

### Task 5: `SendStrategy` — payload reale `v2.6/requests`

**Files:**
- Modify: `apps/backend/src/channels/send/send.strategy.ts`
- Modify: `apps/backend/src/channels/send/send.strategy.spec.ts`
- Modify: `apps/backend/src/channels/channel.module.ts`

**Interfaces:**
- Consumes: `SendAttachmentUploadService.preloadAndUpload(...)` (Task 4),
  `resolvePaymentData(...)` da `payment-config.util.ts` (Task 1),
  `AttachmentService.generatePdfBuffer(recipient, index)` (esistente),
  `resolveAttachmentsConfig(channelConfig)` (esistente,
  `apps/backend/src/attachments/attachment.service.ts:14`),
  `ProtocolloService.protocolla(...)` (esistente, invariato).
- Produces: nessuna nuova interfaccia pubblica.

- [ ] **Step 1: Riscrivere il test `send.strategy.spec.ts`**

Sostituisci l'intero contenuto di
`apps/backend/src/channels/send/send.strategy.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { SendStrategy } from './send.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
  'send.senderTaxId': '01234567890',
  'brand.name': 'Comune di Prova',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockProtocollo = { protocolla: jest.fn(async () => ({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' })) };
const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };
const mockUpload = { preloadAndUpload: jest.fn(async (_b: string, _v: string, _buf: Buffer, _ct: string, preloadIdx: string) => ({ key: `key-${preloadIdx}`, versionToken: `vt-${preloadIdx}`, sha256Base64: 'abc123==' })) };

function makeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData: {},
    ...overrides,
  };
}

function makeCampaign(channelConfig: Record<string, unknown>) {
  return { id: 'camp-1', name: 'TARI', description: '', channelConfig };
}

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockProtocollo.protocolla.mockClear();
    mockAttachments.generatePdfBuffer.mockClear();
    mockUpload.preloadAndUpload.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ notificationRequestId: 'req-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        SendStrategy,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
        { provide: SendAttachmentUploadService, useValue: mockUpload },
      ],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('lancia errore se protocolla non è true (obbligatorio per SEND)', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({ subject: 'Avviso', protocolla: false });
    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/Protocollazione obbligatoria per SEND/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('costruisce il payload v2.6/requests con un documento e nessun pagamento', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({
      subject: 'Avviso TARI 2026',
      protocolla: true,
      taxonomyCode: '010101P',
      physicalCommunicationType: 'AR_REGISTERED_LETTER',
    });

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-0');

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    expect(sendCall).toBeDefined();
    const [, init] = sendCall!;
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
    const payload = JSON.parse(init.body as string);

    expect(payload.paProtocolNumber).toBe('111/2026');
    expect(payload.subject).toBe('Avviso TARI 2026');
    expect(payload.senderTaxId).toBe('01234567890');
    expect(payload.senderDenomination).toBe('Comune di Prova');
    expect(payload.taxonomyCode).toBe('010101P');
    expect(payload.physicalCommunicationType).toBe('AR_REGISTERED_LETTER');
    expect(payload.notificationFeePolicy).toBe('FLAT_RATE');
    expect(payload.recipients).toEqual([{
      recipientType: 'PF',
      taxId: 'RSSMRA85M01H501Z',
      denomination: 'Mario Rossi',
    }]);
    expect(payload.documents).toEqual([{
      ref: { key: 'key-doc-0', versionToken: 'vt-doc-0' },
      title: 'Avviso TARI 2026',
      digests: { sha256: 'abc123==' },
      contentType: 'application/pdf',
      docIdx: 0,
    }]);

    expect(result.messageId).toBe('req-001');
    expect(result.responsePayload).toEqual(expect.objectContaining({
      notificationRequestId: 'req-001',
      protocollo: { numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' },
    }));
  });

  it('include payments nel destinatario se paymentConfig risolve dati validi', async () => {
    const recipient = makeRecipient({ extraData: { importo: '50', avviso: '999888777', cf_ente: '00223344556' } });
    const campaign = makeCampaign({
      subject: 'Avviso',
      protocolla: true,
      taxonomyCode: '010101P',
      paymentConfig: {
        enabled: true,
        amountColumn: 'importo',
        amountType: 'euro',
        noticeNumberColumn: 'avviso',
        payeeFiscalCodeType: 'column',
        payeeFiscalCodeColumn: 'cf_ente',
      },
    });

    await strategy.send(recipient as never, campaign as never);

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].payments).toEqual([
      { pagoPa: { noticeCode: '999888777', creditorTaxId: '00223344556', applyCost: true } },
    ]);
  });

  it('carica più documenti se sono configurati più allegati', async () => {
    const recipient = makeRecipient();
    const campaign = makeCampaign({
      subject: 'Avviso',
      protocolla: true,
      taxonomyCode: '010101P',
      attachments: [{ key: 'a1', label: 'Primo' }, { key: 'a2', label: 'Secondo' }],
    });

    await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 1);
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-0');
    expect(mockUpload.preloadAndUpload).toHaveBeenCalledWith('https://send.test', 'voucher-abc', expect.any(Buffer), 'application/pdf', 'doc-1');

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.documents).toHaveLength(2);
    expect(payload.documents[1].docIdx).toBe(1);
  });

  it('lancia errore leggibile se PN risponde diverso da 202', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === 'https://send.test/delivery/v2.6/requests') {
        return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('{"errors":["bad"]}') });
      }
      return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ notificationRequestId: 'req-001' }) });
    });
    const recipient = makeRecipient();
    const campaign = makeCampaign({ subject: 'Avviso', protocolla: true, taxonomyCode: '010101P' });
    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/SEND API error: HTTP 400/);
  });
});
```

- [ ] **Step 2: Eseguire i test per verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send.strategy --maxWorkers=2`
Expected: FAIL — payload attuale non contiene i campi attesi, endpoint
placeholder diverso, nessuna guardia su `protocolla`.

- [ ] **Step 3: Riscrivere `send.strategy.ts`**

Sostituisci l'intero contenuto di
`apps/backend/src/channels/send/send.strategy.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { resolvePaymentData } from '../payment-config.util';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

function splitFullName(fullName: string | null | undefined): { nome: string; cognome: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nome: '', cognome: '' };
  if (parts.length === 1) return { nome: parts[0], cognome: '' };
  return { nome: parts.slice(0, -1).join(' '), cognome: parts[parts.length - 1] };
}

@Injectable()
export class SendStrategy implements IChannelStrategy {
  private readonly logger = new Logger(SendStrategy.name);
  readonly channel: NotificationChannel = 'SEND';

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
    private readonly attachmentUpload: SendAttachmentUploadService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, unknown>;
    if (cfg['protocolla'] !== true) {
      throw new Error('Protocollazione obbligatoria per SEND: channelConfig.protocolla deve essere true');
    }

    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const baseUrl = await this.settings.get<string>(`${prefix}.baseUrl` as SettingKey);
    const purposeId = await this.settings.get<string>(`${prefix}.purposeId` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);

    // 1. Protocollazione (obbligatoria per SEND) — fornisce paProtocolNumber.
    log(`Protocollazione SEND per CF ${recipient.codiceFiscale}`);
    const { nome, cognome } = splitFullName(recipient.fullName);
    const protocolloDocBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
    const protocolloResult = await this.protocollo.protocolla({
      oggetto: subject,
      destinatario: {
        codiceFiscale: recipient.codiceFiscale,
        nome,
        cognome,
        denominazione: recipient.fullName ?? recipient.codiceFiscale,
      },
      documentBuffer: protocolloDocBuffer,
      documentFilename: `${recipient.codiceFiscale}.pdf`,
    });
    log(`Protocollazione OK: ${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`);
    const paProtocolNumber = `${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`;

    // 2. Documenti: uno o più allegati, caricati via preload + upload S3.
    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const docCount = Math.max(attachmentsConfig.length, 1);
    const documents: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < docCount; idx++) {
      const buffer = idx === 0 ? protocolloDocBuffer : await this.attachments.generatePdfBuffer(recipient, idx);
      const uploaded = await this.attachmentUpload.preloadAndUpload(baseUrl, voucher, buffer, 'application/pdf', `doc-${idx}`);
      documents.push({
        ref: { key: uploaded.key, versionToken: uploaded.versionToken },
        title: subject,
        digests: { sha256: uploaded.sha256Base64 },
        contentType: 'application/pdf',
        docIdx: idx,
      });
    }

    // 3. Pagamento pagoPA (opzionale) — solo dati, nessun PDF bollettino.
    const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, unknown> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    const payments = resolvedPayment
      ? [{ pagoPa: { noticeCode: resolvedPayment.noticeCode, creditorTaxId: resolvedPayment.creditorTaxId, applyCost: true } }]
      : undefined;

    // 4. Payload completo.
    const senderTaxId = await this.settings.get<string>('send.senderTaxId' as SettingKey);
    const senderDenomination = await this.settings.get<string>('brand.name' as SettingKey);
    const taxonomyCode = cfg['taxonomyCode'] as string;
    const physicalCommunicationType = (cfg['physicalCommunicationType'] as string) || 'AR_REGISTERED_LETTER';

    const payload: Record<string, unknown> = {
      idempotenceToken: randomUUID(),
      paProtocolNumber,
      notificationFeePolicy: 'FLAT_RATE',
      physicalCommunicationType,
      senderDenomination,
      senderTaxId,
      taxonomyCode,
      subject,
      recipients: [{
        recipientType: 'PF',
        taxId: recipient.codiceFiscale,
        denomination: recipient.fullName ?? recipient.codiceFiscale,
        ...(payments ? { payments } : {}),
      }],
      documents,
    };

    log(`Invio notifica SEND a CF ${recipient.codiceFiscale} via ${baseUrl} (subject="${subject}")`);
    const response = await fetch(`${baseUrl}/delivery/v2.6/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voucher}`,
      },
      body: JSON.stringify(payload),
    });
    log(`Risposta SEND per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SEND API error: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND accettata per CF ${recipient.codiceFiscale}: notificationRequestId=${data.notificationRequestId}`);
    return {
      messageId: data.notificationRequestId,
      responsePayload: {
        notificationRequestId: data.notificationRequestId,
        protocollo: protocolloResult,
      },
    };
  }
}
```

- [ ] **Step 4: Wiring in `channel.module.ts`**

Modifica `apps/backend/src/channels/channel.module.ts`: aggiungi
`import { SendAttachmentUploadService } from './send/send-attachment-upload.service';`
e aggiungi `SendAttachmentUploadService` all'array `providers` (non serve
esportarlo, usato solo internamente da `SendStrategy`).

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send.strategy --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 6: `tsc --noEmit` completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send.strategy.ts apps/backend/src/channels/send/send.strategy.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): SendStrategy costruisce ed invia il payload reale v2.6/requests"
```

---

### Task 6: `SendStatusSyncService` — demone risoluzione IUN/stato

**Files:**
- Create: `apps/backend/src/channels/send/send-status-sync.service.ts`
- Create: `apps/backend/src/channels/send/send-status-sync.service.spec.ts`
- Modify: `apps/backend/src/channels/channel.module.ts`

**Interfaces:**
- Consumes: `PdndAuthService.getVoucher(env, purposeId)` (esistente),
  `AppSettingsService.get(key)` (esistente), TypeORM `Repository<NotificationAttempt>`.
- Produces: nessuna interfaccia pubblica — job schedulato self-contained.

- [ ] **Step 1: Scrivere il test fallimentare**

Crea `apps/backend/src/channels/send/send-status-sync.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SendStatusSyncService } from './send-status-sync.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

function makeQueryBuilder(results: any[]) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => results),
  };
  return qb;
}

describe('SendStatusSyncService', () => {
  let service: SendStatusSyncService;
  let mockRepo: any;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockRepo = { createQueryBuilder: jest.fn(), save: jest.fn(async (a: any) => a) };

    const module = await Test.createTestingModule({
      providers: [
        SendStatusSyncService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockRepo },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();

    service = module.get(SendStatusSyncService);
  });

  it('resolveMissingIun: risolve IUN se PN risponde ACCEPTED', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'ACCEPTED', iun: 'IUN-123' })),
    });

    await service.resolveMissingIun();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.6/requests?requestId=req-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.iun).toBe('IUN-123');
    expect(attempt.sendStatus).toBe('ACCEPTED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('resolveMissingIun: non fa nulla se PN risponde WAITING', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'WAITING' })),
    });

    await service.resolveMissingIun();

    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('resolveMissingIun: salva sendStatus REFUSED se PN rifiuta', async () => {
    const attempt: any = { id: 'a1', iun: null, sendStatus: null, responsePayload: { notificationRequestId: 'req-1' } };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationRequestStatus: 'REFUSED', errors: [{ code: 'X' }] })),
    });

    await service.resolveMissingIun();

    expect(attempt.sendStatus).toBe('REFUSED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: aggiorna sendStatus da GET notifications/sent/{iun}', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED' };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })),
    });

    await service.updateStatuses();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.9/notifications/sent/IUN-123',
      expect.objectContaining({ headers: { Authorization: 'Bearer voucher-abc' } }),
    );
    expect(attempt.sendStatus).toBe('DELIVERED');
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: non salva se lo stato non è cambiato', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED' };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })),
    });

    await service.updateStatuses();

    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('handleCron chiama sia resolveMissingIun che updateStatuses', async () => {
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));
    const spyResolve = jest.spyOn(service, 'resolveMissingIun');
    const spyUpdate = jest.spyOn(service, 'updateStatuses');
    await service.handleCron();
    expect(spyResolve).toHaveBeenCalled();
    expect(spyUpdate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Eseguire il test per verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest send-status-sync --maxWorkers=2`
Expected: FAIL — `Cannot find module './send-status-sync.service'`

- [ ] **Step 3: Implementare il servizio**

Crea `apps/backend/src/channels/send/send-status-sync.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const BATCH_SIZE = 200;
const TERMINAL_STATUSES = ['VIEWED', 'EFFECTIVE_DATE', 'UNREACHABLE', 'CANCELLED', 'RETURNED_TO_SENDER', 'REFUSED'];

@Injectable()
export class SendStatusSyncService {
  private readonly logger = new Logger(SendStatusSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  @Cron('*/15 * * * *')
  async handleCron(): Promise<void> {
    await this.resolveMissingIun();
    await this.updateStatuses();
  }

  private async getEnvAndBaseUrl(): Promise<{ envKey: 'test' | 'prod'; baseUrl: string; purposeId: string }> {
    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const baseUrl = await this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey);
    const purposeId = await this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey);
    return { envKey, baseUrl, purposeId };
  }

  async resolveMissingIun(): Promise<void> {
    const { envKey, baseUrl, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NULL')
      .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NOT NULL")
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      const requestId = (attempt.responsePayload as Record<string, unknown>)['notificationRequestId'] as string;
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.6/requests?requestId=${encodeURIComponent(requestId)}`, {
          headers: { Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Verifica richiesta SEND ${requestId} fallita: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationRequestStatus: string; iun?: string; errors?: unknown[] };
        if (data.notificationRequestStatus === 'ACCEPTED' && data.iun) {
          attempt.iun = data.iun;
          attempt.sendStatus = 'ACCEPTED';
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
        } else if (data.notificationRequestStatus === 'REFUSED') {
          attempt.sendStatus = 'REFUSED';
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
          this.logger.warn(`Richiesta SEND ${requestId} rifiutata da PN: ${JSON.stringify(data.errors ?? [])}`);
        }
      } catch (err: any) {
        this.logger.warn(`Errore risoluzione IUN per richiesta SEND ${requestId}: ${err.message}`);
      }
    }
  }

  async updateStatuses(): Promise<void> {
    const { envKey, baseUrl, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NOT NULL')
      .andWhere('(attempt.send_status IS NULL OR attempt.send_status NOT IN (:...terminal))', { terminal: TERMINAL_STATUSES })
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${attempt.iun}`, {
          headers: { Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Aggiornamento stato SEND IUN ${attempt.iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationStatus: string };
        if (data.notificationStatus && data.notificationStatus !== attempt.sendStatus) {
          attempt.sendStatus = data.notificationStatus;
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato SEND IUN ${attempt.iun}: ${err.message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Wiring in `channel.module.ts`**

Modifica `apps/backend/src/channels/channel.module.ts`:
- Aggiungi `import { TypeOrmModule } from '@nestjs/typeorm';` e
  `import { NotificationAttempt } from '../entities/notification-attempt.entity';`
- Aggiungi `import { SendStatusSyncService } from './send/send-status-sync.service';`
- Aggiungi `TypeOrmModule.forFeature([NotificationAttempt])` all'array
  `imports`.
- Aggiungi `SendStatusSyncService` all'array `providers`.

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send-status-sync --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 6: `tsc --noEmit` completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send-status-sync.service.ts apps/backend/src/channels/send/send-status-sync.service.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): SendStatusSyncService — demone schedulato risoluzione IUN e stato SEND"
```

---

### Task 7: Impostazioni — `senderTaxId` + editor tassonomie abilitate

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna.
- Produces: nessuna nuova interfaccia — solo UI, legge/scrive
  `send.senderTaxId` e `send.enabledTaxonomyCodes` (Task 3).

- [ ] **Step 1: Aggiungere lo state**

Vicino a `const [settSendTestPurposeId, setSettSendTestPurposeId] = useState('');`
(riga 607), aggiungi:

```ts
  const [settSendSenderTaxId, setSettSendSenderTaxId] = useState('');
  const [settSendTaxonomies, setSettSendTaxonomies] = useState<Array<{ code: string; label: string }>>([]);
```

- [ ] **Step 2: Load**

Vicino a `setSettSendTestPurposeId(String(s['send.test.purposeId'] ?? ''));`
(riga 782), aggiungi:

```ts
        setSettSendSenderTaxId(String(s['send.senderTaxId'] ?? ''));
        try {
          setSettSendTaxonomies(JSON.parse(String(s['send.enabledTaxonomyCodes'] ?? '[]')));
        } catch {
          setSettSendTaxonomies([]);
        }
```

- [ ] **Step 3: Save**

Vicino a `'send.test.purposeId': settSendTestPurposeId,` (riga 1338),
aggiungi:

```ts
    'send.senderTaxId': settSendSenderTaxId,
    'send.enabledTaxonomyCodes': JSON.stringify(settSendTaxonomies),
```

- [ ] **Step 4: JSX — inserire nel tab SEND**

In `apps/frontend-admin/src/App.tsx`, dentro il blocco
`{activeSettingsTab === 'send' && (` (riga 5266), subito dopo la chiusura
del `<div className="mb-4">` dell'"Ambiente attivo" (riga 5281, prima del
`{([...]).map((e) => (` che apre i fieldset per-env), inserisci:

```tsx
                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_sender_taxid">Codice Fiscale / P.IVA Ente (senderTaxId)</label>
                              <input
                                type="text"
                                id="send_sender_taxid"
                                className="form-control form-control-sm"
                                style={{ maxWidth: 260 }}
                                value={settSendSenderTaxId}
                                onChange={(e) => setSettSendSenderTaxId(e.target.value)}
                                maxLength={11}
                              />
                              <div className="form-text small text-muted">11 cifre, obbligatorio nel payload SEND come mittente.</div>
                            </div>

                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark">Tassonomie SEND abilitate</label>
                              <div className="form-text small text-muted mb-2">
                                Codici a 7 caratteri dalla <a href="https://developer.pagopa.it/it/send/guides/knowledge-base/v2.5/tassonomia-send" target="_blank" rel="noreferrer">tabella ufficiale SEND</a>.
                                Termina per "P" se prevede pagamento, "N" se no — inseriscili qui manualmente, saranno selezionabili nel wizard.
                              </div>
                              {settSendTaxonomies.map((t, idx) => (
                                <div key={idx} className="d-flex gap-2 mb-2">
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    style={{ maxWidth: 120 }}
                                    placeholder="Codice"
                                    value={t.code}
                                    maxLength={7}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, code: e.target.value.toUpperCase() } : row))}
                                  />
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Etichetta descrittiva"
                                    value={t.label}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, label: e.target.value } : row))}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-outline-danger btn-sm"
                                    onClick={() => setSettSendTaxonomies(prev => prev.filter((_, i) => i !== idx))}
                                  >
                                    Rimuovi
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                className="btn btn-outline-secondary btn-sm"
                                onClick={() => setSettSendTaxonomies(prev => [...prev, { code: '', label: '' }])}
                              >
                                + Aggiungi tassonomia
                              </button>
                            </div>
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): tab SEND — senderTaxId ed editor tassonomie abilitate"
```

---

### Task 8: Wizard — pagamenti allo step 1, tassonomia, tipo comunicazione fisica

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `settSendTaxonomies` (Task 7).
- Produces: `campaign.channelConfig.taxonomyCode`,
  `campaign.channelConfig.physicalCommunicationType` — consumati da
  `SendStrategy` (Task 5).

- [ ] **Step 1: Aggiungere lo state**

Vicino a `const [wizProtocolla, setWizProtocolla] = useState(false);`,
aggiungi:

```ts
  const [wizTaxonomyCode, setWizTaxonomyCode] = useState('');
  const [wizPhysicalCommunicationType, setWizPhysicalCommunicationType] = useState<'AR_REGISTERED_LETTER' | 'REGISTERED_LETTER_890'>('AR_REGISTERED_LETTER');
```

- [ ] **Step 2: Reset e load da bozza**

Dove c'è `setWizProtocolla(false);` (nel reset wizard), aggiungi:
```ts
    setWizTaxonomyCode('');
    setWizPhysicalCommunicationType('AR_REGISTERED_LETTER');
```

Dove c'è `setWizProtocolla(Boolean(source.channelConfig?.protocolla));`
(load da bozza), aggiungi:
```ts
    setWizTaxonomyCode(source.channelConfig?.taxonomyCode || '');
    setWizPhysicalCommunicationType(source.channelConfig?.physicalCommunicationType || 'AR_REGISTERED_LETTER');
```

- [ ] **Step 3: Spostare il checkbox pagamenti allo step 1**

In `apps/frontend-admin/src/App.tsx`, taglia il blocco checkbox (righe
3955-3966, dentro il `<div className="form-check mb-3">` con
`id="wiz-payment-enabled"`) dal punto attuale (dentro il box "Integrazione
Pagamenti pagoPA" allo step 3, righe 3949-3966) e:

1. Nel box step 3 (righe 3949-3963), rimuovi il blocco checkbox e la sua
   label, lasciando solo l'header e il blocco `{wizPaymentEnabled && (...)}`
   con i campi di mapping. Estendi anche la condizione di visibilità del
   box da `(wizChannel === 'APP_IO' || (wizAppIoMode && wizAppIoMode !== 'none'))`
   a `(wizChannel === 'APP_IO' || wizChannel === 'SEND' || (wizAppIoMode && wizAppIoMode !== 'none'))`
   (righe 3949), così il mapping resta visibile anche per SEND.

2. Nello step 1, subito dopo il blocco checkbox `wiz_protocolla` (dopo la
   chiusura `</div>` di quel form-check, prima del blocco
   `{(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (` che segue),
   inserisci il checkbox pagamenti (per tutti i canali, non solo SEND —
   coerente con la visibilità già estesa al mapping):

```tsx
                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz-payment-enabled"
                      checked={wizPaymentEnabled}
                      onChange={e => setWizPaymentEnabled(e.target.checked)}
                    />
                    <label className="form-check-label small fw-bold" htmlFor="wiz-payment-enabled" style={{ cursor: 'pointer' }}>
                      Integrazione pagamenti pagoPA
                    </label>
                    <div className="form-text small text-muted">Il mapping delle colonne CSV per importo/avviso/CF ente si configura allo step 3.</div>
                  </div>
```

- [ ] **Step 4: Select tassonomia e tipo comunicazione fisica (solo SEND)**

Subito dopo il blocco checkbox pagamenti appena inserito allo step 1,
aggiungi (visibile solo per SEND):

```tsx
                  {wizChannel === 'SEND' && (
                    <>
                      <div className="mb-3">
                        <label className="form-label small fw-bold">Tassonomia SEND *</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizTaxonomyCode}
                          onChange={e => setWizTaxonomyCode(e.target.value)}
                          required
                        >
                          <option value="">-- Seleziona tassonomia --</option>
                          {settSendTaxonomies
                            .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                            .map(t => (
                              <option key={t.code} value={t.code}>{t.code} — {t.label}</option>
                            ))}
                        </select>
                        {settSendTaxonomies.filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N')).length === 0 && (
                          <div className="form-text text-danger small">
                            Nessuna tassonomia {wizPaymentEnabled ? 'con pagamento (P)' : 'senza pagamento (N)'} abilitata. Configurale in Impostazioni → SEND.
                          </div>
                        )}
                      </div>

                      <div className="mb-3">
                        <label className="form-label small fw-bold">Tipo comunicazione fisica (fallback se la consegna digitale fallisce)</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizPhysicalCommunicationType}
                          onChange={e => setWizPhysicalCommunicationType(e.target.value as any)}
                        >
                          <option value="AR_REGISTERED_LETTER">Raccomandata A/R</option>
                          <option value="REGISTERED_LETTER_890">Notifica ex L.890/1982</option>
                        </select>
                        <div className="alert alert-info small mt-2 mb-0">
                          Il costo del cartaceo si applica solo se la consegna digitale fallisce del tutto, e varia per regione/zona di recapito.
                          In generale la <strong>raccomandata A/R</strong> è più economica della <strong>890</strong> a parità di peso.
                          Consulta il <a href="https://notifichedigitali.pagopa.it/static/documents/Prezzi%20Ente%202024.pdf" target="_blank" rel="noreferrer">listino ufficiale aggiornato</a> per le tariffe esatte del tuo lotto/regione.
                        </div>
                      </div>
                    </>
                  )}
```

- [ ] **Step 5: `buildWizChannelConfigDraft` — aggiungere i campi SEND**

Trova (dopo l'edit del sotto-progetto precedente):
```ts
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId, protocolla: wizProtocolla };
```
Subito dopo questa riga, aggiungi:
```ts
    if (wizChannel === 'SEND') {
      cfg.taxonomyCode = wizTaxonomyCode;
      cfg.physicalCommunicationType = wizPhysicalCommunicationType;
    }
```

- [ ] **Step 6: `handleWizLaunch` — aggiornare il branch SEND**

Trova:
```ts
      } else if (wizChannel === 'SEND') {
        channelConfig = { subject: wizSubject, body: wizBody, protocolla: true };
      }
```
Sostituisci con:
```ts
      } else if (wizChannel === 'SEND') {
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          protocolla: true,
          taxonomyCode: wizTaxonomyCode,
          physicalCommunicationType: wizPhysicalCommunicationType,
        };
      }
```

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): wizard SEND — checkbox pagamenti allo step 1, select tassonomia/tipo fisico"
```

---

### Task 9: Verifica end-to-end

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite completa backend**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set del baseline noto (solo
`app.controller.spec.ts` per `LDAP_HOST=mock`, pre-esistente), nessun
nuovo fallimento.

- [ ] **Step 2: Type-check completo**

Run:
```
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore in entrambi.

- [ ] **Step 3: Migration su DB reale di sviluppo**

`docker compose restart backend` (in dev `synchronize=true` allinea lo
schema automaticamente alle nuove colonne entity — non serve eseguire la
migration manualmente in locale, ma verificare che il restart non generi
errori di avvio).

- [ ] **Step 4: Verifica UI manuale**

Dev server attivo. Impostazioni → tab SEND: inserire `senderTaxId` e
almeno una tassonomia (es. `999999N` etichetta "Test"), salvare,
verificare persistenza in DB (`psql ... SELECT key,value FROM
app_settings WHERE key IN ('send.senderTaxId','send.enabledTaxonomyCodes');`).
Wizard → canale SEND: verificare checkbox pagamenti allo step 1, select
tassonomia filtrata (solo N se pagamenti OFF, solo P se ON), alert tipo
comunicazione fisica visibile.

- [ ] **Step 5: Nessun invio reale in questa fase**

Non testare `SendStrategy.send()` contro l'ambiente PN reale come parte
di questo piano — richiede credenziali di collaudo SEND non disponibili
in questa sessione. Un test manuale guidato con l'utente, analogo a
quello fatto per `ProtocolloService`, va pianificato separatamente prima
di considerare l'integrazione realmente completa (incluso il primo giro
del demone `SendStatusSyncService` contro una richiesta reale).
