# API esterna v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire `external/v1` con `external/v2`: contratto tipizzato che permette di inviare davvero su EMAIL/PEC/APP_IO/SEND/POSTAL (PF e PG), con `/capabilities` che espone tutti i valori ammessi, idempotenza e stato arricchito con `events[]`.

**Architecture:** Adapter sottile sopra `CampaignsService` (campagna mono-destinatario, `channelConfig.source = 'external'`). La validazione statica (class-validator) e quella dinamica (contro le capabilities correnti) producono una lista unica di `ValidationIssue`. Lo stato è calcolato in lettura da una funzione pura che riusa `postalLegalOutcome()` e `sendLegalDateOf()`.

**Tech Stack:** NestJS 12 (ESM, import con estensione `.js`), TypeORM, class-validator/class-transformer, ioredis, Vitest (alias globale `jest` = `vi`), supertest, `@comunicapa/shared-types` (file unico `src/index.ts`).

**Spec:** `docs/superpowers/specs/2026-10-01-external-api-v2-design.md`

## Global Constraints

- Base path `external/v2`. Tutte le risposte HTTP **200**, esito nel campo `success`; ogni `@Post()` ha `@HttpCode(HttpStatus.OK)`.
- Forma errore: `{ success: false, error: { code, message, details? } }`. Codici: `UNAUTHORIZED`, `VALIDATION_ERROR`, `CHANNEL_INACTIVE`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `ATTACHMENT_INVALID`, `LAUNCH_BLOCKED`, `NOT_FOUND`, `INTERNAL_ERROR`.
- `details` di `VALIDATION_ERROR` = `Array<{ field: string; message: string; allowed?: string[] }>`.
- APP_IO: subject 10–120, body 80–10000 caratteri di testo HTML-stripped.
- Idempotency: header `Idempotency-Key` 1–255 caratteri, TTL 24h, chiave Redis `ext:idem:<clientId>:<sha256(key)>`.
- SEND sempre `protocolla: true`. Tassonomia: suffisso `P` ⇔ `payment` presente.
- Destinatario: `PF` → `taxId` `/^[A-Za-z0-9]{16}$/`; `PG` → `taxId` `/^\d{11}$/`.
- Colonne `extraData` interne: `_extStreet`, `_extZip`, `_extMunicipality`, `_extProvince`, `_extCountry`, `_extNoticeCode`, `_extAmountCents`, `_extDueDate`.
- `@comunicapa/shared-types` resta **un solo file** `packages/shared-types/src/index.ts` (import relativi tra file del pacchetto → `ERR_MODULE_NOT_FOUND` a runtime).
- Mai PII reale in test/fixture: usare `RSSMRA80A01H501U`, `ROSSI MARIO`, `ACME SRL`, P.IVA `01234567890`.
- Import relativi backend sempre con estensione `.js`.
- Criterio suite: failure set identico alla baseline (1 fallimento noto `app.controller.spec.ts` › `isLdapMock`).

## Review Focus

1. **Retry dopo timeout lato client con la stessa `Idempotency-Key`** → nessuna seconda campagna/raccomandata; risposta identica alla prima. Test in Task 9 (`create` chiamato due volte, `campaigns.create` invocato una volta).
2. **Payload con campi sconosciuti o annidati non dichiarati** (es. `recipient.foo`) → `VALIDATION_ERROR` con `field: 'recipient.foo'`, mai ignorato in silenzio. Test in Task 4.
3. **Allegato con token di un altro client o già consumato** → `ATTACHMENT_INVALID`, nessuna campagna lasciata in bozza orfana di allegato; chiave idempotenza rilasciata. Test in Task 9.
4. **POSTAL dirottata a PEC da INAD** → stato con `effectiveChannel: 'PEC'`, `diversion.source: 'INAD'` ed esito legale dal ramo dirottato. Test in Task 10.
5. **Comune italiano lungo (> 30 caratteri) o provincia mancante per indirizzo italiano** → abbreviazione automatica per i 5 noti, altrimenti `VALIDATION_ERROR` su `recipient.address.municipality`/`province`. Test in Task 4.

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/shared-types/src/index.ts` | + catalogo tassonomie SEND, enum `physicalCommunicationType`, enum Agol, helper servizio postale |
| `apps/frontend-admin/src/data/sendTaxonomy.ts` | **eliminato** (spostato in shared-types) |
| `apps/backend/src/channels/send/send-dispatch.service.ts` | `recipientType` PF/PG |
| `apps/backend/src/external-api/external-api.error.ts` | `ExternalApiError`, `ValidationIssue`, `ExternalErrorCode` |
| `apps/backend/src/external-api/external-api-exception.filter.ts` | mappa `ExternalApiError` |
| `apps/backend/src/external-api/validate-body.util.ts` | class-validator → `ValidationIssue[]` con path completo |
| `apps/backend/src/external-api/dto/create-notification.dto.ts` | DTO v2 + regole statiche |
| `apps/backend/src/external-api/dto/cerca-domicilio.dto.ts` | `{ taxId }` CF o P.IVA |
| `apps/backend/src/external-api/external-capabilities.service.ts` | capabilities + validazione dinamica |
| `apps/backend/src/external-api/external-notification.mapper.ts` | DTO → `channelConfig` + destinatario (puro) |
| `apps/backend/src/external-api/external-idempotency.store.ts` | Redis SET NX / replay |
| `apps/backend/src/external-api/external-notifications.service.ts` | orchestrazione `create` |
| `apps/backend/src/external-api/external-notification-status.ts` | stato/legal/events (puro) |
| `apps/backend/src/external-api/external-notification-status.service.ts` | carica dati e chiama il builder |
| `apps/backend/src/external-api/external-*.controller.ts` | route `external/v2/*` |
| `apps/backend/src/campaigns/campaigns.service.ts` | `addSingleRecipient` con `fullName`; firma SEND single-flow anche per `source: 'external'`; rimozione `getExternalDeliveryStatus` |
| `apps/backend/openapi/external-api-v2.yaml` | spec OpenAPI 2.0.0 |

Eliminati in Task 12: `external-api.service.ts`, `external-api.service.spec.ts`, `dto/create-external-notification.dto.ts`, `dto/create-external-notification.dto.spec.ts`, `dto/cerca-domicilio-external.dto.ts`, `openapi/external-api.yaml`.

Comandi (dal checkout principale, stack Docker dev attivo):

```bash
docker compose exec backend node_modules/.bin/vitest run <pattern>
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Dopo modifiche a `apps/backend/src/` fuori dai test: `docker compose restart backend` (il watch su bind mount Windows spesso non le vede).

---

### Task 1: Costanti condivise (tassonomia SEND, Agol, physicalCommunicationType)

**Files:**
- Modify: `packages/shared-types/src/index.ts` (append)
- Modify: `packages/shared-types/src/index.spec.ts` (append)
- Delete: `apps/frontend-admin/src/data/sendTaxonomy.ts`
- Modify: `apps/frontend-admin/src/App.tsx:10-11`

**Interfaces:**
- Produces:
  - `interface SendTaxonomyEntry { code: string; entityType: string; title: string; description: string }`
  - `const SEND_ENTITY_TYPES: { code: string; label: string }[]`
  - `const SEND_TAXONOMY_CATALOG: SendTaxonomyEntry[]`
  - `function sendTaxonomyRequiresPayment(code: string): boolean`
  - `const SEND_PHYSICAL_COMMUNICATION_TYPES: readonly ['AR_REGISTERED_LETTER', 'REGISTERED_LETTER_890']`, `type SendPhysicalCommunicationType`
  - `const POSTAL_AGOL_NOTIFIER_TYPES: readonly ['NonUtilizzato', 'UfficialeGiudiziario', 'Procuratore', 'ParteIstante']`
  - `const POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS: readonly ['NonRichiedere', 'Concordato', 'Automatico']`
  - `function isPostalAgolService(serviceType: string): boolean`
  - `function postalServiceSupportsReturnReceipt(serviceType: string): boolean`

- [ ] **Step 1: Write the failing test** — append to `packages/shared-types/src/index.spec.ts` (and add the new names to the existing `import { ... } from './index'` line):

```ts
describe('costanti SEND/POSTAL condivise', () => {
  it('catalogo tassonomie SEND senza codici duplicati, ogni codice termina in P o N', () => {
    const codes = SEND_TAXONOMY_CATALOG.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^\d{6}[PN]$/.test(c))).toBe(true);
  });

  it('sendTaxonomyRequiresPayment segue il suffisso', () => {
    expect(sendTaxonomyRequiresPayment('010101P')).toBe(true);
    expect(sendTaxonomyRequiresPayment('010101N')).toBe(false);
  });

  it('helper servizio postale', () => {
    expect(isPostalAgolService('AgolRaccomandata')).toBe(true);
    expect(isPostalAgolService('Raccomandata')).toBe(false);
    expect(postalServiceSupportsReturnReceipt('Raccomandata1')).toBe(true);
    expect(postalServiceSupportsReturnReceipt('PostaOrdinaria')).toBe(false);
  });

  it('enum condivise', () => {
    expect(SEND_PHYSICAL_COMMUNICATION_TYPES).toEqual(['AR_REGISTERED_LETTER', 'REGISTERED_LETTER_890']);
    expect(POSTAL_AGOL_NOTIFIER_TYPES).toContain('NonUtilizzato');
    expect(POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS).toContain('NonRichiedere');
  });
});
```

- [ ] **Step 2: Move the catalog** — append to `packages/shared-types/src/index.ts` the whole content of `apps/frontend-admin/src/data/sendTaxonomy.ts` (header comment with source URL, `SendTaxonomyEntry`, `SEND_ENTITY_TYPES`, `SEND_TAXONOMY_CATALOG`) unchanged, then append:

```ts
/** Regola già applicata dal wizard: codici con suffisso P solo con pagamento pagoPA, N senza. */
export function sendTaxonomyRequiresPayment(code: string): boolean {
  return code.endsWith('P');
}

export const SEND_PHYSICAL_COMMUNICATION_TYPES = ['AR_REGISTERED_LETTER', 'REGISTERED_LETTER_890'] as const;
export type SendPhysicalCommunicationType = (typeof SEND_PHYSICAL_COMMUNICATION_TYPES)[number];

/** Valori GlobalCom Agol (`tipoNotificante`/`secondoTentativoRecapito`), stessi letterali di postal.strategy.ts. */
export const POSTAL_AGOL_NOTIFIER_TYPES = ['NonUtilizzato', 'UfficialeGiudiziario', 'Procuratore', 'ParteIstante'] as const;
export const POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS = ['NonRichiedere', 'Concordato', 'Automatico'] as const;

/** Stessa regola di postal.strategy.ts / hasPostalArTracking. */
export function isPostalAgolService(serviceType: string): boolean {
  return serviceType.startsWith('Agol');
}

export function postalServiceSupportsReturnReceipt(serviceType: string): boolean {
  return serviceType.startsWith('Raccomandata');
}
```

Delete `apps/frontend-admin/src/data/sendTaxonomy.ts`. In `apps/frontend-admin/src/App.tsx` replace lines 10–11 with:

```ts
import { COUNTRIES, matchCountry, isValidCap, abbreviateLongMunicipality, SEND_ENTITY_TYPES, SEND_TAXONOMY_CATALOG } from '@comunicapa/shared-types';
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` and `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: no new errors. (I test `index.spec.ts` di shared-types girano in CI con `pnpm test`; in locale la copertura arriva da Task 5.)

- [ ] **Step 4: Check the admin UI still loads** — open `http://localhost:3000`, wizard SEND → the taxonomy select lists codes. If Vite reports `does not provide an export named SEND_TAXONOMY_CATALOG`, run `docker compose restart frontend-admin`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src/index.ts packages/shared-types/src/index.spec.ts apps/frontend-admin/src/App.tsx apps/frontend-admin/src/data/sendTaxonomy.ts
git commit -m "refactor(shared-types): catalogo tassonomie SEND ed enum Agol condivisi"
```

---

### Task 2: SEND `recipientType` PG per Partita IVA

**Files:**
- Modify: `apps/backend/src/channels/send/send-dispatch.service.ts:233`
- Test: `apps/backend/src/channels/send/send-dispatch.service.spec.ts`

- [ ] **Step 1: Write the failing test** — add inside the existing `describe` (uses `makeAttempt`, `mockBatch`, `mockFetch` already defined in the file):

```ts
  it('usa recipientType PG quando il codice fiscale del destinatario è una Partita IVA', async () => {
    const attempt = makeAttempt({
      recipient: {
        id: 'r1',
        codiceFiscale: '01234567890',
        fullName: 'ACME SRL',
        extraData: {},
        campaign: {
          id: 'camp-1',
          name: 'TARI',
          retentionDays: null,
          channelConfig: { subject: 'Avviso', taxonomyCode: '010101N' },
        } as unknown as Campaign,
      } as unknown as Recipient,
    });
    mockBatch([attempt]);

    await service.handleCron();

    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    const payload = JSON.parse(sendCall![1].body as string);
    expect(payload.recipients[0].recipientType).toBe('PG');
    expect(payload.recipients[0].taxId).toBe('01234567890');
  });

  it('usa recipientType PF per un codice fiscale di persona fisica', async () => {
    mockBatch([makeAttempt()]);
    await service.handleCron();
    const sendCall = mockFetch.mock.calls.find(([url]) => url === 'https://send.test/delivery/v2.6/requests');
    expect(JSON.parse(sendCall![1].body as string).recipients[0].recipientType).toBe('PF');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run send-dispatch.service`
Expected: FAIL — `expected 'PF' to be 'PG'`.

- [ ] **Step 3: Implement** — in `send-dispatch.service.ts` add the import next to the others:

```ts
import { isPartitaIva } from '../tax-id.util.js';
```

and replace `recipientType: 'PF',` (line 233) with:

```ts
        // P.IVA (11 cifre) = persona giuridica: PN valida recipientType
        // contro il formato del taxId, PF fisso rifiutava le imprese.
        recipientType: isPartitaIva(recipient.codiceFiscale) ? 'PG' : 'PF',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run send-dispatch.service`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/send/send-dispatch.service.ts apps/backend/src/channels/send/send-dispatch.service.spec.ts
git commit -m "fix(send): recipientType PG per destinatari con Partita IVA"
```

---

### Task 3: `ExternalApiError`, filtro e validazione con path completo

**Files:**
- Create: `apps/backend/src/external-api/external-api.error.ts`
- Create: `apps/backend/src/external-api/validate-body.util.ts`
- Create: `apps/backend/src/external-api/validate-body.util.spec.ts`
- Modify: `apps/backend/src/external-api/external-api-exception.filter.ts`
- Test: `apps/backend/src/external-api/external-api-exception.filter.spec.ts`

**Interfaces:**
- Produces:
  - `type ExternalErrorCode = 'UNAUTHORIZED' | 'VALIDATION_ERROR' | 'CHANNEL_INACTIVE' | 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_IN_PROGRESS' | 'ATTACHMENT_INVALID' | 'LAUNCH_BLOCKED' | 'NOT_FOUND' | 'INTERNAL_ERROR'`
  - `interface ValidationIssue { field: string; message: string; allowed?: string[] }`
  - `class ExternalApiError extends Error { readonly code: ExternalErrorCode; readonly details?: ValidationIssue[] }`
  - `function validateBody<T extends object>(cls: new () => T, body: unknown): Promise<{ value: T; issues: ValidationIssue[] }>`

- [ ] **Step 1: Write the failing tests**

`validate-body.util.spec.ts`:

```ts
import 'reflect-metadata';
import { IsString, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { validateBody } from './validate-body.util.js';

class Inner {
  @IsString()
  name!: string;
}

class Outer {
  @IsString()
  title!: string;

  @ValidateNested()
  @Type(() => Inner)
  @IsOptional()
  inner?: Inner;
}

describe('validateBody', () => {
  it('restituisce issues con il path completo dei campi annidati', async () => {
    const { issues } = await validateBody(Outer, { title: 'x', inner: { name: 5 } });
    expect(issues).toEqual([{ field: 'inner.name', message: expect.stringContaining('name') }]);
  });

  it('segnala come issue i campi non dichiarati (forbidNonWhitelisted)', async () => {
    const { issues } = await validateBody(Outer, { title: 'x', inner: { name: 'a', foo: 1 } });
    expect(issues).toEqual([{ field: 'inner.foo', message: 'campo non ammesso' }]);
  });

  it('più vincoli violati sullo stesso campo → una sola issue', async () => {
    const { issues } = await validateBody(Outer, { title: 5 });
    expect(issues.map((i) => i.field)).toEqual(['title']);
  });

  it('body non oggetto → issue sul root', async () => {
    const { issues } = await validateBody(Outer, 'stringa');
    expect(issues).toEqual([{ field: '', message: 'body JSON oggetto obbligatorio' }]);
  });

  it('nessuna issue → value è un\'istanza della classe', async () => {
    const { value, issues } = await validateBody(Outer, { title: 'x' });
    expect(issues).toEqual([]);
    expect(value).toBeInstanceOf(Outer);
  });
});
```

Append to `external-api-exception.filter.spec.ts` (riusa gli helper host/response già presenti nel file; se nel file non esiste un helper, usa questo):

```ts
import { ExternalApiError } from './external-api.error.js';

describe('ExternalApiExceptionFilter — ExternalApiError', () => {
  function run(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => undefined }),
    } as any;
    new ExternalApiExceptionFilter().catch(exception, host);
    return { status, json };
  }

  it('mappa code/message/details di ExternalApiError con HTTP 200', () => {
    const { status, json } = run(
      new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', [{ field: 'send.taxonomyCode', message: 'non abilitato', allowed: ['010101N'] }]),
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details: [{ field: 'send.taxonomyCode', message: 'non abilitato', allowed: ['010101N'] }] },
    });
  });

  it('omette details quando assente', () => {
    const { json } = run(new ExternalApiError('NOT_FOUND', 'Notifica non trovata'));
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec backend node_modules/.bin/vitest run validate-body external-api-exception`
Expected: FAIL — module `./external-api.error.js` / `./validate-body.util.js` not found.

- [ ] **Step 3: Implement**

`external-api.error.ts`:

```ts
export type ExternalErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'CHANNEL_INACTIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'ATTACHMENT_INVALID'
  | 'LAUNCH_BLOCKED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ValidationIssue {
  field: string;
  message: string;
  allowed?: string[];
}

/** Errore di dominio dell'API esterna: il filtro lo traduce 1:1 nel body `{ success:false, error }` (sempre HTTP 200). */
export class ExternalApiError extends Error {
  constructor(
    readonly code: ExternalErrorCode,
    message: string,
    readonly details?: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}
```

`validate-body.util.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { ValidationIssue } from './external-api.error.js';

/**
 * Validazione manuale (non la ValidationPipe globale): la pipe appiattisce gli
 * errori annidati in stringhe senza path affidabile, qui serve `field` completo
 * (`recipient.address.zip`) nel contratto `details[]`. I controller v2 che la
 * usano dichiarano `@Body() body: Record<string, unknown>` — metatype Object,
 * che la ValidationPipe globale salta per costruzione.
 */
export async function validateBody<T extends object>(
  cls: new () => T,
  body: unknown,
): Promise<{ value: T; issues: ValidationIssue[] }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { value: new cls(), issues: [{ field: '', message: 'body JSON oggetto obbligatorio' }] };
  }
  const value = plainToInstance(cls, body);
  const errors = await validate(value, { whitelist: true, forbidNonWhitelisted: true });
  return { value, issues: flatten(errors, '') };
}

/** Una issue per campo (messaggi uniti con "; "): più vincoli violati sullo stesso campo non duplicano `field`. */
function flatten(errors: ValidationError[], parent: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const messages = Object.entries(e.constraints ?? {}).map(([key, message]) => (key === 'whitelistValidation' ? 'campo non ammesso' : message));
    if (messages.length) out.push({ field, message: messages.join('; ') });
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}
```

In `external-api-exception.filter.ts` add `import { ExternalApiError } from './external-api.error.js';` and make `ExternalApiError` the first branch of `normalize()`:

```ts
    if (exception instanceof ExternalApiError) {
      return {
        success: false,
        error: { code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) },
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose exec backend node_modules/.bin/vitest run validate-body external-api-exception`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-api.error.ts apps/backend/src/external-api/validate-body.util.ts apps/backend/src/external-api/validate-body.util.spec.ts apps/backend/src/external-api/external-api-exception.filter.ts apps/backend/src/external-api/external-api-exception.filter.spec.ts
git commit -m "feat(external-api): ExternalApiError e validazione con path completo"
```

---

### Task 4: DTO `CreateNotificationDto` (formato) + regole per canale

**Perché due livelli:** in class-validator `@IsOptional()` (e `@ValidateIf` falso) salta **tutti** i validatori della proprietà quando il valore è assente — una regola "address obbligatorio per SEND" messa sulla proprietà non scatterebbe mai. Quindi: le classi DTO validano solo il **formato** (tipi, regex, lunghezze fisse, campi sconosciuti), una funzione pura `channelRuleIssues()` applica le regole che dipendono dal canale (presenza/divieto, limiti App IO).

**Files:**
- Create: `apps/backend/src/external-api/dto/create-notification.dto.ts`
- Create: `apps/backend/src/external-api/dto/create-notification.dto.spec.ts`

**Interfaces:**
- Consumes: `validateBody`, `ValidationIssue` (Task 3).
- Produces (exported):
  - classi `CreateNotificationDto { channel: NotificationChannel; externalReference?: string; recipient: RecipientDto; content: ContentDto; attachments?: AttachmentRefDto[]; payment?: PaymentDto; sender?: SenderDto; appIoParallel?: AppIoParallelDto; send?: SendOptionsDto; postal?: PostalOptionsDto }`, `RecipientDto { type: 'PF' | 'PG'; taxId: string; fullName?: string; email?: string; pec?: string; address?: AddressDto }`, `AddressDto { street: string; zip?: string; municipality: string; province?: string; country?: string }`, `ContentDto { subject: string; body?: string }`, `AttachmentRefDto { token: string; label?: string }`, `PaymentDto { noticeCode: string; amountCents: number; creditorTaxId: string; dueDate?: string }`, `SenderDto { mailConfigId?: string; pecReserveMailConfigId?: string; ioServiceId?: string }`, `AppIoParallelDto { subject?: string; body?: string }`, `SendOptionsDto { taxonomyCode: string; physicalCommunicationType?: SendPhysicalCommunicationType }`, `PostalOptionsDto { serviceType?: string; contractCode?: string; returnReceipt?: boolean; color?: boolean; duplex?: boolean; coverPageId?: string; agol?: PostalAgolDto }`, `PostalAgolDto { notifierType?: string; secondAttempt?: string; notifierName?: string; chronologicalNumber?: string }`
  - `const APP_IO_LIMITS = { subject: [10, 120], body: [80, 10000] } as const`
  - `function stripHtmlForLength(value: string): string`
  - `function channelRuleIssues(dto: CreateNotificationDto): ValidationIssue[]`
  - `function validateCreateNotification(body: unknown): Promise<{ value: CreateNotificationDto; issues: ValidationIssue[] }>` — formato prima; le regole per canale solo se il formato è valido (evita issue a cascata su oggetti malformati).

- [ ] **Step 1: Write the failing test** — `dto/create-notification.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { validateCreateNotification } from './create-notification.dto.js';

const TOKEN = '3fbb1e2a-1234-4abc-9def-426614174000';
const LONG_BODY = '<p>' + 'Gentile cittadino, la informiamo che è disponibile un nuovo avviso. '.repeat(2) + '</p>';
const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };

function email(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'EMAIL',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' },
    content: { subject: 'Avviso TARI 2026', body: '<p>Testo</p>' },
    ...overrides,
  };
}

function postal(overrides: Record<string, unknown> = {}, address: Record<string, unknown> = ADDRESS) {
  return {
    channel: 'POSTAL',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address },
    content: { subject: 'Avviso' },
    attachments: [{ token: TOKEN }],
    ...overrides,
  };
}

async function fields(body: unknown): Promise<string[]> {
  const { issues } = await validateCreateNotification(body);
  return issues.map((i) => i.field).sort();
}

describe('validateCreateNotification — formato', () => {
  it('EMAIL minimo valido', async () => {
    expect(await fields(email())).toEqual([]);
  });

  it('campo sconosciuto annidato → issue con path completo', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', foo: 1 } }))).toEqual(['recipient.foo']);
  });

  it('channel non valido → solo issue di formato, niente regole per canale a cascata', async () => {
    expect(await fields(email({ channel: 'FAX' }))).toEqual(['channel']);
  });

  it('PF con taxId da 11 cifre e PG con CF da 16 → errore su recipient.taxId', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: '01234567890', email: 'a@b.it' } }))).toEqual(['recipient.taxId']);
    expect(await fields(email({ recipient: { type: 'PG', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' } }))).toEqual(['recipient.taxId']);
  });

  it('PG con P.IVA valida', async () => {
    expect(await fields(email({ recipient: { type: 'PG', taxId: '01234567890', email: 'a@b.it' } }))).toEqual([]);
  });

  it('token allegato non UUID → errore (anti path traversal)', async () => {
    expect(await fields(postal({ attachments: [{ token: '../altro/tok' }] }))).toEqual(['attachments.0.token']);
  });

  it('payment: dueDate YYYY-MM-DD, amountCents intero > 0', async () => {
    const f = await fields({
      channel: 'SEND',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Notifica atto' },
      attachments: [{ token: TOKEN }],
      send: { taxonomyCode: '010101P' },
      payment: { noticeCode: '302000000000000000', amountCents: 0, creditorTaxId: '01234567890', dueDate: '31/12/2026' },
    });
    expect(f).toEqual(['payment.amountCents', 'payment.dueDate']);
  });

  it('indirizzo italiano senza provincia → errore; estero senza provincia → valido', async () => {
    expect(await fields(postal({}, { street: 'Via Roma 1', municipality: 'Roma' }))).toEqual(['recipient.address.province']);
    expect(await fields(postal({}, { street: 'Rue X 1', municipality: 'Bruxelles', country: 'Belgio' }))).toEqual([]);
  });

  it('comune noto oltre 30 caratteri → abbreviato; altro comune oltre 30 → errore', async () => {
    const ok = await validateCreateNotification(postal({}, { street: 'Via Roma 1', municipality: 'Villa Santa Lucia degli Abruzzi', province: 'AQ' }));
    expect(ok.issues).toEqual([]);
    expect(ok.value.recipient.address!.municipality).toBe('VILLA SANTA LUCIA ABRUZZI');
    expect(await fields(postal({}, { street: 'Via Roma 1', municipality: 'Comune Inventato Con Nome Davvero Lunghissimo', province: 'XX' }))).toEqual([
      'recipient.address.municipality',
    ]);
  });

  it('postal.agol con serviceType non Agol → errore', async () => {
    expect(await fields(postal({ postal: { serviceType: 'Raccomandata', agol: { notifierType: 'NonUtilizzato' } } }))).toEqual(['postal.agol']);
  });
});

describe('validateCreateNotification — regole per canale', () => {
  it('EMAIL senza email, PEC senza pec → errore sul contatto', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U' } }))).toEqual(['recipient.email']);
    expect(await fields(email({ channel: 'PEC' }))).toEqual(['recipient.pec']);
  });

  it('subject vuoto dopo trim → errore per ogni canale', async () => {
    expect(await fields(email({ content: { subject: '   ', body: '<p>x</p>' } }))).toEqual(['content.subject']);
  });

  it('body con solo markup vuoto → errore (shell Tiptap <p></p>)', async () => {
    expect(await fields(email({ content: { subject: 'Avviso', body: '<p></p>' } }))).toEqual(['content.body']);
  });

  it('APP_IO: subject corto e body sotto 80 caratteri visibili', async () => {
    expect(await fields(email({ channel: 'APP_IO', content: { subject: 'Breve', body: '<p>corto</p>' } }))).toEqual(['content.body', 'content.subject']);
  });

  it('SEND completo valido', async () => {
    expect(
      await fields({
        channel: 'SEND',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
        content: { subject: 'Notifica atto' },
        attachments: [{ token: TOKEN }],
        send: { taxonomyCode: '010101N' },
      }),
    ).toEqual([]);
  });

  it('SEND: body vietato, address/fullName/attachments/send obbligatori', async () => {
    const f = await fields({
      channel: 'SEND',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U' },
      content: { subject: 'Notifica atto', body: '<p>x</p>' },
    });
    expect(f).toEqual(['attachments', 'content.body', 'recipient.address', 'recipient.fullName', 'send']);
  });

  it('blocchi canale-specifici fuori canale → errore', async () => {
    const f = await fields(email({ send: { taxonomyCode: '010101N' }, postal: {}, payment: { noticeCode: '302000000000000000', amountCents: 1, creditorTaxId: '01234567890' } }));
    expect(f).toEqual(['payment', 'postal', 'send']);
  });

  it('address vietato fuori da SEND/POSTAL', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', address: ADDRESS } }))).toEqual(['recipient.address']);
  });

  it('appIoParallel: vietato su APP_IO; su POSTAL subject+body obbligatori', async () => {
    expect(await fields(email({ channel: 'APP_IO', content: { subject: 'Avviso TARI 2026', body: LONG_BODY }, appIoParallel: {} }))).toEqual(['appIoParallel']);
    expect(await fields(postal({ appIoParallel: { subject: 'Hai una nuova comunicazione' } }))).toEqual(['appIoParallel']);
  });

  it('EMAIL + appIoParallel senza override ricade su content: vincoli App IO sul testo effettivo', async () => {
    expect(await fields(email({ appIoParallel: {} }))).toEqual(['appIoParallel']);
    expect(await fields(email({ content: { subject: 'Avviso TARI 2026', body: LONG_BODY }, appIoParallel: {} }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run create-notification.dto`
Expected: FAIL — module `./create-notification.dto.js` not found.

- [ ] **Step 3: Implement** — `dto/create-notification.dto.ts`:

```ts
import 'reflect-metadata';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  abbreviateLongMunicipality,
  isPostalAgolService,
  matchCountry,
  POSTAL_AGOL_NOTIFIER_TYPES,
  POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS,
  SEND_PHYSICAL_COMMUNICATION_TYPES,
  type NotificationChannel,
  type SendPhysicalCommunicationType,
} from '@comunicapa/shared-types';
import type { ValidationIssue } from '../external-api.error.js';
import { validateBody } from '../validate-body.util.js';

export const APP_IO_LIMITS = { subject: [10, 120], body: [80, 10000] } as const;

/** Stesso stripping del wizard (isWizBodyEmpty / wizPlainTextLength in App.tsx): PagoPA misura il testo visibile. */
export function stripHtmlForLength(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

/** Vincolo su un valore PRESENTE che dipende da un campo fratello (stesso oggetto). */
function SiblingRule<T>(message: string, check: (value: unknown, self: T) => boolean): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: `siblingRule_${String(propertyName)}`,
      target: object.constructor,
      propertyName: propertyName as string,
      options: { message },
      validator: {
        validate: (value: unknown, args: ValidationArguments) => check(value, args.object as T),
      },
    });
  };
}

function isItalian(country: string | undefined): boolean {
  return !country?.trim() || matchCountry(country.trim()) === 'Italia';
}

export class AddressDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  street!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  zip?: string;

  // Uno dei 5 comuni italiani noti oltre 30 caratteri → forma abbreviata (stessa regola della correzione indirizzo).
  @Transform(({ value }) => (typeof value === 'string' ? abbreviateLongMunicipality(value) : value))
  @IsString()
  @MinLength(1)
  @MaxLength(30, { message: 'municipality non può superare 30 caratteri' })
  municipality!: string;

  @ValidateIf((o: AddressDto) => isItalian(o.country) || o.province !== undefined)
  @IsString({ message: 'province obbligatoria per indirizzi italiani' })
  @Matches(/^[A-Za-z]{2}$/, { message: 'province deve essere la sigla di 2 lettere' })
  province?: string;

  @IsOptional()
  @IsString()
  @SiblingRule<AddressDto>('country non riconosciuto', (v) => matchCountry(String(v)) !== null)
  country?: string;
}

export class RecipientDto {
  @IsIn(['PF', 'PG'])
  type!: 'PF' | 'PG';

  @IsString()
  @SiblingRule<RecipientDto>('taxId deve essere un codice fiscale di 16 caratteri (PF) o una partita IVA di 11 cifre (PG)', (v, self) =>
    typeof v === 'string' && (self.type === 'PG' ? /^\d{11}$/.test(v) : /^[A-Za-z0-9]{16}$/.test(v)),
  )
  taxId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEmail()
  pec?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

export class ContentDto {
  @IsString()
  @MaxLength(10000)
  subject!: string;

  @IsOptional()
  @IsString()
  body?: string;
}

export class AttachmentRefDto {
  /** Sempre randomUUID() server-side: @IsUUID blocca path traversal prima di tokens.resolve(). */
  @IsUUID()
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class PaymentDto {
  @Matches(/^\d{18}$/, { message: 'noticeCode deve essere il codice avviso pagoPA di 18 cifre' })
  noticeCode!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @Matches(/^\d{11}$/, { message: 'creditorTaxId deve essere il codice fiscale ente di 11 cifre' })
  creditorTaxId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate deve essere in formato YYYY-MM-DD' })
  dueDate?: string;
}

export class SenderDto {
  @IsOptional() @IsUUID() mailConfigId?: string;
  @IsOptional() @IsUUID() pecReserveMailConfigId?: string;
  @IsOptional() @IsUUID() ioServiceId?: string;
}

export class AppIoParallelDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() body?: string;
}

export class SendOptionsDto {
  @Matches(/^\d{6}[PN]$/, { message: 'taxonomyCode non valido (6 cifre + P/N)' })
  taxonomyCode!: string;

  @IsOptional()
  @IsIn([...SEND_PHYSICAL_COMMUNICATION_TYPES])
  physicalCommunicationType?: SendPhysicalCommunicationType;
}

export class PostalAgolDto {
  @IsOptional() @IsIn([...POSTAL_AGOL_NOTIFIER_TYPES]) notifierType?: string;
  @IsOptional() @IsIn([...POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS]) secondAttempt?: string;
  @IsOptional() @IsString() @MaxLength(100) notifierName?: string;
  @IsOptional() @IsString() @MaxLength(50) chronologicalNumber?: string;
}

export class PostalOptionsDto {
  @IsOptional() @IsString() serviceType?: string;
  @IsOptional() @IsString() contractCode?: string;
  @IsOptional() @IsBoolean() returnReceipt?: boolean;
  @IsOptional() @IsBoolean() color?: boolean;
  @IsOptional() @IsBoolean() duplex?: boolean;
  @IsOptional() @IsString() coverPageId?: string;

  @IsOptional()
  @SiblingRule<PostalOptionsDto>('agol ammesso solo con un serviceType Agol', (_v, self) => !!self.serviceType && isPostalAgolService(self.serviceType))
  @ValidateNested()
  @Type(() => PostalAgolDto)
  agol?: PostalAgolDto;
}

export class CreateNotificationDto {
  @IsIn(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'])
  channel!: NotificationChannel;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @ValidateNested()
  @Type(() => RecipientDto)
  recipient!: RecipientDto;

  @ValidateNested()
  @Type(() => ContentDto)
  content!: ContentDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentDto)
  payment?: PaymentDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SenderDto)
  sender?: SenderDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppIoParallelDto)
  appIoParallel?: AppIoParallelDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SendOptionsDto)
  send?: SendOptionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PostalOptionsDto)
  postal?: PostalOptionsDto;
}

const PHYSICAL: readonly string[] = ['SEND', 'POSTAL'];

function appIoTextOk(subject: string, body: string): boolean {
  const plain = stripHtmlForLength(body);
  return (
    subject.length >= APP_IO_LIMITS.subject[0] && subject.length <= APP_IO_LIMITS.subject[1] &&
    plain.length >= APP_IO_LIMITS.body[0] && plain.length <= APP_IO_LIMITS.body[1]
  );
}

/**
 * Regole che dipendono dal canale, su un DTO di formato già valido. Riprendono
 * senza modifiche le regole v1 verificate contro il wizard admin (subject
 * sempre obbligatorio; body vietato per SEND/POSTAL; vincoli PagoPA App IO sul
 * testo visibile; App IO parallela solo per EMAIL/PEC/POSTAL, override
 * obbligatori per POSTAL).
 */
export function channelRuleIssues(dto: CreateNotificationDto): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const ch = dto.channel;
  const physical = PHYSICAL.includes(ch);
  const r = dto.recipient;

  if (ch === 'EMAIL' && !r.email) add('recipient.email', 'email obbligatoria per il canale EMAIL');
  if (ch === 'PEC' && !r.pec) add('recipient.pec', 'pec obbligatoria per il canale PEC');
  if (physical && !r.fullName?.trim()) add('recipient.fullName', 'fullName obbligatorio per SEND e POSTAL');
  if (physical && !r.address) add('recipient.address', 'address obbligatorio per SEND e POSTAL');
  if (!physical && r.address) add('recipient.address', 'address ammesso solo per SEND e POSTAL');

  const subject = dto.content.subject;
  if (!subject.trim()) add('content.subject', 'subject obbligatorio (non vuoto)');
  else if (ch === 'APP_IO' && (subject.length < APP_IO_LIMITS.subject[0] || subject.length > APP_IO_LIMITS.subject[1])) {
    add('content.subject', `subject deve avere tra ${APP_IO_LIMITS.subject[0]} e ${APP_IO_LIMITS.subject[1]} caratteri per APP_IO`);
  }

  const body = dto.content.body;
  if (physical) {
    if (body !== undefined) add('content.body', `body non ammesso per ${ch}: il contenuto notificato sono gli allegati`);
  } else if (body === undefined || !stripHtmlForLength(body)) {
    add('content.body', 'body obbligatorio (testo visibile non vuoto)');
  } else if (ch === 'APP_IO') {
    const len = stripHtmlForLength(body).length;
    if (len < APP_IO_LIMITS.body[0] || len > APP_IO_LIMITS.body[1]) {
      add('content.body', `body deve avere tra ${APP_IO_LIMITS.body[0]} e ${APP_IO_LIMITS.body[1]} caratteri visibili per APP_IO`);
    }
  }

  if (physical && !dto.attachments?.length) add('attachments', 'attachments obbligatorio (almeno 1) per SEND e POSTAL');
  if (dto.payment && ch !== 'SEND' && ch !== 'APP_IO') add('payment', 'payment ammesso solo per SEND e APP_IO');
  if (ch === 'SEND' && !dto.send) add('send', 'send obbligatorio per il canale SEND');
  if (ch !== 'SEND' && dto.send) add('send', 'send ammesso solo per il canale SEND');
  if (ch !== 'POSTAL' && dto.postal) add('postal', 'postal ammesso solo per il canale POSTAL');

  const p = dto.appIoParallel;
  if (p) {
    if (!['EMAIL', 'PEC', 'POSTAL'].includes(ch)) {
      add('appIoParallel', 'appIoParallel ammesso solo per EMAIL, PEC e POSTAL');
    } else if (ch === 'POSTAL' && (!p.subject || !p.body)) {
      add('appIoParallel', 'per POSTAL appIoParallel.subject e appIoParallel.body sono obbligatori');
    } else if (!appIoTextOk(p.subject ?? subject, p.body ?? body ?? '')) {
      add(
        'appIoParallel',
        `testo App IO effettivo (override o content): oggetto ${APP_IO_LIMITS.subject[0]}-${APP_IO_LIMITS.subject[1]}, testo ${APP_IO_LIMITS.body[0]}-${APP_IO_LIMITS.body[1]} caratteri visibili`,
      );
    }
  }
  return issues;
}

export async function validateCreateNotification(body: unknown): Promise<{ value: CreateNotificationDto; issues: ValidationIssue[] }> {
  const { value, issues } = await validateBody(CreateNotificationDto, body);
  if (issues.length) return { value, issues };
  return { value, issues: channelRuleIssues(value) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run create-notification.dto`
Expected: PASS. Se `@Transform` non viene applicato su `municipality` (comune non abbreviato), verificare che `validateBody` usi `plainToInstance` (Task 3) — `@Transform` agisce solo lì.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/dto/create-notification.dto.ts apps/backend/src/external-api/dto/create-notification.dto.spec.ts
git commit -m "feat(external-api): DTO v2 tipizzato con regole per canale"
```

---

### Task 5: `ExternalCapabilitiesService` (capabilities + validazione dinamica)

**Files:**
- Create: `apps/backend/src/external-api/external-capabilities.service.ts`
- Create: `apps/backend/src/external-api/external-capabilities.service.spec.ts`

**Interfaces:**
- Consumes: `CreateNotificationDto` (Task 4), `ValidationIssue` (Task 3), `SEND_TAXONOMY_CATALOG`, `sendTaxonomyRequiresPayment`, `SEND_PHYSICAL_COMMUNICATION_TYPES`, `POSTAL_AGOL_*`, `isPostalAgolService`, `postalServiceSupportsReturnReceipt` (Task 1), `MailConfigsService.listMasked(type)`, `IoServicesService.listMasked()`, `PostalProvidersService.getActive()`, `AppSettingsService.get()`.
- Produces:
  - `interface CapabilitiesResponse` (shape below)
  - `ExternalCapabilitiesService.getCapabilities(): Promise<CapabilitiesResponse>`
  - `ExternalCapabilitiesService.validate(dto: CreateNotificationDto, caps: CapabilitiesResponse): { inactiveChannel: boolean; issues: ValidationIssue[] }`
  - `ExternalCapabilitiesService.resolveDefaults(dto, caps): { taxonomyCode?: string; physicalCommunicationType?: string; postalServiceType?: string }` — default espliciti da scrivere in `channelConfig`.

- [ ] **Step 1: Write the failing test** — `external-capabilities.service.spec.ts`:

```ts
import 'reflect-metadata';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

function makeService(over: { settings?: Record<string, unknown>; postal?: unknown; mail?: unknown[]; io?: unknown[] } = {}) {
  const settings: Record<string, unknown> = {
    'send.environment': 'test',
    'send.test.apiKey': 'k',
    'send.test.purposeId': 'p',
    'send.test.group': '',
    'send.enabledTaxonomyCodes': JSON.stringify([
      { code: '010101N', label: 'Atto generico', isDefault: true },
      { code: '010101P', label: 'Atto con pagamento' },
    ]),
    ...over.settings,
  };
  const mail = over.mail ?? [
    { id: '11111111-1111-4111-8111-111111111111', type: 'EMAIL', name: 'Tributi', fromAddress: 'noreply@example.com', active: true, isDefault: true, host: 'smtp', username: 'u', password: '***' },
    { id: '22222222-2222-4222-8222-222222222222', type: 'PEC', name: 'Protocollo', fromAddress: 'protocollo@pec.example.com', active: true, isDefault: true, host: 'smtp', username: 'u', password: '***' },
  ];
  const io = over.io ?? [{ id: '33333333-3333-4333-8333-333333333333', nome: 'Tributi', isDefault: true, apiKeyPrimaria: '***' }];
  const postal = over.postal === undefined
    ? { enabledServiceTypes: ['Raccomandata', 'AgolRaccomandata', 'PostaOrdinaria'], contratti: [{ codiceContratto: 'C1', descrizione: 'Nazionale', tipologia: 'Std', estero: false }] }
    : over.postal;
  return new ExternalCapabilitiesService(
    { listMasked: jest.fn(async (type?: string) => (mail as any[]).filter((m) => !type || m.type === type)) } as any,
    { listMasked: jest.fn(async () => io), resolveApiKey: jest.fn(async () => (io.length ? { apiKey: 'x', idService: 'y' } : null)) } as any,
    { getActive: jest.fn(async () => postal) } as any,
    { get: jest.fn(async (k: string) => settings[k]) } as any,
  );
}

const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };
const sendDto = (send: Record<string, unknown>, payment?: unknown) =>
  ({
    channel: 'SEND',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
    content: { subject: 'Notifica atto' },
    attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
    send,
    ...(payment ? { payment } : {}),
  }) as unknown as CreateNotificationDto;

describe('ExternalCapabilitiesService.getCapabilities', () => {
  it('espone mittenti senza segreti, tassonomie con descrizione dal catalogo, opzioni POSTAL', async () => {
    const caps = await makeService().getCapabilities();
    expect(caps.success).toBe(true);
    expect(caps.channels.EMAIL).toEqual({
      active: true,
      senders: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Tributi', fromAddress: 'noreply@example.com', default: true }],
    });
    expect(JSON.stringify(caps)).not.toContain('smtp');
    expect(caps.channels.SEND.active).toBe(true);
    expect(caps.channels.SEND.taxonomies[0]).toEqual(
      expect.objectContaining({ code: '010101N', label: 'Atto generico', requiresPayment: false, default: true, description: expect.any(String) }),
    );
    expect(caps.channels.SEND.taxonomies[1]).toEqual(expect.objectContaining({ code: '010101P', requiresPayment: true, default: false }));
    expect(caps.channels.POSTAL.serviceTypes).toEqual([
      { value: 'Raccomandata', returnReceiptAvailable: true, agol: false, default: true },
      { value: 'AgolRaccomandata', returnReceiptAvailable: false, agol: true, default: false },
      { value: 'PostaOrdinaria', returnReceiptAvailable: false, agol: false, default: false },
    ]);
    expect(caps.channels.POSTAL.contracts).toEqual([{ code: 'C1', description: 'Nazionale', type: 'Std', foreign: false }]);
    expect(caps.channels.APP_IO).toEqual({ active: true, services: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Tributi', default: true }], parallelAvailable: true });
  });

  it('canali non configurati → active false e liste vuote', async () => {
    const caps = await makeService({ postal: null, mail: [], io: [], settings: { 'send.test.apiKey': '' } }).getCapabilities();
    expect(caps.channels.EMAIL).toEqual({ active: false, senders: [] });
    expect(caps.channels.SEND.active).toBe(false);
    expect(caps.channels.POSTAL).toEqual(expect.objectContaining({ active: false, serviceTypes: [], contracts: [] }));
    expect(caps.channels.APP_IO.active).toBe(false);
  });

  it('setting tassonomie in formato legacy string[] → tollerato', async () => {
    const caps = await makeService({ settings: { 'send.enabledTaxonomyCodes': JSON.stringify(['010101N']) } }).getCapabilities();
    expect(caps.channels.SEND.taxonomies[0]).toEqual(expect.objectContaining({ code: '010101N', default: true }));
  });
});

describe('ExternalCapabilitiesService.validate', () => {
  it('canale inattivo → inactiveChannel true', async () => {
    const svc = makeService({ postal: null });
    const caps = await svc.getCapabilities();
    const r = svc.validate({ channel: 'POSTAL' } as CreateNotificationDto, caps);
    expect(r.inactiveChannel).toBe(true);
  });

  it('tassonomia non abilitata → issue con allowed', async () => {
    const svc = makeService();
    const r = svc.validate(sendDto({ taxonomyCode: '020202N' }), await svc.getCapabilities());
    expect(r.issues).toEqual([{ field: 'send.taxonomyCode', message: expect.any(String), allowed: ['010101N', '010101P'] }]);
  });

  it('codice P senza payment e codice N con payment → issue', async () => {
    const svc = makeService();
    const caps = await svc.getCapabilities();
    expect(svc.validate(sendDto({ taxonomyCode: '010101P' }), caps).issues.map((i) => i.field)).toEqual(['send.taxonomyCode']);
    const pay = { noticeCode: '302000000000000000', amountCents: 100, creditorTaxId: '01234567890' };
    expect(svc.validate(sendDto({ taxonomyCode: '010101N' }, pay), caps).issues.map((i) => i.field)).toEqual(['send.taxonomyCode']);
    expect(svc.validate(sendDto({ taxonomyCode: '010101P' }, pay), caps).issues).toEqual([]);
  });

  it('serviceType e contractCode POSTAL non ammessi → issue con allowed', async () => {
    const svc = makeService();
    const dto = {
      channel: 'POSTAL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Avviso' },
      attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      postal: { serviceType: 'Telegramma', contractCode: 'ZZ' },
    } as unknown as CreateNotificationDto;
    const r = svc.validate(dto, await svc.getCapabilities());
    expect(r.issues).toEqual([
      { field: 'postal.serviceType', message: expect.any(String), allowed: ['Raccomandata', 'AgolRaccomandata', 'PostaOrdinaria'] },
      { field: 'postal.contractCode', message: expect.any(String), allowed: ['C1'] },
    ]);
  });

  it('returnReceipt su servizio senza AR → issue', async () => {
    const svc = makeService();
    const dto = {
      channel: 'POSTAL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Avviso' },
      attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      postal: { serviceType: 'PostaOrdinaria', returnReceipt: true },
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['postal.returnReceipt']);
  });

  it('sender di tipo sbagliato o inesistente → issue', async () => {
    const svc = makeService();
    const dto = {
      channel: 'EMAIL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' },
      content: { subject: 'Avviso', body: '<p>x</p>' },
      sender: { mailConfigId: '22222222-2222-4222-8222-222222222222', ioServiceId: '44444444-4444-4444-8444-444444444444' },
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['sender.mailConfigId', 'sender.ioServiceId']);
  });

  it('appIoParallel con App IO non configurato → issue', async () => {
    const svc = makeService({ io: [] });
    const dto = {
      channel: 'EMAIL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' },
      content: { subject: 'Avviso', body: '<p>x</p>' },
      appIoParallel: {},
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['appIoParallel']);
  });

  it('resolveDefaults: tassonomia default coerente con payment, servizio postale default', async () => {
    const svc = makeService();
    const caps = await svc.getCapabilities();
    expect(svc.resolveDefaults(sendDto({ taxonomyCode: '010101N' }), caps)).toEqual({ physicalCommunicationType: 'AR_REGISTERED_LETTER' });
    const postal = { channel: 'POSTAL', postal: {} } as unknown as CreateNotificationDto;
    expect(svc.resolveDefaults(postal, caps)).toEqual({ postalServiceType: 'Raccomandata' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-capabilities.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `external-capabilities.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  isPostalAgolService,
  postalServiceSupportsReturnReceipt,
  POSTAL_AGOL_NOTIFIER_TYPES,
  POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS,
  SEND_PHYSICAL_COMMUNICATION_TYPES,
  SEND_TAXONOMY_CATALOG,
  sendTaxonomyRequiresPayment,
} from '@comunicapa/shared-types';
import { MailConfigsService } from '../mail-configs/mail-configs.service.js';
import { IoServicesService } from '../io-services/io-services.service.js';
import { PostalProvidersService } from '../postal-providers/postal-providers.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import type { SettingKey } from '../settings/settings.registry.js';
import type { ValidationIssue } from './external-api.error.js';
import { APP_IO_LIMITS, type CreateNotificationDto } from './dto/create-notification.dto.js';
import { MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util.js';

export interface SenderCapability { id: string; name: string; fromAddress: string; default: boolean }
export interface TaxonomyCapability { code: string; label: string; description: string; requiresPayment: boolean; default: boolean }
export interface PostalServiceCapability { value: string; returnReceiptAvailable: boolean; agol: boolean; default: boolean }

export interface CapabilitiesResponse {
  success: true;
  recipientTypes: ['PF', 'PG'];
  limits: {
    attachment: { chunkMaxBytes: number; chunkRecommendedBytes: number; tokenTtlHours: number };
    appIo: { subject: readonly [number, number]; body: readonly [number, number] };
    idempotencyKeyTtlHours: number;
  };
  channels: {
    EMAIL: { active: boolean; senders: SenderCapability[] };
    PEC: { active: boolean; senders: SenderCapability[] };
    APP_IO: { active: boolean; services: Array<{ id: string; name: string; default: boolean }>; parallelAvailable: boolean };
    SEND: {
      active: boolean;
      environment: string;
      taxonomies: TaxonomyCapability[];
      physicalCommunicationTypes: Array<{ value: string; default: boolean }>;
    };
    POSTAL: {
      active: boolean;
      serviceTypes: PostalServiceCapability[];
      contracts: Array<{ code: string; description: string; type: string; foreign: boolean }>;
      defaults: { color: boolean; duplex: boolean; returnReceipt: boolean };
      agol: { notifierTypes: string[]; secondAttemptOptions: string[] };
    };
  };
}

export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Unica fonte per /capabilities E per la validazione dinamica di POST
 * /notifications: un valore accettato in creazione è per costruzione uno di
 * quelli esposti qui, mai due liste che divergono.
 */
@Injectable()
export class ExternalCapabilitiesService {
  constructor(
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly postalProviders: PostalProvidersService,
    private readonly settings: AppSettingsService,
  ) {}

  async getCapabilities(): Promise<CapabilitiesResponse> {
    const [emailList, pecList, ioList, ioKey, postal, taxonomyRaw, sendEnv] = await Promise.all([
      this.mailConfigs.listMasked('EMAIL' as any),
      this.mailConfigs.listMasked('PEC' as any),
      this.ioServices.listMasked(),
      this.ioServices.resolveApiKey(),
      this.postalProviders.getActive(),
      this.settings.get<string>('send.enabledTaxonomyCodes'),
      this.settings.get<string>('send.environment'),
    ]);

    const toSender = (c: { id: string; name: string; fromAddress: string; isDefault: boolean }): SenderCapability => ({
      id: c.id, name: c.name, fromAddress: c.fromAddress, default: c.isDefault,
    });
    const emailSenders = emailList.filter((c) => c.active).map(toSender);
    const pecSenders = pecList.filter((c) => c.active).map(toSender);

    // Stesso ambiente/prefisso di SendDispatchService.dispatchOne().
    const prefix = `send.${sendEnv === 'produzione' ? 'prod' : 'test'}`;
    const [sendApiKey, sendPurposeId] = await Promise.all([
      this.settings.get<string>(`${prefix}.apiKey` as SettingKey),
      this.settings.get<string>(`${prefix}.purposeId` as SettingKey),
    ]);
    const sendActive = !!sendApiKey && !!sendPurposeId;

    const appIoActive = ioKey !== null;
    const serviceTypes = postal?.enabledServiceTypes ?? [];

    return {
      success: true,
      recipientTypes: ['PF', 'PG'],
      limits: {
        attachment: { chunkMaxBytes: MAX_CHUNK_SIZE_BYTES, chunkRecommendedBytes: 512 * 1024, tokenTtlHours: 24 },
        appIo: { subject: APP_IO_LIMITS.subject, body: APP_IO_LIMITS.body },
        idempotencyKeyTtlHours: IDEMPOTENCY_TTL_HOURS,
      },
      channels: {
        EMAIL: { active: emailSenders.length > 0, senders: emailSenders },
        PEC: { active: pecSenders.length > 0, senders: pecSenders },
        APP_IO: {
          active: appIoActive,
          services: appIoActive ? ioList.map((s) => ({ id: s.id, name: s.nome, default: s.isDefault })) : [],
          parallelAvailable: appIoActive,
        },
        SEND: {
          active: sendActive,
          environment: sendEnv || 'test',
          taxonomies: sendActive ? parseTaxonomies(taxonomyRaw) : [],
          physicalCommunicationTypes: SEND_PHYSICAL_COMMUNICATION_TYPES.map((value, i) => ({ value, default: i === 0 })),
        },
        POSTAL: {
          active: postal !== null && postal !== undefined,
          serviceTypes: serviceTypes.map((value, i) => ({
            value,
            returnReceiptAvailable: postalServiceSupportsReturnReceipt(value),
            agol: isPostalAgolService(value),
            default: i === 0,
          })),
          contracts: (postal?.contratti ?? []).map((c) => ({ code: c.codiceContratto, description: c.descrizione, type: c.tipologia, foreign: c.estero })),
          // Stessi fallback runtime di postal.strategy.ts (colore off, fronte/retro on, AR off).
          defaults: { color: false, duplex: true, returnReceipt: false },
          agol: { notifierTypes: [...POSTAL_AGOL_NOTIFIER_TYPES], secondAttemptOptions: [...POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS] },
        },
      },
    };
  }

  validate(dto: CreateNotificationDto, caps: CapabilitiesResponse): { inactiveChannel: boolean; issues: ValidationIssue[] } {
    if (!caps.channels[dto.channel]?.active) return { inactiveChannel: true, issues: [] };
    const issues: ValidationIssue[] = [];

    if (dto.channel === 'SEND' && dto.send) {
      const allowed = caps.channels.SEND.taxonomies.map((t) => t.code);
      const code = dto.send.taxonomyCode;
      if (!allowed.includes(code)) {
        issues.push({ field: 'send.taxonomyCode', message: 'taxonomyCode non abilitato su questa istanza', allowed });
      } else if (sendTaxonomyRequiresPayment(code) !== !!dto.payment) {
        issues.push({
          field: 'send.taxonomyCode',
          message: dto.payment ? 'con payment serve un taxonomyCode con suffisso P' : 'un taxonomyCode con suffisso P richiede payment',
          allowed: caps.channels.SEND.taxonomies.filter((t) => t.requiresPayment === !!dto.payment).map((t) => t.code),
        });
      }
    }

    if (dto.channel === 'POSTAL' && dto.postal) {
      const services = caps.channels.POSTAL.serviceTypes;
      const st = dto.postal.serviceType;
      if (st !== undefined && !services.some((s) => s.value === st)) {
        issues.push({ field: 'postal.serviceType', message: 'serviceType non abilitato', allowed: services.map((s) => s.value) });
      }
      const contracts = caps.channels.POSTAL.contracts.map((c) => c.code);
      if (dto.postal.contractCode !== undefined && !contracts.includes(dto.postal.contractCode)) {
        issues.push({ field: 'postal.contractCode', message: 'contractCode non disponibile', allowed: contracts });
      }
      const effective = st ?? services.find((s) => s.default)?.value;
      if (dto.postal.returnReceipt && effective && !postalServiceSupportsReturnReceipt(effective)) {
        issues.push({ field: 'postal.returnReceipt', message: `ricevuta di ritorno non disponibile per il servizio ${effective}` });
      }
    }

    const s = dto.sender;
    if (s?.mailConfigId !== undefined) {
      const list = dto.channel === 'PEC' ? caps.channels.PEC.senders : caps.channels.EMAIL.senders;
      if (!list.some((x) => x.id === s.mailConfigId)) {
        issues.push({ field: 'sender.mailConfigId', message: 'mittente non disponibile per il canale', allowed: list.map((x) => x.id) });
      }
    }
    if (s?.pecReserveMailConfigId !== undefined && !caps.channels.PEC.senders.some((x) => x.id === s.pecReserveMailConfigId)) {
      issues.push({ field: 'sender.pecReserveMailConfigId', message: 'mittente PEC non disponibile', allowed: caps.channels.PEC.senders.map((x) => x.id) });
    }
    if (s?.ioServiceId !== undefined && !caps.channels.APP_IO.services.some((x) => x.id === s.ioServiceId)) {
      issues.push({ field: 'sender.ioServiceId', message: 'servizio App IO non disponibile', allowed: caps.channels.APP_IO.services.map((x) => x.id) });
    }
    if (dto.appIoParallel && !caps.channels.APP_IO.parallelAvailable) {
      issues.push({ field: 'appIoParallel', message: 'App IO non configurato su questa istanza' });
    }
    return { inactiveChannel: false, issues };
  }

  resolveDefaults(dto: CreateNotificationDto, caps: CapabilitiesResponse): { physicalCommunicationType?: string; postalServiceType?: string } {
    if (dto.channel === 'SEND') {
      return { physicalCommunicationType: dto.send?.physicalCommunicationType ?? caps.channels.SEND.physicalCommunicationTypes.find((t) => t.default)!.value };
    }
    if (dto.channel === 'POSTAL') {
      const def = caps.channels.POSTAL.serviceTypes.find((s) => s.default)?.value;
      return { postalServiceType: dto.postal?.serviceType ?? def };
    }
    return {};
  }
}

/** Setting `send.enabledTaxonomyCodes`: `{code,label,isDefault}[]` (UI attuale) o `string[]` (formato storico). */
function parseTaxonomies(raw: string | undefined): TaxonomyCapability[] {
  let list: Array<string | { code: string; label?: string; isDefault?: boolean }>;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  const rows = list.map((e) => (typeof e === 'string' ? { code: e, label: '', isDefault: false } : { code: e.code, label: e.label ?? '', isDefault: !!e.isDefault }));
  const hasDefault = rows.some((r) => r.isDefault);
  return rows.map((r, i) => {
    const entry = SEND_TAXONOMY_CATALOG.find((t) => t.code === r.code);
    return {
      code: r.code,
      label: r.label || entry?.title || r.code,
      description: entry?.description ?? '',
      requiresPayment: sendTaxonomyRequiresPayment(r.code),
      default: hasDefault ? r.isDefault : i === 0,
    };
  });
}
```

Nota: `resolveDefaults` **non** sceglie mai una tassonomia (`send.taxonomyCode` è obbligatorio nel DTO). Il test `resolveDefaults` del Step 1 lo riflette.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-capabilities.service`
Expected: PASS. Se `listMasked('EMAIL')` richiede l'enum `MailServerType`, importarlo da `../mail-configs/...` e rimuovere i cast `as any`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-capabilities.service.ts apps/backend/src/external-api/external-capabilities.service.spec.ts
git commit -m "feat(external-api): capabilities v2 con valori ammessi e validazione dinamica"
```

---

### Task 6: Mapper DTO → `channelConfig` + destinatario

**Files:**
- Create: `apps/backend/src/external-api/external-notification.mapper.ts`
- Create: `apps/backend/src/external-api/external-notification.mapper.spec.ts`

**Interfaces:**
- Consumes: `CreateNotificationDto` (Task 4).
- Produces:
  - `interface MappedNotification { channelConfig: Record<string, unknown>; recipient: { codiceFiscale: string; fullName: string | null; email: string | null; pec: string | null; extraData: Record<string, string> } }`
  - `function mapNotification(dto: CreateNotificationDto, defaults: { physicalCommunicationType?: string; postalServiceType?: string }): MappedNotification`
  - `const EXT_COLUMNS` (nomi colonne `_ext*`)

- [ ] **Step 1: Write the failing test**

```ts
import { mapNotification, EXT_COLUMNS } from './external-notification.mapper.js';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };

describe('mapNotification', () => {
  it('EMAIL: subject/body, sender, App IO parallela, source external, mai wizSingleMode', () => {
    const m = mapNotification(
      {
        channel: 'EMAIL',
        externalReference: 'PROT-1',
        recipient: { type: 'PF', taxId: 'rssmra80a01h501u', email: 'a@b.it' },
        content: { subject: 'Avviso', body: '<p>x</p>' },
        sender: { mailConfigId: '11111111-1111-4111-8111-111111111111' },
        appIoParallel: { subject: 'Hai una comunicazione' },
      } as CreateNotificationDto,
      {},
    );
    expect(m.channelConfig).toEqual({
      source: 'external',
      externalReference: 'PROT-1',
      subject: 'Avviso',
      body: '<p>x</p>',
      mailConfigId: '11111111-1111-4111-8111-111111111111',
      secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', subjectOverride: 'Hai una comunicazione', bodyOverride: undefined }],
    });
    expect(m.channelConfig).not.toHaveProperty('wizSingleMode');
    expect(m.recipient).toEqual({ codiceFiscale: 'RSSMRA80A01H501U', fullName: null, email: 'a@b.it', pec: null, extraData: {} });
  });

  it('SEND: tassonomia, tipo comunicazione, protocolla true, indirizzo e pagamento su colonne _ext*', () => {
    const m = mapNotification(
      {
        channel: 'SEND',
        recipient: { type: 'PG', taxId: '01234567890', fullName: 'ACME SRL', address: ADDRESS },
        content: { subject: 'Notifica atto' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
        payment: { noticeCode: '302000000000000000', amountCents: 12300, creditorTaxId: '01234567890', dueDate: '2026-12-31' },
        send: { taxonomyCode: '010101P' },
      } as CreateNotificationDto,
      { physicalCommunicationType: 'AR_REGISTERED_LETTER' },
    );
    expect(m.channelConfig).toEqual({
      source: 'external',
      subject: 'Notifica atto',
      protocolla: true,
      taxonomyCode: '010101P',
      physicalCommunicationType: 'AR_REGISTERED_LETTER',
      physicalAddressConfig: {
        enabled: true,
        addressColumn: EXT_COLUMNS.street,
        zipColumn: EXT_COLUMNS.zip,
        municipalityColumn: EXT_COLUMNS.municipality,
        provinceColumn: EXT_COLUMNS.province,
        countryColumn: EXT_COLUMNS.country,
      },
      paymentConfig: {
        enabled: true,
        amountType: 'cents',
        noticeNumberColumn: EXT_COLUMNS.noticeCode,
        amountColumn: EXT_COLUMNS.amountCents,
        payeeFiscalCodeType: 'static',
        payeeFiscalCodeStatic: '01234567890',
        dueDateColumn: EXT_COLUMNS.dueDate,
      },
    });
    expect(m.recipient).toEqual({
      codiceFiscale: '01234567890',
      fullName: 'ACME SRL',
      email: null,
      pec: null,
      extraData: {
        _extStreet: 'Via Roma 1',
        _extZip: '00100',
        _extMunicipality: 'Roma',
        _extProvince: 'RM',
        _extCountry: '',
        _extNoticeCode: '302000000000000000',
        _extAmountCents: '12300',
        _extDueDate: '2026-12-31',
      },
    });
  });

  it('POSTAL: tutte le opzioni, Agol, servizio di default', () => {
    const m = mapNotification(
      {
        channel: 'POSTAL',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: { ...ADDRESS, province: 'rm' } },
        content: { subject: 'Avviso' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
        postal: {
          contractCode: 'C1', returnReceipt: true, color: true, duplex: false, coverPageId: 'CP1',
          agol: { notifierType: 'Procuratore', secondAttempt: 'Automatico', notifierName: 'ROSSI MARIO', chronologicalNumber: '42' },
        },
      } as CreateNotificationDto,
      { postalServiceType: 'AgolRaccomandata' },
    );
    expect(m.channelConfig).toEqual(expect.objectContaining({
      postalServiceType: 'AgolRaccomandata',
      postalCodiceContratto: 'C1',
      postalReturnReceipt: true,
      postalColorPrint: true,
      postalDuplex: false,
      postalIdCoverPage: 'CP1',
      postalAgolTipoNotificante: 'Procuratore',
      postalAgolSecondoTentativo: 'Automatico',
      postalAgolNomeNotificante: 'ROSSI MARIO',
      postalAgolNumeroCronologico: '42',
    }));
    expect(m.channelConfig).not.toHaveProperty('protocolla');
    expect(m.recipient.extraData._extProvince).toBe('RM');
  });

  it('opzioni postali omesse → chiavi assenti (fallback runtime della strategy)', () => {
    const m = mapNotification(
      {
        channel: 'POSTAL',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
        content: { subject: 'Avviso' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      } as CreateNotificationDto,
      { postalServiceType: 'Raccomandata' },
    );
    for (const k of ['postalCodiceContratto', 'postalReturnReceipt', 'postalColorPrint', 'postalDuplex', 'postalIdCoverPage', 'postalAgolTipoNotificante']) {
      expect(m.channelConfig).not.toHaveProperty(k);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification.mapper`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `external-notification.mapper.ts`:

```ts
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

/** Colonne extraData dedicate: physicalAddressConfig/paymentConfig puntano qui (stesso schema del self-bootstrap `_edit*` di updateRecipientAddressAndRetry). */
export const EXT_COLUMNS = {
  street: '_extStreet',
  zip: '_extZip',
  municipality: '_extMunicipality',
  province: '_extProvince',
  country: '_extCountry',
  noticeCode: '_extNoticeCode',
  amountCents: '_extAmountCents',
  dueDate: '_extDueDate',
} as const;

export interface MappedNotification {
  channelConfig: Record<string, unknown>;
  recipient: { codiceFiscale: string; fullName: string | null; email: string | null; pec: string | null; extraData: Record<string, string> };
}

/** Assegna solo se definito: un'opzione omessa resta assente e la strategy usa il proprio fallback. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

export function mapNotification(
  dto: CreateNotificationDto,
  defaults: { physicalCommunicationType?: string; postalServiceType?: string },
): MappedNotification {
  // `source: 'external'` sostituisce wizSingleMode (che faceva saltare il check INAD al lancio).
  const cfg: Record<string, unknown> = { source: 'external' };
  put(cfg, 'externalReference', dto.externalReference);
  cfg['subject'] = dto.content.subject;
  put(cfg, 'body', dto.content.body);

  put(cfg, 'mailConfigId', dto.sender?.mailConfigId);
  put(cfg, 'pecReserveMailConfigId', dto.sender?.pecReserveMailConfigId);
  put(cfg, 'ioServiceId', dto.sender?.ioServiceId);

  if (dto.appIoParallel) {
    cfg['secondaryChannels'] = [
      { channel: 'APP_IO', mode: 'parallel', subjectOverride: dto.appIoParallel.subject, bodyOverride: dto.appIoParallel.body },
    ];
  }

  if (dto.channel === 'SEND') {
    cfg['protocolla'] = true;
    cfg['taxonomyCode'] = dto.send!.taxonomyCode;
    put(cfg, 'physicalCommunicationType', defaults.physicalCommunicationType);
  }

  if (dto.channel === 'POSTAL') {
    const p = dto.postal ?? {};
    put(cfg, 'postalServiceType', defaults.postalServiceType);
    put(cfg, 'postalCodiceContratto', p.contractCode);
    put(cfg, 'postalReturnReceipt', p.returnReceipt);
    put(cfg, 'postalColorPrint', p.color);
    put(cfg, 'postalDuplex', p.duplex);
    put(cfg, 'postalIdCoverPage', p.coverPageId);
    put(cfg, 'postalAgolTipoNotificante', p.agol?.notifierType);
    put(cfg, 'postalAgolSecondoTentativo', p.agol?.secondAttempt);
    put(cfg, 'postalAgolNomeNotificante', p.agol?.notifierName);
    put(cfg, 'postalAgolNumeroCronologico', p.agol?.chronologicalNumber);
  }

  const extraData: Record<string, string> = {};
  const a = dto.recipient.address;
  if (a) {
    cfg['physicalAddressConfig'] = {
      enabled: true,
      addressColumn: EXT_COLUMNS.street,
      zipColumn: EXT_COLUMNS.zip,
      municipalityColumn: EXT_COLUMNS.municipality,
      provinceColumn: EXT_COLUMNS.province,
      countryColumn: EXT_COLUMNS.country,
    };
    extraData[EXT_COLUMNS.street] = a.street.trim();
    extraData[EXT_COLUMNS.zip] = (a.zip ?? '').trim();
    extraData[EXT_COLUMNS.municipality] = a.municipality.trim();
    extraData[EXT_COLUMNS.province] = (a.province ?? '').trim().toUpperCase();
    extraData[EXT_COLUMNS.country] = (a.country ?? '').trim();
  }

  if (dto.payment) {
    cfg['paymentConfig'] = {
      enabled: true,
      amountType: 'cents',
      noticeNumberColumn: EXT_COLUMNS.noticeCode,
      amountColumn: EXT_COLUMNS.amountCents,
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: dto.payment.creditorTaxId,
      ...(dto.payment.dueDate ? { dueDateColumn: EXT_COLUMNS.dueDate } : {}),
    };
    extraData[EXT_COLUMNS.noticeCode] = dto.payment.noticeCode;
    extraData[EXT_COLUMNS.amountCents] = String(dto.payment.amountCents);
    if (dto.payment.dueDate) extraData[EXT_COLUMNS.dueDate] = dto.payment.dueDate;
  }

  return {
    channelConfig: cfg,
    recipient: {
      codiceFiscale: dto.recipient.taxId.trim().toUpperCase(),
      fullName: dto.recipient.fullName?.trim() || null,
      email: dto.recipient.email?.trim() || null,
      pec: dto.recipient.pec?.trim() || null,
      extraData,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification.mapper`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-notification.mapper.ts apps/backend/src/external-api/external-notification.mapper.spec.ts
git commit -m "feat(external-api): mapping DTO v2 su channelConfig e destinatario"
```

---

### Task 7: Store idempotenza su Redis

**Files:**
- Create: `apps/backend/src/external-api/external-idempotency.store.ts`
- Create: `apps/backend/src/external-api/external-idempotency.store.spec.ts`

**Interfaces:**
- Produces:
  - `type IdempotencyBegin = { kind: 'new' } | { kind: 'replay'; response: unknown } | { kind: 'conflict' } | { kind: 'in_progress' }`
  - `ExternalIdempotencyStore.begin(clientId: string, key: string, requestHash: string): Promise<IdempotencyBegin>`
  - `ExternalIdempotencyStore.complete(clientId: string, key: string, requestHash: string, response: unknown): Promise<void>`
  - `ExternalIdempotencyStore.release(clientId: string, key: string): Promise<void>`
  - `function hashRequest(body: unknown): string` (sha256 di JSON con chiavi ordinate)
  - Costruttore: `new ExternalIdempotencyStore(redis: IdempotencyRedis)`, dove `IdempotencyRedis = Pick<Redis, 'set' | 'get' | 'del'>`; provider Nest `EXTERNAL_IDEMPOTENCY_REDIS`.

- [ ] **Step 1: Write the failing test**

```ts
import { ExternalIdempotencyStore, hashRequest } from './external-idempotency.store.js';

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    del: jest.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
}

describe('ExternalIdempotencyStore', () => {
  it('prima richiesta → new; replay dopo complete → stessa risposta', async () => {
    const redis = fakeRedis();
    const store = new ExternalIdempotencyStore(redis as any);
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'new' });
    await store.complete('c1', 'k1', 'h1', { success: true, notificationId: 'n1' });
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'replay', response: { success: true, notificationId: 'n1' } });
  });

  it('stessa chiave con hash diverso → conflict; ancora pending → in_progress', async () => {
    const store = new ExternalIdempotencyStore(fakeRedis() as any);
    await store.begin('c1', 'k1', 'h1');
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'in_progress' });
    expect(await store.begin('c1', 'k1', 'h2')).toEqual({ kind: 'conflict' });
  });

  it('release libera la chiave', async () => {
    const store = new ExternalIdempotencyStore(fakeRedis() as any);
    await store.begin('c1', 'k1', 'h1');
    await store.release('c1', 'k1');
    expect(await store.begin('c1', 'k1', 'h1')).toEqual({ kind: 'new' });
  });

  it('chiavi isolate per client e con TTL 24h, chiave Redis hashata', async () => {
    const redis = fakeRedis();
    const store = new ExternalIdempotencyStore(redis as any);
    await store.begin('c1', 'k1', 'h1');
    expect(await store.begin('c2', 'k1', 'h1')).toEqual({ kind: 'new' });
    const [key, , ex, ttl, nx] = redis.set.mock.calls[0];
    expect(key).toMatch(/^ext:idem:c1:[0-9a-f]{64}$/);
    expect([ex, ttl, nx]).toEqual(['EX', 86400, 'NX']);
  });

  it('hashRequest ignora l\'ordine delle chiavi', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-idempotency.store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { IDEMPOTENCY_TTL_HOURS } from './external-capabilities.service.js';

export const EXTERNAL_IDEMPOTENCY_REDIS = Symbol('EXTERNAL_IDEMPOTENCY_REDIS');
export type IdempotencyRedis = Pick<Redis, 'set' | 'get' | 'del'>;

export type IdempotencyBegin =
  | { kind: 'new' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

interface Entry {
  state: 'pending' | 'done';
  requestHash: string;
  response?: unknown;
}

const TTL_SECONDS = IDEMPOTENCY_TTL_HOURS * 3600;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

/**
 * Un retry del client dopo un timeout non deve creare una seconda notifica
 * (SEND/POSTAL costano). SET NX rende atomica la prenotazione della chiave
 * anche con due richieste concorrenti identiche.
 */
@Injectable()
export class ExternalIdempotencyStore {
  constructor(@Inject(EXTERNAL_IDEMPOTENCY_REDIS) private readonly redis: IdempotencyRedis) {}

  private keyOf(clientId: string, key: string): string {
    return `ext:idem:${clientId}:${createHash('sha256').update(key).digest('hex')}`;
  }

  async begin(clientId: string, key: string, requestHash: string): Promise<IdempotencyBegin> {
    const redisKey = this.keyOf(clientId, key);
    const pending: Entry = { state: 'pending', requestHash };
    const ok = await this.redis.set(redisKey, JSON.stringify(pending), 'EX', TTL_SECONDS, 'NX');
    if (ok === 'OK') return { kind: 'new' };
    const raw = await this.redis.get(redisKey);
    if (!raw) return this.begin(clientId, key, requestHash);
    const entry = JSON.parse(raw) as Entry;
    if (entry.requestHash !== requestHash) return { kind: 'conflict' };
    if (entry.state === 'pending') return { kind: 'in_progress' };
    return { kind: 'replay', response: entry.response };
  }

  async complete(clientId: string, key: string, requestHash: string, response: unknown): Promise<void> {
    const done: Entry = { state: 'done', requestHash, response };
    await this.redis.set(this.keyOf(clientId, key), JSON.stringify(done), 'EX', TTL_SECONDS);
  }

  async release(clientId: string, key: string): Promise<void> {
    await this.redis.del(this.keyOf(clientId, key));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-idempotency.store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-idempotency.store.ts apps/backend/src/external-api/external-idempotency.store.spec.ts
git commit -m "feat(external-api): idempotenza su Redis per POST notifications"
```

---

### Task 8: `CampaignsService` — `fullName` esplicito e firma SEND per `source: 'external'`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:431-445` (`addSingleRecipient`), `:661` (firma SEND)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `addSingleRecipient(campaignId: string, data: { codiceFiscale: string; fullName?: string | null; email?: string | null; pec?: string | null; extraData: Record<string, unknown> }): Promise<Recipient>`
- Produces: `export function isSingleRecipientFlow(campaign: Pick<Campaign, 'channelConfig'>): boolean` (in `campaigns.service.ts`, accanto a `hasPostalArTracking`)

Decisioni sui 4 usi di `wizSingleMode` (spec, sezione "Campagna"):
- `:549` messaggio "Passo 1/3" → irrilevante per l'API (gli allegati sono validati prima); invariato.
- `:661` firma SEND → con `source: 'external'` deve seguire il ramo singolo (warning non bloccante), altrimenti il lancio esterno resterebbe bloccato in attesa del job di verifica massiva. Usa `isSingleRecipientFlow`.
- `:725` skip INAD → resta legato **solo** a `wizSingleMode`: per `source: 'external'` il check INAD gira (D5). Invariato.
- `:1985` classifica download → già escluse da `HAVING COUNT(r.id) > 1`; invariato.

- [ ] **Step 1: Write the failing tests** — append to `campaigns.service.spec.ts`:

```ts
import { isSingleRecipientFlow } from './campaigns.service.js';

describe('isSingleRecipientFlow', () => {
  it('vero per wizard singolo e per campagne API esterna, falso per massive', () => {
    expect(isSingleRecipientFlow({ channelConfig: { wizSingleMode: true } })).toBe(true);
    expect(isSingleRecipientFlow({ channelConfig: { source: 'external' } })).toBe(true);
    expect(isSingleRecipientFlow({ channelConfig: {} })).toBe(false);
  });
});
```

Per `addSingleRecipient`, aggiungere un test nel `describe` del file che già costruisce `CampaignsService` con `recipientRepo` mockato (cercare `describe('CampaignsService.getExternalDeliveryStatus'` per lo schema di setup e copiarne il `beforeEach`):

```ts
  it('addSingleRecipient salva fullName esplicito, senza leggerlo da extraData', async () => {
    await service.addSingleRecipient('c1', {
      codiceFiscale: 'RSSMRA80A01H501U',
      fullName: 'ROSSI MARIO',
      extraData: { _extStreet: 'Via Roma 1' },
    });
    expect(recipientRepo.create).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'ROSSI MARIO', extraData: { _extStreet: 'Via Roma 1' } }));
  });
```

(`recipientRepo.create` deve essere `jest.fn((x) => x)` e `save` `jest.fn(async (x) => x)` nel mock; aggiungerli se il setup copiato non li ha.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec -t "isSingleRecipientFlow|addSingleRecipient"`
Expected: FAIL — `isSingleRecipientFlow` non esportata; `fullName` `null`.

- [ ] **Step 3: Implement**

Accanto a `hasPostalArTracking` (riga ~102):

```ts
/**
 * Un solo destinatario per costruzione: wizard "invio singolo" o API esterna.
 * Usato per i controlli che in massivo sono bloccanti (es. verifica firma SEND
 * via job BullMQ) e su un destinatario solo vanno fatti in linea. NON per lo
 * skip INAD: quello resta legato a wizSingleMode, l'API esterna dirotta come
 * il lancio UI.
 */
export function isSingleRecipientFlow(campaign: Pick<Campaign, 'channelConfig'>): boolean {
  return campaign.channelConfig?.['wizSingleMode'] === true || campaign.channelConfig?.['source'] === 'external';
}
```

Riga ~661: sostituire

```ts
      const isWizSingleModeForSignature = campaign.channelConfig?.['wizSingleMode'] === true;
      if (isWizSingleModeForSignature) {
```

con

```ts
      if (isSingleRecipientFlow(campaign)) {
```

`addSingleRecipient`:

```ts
  async addSingleRecipient(
    campaignId: string,
    data: { codiceFiscale: string; fullName?: string | null; email?: string | null; pec?: string | null; extraData: Record<string, unknown> },
  ): Promise<Recipient> {
    const recipient = this.recipientRepo.create({
      campaignId,
      codiceFiscale: data.codiceFiscale,
      email: data.email ?? null,
      pec: data.pec ?? null,
      fullName: data.fullName ?? null,
      extraData: data.extraData,
      status: RecipientStatus.PENDING,
    });
    return this.recipientRepo.save(recipient);
  }
```

Verificare con `grep -rn "addSingleRecipient" apps/backend/src` che l'unico altro chiamante sia `external-api.service.ts` (eliminato in Task 12); se altri chiamanti passano `extraData.full_name`, passare `fullName: extraData['full_name']` esplicitamente da lì.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service`
Expected: PASS (nessun nuovo fallimento nel file).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "refactor(campaigns): fullName esplicito e firma SEND in linea per API esterna"
```

---

### Task 9: `ExternalNotificationsService.create`

**Files:**
- Create: `apps/backend/src/external-api/external-notifications.service.ts`
- Create: `apps/backend/src/external-api/external-notifications.service.spec.ts`

**Interfaces:**
- Consumes: `validateCreateNotification`, `CreateNotificationDto` (T4), `ExternalCapabilitiesService` (T5), `mapNotification` (T6), `ExternalIdempotencyStore`, `hashRequest` (T7), `CampaignsService.create/setExternalClientId/updateDraft/addSingleRecipient/launch` (T8), `ExternalAttachmentTokensService.resolve/markConsumed`, `AuditLogsService.log`, `getUploadsDir`.
- Produces: `ExternalNotificationsService.create(body: unknown, client: ExternalApiClient, idempotencyKey: string | undefined): Promise<{ success: true; notificationId: string; status: 'accepted' }>` — lancia `ExternalApiError` per ogni esito negativo.

- [ ] **Step 1: Write the failing test**

```ts
import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalApiError } from './external-api.error.js';

const client = { id: 'client-1', name: 'Gestionale Tributi' } as any;
const EMAIL_BODY = {
  channel: 'EMAIL',
  externalReference: 'PROT-1',
  recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' },
  content: { subject: 'Avviso TARI 2026', body: '<p>Testo</p>' },
};
const TOKEN = '3fbb1e2a-1234-4abc-9def-426614174000';
const SEND_BODY = {
  channel: 'SEND',
  recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' } },
  content: { subject: 'Notifica atto' },
  attachments: [{ token: TOKEN, label: 'Atto' }],
  send: { taxonomyCode: '010101N' },
};

function setup(opts: { inactive?: boolean; dynamicIssues?: unknown[]; idem?: string; launchBlocked?: boolean; tokenResolves?: boolean } = {}) {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'ext-att-'));
  const src = join(tmp, 'atto.pdf');
  fs.writeFileSync(src, '%PDF-1.4');
  const caps = { channels: {} };
  const capabilities = {
    getCapabilities: jest.fn(async () => caps),
    validate: jest.fn(() => ({ inactiveChannel: !!opts.inactive, issues: opts.dynamicIssues ?? [] })),
    resolveDefaults: jest.fn(() => ({ physicalCommunicationType: 'AR_REGISTERED_LETTER' })),
  };
  const idempotency = {
    begin: jest.fn(async () => (opts.idem ? (opts.idem === 'replay' ? { kind: 'replay', response: { success: true, notificationId: 'old', status: 'accepted' } } : { kind: opts.idem }) : { kind: 'new' })),
    complete: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
  const campaigns = {
    create: jest.fn(async (dto: any) => ({ id: 'camp-1', name: dto.name, channelConfig: dto.channelConfig })),
    setExternalClientId: jest.fn(async () => undefined),
    updateDraft: jest.fn(async () => undefined),
    addSingleRecipient: jest.fn(async () => ({ id: 'rec-1' })),
    launch: jest.fn(async () => (opts.launchBlocked ? { launched: 0, campaignId: 'camp-1', blocked: true, message: 'Quota INAD esaurita' } : { launched: 1, campaignId: 'camp-1' })),
    remove: jest.fn(async () => undefined),
  };
  const tokens = {
    resolve: jest.fn(() => (opts.tokenResolves === false ? null : { path: src, filename: 'atto.pdf' })),
    markConsumed: jest.fn(),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const uploadsRoot = fs.mkdtempSync(join(os.tmpdir(), 'ext-up-'));
  const service = new ExternalNotificationsService(
    capabilities as any, idempotency as any, campaigns as any, tokens as any, audit as any,
    (campaignId: string) => join(uploadsRoot, campaignId),
  );
  return { service, capabilities, idempotency, campaigns, tokens, audit, uploadsRoot };
}

async function errorOf(p: Promise<unknown>): Promise<ExternalApiError> {
  try {
    await p;
  } catch (e) {
    return e as ExternalApiError;
  }
  throw new Error('nessun errore lanciato');
}

describe('ExternalNotificationsService.create', () => {
  it('Idempotency-Key mancante → VALIDATION_ERROR su header', async () => {
    const { service } = setup();
    const e = await errorOf(service.create(EMAIL_BODY, client, undefined));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details).toEqual([{ field: 'Idempotency-Key', message: expect.any(String) }]);
  });

  it('EMAIL: crea campagna source external, destinatario, lancia, audit, risposta accepted', async () => {
    const { service, campaigns, audit, idempotency } = setup();
    const res = await service.create(EMAIL_BODY, client, 'key-1');
    expect(res).toEqual({ success: true, notificationId: 'rec-1', status: 'accepted' });
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: '[API] Gestionale Tributi — PROT-1', channelType: 'EMAIL', channelConfig: expect.objectContaining({ source: 'external' }) }),
      'external:Gestionale Tributi',
    );
    expect(campaigns.setExternalClientId).toHaveBeenCalledWith('camp-1', 'client-1');
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ codiceFiscale: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' }));
    expect(campaigns.launch).toHaveBeenCalledWith('camp-1', { username: 'external-api', role: 'admin' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_API_CREATE', details: { channel: 'EMAIL', externalReference: 'PROT-1', taxId: '***H501U' } }));
    expect(idempotency.complete).toHaveBeenCalledWith('client-1', 'key-1', expect.any(String), res);
  });

  it('replay idempotente → risposta salvata, nessuna nuova campagna', async () => {
    const { service, campaigns } = setup({ idem: 'replay' });
    expect(await service.create(EMAIL_BODY, client, 'key-1')).toEqual({ success: true, notificationId: 'old', status: 'accepted' });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('conflict / in_progress → codici dedicati', async () => {
    expect((await errorOf(setup({ idem: 'conflict' }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await errorOf(setup({ idem: 'in_progress' }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('validazione statica fallita → VALIDATION_ERROR prima di toccare Redis', async () => {
    const { service, idempotency } = setup();
    const e = await errorOf(service.create({ ...EMAIL_BODY, channel: 'FAX' }, client, 'k'));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details!.map((d) => d.field)).toContain('channel');
    expect(idempotency.begin).not.toHaveBeenCalled();
  });

  it('canale inattivo → CHANNEL_INACTIVE; issue dinamiche → VALIDATION_ERROR', async () => {
    expect((await errorOf(setup({ inactive: true }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('CHANNEL_INACTIVE');
    const e = await errorOf(setup({ dynamicIssues: [{ field: 'sender.mailConfigId', message: 'x' }] }).service.create(EMAIL_BODY, client, 'k'));
    expect(e.code).toBe('VALIDATION_ERROR');
  });

  it('SEND: copia allegato, consuma token, salva attachments in channelConfig', async () => {
    const { service, campaigns, tokens, uploadsRoot } = setup();
    await service.create(SEND_BODY, client, 'k');
    expect(fs.existsSync(join(uploadsRoot, 'camp-1', '0_atto.pdf'))).toBe(true);
    expect(tokens.markConsumed).toHaveBeenCalledWith('client-1', TOKEN);
    expect(campaigns.updateDraft).toHaveBeenCalledWith('camp-1', {
      channelConfig: expect.objectContaining({ taxonomyCode: '010101N', protocolla: true, attachments: [{ key: 'allegato_0', label: 'Atto' }] }),
    });
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ extraData: expect.objectContaining({ allegato_0: '0_atto.pdf', _extStreet: 'Via Roma 1' }) }));
  });

  it('token allegato non valido → ATTACHMENT_INVALID, campagna eliminata, chiave rilasciata, token non consumato', async () => {
    const { service, campaigns, tokens, idempotency } = setup({ tokenResolves: false });
    const e = await errorOf(service.create(SEND_BODY, client, 'k'));
    expect(e.code).toBe('ATTACHMENT_INVALID');
    expect(campaigns.remove).toHaveBeenCalledWith('camp-1', { username: 'external-api', role: 'admin' });
    expect(idempotency.release).toHaveBeenCalledWith('client-1', 'k');
    expect(tokens.markConsumed).not.toHaveBeenCalled();
  });

  it('launch bloccato → LAUNCH_BLOCKED con messaggio, chiave rilasciata', async () => {
    const { service, idempotency } = setup({ launchBlocked: true });
    const e = await errorOf(service.create(EMAIL_BODY, client, 'k'));
    expect(e).toMatchObject({ code: 'LAUNCH_BLOCKED', message: 'Quota INAD esaurita' });
    expect(idempotency.release).toHaveBeenCalled();
  });

  it('eccezione inattesa → chiave rilasciata e rilanciata', async () => {
    const { service, campaigns, idempotency } = setup();
    campaigns.addSingleRecipient.mockRejectedValueOnce(new Error('db giù'));
    await expect(service.create(EMAIL_BODY, client, 'k')).rejects.toThrow('db giù');
    expect(idempotency.release).toHaveBeenCalledWith('client-1', 'k');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notifications.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Prima verificare che `CampaignsService` abbia un metodo pubblico per eliminare una bozza: `grep -n "  async remove(" apps/backend/src/campaigns/campaigns.service.ts`. La firma attesa è `remove(id: string, requester: CampaignRequester)`; se diversa, adeguare la chiamata (e il test) alla firma reale.

```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import type { AttachmentConfigEntry } from '../attachments/attachment.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import type { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalIdempotencyStore, hashRequest } from './external-idempotency.store.js';
import { mapNotification } from './external-notification.mapper.js';
import { validateCreateNotification, type CreateNotificationDto } from './dto/create-notification.dto.js';
import { ExternalApiError } from './external-api.error.js';

export const EXTERNAL_UPLOADS_DIR = Symbol('EXTERNAL_UPLOADS_DIR');
const REQUESTER = { username: 'external-api', role: 'admin' as const };

export interface CreateNotificationResult {
  success: true;
  notificationId: string;
  status: 'accepted';
}

@Injectable()
export class ExternalNotificationsService {
  constructor(
    private readonly capabilities: ExternalCapabilitiesService,
    private readonly idempotency: ExternalIdempotencyStore,
    private readonly campaigns: CampaignsService,
    private readonly tokens: ExternalAttachmentTokensService,
    private readonly audit: AuditLogsService,
    @Optional() @Inject(EXTERNAL_UPLOADS_DIR) private readonly uploadsDir: (campaignId: string) => string = getUploadsDir,
  ) {}

  async create(body: unknown, client: ExternalApiClient, idempotencyKey: string | undefined): Promise<CreateNotificationResult> {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', [
        { field: 'Idempotency-Key', message: 'header Idempotency-Key obbligatorio (1-255 caratteri)' },
      ]);
    }

    const { value: dto, issues } = await validateCreateNotification(body);
    if (issues.length) throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', issues);

    const caps = await this.capabilities.getCapabilities();
    const dyn = this.capabilities.validate(dto, caps);
    if (dyn.inactiveChannel) throw new ExternalApiError('CHANNEL_INACTIVE', `Canale ${dto.channel} non configurato su questa istanza`);
    if (dyn.issues.length) throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', dyn.issues);

    const requestHash = hashRequest(body);
    const begin = await this.idempotency.begin(client.id, idempotencyKey, requestHash);
    if (begin.kind === 'replay') return begin.response as CreateNotificationResult;
    if (begin.kind === 'conflict') throw new ExternalApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key già usata con un payload diverso');
    if (begin.kind === 'in_progress') throw new ExternalApiError('IDEMPOTENCY_IN_PROGRESS', 'Richiesta con la stessa Idempotency-Key ancora in elaborazione');

    try {
      const result = await this.createAndLaunch(dto, client, this.capabilities.resolveDefaults(dto, caps));
      await this.idempotency.complete(client.id, idempotencyKey, requestHash, result);
      return result;
    } catch (err) {
      await this.idempotency.release(client.id, idempotencyKey);
      throw err;
    }
  }

  private async createAndLaunch(
    dto: CreateNotificationDto,
    client: ExternalApiClient,
    defaults: { physicalCommunicationType?: string; postalServiceType?: string },
  ): Promise<CreateNotificationResult> {
    const mapped = mapNotification(dto, defaults);
    const campaign = await this.campaigns.create(
      {
        name: `[API] ${client.name} — ${dto.externalReference ?? new Date().toISOString()}`,
        channelType: dto.channel,
        channelConfig: mapped.channelConfig,
      },
      `external:${client.name}`,
    );
    await this.campaigns.setExternalClientId(campaign.id, client.id);

    const extraData: Record<string, unknown> = { ...mapped.recipient.extraData };
    if (dto.attachments?.length) {
      // Risolti tutti prima di copiare/consumare: un token invalido non deve lasciare token già consumati.
      const resolved = dto.attachments.map((ref) => ({ ref, file: this.tokens.resolve(client.id, ref.token) }));
      const missing = resolved.find((r) => !r.file);
      if (missing) {
        await this.campaigns.remove(campaign.id, REQUESTER).catch(() => undefined);
        throw new ExternalApiError('ATTACHMENT_INVALID', `Allegato con token "${missing.ref.token}" non trovato, già usato o scaduto`);
      }
      const destDir = this.uploadsDir(campaign.id);
      fs.mkdirSync(destDir, { recursive: true });
      const attachmentsConfig: AttachmentConfigEntry[] = [];
      resolved.forEach(({ ref, file }, i) => {
        const destFilename = `${i}_${file!.filename}`;
        fs.copyFileSync(file!.path, join(destDir, destFilename));
        this.tokens.markConsumed(client.id, ref.token);
        attachmentsConfig.push({ key: `allegato_${i}`, label: ref.label ?? `Allegato ${i + 1}` });
        extraData[`allegato_${i}`] = destFilename;
      });
      // updateDraft sostituisce channelConfig per intero: spread obbligatorio.
      await this.campaigns.updateDraft(campaign.id, { channelConfig: { ...campaign.channelConfig, attachments: attachmentsConfig } } as any);
    }

    const recipient = await this.campaigns.addSingleRecipient(campaign.id, { ...mapped.recipient, extraData });

    // Requester sintetico admin: il confine di sicurezza è ApiKeyGuard (come v1).
    const launch = await this.campaigns.launch(campaign.id, REQUESTER);
    if (launch.blocked) throw new ExternalApiError('LAUNCH_BLOCKED', launch.message ?? 'Lancio bloccato');

    await this.audit.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: `external:${client.name}`,
      action: 'EXTERNAL_API_CREATE',
      details: { channel: dto.channel, externalReference: dto.externalReference ?? null, taxId: `***${mapped.recipient.codiceFiscale.slice(-4)}` },
    });

    return { success: true, notificationId: recipient.id, status: 'accepted' };
  }
}
```

Il test passa `externalReference: 'PROT-1'`; per un body senza `externalReference` l'audit registra `externalReference: null` — allineare l'assert del test EMAIL se si aggiunge un caso senza riferimento.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notifications.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-notifications.service.ts apps/backend/src/external-api/external-notifications.service.spec.ts
git commit -m "feat(external-api): creazione notifica v2 con idempotenza e validazione"
```

---

### Task 10: Builder puro di stato/esito/eventi

**Files:**
- Create: `apps/backend/src/external-api/external-notification-status.ts`
- Create: `apps/backend/src/external-api/external-notification-status.spec.ts`

**Interfaces:**
- Consumes: `postalLegalOutcome` (`campaigns/postal-legal-outcome.util.ts`), `sendLegalDateOf` (`campaigns/send-legal-date.util.ts`), `hasPostalArTracking` (`campaigns/campaigns.service.ts`), `isPartitaIva` (`channels/tax-id.util.ts`).
- Produces:
  - `interface StatusInput { recipient: { id; createdAt: Date; status: string; codiceFiscale: string; inadCheck: Recipient['inadCheck'] }; campaign: { status: string; channelType: string; channelConfig: Record<string, unknown> }; attempt: NotificationAttemptLike | null; poste: { status: string; outcomeAt: Date | null; movements?: unknown } | null }`
  - `type NotificationAttemptLike = Pick<NotificationAttempt, 'status' | 'channelType' | 'sentAt' | 'errorMessage' | 'iun' | 'sendStatus' | 'sendStatusHistory' | 'protocolNumber' | 'protocolYear' | 'protocolledAt' | 'postalTrackingId' | 'postalStatus' | 'postalStatusHistory' | 'postalDeliveryStatus' | 'postalDeliveryDate' | 'costCents' | 'responsePayload'>`
  - `function buildNotificationStatus(input: StatusInput): NotificationStatusResponse`
  - `NotificationStatusResponse` (shape della spec, sezione "Stato")

- [ ] **Step 1: Write the failing test**

```ts
import { buildNotificationStatus, type StatusInput } from './external-notification-status.js';

const T0 = new Date('2026-10-01T10:00:00Z');
const T1 = new Date('2026-10-01T10:05:00Z');

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null },
    campaign: { status: 'completed', channelType: 'EMAIL', channelConfig: { source: 'external', externalReference: 'PROT-1' } },
    attempt: null,
    poste: null,
    ...over,
  };
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    status: 'success', channelType: 'EMAIL', sentAt: T1, errorMessage: null, iun: null, sendStatus: null, sendStatusHistory: null,
    protocolNumber: null, protocolYear: null, protocolledAt: null, postalTrackingId: null, postalStatus: null, postalStatusHistory: null,
    postalDeliveryStatus: null, postalDeliveryDate: null, costCents: null, responsePayload: null,
    ...over,
  } as any;
}

describe('buildNotificationStatus', () => {
  it('nessun attempt → accepted, evento accepted', () => {
    const s = buildNotificationStatus(input({ campaign: { status: 'queued', channelType: 'EMAIL', channelConfig: {} } }));
    expect(s).toEqual(expect.objectContaining({
      success: true, notificationId: 'rec-1', externalReference: null, requestedChannel: 'EMAIL', effectiveChannel: 'EMAIL',
      diversion: null, status: 'accepted', error: null, costCents: null,
    }));
    expect(s.events.map((e) => e.type)).toEqual(['accepted']);
    expect(s).not.toHaveProperty('legal');
    expect(s).not.toHaveProperty('send');
  });

  it('campagna checking_inad → checking; destinatario pending_review → pending_review', () => {
    expect(buildNotificationStatus(input({ campaign: { status: 'checking_inad', channelType: 'PEC', channelConfig: {} } })).status).toBe('checking');
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'pending_review', codiceFiscale: '01234567890',
        inadCheck: { found: true, diverted: true, originalChannel: 'PEC', originalAddress: 'vecchia@pec.it', foundAddress: 'nuova@pec.it', checkedAt: T1.toISOString() } },
      campaign: { status: 'running', channelType: 'PEC', channelConfig: {} },
    }));
    expect(s.status).toBe('pending_review');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'pending_review']);
  });

  it('EMAIL inviata → sent, mai delivered', () => {
    const s = buildNotificationStatus(input({ attempt: attempt() }));
    expect(s.status).toBe('sent');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'sent']);
  });

  it('attempt queued → in_progress; failed → failed con errore', () => {
    expect(buildNotificationStatus(input({ attempt: attempt({ status: 'queued', sentAt: null }) })).status).toBe('in_progress');
    const f = buildNotificationStatus(input({ attempt: attempt({ status: 'failed', sentAt: null, errorMessage: 'SMTP 550' }) }));
    expect(f).toEqual(expect.objectContaining({ status: 'failed', error: 'SMTP 550' }));
    expect(f.events.at(-1)).toEqual(expect.objectContaining({ type: 'failed', data: { error: 'SMTP 550' } }));
  });

  it('SEND perfezionata → delivered con IUN, data legale, protocollo, eventi send_status', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'SEND', channelConfig: {} },
      attempt: attempt({
        channelType: 'SEND', iun: 'ABCD-EFGH-IJKL-202610-M-1', sendStatus: 'VIEWED', protocolNumber: 123, protocolYear: 2026, protocolledAt: T0, costCents: 850,
        sendStatusHistory: [
          { status: 'ACCEPTED', activeFrom: '2026-10-01T11:00:00Z' },
          { status: 'VIEWED', activeFrom: '2026-10-03T09:00:00Z' },
        ],
      }),
    }));
    expect(s.status).toBe('delivered');
    expect(s.legal).toEqual({ outcome: 'delivered', at: '2026-10-03T09:00:00Z', reason: 'VIEWED' });
    expect(s.send).toEqual({ iun: 'ABCD-EFGH-IJKL-202610-M-1', status: 'VIEWED', legalDate: '2026-10-03T09:00:00Z', protocol: { number: 123, year: 2026, at: T0.toISOString() } });
    expect(s.costCents).toBe(850);
    expect(s.events.filter((e) => e.type === 'send_status').map((e) => e.data)).toEqual([{ status: 'ACCEPTED' }, { status: 'VIEWED' }]);
  });

  it('SEND UNREACHABLE → not_delivered', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'SEND', channelConfig: {} },
      attempt: attempt({ channelType: 'SEND', sendStatus: 'UNREACHABLE', sendStatusHistory: [{ status: 'UNREACHABLE', activeFrom: '2026-10-05T00:00:00Z' }] }),
    }));
    expect(s.status).toBe('not_delivered');
    expect(s.legal).toEqual({ outcome: 'not_delivered', at: null, reason: 'UNREACHABLE' });
  });

  it('POSTAL Raccomandata AR consegnata → delivered con data consegna', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata', postalReturnReceipt: true } },
      attempt: attempt({ channelType: 'POSTAL', postalTrackingId: 'ID1', postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato a Domicilio', postalDeliveryDate: T1,
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-10-01T12:00:00Z', codiceErrore: '0' }] }),
    }));
    expect(s.status).toBe('delivered');
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Consegnato a Domicilio' });
    expect(s.postal).toEqual({ trackingId: 'ID1', status: 'Consegnato', deliveryStatus: 'Consegnato a Domicilio', deliveryDate: T1.toISOString() });
  });

  it('POSTAL dirottata a PEC da INAD → effectiveChannel PEC, diversion INAD, esito dal ramo dirottato', () => {
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: 'RSSMRA80A01H501U',
        inadCheck: { found: true, diverted: true, originalChannel: 'POSTAL', originalAddress: null, checkedAt: T0.toISOString() } },
      campaign: { status: 'completed', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata' } },
      attempt: attempt({ channelType: 'PEC' }),
    }));
    expect(s.requestedChannel).toBe('POSTAL');
    expect(s.effectiveChannel).toBe('PEC');
    expect(s.diversion).toEqual({ source: 'INAD' });
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Via PEC' });
    expect(s.status).toBe('delivered');
    expect(s).not.toHaveProperty('postal');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'diverted', 'sent']);
  });

  it('PG dirottata → diversion REGISTRO_IMPRESE', () => {
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: '01234567890',
        inadCheck: { found: true, diverted: true, originalChannel: 'EMAIL', originalAddress: 'a@b.it', checkedAt: T0.toISOString() } },
      attempt: attempt({ channelType: 'PEC' }),
    }));
    expect(s.diversion).toEqual({ source: 'REGISTRO_IMPRESE' });
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Via PEC' });
    expect(s.status).toBe('delivered');
  });

  it('App IO parallela riportata dal responsePayload', () => {
    const s = buildNotificationStatus(input({ campaign: { status: 'completed', channelType: 'EMAIL', channelConfig: { secondaryChannels: [{ channel: 'APP_IO' }] } }, attempt: attempt({ responsePayload: { appIo: { success: true } } }) }));
    expect(s.appIoParallel).toEqual({ success: true });
  });

  it('id evento stabile tra due letture, eventi ordinati per at', () => {
    const i = input({ attempt: attempt() });
    const a = buildNotificationStatus(i).events;
    const b = buildNotificationStatus(i).events;
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a.map((e) => e.at)).toEqual([...a.map((e) => e.at)].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification-status.spec`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'crypto';
import { postalLegalOutcome, type PostalLegalOutcome } from '../campaigns/postal-legal-outcome.util.js';
import { sendLegalDateOf } from '../campaigns/send-legal-date.util.js';
import { hasPostalArTracking } from '../campaigns/campaigns.service.js';
import { isPartitaIva } from '../channels/tax-id.util.js';
import type { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import type { Recipient } from '../entities/recipient.entity.js';

export type NotificationAttemptLike = Pick<
  NotificationAttempt,
  | 'status' | 'channelType' | 'sentAt' | 'errorMessage' | 'iun' | 'sendStatus' | 'sendStatusHistory'
  | 'protocolNumber' | 'protocolYear' | 'protocolledAt' | 'postalTrackingId' | 'postalStatus'
  | 'postalStatusHistory' | 'postalDeliveryStatus' | 'postalDeliveryDate' | 'costCents' | 'responsePayload'
>;

export interface StatusInput {
  recipient: { id: string; createdAt: Date; status: string; codiceFiscale: string; inadCheck: Recipient['inadCheck'] };
  campaign: { status: string; channelType: string; channelConfig: Record<string, unknown> };
  attempt: NotificationAttemptLike | null;
  poste: { status: string; outcomeAt: Date | null } | null;
}

export type NotificationStatus = 'accepted' | 'checking' | 'pending_review' | 'in_progress' | 'sent' | 'delivered' | 'not_delivered' | 'failed' | 'cancelled';

export interface NotificationEvent { id: string; type: string; at: string; data: Record<string, unknown> }

export interface NotificationStatusResponse {
  success: true;
  notificationId: string;
  externalReference: string | null;
  createdAt: string;
  requestedChannel: string;
  effectiveChannel: string;
  diversion: { source: 'INAD' | 'REGISTRO_IMPRESE' } | null;
  status: NotificationStatus;
  legal?: { outcome: PostalLegalOutcome; at: string | null; reason: string | null };
  send?: { iun: string | null; status: string | null; legalDate: string | null; protocol: { number: number; year: number; at: string | null } | null };
  postal?: { trackingId: string | null; status: string | null; deliveryStatus: string | null; deliveryDate: string | null };
  appIoParallel?: { success: boolean };
  costCents: number | null;
  error: string | null;
  events: NotificationEvent[];
}

const SEND_NOT_DELIVERED = ['UNREACHABLE', 'CANCELLED', 'REFUSED'];
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function event(type: string, at: string, data: Record<string, unknown> = {}): NotificationEvent {
  const id = createHash('sha1').update(`${type}|${at}|${JSON.stringify(data)}`).digest('hex');
  return { id, type, at, data };
}

export function buildNotificationStatus(input: StatusInput): NotificationStatusResponse {
  const { recipient, campaign, attempt } = input;
  const cfg = campaign.channelConfig ?? {};
  const diverted = !!recipient.inadCheck?.diverted && recipient.status !== 'pending_review';
  const effectiveChannel = attempt?.channelType ?? campaign.channelType;

  // --- esito legale: POSTAL, SEND e qualunque canale dirottato a PEC ---
  // (il ramo `diverted` di postalLegalOutcome è indipendente dal canale di partenza)
  let legal: NotificationStatusResponse['legal'];
  if (campaign.channelType === 'POSTAL' || (diverted && campaign.channelType !== 'SEND')) {
    const r = postalLegalOutcome({
      diverted,
      arTracking: hasPostalArTracking({ channelConfig: cfg }),
      attempt: attempt
        ? { status: attempt.status, postalStatus: attempt.postalStatus, postalDeliveryStatus: attempt.postalDeliveryStatus, postalDeliveryDate: attempt.postalDeliveryDate, sentAt: attempt.sentAt, errorMessage: attempt.errorMessage, postalStatusHistory: attempt.postalStatusHistory }
        : null,
      poste: input.poste,
    });
    legal = { outcome: r.outcome, at: iso(r.at), reason: r.reason };
  } else if (campaign.channelType === 'SEND' && attempt) {
    const legalDate = sendLegalDateOf(attempt.sendStatusHistory);
    if (attempt.status === 'failed') legal = { outcome: 'not_delivered', at: null, reason: attempt.errorMessage ?? 'Invio fallito' };
    else if (legalDate) legal = { outcome: 'delivered', at: legalDate, reason: attempt.sendStatus };
    else if (attempt.sendStatus && SEND_NOT_DELIVERED.includes(attempt.sendStatus)) legal = { outcome: 'not_delivered', at: null, reason: attempt.sendStatus };
    else legal = { outcome: 'in_progress', at: null, reason: attempt.sendStatus };
  }

  // --- errore (regola v1) ---
  let error: string | null = null;
  if (attempt?.status === 'failed') error = attempt.errorMessage ?? 'Invio fallito';
  else if (attempt?.channelType === 'POSTAL') {
    const last = [...(attempt.postalStatusHistory ?? [])].reverse().find((h) => h.codiceErrore && h.codiceErrore !== '0');
    if (last) error = last.descrizione ? `${last.codiceErrore}: ${last.descrizione}` : last.codiceErrore ?? null;
  }

  // --- status riassuntivo ---
  let status: NotificationStatus;
  if (recipient.status === 'pending_review') status = 'pending_review';
  else if (!attempt) status = campaign.status === 'checking_inad' ? 'checking' : campaign.status === 'cancelled' ? 'cancelled' : 'accepted';
  else if (attempt.status === 'failed') status = 'failed';
  else if (attempt.status === 'cancelled') status = 'cancelled';
  else if (attempt.status === 'queued' || attempt.status === 'processing') status = 'in_progress';
  else if (legal?.outcome === 'delivered') status = 'delivered';
  else if (legal?.outcome === 'not_delivered') status = 'not_delivered';
  else status = 'sent';

  // --- eventi derivati ---
  const events: NotificationEvent[] = [event('accepted', recipient.createdAt.toISOString())];
  const checkedAt = recipient.inadCheck?.checkedAt;
  if (recipient.status === 'pending_review' && checkedAt) events.push(event('pending_review', checkedAt));
  else if (diverted && checkedAt) events.push(event('diverted', checkedAt, { to: 'PEC' }));
  if (attempt?.protocolledAt) events.push(event('protocolled', attempt.protocolledAt.toISOString(), { number: attempt.protocolNumber, year: attempt.protocolYear }));
  if (attempt?.sentAt) events.push(event('sent', attempt.sentAt.toISOString(), { channel: attempt.channelType }));
  for (const h of attempt?.sendStatusHistory ?? []) events.push(event('send_status', new Date(h.activeFrom).toISOString(), { status: h.status }));
  for (const h of attempt?.postalStatusHistory ?? []) {
    events.push(event('postal_status', new Date(h.rilevatoIl).toISOString(), { stato: h.stato, ...(h.codiceErrore && h.codiceErrore !== '0' ? { codiceErrore: h.codiceErrore } : {}) }));
  }
  if (input.poste?.outcomeAt) events.push(event('poste_tracking', input.poste.outcomeAt.toISOString(), { status: input.poste.status }));
  if (attempt?.status === 'failed') events.push(event('failed', (attempt.sentAt ?? recipient.createdAt).toISOString(), { error }));
  events.sort((a, b) => a.at.localeCompare(b.at));

  const response: NotificationStatusResponse = {
    success: true,
    notificationId: recipient.id,
    externalReference: (cfg['externalReference'] as string | undefined) ?? null,
    createdAt: recipient.createdAt.toISOString(),
    requestedChannel: campaign.channelType,
    effectiveChannel,
    diversion: diverted ? { source: isPartitaIva(recipient.codiceFiscale) ? 'REGISTRO_IMPRESE' : 'INAD' } : null,
    status,
    costCents: attempt?.costCents ?? null,
    error,
    events,
  };
  if (legal) response.legal = legal;
  if (effectiveChannel === 'SEND' && attempt) {
    response.send = {
      iun: attempt.iun,
      status: attempt.sendStatus,
      legalDate: sendLegalDateOf(attempt.sendStatusHistory),
      protocol: attempt.protocolNumber != null && attempt.protocolYear != null ? { number: attempt.protocolNumber, year: attempt.protocolYear, at: iso(attempt.protocolledAt) } : null,
    };
  }
  if (effectiveChannel === 'POSTAL' && attempt) {
    response.postal = { trackingId: attempt.postalTrackingId, status: attempt.postalStatus, deliveryStatus: attempt.postalDeliveryStatus, deliveryDate: iso(attempt.postalDeliveryDate) };
  }
  if (Array.isArray(cfg['secondaryChannels']) && attempt) {
    response.appIoParallel = { success: !!(attempt.responsePayload?.['appIo'] as { success?: boolean } | undefined)?.success };
  }
  return response;
}
```

Nota spec: `diversion` nella spec mostra anche `address`; la PEC trovata NON è persistita in `inadCheck` per i dirottamenti applicati (solo `foundAddress` per il caso review). Per non esporre un dato inesistente il builder restituisce solo `source`. Aggiornare la spec in Task 13 (`diversion: { source }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification-status.spec`
Expected: PASS. Se l'import di `hasPostalArTracking` da `campaigns.service.js` crea un ciclo di import a runtime, spostare `hasPostalArTracking` in `campaigns/postal-legal-outcome.util.ts` (riesportarla da `campaigns.service.ts` per i chiamanti esistenti).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-notification-status.ts apps/backend/src/external-api/external-notification-status.spec.ts
git commit -m "feat(external-api): stato notifica v2 con esito legale ed eventi"
```

---

### Task 11: `ExternalNotificationStatusService` (caricamento dati)

**Files:**
- Create: `apps/backend/src/external-api/external-notification-status.service.ts`
- Create: `apps/backend/src/external-api/external-notification-status.service.spec.ts`

**Interfaces:**
- Consumes: `buildNotificationStatus` (T10), repository TypeORM `Recipient`, `Campaign`, `NotificationAttempt`, `PostalPosteTracking`.
- Produces: `ExternalNotificationStatusService.get(notificationId: string, clientId: string): Promise<NotificationStatusResponse>` — `ExternalApiError('NOT_FOUND', 'Notifica non trovata')` se inesistente, di altro client o id non UUID.

- [ ] **Step 1: Write the failing test**

```ts
import { ExternalNotificationStatusService } from './external-notification-status.service.js';

const REC_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function setup(opts: { recipient?: unknown; campaign?: unknown; attempts?: unknown[]; poste?: unknown } = {}) {
  const recipientRepo = { findOne: jest.fn(async () => opts.recipient ?? null) };
  const campaignRepo = { findOneBy: jest.fn(async () => opts.campaign ?? null) };
  const attemptRepo = { find: jest.fn(async () => opts.attempts ?? []) };
  const posteRepo = { findOne: jest.fn(async () => opts.poste ?? null) };
  const svc = new ExternalNotificationStatusService(recipientRepo as any, campaignRepo as any, attemptRepo as any, posteRepo as any);
  return { svc, recipientRepo, attemptRepo, posteRepo };
}

const recipient = { id: REC_ID, campaignId: 'camp-1', createdAt: new Date('2026-10-01T10:00:00Z'), status: 'sent', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null };

describe('ExternalNotificationStatusService.get', () => {
  it('id non UUID → NOT_FOUND senza query', async () => {
    const { svc, recipientRepo } = setup();
    await expect(svc.get('../x', 'client-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(recipientRepo.findOne).not.toHaveBeenCalled();
  });

  it('destinatario di un altro client → stesso NOT_FOUND', async () => {
    const { svc } = setup({ recipient, campaign: { id: 'camp-1', externalClientId: 'altro', status: 'completed', channelType: 'EMAIL', channelConfig: {} } });
    await expect(svc.get(REC_ID, 'client-1')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Notifica non trovata' });
  });

  it('usa l\'attempt con attemptNumber più alto e la verifica Poste di quell\'attempt', async () => {
    const { svc, posteRepo } = setup({
      recipient,
      campaign: { id: 'camp-1', externalClientId: 'client-1', status: 'completed', channelType: 'EMAIL', channelConfig: {} },
      attempts: [
        { id: 'a1', attemptNumber: 1, status: 'failed', channelType: 'EMAIL', sentAt: null, errorMessage: 'x' },
        { id: 'a2', attemptNumber: 2, status: 'success', channelType: 'EMAIL', sentAt: new Date('2026-10-01T10:05:00Z') },
      ],
    });
    const s = await svc.get(REC_ID, 'client-1');
    expect(s.status).toBe('sent');
    expect(posteRepo.findOne).toHaveBeenCalledWith({ where: { attemptId: 'a2' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification-status.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { ExternalApiError } from './external-api.error.js';
import { buildNotificationStatus, type NotificationStatusResponse } from './external-notification-status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ExternalNotificationStatusService {
  constructor(
    @InjectRepository(Recipient) private readonly recipients: Repository<Recipient>,
    @InjectRepository(Campaign) private readonly campaigns: Repository<Campaign>,
    @InjectRepository(NotificationAttempt) private readonly attempts: Repository<NotificationAttempt>,
    @InjectRepository(PostalPosteTracking) private readonly poste: Repository<PostalPosteTracking>,
  ) {}

  async get(notificationId: string, clientId: string): Promise<NotificationStatusResponse> {
    // Stesso errore per id malformato, inesistente o di un altro client: nessuna enumerazione.
    const notFound = new ExternalApiError('NOT_FOUND', 'Notifica non trovata');
    if (!UUID.test(notificationId)) throw notFound;
    const recipient = await this.recipients.findOne({ where: { id: notificationId } });
    if (!recipient) throw notFound;
    const campaign = await this.campaigns.findOneBy({ id: recipient.campaignId });
    if (!campaign || campaign.externalClientId !== clientId) throw notFound;

    const attempts = await this.attempts.find({ where: { recipientId: recipient.id } });
    const latest = attempts.reduce<NotificationAttempt | null>((a, b) => (!a || b.attemptNumber > a.attemptNumber ? b : a), null);
    const poste = latest ? await this.poste.findOne({ where: { attemptId: latest.id } }) : null;

    return buildNotificationStatus({
      recipient: { id: recipient.id, createdAt: recipient.createdAt, status: recipient.status, codiceFiscale: recipient.codiceFiscale, inadCheck: recipient.inadCheck },
      campaign: { status: campaign.status, channelType: campaign.channelType, channelConfig: campaign.channelConfig ?? {} },
      attempt: latest,
      poste: poste ? { status: poste.status, outcomeAt: poste.outcomeAt } : null,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run external-notification-status`
Expected: PASS (builder + service).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/external-api/external-notification-status.service.ts apps/backend/src/external-api/external-notification-status.service.spec.ts
git commit -m "feat(external-api): lettura stato notifica v2 con controllo proprietà"
```

---

### Task 12: Controller `external/v2`, wiring modulo, rimozione v1, test HTTP reale

**Files:**
- Modify: `apps/backend/src/external-api/external-notifications.controller.ts` (riscritto)
- Modify: `apps/backend/src/external-api/external-capabilities.controller.ts` (riscritto)
- Modify: `apps/backend/src/external-api/external-domicilio.controller.ts`
- Create: `apps/backend/src/external-api/dto/cerca-domicilio.dto.ts`
- Modify: `apps/backend/src/external-api/external-attachments.controller.ts:14` (route)
- Modify: `apps/backend/src/external-api/external-api.module.ts`
- Modify: `apps/backend/src/external-api/external-api-http-status.integration.spec.ts` (riscritto per v2)
- Modify: `apps/backend/src/external-api/external-notifications.controller.spec.ts`, `external-capabilities.controller.spec.ts`, `external-domicilio.controller.spec.ts`, `external-attachments.controller.spec.ts` (route/nuove dipendenze)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (rimuovere `getExternalDeliveryStatus` ~3305-3343 e l'import di `ExternalDeliveryStatusDto`), `campaigns/dto/campaign-stats.dto.ts` (rimuovere `ExternalDeliveryStatusDto` ~260-282), `campaigns/campaigns.service.spec.ts` (rimuovere `describe('CampaignsService.getExternalDeliveryStatus'`)
- Delete: `external-api.service.ts`, `external-api.service.spec.ts`, `dto/create-external-notification.dto.ts`, `dto/create-external-notification.dto.spec.ts`, `dto/cerca-domicilio-external.dto.ts`

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: route `GET external/v2/capabilities`, `POST external/v2/domicilio/cerca`, `POST external/v2/attachments/upload/{init,chunk,complete}`, `POST external/v2/notifications`, `GET external/v2/notifications/:notificationId`.

- [ ] **Step 1: Write the failing integration test** — riscrivere `external-api-http-status.integration.spec.ts` mantenendo l'impianto esistente (Test.createTestingModule con controller reali, service mockati, `ValidationPipe` globale identica a `main.ts`) e sostituendo i casi:

```ts
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ExternalNotificationsController } from './external-notifications.controller.js';
import { ExternalAttachmentsController } from './external-attachments.controller.js';
import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { DomicilioService } from '../channels/domicilio/domicilio.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ExternalApiClientsService } from './external-api-clients.service.js';
import { ExternalApiError } from './external-api.error.js';
import { chunkUploadDir } from '../campaigns/chunked-upload.util.js';

/**
 * Boot reale di controller+guard+filter con richieste HTTP vere: intercetta
 * i due gotcha non visibili agli spec unit (201 al posto di 200 su @Post,
 * provider non risolti). Vedi docs/claude/external-api-module.md.
 */
describe('external/v2 — status code contratto HTTP reale (integration)', () => {
  let app: INestApplication;
  const VALID_KEY = 'valid-key-e2e';
  const FAKE_CLIENT = { id: 'client-1', name: 'Test Client HTTP' };
  const createdUploadIds: string[] = [];
  const notifications = { create: jest.fn() };
  const status = { get: jest.fn() };
  const capabilities = { getCapabilities: jest.fn(async () => ({ success: true, channels: {} })) };
  const domicilio = { cercaDomicilio: jest.fn(async (taxId: string) => ({ codiceFiscale: taxId })) };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ExternalNotificationsController, ExternalAttachmentsController, ExternalDomicilioController, ExternalCapabilitiesController],
      providers: [
        ApiKeyGuard,
        {
          provide: ExternalApiClientsService,
          useValue: {
            findActiveByKey: jest.fn(async (k: string) => (k === VALID_KEY ? FAKE_CLIENT : null)),
            touchLastUsed: jest.fn(async () => undefined),
          },
        },
        { provide: ExternalNotificationsService, useValue: notifications },
        { provide: ExternalNotificationStatusService, useValue: status },
        { provide: ExternalCapabilitiesService, useValue: capabilities },
        { provide: ExternalAttachmentTokensService, useValue: { completeUpload: jest.fn(async () => ({ token: 'tok-http-1' })) } },
        { provide: DomicilioService, useValue: domicilio },
        { provide: AuditLogsService, useValue: { log: jest.fn(async () => undefined) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const id of createdUploadIds) fs.rmSync(chunkUploadDir(id), { recursive: true, force: true });
  });

  it('POST /external/v2/notifications → 200, body e Idempotency-Key passati al service senza ValidationPipe globale', async () => {
    notifications.create.mockResolvedValueOnce({ success: true, notificationId: 'rec-1', status: 'accepted' });
    const body = { channel: 'EMAIL', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', unknown: 1 }, content: { subject: 'x', body: 'y' } };
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', VALID_KEY).set('Idempotency-Key', 'k-1').send(body).expect(200);
    expect(res.body).toEqual({ success: true, notificationId: 'rec-1', status: 'accepted' });
    // Il body arriva intatto (campo sconosciuto incluso): la validazione con path completo è del service.
    expect(notifications.create).toHaveBeenCalledWith(body, FAKE_CLIENT, 'k-1');
  });

  it('POST /external/v2/notifications con ExternalApiError → 200 con code/details', async () => {
    notifications.create.mockRejectedValueOnce(new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', [{ field: 'recipient.unknown', message: 'campo non ammesso' }]));
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', VALID_KEY).set('Idempotency-Key', 'k-2').send({}).expect(200);
    expect(res.body).toEqual({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details: [{ field: 'recipient.unknown', message: 'campo non ammesso' }] } });
  });

  it('GET /external/v2/notifications/:id → 200; NOT_FOUND resta 200', async () => {
    status.get.mockResolvedValueOnce({ success: true, notificationId: 'rec-1', status: 'sent', events: [] });
    await request(app.getHttpServer()).get('/external/v2/notifications/rec-1').set('X-Api-Key', VALID_KEY).expect(200);
    expect(status.get).toHaveBeenCalledWith('rec-1', 'client-1');
    status.get.mockRejectedValueOnce(new ExternalApiError('NOT_FOUND', 'Notifica non trovata'));
    const res = await request(app.getHttpServer()).get('/external/v2/notifications/x').set('X-Api-Key', VALID_KEY).expect(200);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /external/v2/capabilities → 200', async () => {
    await request(app.getHttpServer()).get('/external/v2/capabilities').set('X-Api-Key', VALID_KEY).expect(200);
  });

  it('POST /external/v2/domicilio/cerca accetta P.IVA → 200', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/domicilio/cerca').set('X-Api-Key', VALID_KEY).send({ taxId: '01234567890' }).expect(200);
    expect(res.body).toEqual({ success: true, codiceFiscale: '01234567890' });
    expect(domicilio.cercaDomicilio).toHaveBeenCalledWith('01234567890', 'external:Test Client HTTP');
  });

  it('POST /external/v2/domicilio/cerca con taxId non valido → VALIDATION_ERROR (200)', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/domicilio/cerca').set('X-Api-Key', VALID_KEY).send({ taxId: '123' }).expect(200);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /external/v2/attachments/upload/init/chunk/complete → 200', async () => {
    const init = await request(app.getHttpServer()).post('/external/v2/attachments/upload/init').set('X-Api-Key', VALID_KEY).send({ filename: 'atto.pdf', totalChunks: 1 }).expect(200);
    createdUploadIds.push(init.body.uploadId);
    await request(app.getHttpServer()).post('/external/v2/attachments/upload/chunk').set('X-Api-Key', VALID_KEY)
      .field('uploadId', init.body.uploadId).field('index', '0').attach('chunk', Buffer.from('%PDF-1.4'), 'chunk').expect(200);
    const done = await request(app.getHttpServer()).post('/external/v2/attachments/upload/complete').set('X-Api-Key', VALID_KEY).send({ uploadId: randomUUID() }).expect(200);
    expect(done.body).toEqual({ success: true, attachmentToken: 'tok-http-1' });
  });

  it('API key non valida → 200 UNAUTHORIZED; route v1 non esiste più', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', 'nope').send({}).expect(200);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    await request(app.getHttpServer()).get('/external/v1/capabilities').set('X-Api-Key', VALID_KEY).expect(404);
  });
});
```

Mantenere i casi path-traversal esistenti su `attachments/upload/{init,chunk,complete}` (copiarli dal file attuale cambiando `v1` → `v2`): proteggono da regressioni di sicurezza.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run external-api-http-status`
Expected: FAIL — import di `ExternalNotificationsService`/route `v2` non trovati.

- [ ] **Step 3: Implement**

`dto/cerca-domicilio.dto.ts`:

```ts
import { IsString, Matches } from 'class-validator';

export class CercaDomicilioDto {
  @IsString()
  @Matches(/^([A-Za-z0-9]{16}|\d{11})$/, { message: 'taxId deve essere un codice fiscale di 16 caratteri o una partita IVA di 11 cifre' })
  taxId!: string;
}
```

`external-domicilio.controller.ts`:

```ts
import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { DomicilioService } from '../channels/domicilio/domicilio.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto.js';

@Controller('external/v2/domicilio')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalDomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /** CF → INAD+App IO+ANPR; P.IVA (11 cifre) → Registro Imprese (smistamento in DomicilioService). */
  @Post('cerca')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioDto, @Req() req: RequestWithApiClient) {
    const taxId = dto.taxId.toUpperCase().trim();
    const operator = `external:${req.apiClient.name}`;
    const result = await this.domicilioService.cercaDomicilio(taxId, operator);
    await this.auditLogsService.log({ operator, action: 'EXTERNAL_DOMICILIO_SEARCH', details: { taxId: `***${taxId.slice(-4)}` } });
    return { success: true, ...result };
  }
}
```

`external-capabilities.controller.ts`:

```ts
import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';

@Controller('external/v2/capabilities')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalCapabilitiesController {
  constructor(private readonly capabilities: ExternalCapabilitiesService) {}

  @Get()
  get() {
    return this.capabilities.getCapabilities();
  }
}
```

`external-notifications.controller.ts`:

```ts
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';

@Controller('external/v2/notifications')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalNotificationsController {
  constructor(
    private readonly notifications: ExternalNotificationsService,
    private readonly status: ExternalNotificationStatusService,
  ) {}

  /**
   * `Record<string, unknown>` (metatype Object) è voluto: la ValidationPipe
   * globale lo salta e la validazione con path completo (`details[].field`)
   * la fa il service — vedi validate-body.util.ts.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() body: Record<string, unknown>, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: RequestWithApiClient) {
    return this.notifications.create(body, req.apiClient, idempotencyKey);
  }

  @Get(':notificationId')
  get(@Param('notificationId') notificationId: string, @Req() req: RequestWithApiClient) {
    return this.status.get(notificationId, req.apiClient.id);
  }
}
```

`external-attachments.controller.ts`: riga 14 → `@Controller('external/v2/attachments/upload')`.

`external-api.module.ts` — sostituire import/provider:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { MailConfigsModule } from '../mail-configs/mail-configs.module.js';
import { IoServicesModule } from '../io-services/io-services.module.js';
import { PostalProvidersModule } from '../postal-providers/postal-providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DomicilioModule } from '../channels/domicilio/domicilio.module.js';
import type { AppConfiguration } from '../config/configuration.js';
import { ExternalApiClientsService } from './external-api-clients.service.js';
import { AdminExternalClientsController } from './admin-external-clients.controller.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { ExternalAttachmentRetentionService } from './external-attachment-retention.service.js';
import { ExternalAttachmentsController } from './external-attachments.controller.js';
import { ExternalNotificationsController } from './external-notifications.controller.js';
import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalIdempotencyStore, EXTERNAL_IDEMPOTENCY_REDIS } from './external-idempotency.store.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExternalApiClient, Recipient, Campaign, NotificationAttempt, PostalPosteTracking]),
    AuditLogsModule,
    CampaignsModule,
    MailConfigsModule,
    IoServicesModule,
    PostalProvidersModule,
    SettingsModule,
    DomicilioModule,
  ],
  controllers: [
    AdminExternalClientsController,
    ExternalAttachmentsController,
    ExternalNotificationsController,
    ExternalCapabilitiesController,
    ExternalDomicilioController,
  ],
  providers: [
    ExternalApiClientsService,
    ExternalAttachmentTokensService,
    ExternalAttachmentRetentionService,
    ExternalCapabilitiesService,
    ExternalIdempotencyStore,
    ExternalNotificationsService,
    ExternalNotificationStatusService,
    {
      // Stesso pattern di OidcFlowService: client ioredis dedicato, lazyConnect.
      provide: EXTERNAL_IDEMPOTENCY_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) =>
        new Redis(config.get('redis.url', { infer: true }), { lazyConnect: true, maxRetriesPerRequest: 2 }),
    },
  ],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
```

Verificare che `MailConfigsModule`, `IoServicesModule`, `PostalProvidersModule`, `SettingsModule`, `DomicilioModule`, `CampaignsModule` esportino i service usati (`grep -n "exports" <modulo>`): gotcha noto, un provider non esportato manda il backend in crash-loop al boot senza che nessuno unit test lo intercetti.

Eliminare i file v1 elencati in **Files**. Rimuovere `getExternalDeliveryStatus` e `ExternalDeliveryStatusDto` (e il relativo `describe` nello spec di campaigns). Aggiornare gli spec dei controller (`external-*.controller.spec.ts`) alle nuove dipendenze e route: per i controller sottili sono sufficienti test di delega (es. `create` chiama `notifications.create(body, req.apiClient, 'k')`), la copertura vera è negli spec dei service e nell'integration.

- [ ] **Step 4: Run tests, type-check, boot reale**

Run:
```bash
docker compose exec backend node_modules/.bin/vitest run external-api
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose restart backend
docker compose logs --tail=50 backend
```
Expected: test PASS; tsc senza errori; nei log `Nest application successfully started` e route mappate `{/external/v2/...}`, nessun `UnknownDependenciesException`.

- [ ] **Step 5: Run full suite**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: unico fallimento il noto `app.controller.spec.ts` › `isLdapMock`.

- [ ] **Step 6: Commit**

```bash
git add -A apps/backend/src/external-api apps/backend/src/campaigns
git commit -m "feat(external-api)!: endpoint external/v2, rimozione v1

BREAKING CHANGE: external/v1 rimosso, i client passano a external/v2."
```

---

### Task 13: OpenAPI v2, documentazione, README

**Files:**
- Create: `apps/backend/openapi/external-api-v2.yaml`
- Delete: `apps/backend/openapi/external-api.yaml`
- Modify: `apps/backend/src/external-api/external-attachment-tokens.service.ts:39` (riferimento commento a `external-api-v2.yaml`)
- Modify: `docs/claude/external-api-module.md`
- Modify: `README.md:175-190`
- Modify: `docs/superpowers/specs/2026-10-01-external-api-v2-design.md` (`diversion` = solo `source`)

- [ ] **Step 1: Write the OpenAPI spec** — OpenAPI 3.0.3, `info.version: 2.0.0`, `servers: - url: /api/external/v2`, `security: apiKey (header X-Api-Key)`. Per ogni path della tabella "Contratto" della spec: request/response schema completi, ricavati 1:1 da `CreateNotificationDto` (Task 4), `CapabilitiesResponse` (Task 5), `NotificationStatusResponse` (Task 10), `CercaDomicilioDto` (Task 12). Includere:
  - header `Idempotency-Key` (required) su `POST /notifications`;
  - `components.schemas.ErrorResponse` con l'enum dei 9 codici e `details: array of { field, message, allowed[] }`;
  - esempi `examples` per EMAIL, PEC con App IO parallela, APP_IO, SEND con pagamento (codice `P`), POSTAL Raccomandata AR, POSTAL Agol, destinatario PG — solo dati fittizi (`RSSMRA80A01H501U`, `ROSSI MARIO`, `ACME SRL`, `01234567890`, `example.com`);
  - descrizione delle regole per canale (tabella "Regole di validazione" della spec) nelle `description` dei campi;
  - nota in `info.description`: tutte le risposte HTTP 200, esito in `success`; `status`/`legal` di SEND/POSTAL cambiano per giorni, pollare `GET /notifications/{id}` ed usare `events[].id` per deduplicare.

- [ ] **Step 2: Validate the YAML**

Run:
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}/apps/backend/openapi:/spec" redocly/cli lint /spec/external-api-v2.yaml
```
Expected: nessun errore (warning su `operationId`/`license` accettabili). Se l'immagine non è scaricabile, in alternativa: `docker compose exec backend node -e "require('/app/node_modules/.pnpm/node_modules/yaml')"` non è garantito — in quel caso parse con `node -e "const y=require('js-yaml')..."` solo se presente; altrimenti segnalarlo nel report.

- [ ] **Step 3: Docs** — `docs/claude/external-api-module.md`: sostituire `external/v1/*` con `external/v2/*` nei due gotcha esistenti e aggiungere in fondo:

```markdown
## Contratto v2 — regole da non rompere

- `POST external/v2/notifications` riceve `@Body() body: Record<string, unknown>`:
  metatype Object, la ValidationPipe globale lo salta di proposito. La
  validazione (statica + dinamica contro le capabilities) è in
  `ExternalNotificationsService` via `validateBody()` per avere
  `details[].field` con path completo. Non tipizzare quel `@Body()` con il
  DTO: la pipe globale risponderebbe prima con messaggi senza path.
- Campagne API marcate `channelConfig.source = 'external'`, MAI
  `wizSingleMode`: quel flag salta il check INAD al lancio, l'API deve
  dirottare come il lancio UI. Per i controlli "un solo destinatario" usare
  `isSingleRecipientFlow()`.
- Indirizzo e pagamento passano da colonne `extraData` `_ext*`
  (`EXT_COLUMNS` in `external-notification.mapper.ts`) puntate da
  `physicalAddressConfig`/`paymentConfig`.
- Ogni valore enumerato accettato in creazione deve venire da
  `ExternalCapabilitiesService` (stessa fonte di `/capabilities`).
- `notificationId` = `recipient.id`: un futuro endpoint a lotto crea N
  destinatari e riusa `GET /notifications/{id}` invariato.
- `events[].id` = sha1(type|at|data): stabile, base per un futuro webhook.
```

README (righe 175–190): sostituire l'elenco endpoint con quello v2 (capabilities, domicilio/cerca con CF o P.IVA, attachments, notifications con `Idempotency-Key`, `GET /notifications/{notificationId}`) e il link a `apps/backend/openapi/external-api-v2.yaml`.

Spec: nella sezione "Stato" sostituire `"diversion": { "source": "INAD", "address": "..." }` con `"diversion": { "source": "INAD" }` e la riga esplicativa con "`diversion` da `recipient.inadCheck.diverted`; la fonte è `REGISTRO_IMPRESE` se il taxId è una P.IVA, altrimenti `INAD`. L'indirizzo trovato non è persistito per i dirottamenti applicati e non viene esposto."

- [ ] **Step 4: Commit**

```bash
git add apps/backend/openapi docs/claude/external-api-module.md README.md docs/superpowers/specs/2026-10-01-external-api-v2-design.md apps/backend/src/external-api/external-attachment-tokens.service.ts
git commit -m "docs(external-api): OpenAPI v2, note modulo e README"
```

---

### Task 14: E2E manuale in dev (nessun commit)

**Files:**
- Create (non committato): `apps/backend/src/debug/external-v2-e2e.mjs`

- [ ] **Step 1: Create an API client** — dalla UI admin (`http://localhost:3000`, Impostazioni → Client API esterni) creare un client "E2E v2" e copiare la chiave.

- [ ] **Step 2: Write the script**

```js
// Uso: MSYS_NO_PATHCONV=1 docker compose exec -w /app/apps/backend -e EXT_KEY=<chiave> -e CHANNEL=EMAIL backend node src/debug/external-v2-e2e.mjs
const BASE = 'http://localhost:8080/external/v2';
const KEY = process.env.EXT_KEY;
const CHANNEL = process.env.CHANNEL ?? 'EMAIL';
const H = { 'X-Api-Key': KEY };

async function j(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const body = await res.json();
  console.log(res.status, path, JSON.stringify(body, null, 2));
  return body;
}

async function upload() {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const init = await j('/attachments/upload/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'atto.pdf', totalChunks: 1 }) });
  const fd = new FormData();
  fd.append('uploadId', init.uploadId);
  fd.append('index', '0');
  fd.append('chunk', new Blob([pdf]), 'chunk');
  await j('/attachments/upload/chunk', { method: 'POST', body: fd });
  const done = await j('/attachments/upload/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: init.uploadId }) });
  return done.attachmentToken;
}

const caps = await j('/capabilities');
const address = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };
const bodies = {
  EMAIL: { channel: 'EMAIL', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: process.env.TO ?? 'test@example.com' }, content: { subject: 'Test API v2', body: '<p>Prova invio API esterna v2.</p>' } },
  PEC: { channel: 'PEC', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', pec: process.env.TO ?? 'test@pec.example.com' }, content: { subject: 'Test API v2', body: '<p>Prova invio API esterna v2.</p>' } },
  APP_IO: { channel: 'APP_IO', recipient: { type: 'PF', taxId: process.env.CF ?? 'RSSMRA80A01H501U' }, content: { subject: 'Test API esterna v2', body: '<p>' + 'Prova invio App IO tramite API esterna versione due. '.repeat(3) + '</p>' } },
  SEND: async () => ({ channel: 'SEND', recipient: { type: 'PF', taxId: process.env.CF ?? 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address }, content: { subject: 'Test API v2' }, attachments: [{ token: await upload(), label: 'Atto' }], send: { taxonomyCode: caps.channels.SEND.taxonomies.find((t) => !t.requiresPayment)?.code } }),
  POSTAL: async () => ({ channel: 'POSTAL', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address }, content: { subject: 'Test API v2' }, attachments: [{ token: await upload() }] }),
};
const b = typeof bodies[CHANNEL] === 'function' ? await bodies[CHANNEL]() : bodies[CHANNEL];
const key = `e2e-${Date.now()}`;
const created = await j('/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(b) });
const replay = await j('/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(b) });
console.log('replay identico:', JSON.stringify(created) === JSON.stringify(replay));
if (created.success) {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    await j(`/notifications/${created.notificationId}`);
  }
}
```

- [ ] **Step 3: Run per canale** — `EMAIL`, `PEC`, `APP_IO` (con un CF di test App IO), `SEND` (ambiente test PN). **POSTAL solo con conferma esplicita dell'utente** (GlobalCom reale, costo reale). Verificare per ciascuno: `success: true`, replay identico, stato che avanza (`accepted` → `in_progress` → `sent`), campagna visibile nel backoffice con nome `[API] E2E v2 — …`.

- [ ] **Step 4: Cleanup** — eliminare `apps/backend/src/debug/external-v2-e2e.mjs`; revocare il client "E2E v2" dalla UI. Riportare nel report gli output (senza PII).

---

## Self-review

- **Copertura spec:** contratto/endpoint → T12; capabilities → T5+T12; regole statiche → T4; dinamiche → T5; idempotenza → T7+T9; mapping → T6; destinatario/fullName → T8; `wizSingleMode` 4 usi → T8 (decisioni esplicite); allegati/lancio/audit → T9; fix PG → T2; stato/legal/events → T10+T11; domicilio P.IVA → T12; errori → T3; sicurezza (UUID token, NOT_FOUND unico, audit mascherato, no segreti) → T4/T11/T9/T5; rimozioni v1 → T12; test HTTP → T12; E2E → T14; docs/OpenAPI → T13; tassonomia condivisa → T1.
- **Scostamenti dalla spec (riportati in T13):** `diversion` senza `address` (dato non persistito); le costanti condivise non vengono ancora usate da `postal.strategy.ts`/`send-dispatch.service.ts` (letterali identici, refactor fuori scope).
- **Coerenza tipi:** `validateBody(cls, body)` (T3) usato da `validateCreateNotification(body)` (T4); `CapabilitiesResponse`/`validate`/`resolveDefaults` (T5) usati in T9; `mapNotification(dto, defaults)` (T6) in T9; `ExternalIdempotencyStore.begin/complete/release` (T7) in T9; `buildNotificationStatus(StatusInput)` (T10) in T11; `ExternalNotificationStatusService.get(id, clientId)` (T11) in T12.
