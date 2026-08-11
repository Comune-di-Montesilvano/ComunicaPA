# Registro Imprese via PDND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interrogare il Registro Imprese via PDND (API "PCAD-PDND", Unioncamere) al posto di ANPR/INAD quando il destinatario è una Partita IVA, sia in ricerca singola (`DomicilioService`) sia in verifica bulk campagne (`InadVerifyBulkService`).

**Architecture:** Nuovo `RegistroImpreseService` (mirror di `InadService`/`InipecService`, stesso client PDND condiviso). `DomicilioService` instrada su Partita IVA (11 cifre) verso Registro Imprese invece di ANPR/INAD/App IO. Bulk campagne: nuova coda BullMQ dedicata `registro-imprese-verify` (un job per PIVA, rate limiter + backoff esponenziale su 429), i cui risultati confluiscono nello stesso `InadVerificationJob` esistente — il demone Cron `InadVerifyBulkSyncService` già in uso attende anche il completamento della quota PIVA prima di finalizzare il job.

**Tech Stack:** NestJS 10, TypeORM 0.3, BullMQ 5 (`@nestjs/bullmq` 10), Jest (`--maxWorkers=2` sempre in questo repo), Postgres (colonne jsonb).

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-08-11-registro-imprese-pdnd-design.md`.
- Spec OpenAPI Registro Imprese: `tinn/pdnd/registro imprese/Specifica API.json.json` — hosts collaudo `pdndcl.registroimprese.it`, prod `pdnd.registroimprese.it`; risposta `dettaglio/codicefiscale` è XML opaco (`{type:"string"}`), nessuno schema — parsing minimale (solo `raw`) finché non arriva un test reale, l'API non è ancora abilitata per l'ente.
- 11 cifre numeriche = Partita IVA, 16 alfanumerici = CF persona fisica — nessun altro criterio.
- Auth Registro Imprese: `bearerAuth` standard via `PdndAuthService.getVoucher(env, purposeId)` — nessun claim `digest` (diverso da ANPR).
- Tutti i test backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza il flag, satura RAM WSL2). Type-check: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Migration nuove vanno SEMPRE aggiunte sia al file `migrations/` sia all'array `migrations` in `database.module.ts` (altrimenti invisibili, nessun errore — vedi CLAUDE.md).
- Bottone/etichetta/badge canale già esistenti non vanno duplicati altrove — non applicabile qui (nessun nuovo canale di invio, solo arricchimento verifica).

---

### Task 1: `isPartitaIva` util

**Files:**
- Create: `apps/backend/src/channels/tax-id.util.ts`
- Test: `apps/backend/src/channels/tax-id.util.spec.ts`

**Interfaces:**
- Produces: `isPartitaIva(value: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/channels/tax-id.util.spec.ts
import { isPartitaIva } from './tax-id.util';

describe('isPartitaIva', () => {
  it('riconosce 11 cifre numeriche come Partita IVA', () => {
    expect(isPartitaIva('12345678901')).toBe(true);
  });

  it('accetta spazi ai bordi', () => {
    expect(isPartitaIva('  12345678901  ')).toBe(true);
  });

  it('rifiuta un CF persona fisica (16 alfanumerici)', () => {
    expect(isPartitaIva('RRANGL74M28R701V')).toBe(false);
  });

  it('rifiuta stringhe con lunghezza diversa da 11', () => {
    expect(isPartitaIva('1234567890')).toBe(false);
    expect(isPartitaIva('123456789012')).toBe(false);
  });

  it('rifiuta 11 caratteri non tutti numerici', () => {
    expect(isPartitaIva('1234567890A')).toBe(false);
  });

  it('rifiuta stringa vuota', () => {
    expect(isPartitaIva('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest tax-id.util --maxWorkers=2`
Expected: FAIL — Cannot find module './tax-id.util'

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/src/channels/tax-id.util.ts
/**
 * 11 cifre numeriche = Partita IVA, 16 alfanumerici = CF persona fisica.
 * Nessun caso ambiguo noto — un solo punto di verità, riusato da
 * DomicilioService e InadVerifyBulkService.
 */
export function isPartitaIva(value: string): boolean {
  return /^\d{11}$/.test(value.trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest tax-id.util --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/tax-id.util.ts apps/backend/src/channels/tax-id.util.spec.ts
git commit -m "feat(registro-imprese): util isPartitaIva

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `RegistroImpreseService`

**Files:**
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese-rate-limit.error.ts`
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese.service.ts`
- Test: `apps/backend/src/channels/registro-imprese/registro-imprese.service.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get<T>(key: SettingKey): Promise<T>`, `PdndAuthService.getVoucher(env: PdndEnvironment, purposeId: string): Promise<string>` (già esistenti).
- Produces: `RegistroImpreseRateLimitError` (classe, campo `retryAfterSeconds?: number`), `RegistroImpreseDettaglioResult { found: boolean; raw: string; pec?: string; denominazione?: string }`, `RegistroImpreseService.getVoucher(env): Promise<string>`, `RegistroImpreseService.dettaglioImpresa(partitaIva: string, env?: PdndEnvironment): Promise<RegistroImpreseDettaglioResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese.service.spec.ts
import { Test } from '@nestjs/testing';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSettings = { get: jest.fn(async (key: string) => (key === 'registroImprese.prod.purposeId' ? 'purpose-ri-prod' : undefined)) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('RegistroImpreseService.dettaglioImpresa', () => {
  let service: RegistroImpreseService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        RegistroImpreseService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(RegistroImpreseService);
  });

  it('restituisce found:true e il raw XML quando risponde 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve('<impresa><denominazione>ACME SRL</denominazione></impresa>'),
    });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result).toEqual({ found: true, raw: '<impresa><denominazione>ACME SRL</denominazione></impresa>' });
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-ri-prod');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://pdnd.registroimprese.it/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=12345678901');
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('restituisce found:false su 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('') });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result).toEqual({ found: false, raw: '' });
  });

  it('lancia RegistroImpreseRateLimitError su 429 con Retry-After', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'Retry-After' ? '30' : null) },
      text: () => Promise.resolve('limite superato'),
    });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(RegistroImpreseRateLimitError);
    try {
      await service.dettaglioImpresa('12345678901');
    } catch (err) {
      expect((err as RegistroImpreseRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, text: () => Promise.resolve('non abilitato') });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/Registro Imprese dettaglio fallito: HTTP 401/);
  });

  it('propaga errore se il purposeId non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/purposeId non impostato/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest registro-imprese.service --maxWorkers=2`
Expected: FAIL — Cannot find module './registro-imprese.service'

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese-rate-limit.error.ts
export class RegistroImpreseRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds?: number) {
    super(`Registro Imprese: limite richieste superato${retryAfterSeconds ? ` (riprova tra ${retryAfterSeconds}s)` : ''}`);
    this.name = 'RegistroImpreseRateLimitError';
  }
}
```

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese.service.ts
import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

const REGISTRO_IMPRESE_BASE_URL: Record<PdndEnvironment, string> = {
  test: 'https://pdndcl.registroimprese.it',
  prod: 'https://pdnd.registroimprese.it',
};

export interface RegistroImpreseDettaglioResult {
  found: boolean;
  raw: string;
  pec?: string;
  denominazione?: string;
}

/**
 * Integrazione Registro Imprese (PCAD-PDND, Unioncamere) — sostituisce
 * INIPEC come fonte del domicilio digitale d'impresa. Risposta XML opaca
 * (nessuno schema nello spec OpenAPI, solo {type:"string"}): parsing
 * minimale finché non disponibile un esempio reale (API non ancora
 * abilitata per l'ente al momento di questa implementazione — vedi
 * docs/superpowers/specs/2026-08-11-registro-imprese-pdnd-design.md).
 */
@Injectable()
export class RegistroImpreseService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`registroImprese.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione Registro Imprese (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async dettaglioImpresa(partitaIva: string, env: PdndEnvironment = 'prod'): Promise<RegistroImpreseDettaglioResult> {
    const voucher = await this.getVoucher(env);
    const url = `${REGISTRO_IMPRESE_BASE_URL[env]}/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=${encodeURIComponent(partitaIva)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });
    const text = await response.text();

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new RegistroImpreseRateLimitError(retryAfterSeconds);
    }
    if (response.status === 404) {
      return { found: false, raw: text };
    }
    if (!response.ok) {
      throw new Error(`Registro Imprese dettaglio fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    // Fase 1: schema XML non documentato nello spec OpenAPI. Nessun parsing
    // tipizzato finché non arriva un esempio reale — solo `raw` restituito.
    // pec/denominazione da estrarre qui una volta noto lo schema.
    return { found: true, raw: text };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest registro-imprese.service --maxWorkers=2`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/registro-imprese/registro-imprese.service.ts apps/backend/src/channels/registro-imprese/registro-imprese-rate-limit.error.ts apps/backend/src/channels/registro-imprese/registro-imprese.service.spec.ts
git commit -m "feat(registro-imprese): RegistroImpreseService (dettaglio impresa via PDND)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Settings registry — purposeId Registro Imprese

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts:98-99`

**Interfaces:**
- Produces: chiavi settings `registroImprese.test.purposeId`, `registroImprese.prod.purposeId` (type `SettingKey`).

- [ ] **Step 1: Aggiungi le chiavi**

In `apps/backend/src/settings/settings.registry.ts`, dopo la riga `'inipec.prod.purposeId': { type: 'string', default: '' },` (riga 99):

```ts
  'inipec.test.purposeId': { type: 'string', default: '' },
  'inipec.prod.purposeId': { type: 'string', default: '' },
  // Registro Imprese (PCAD-PDND, Unioncamere) — sostituisce INIPEC come
  // fonte del domicilio digitale d'impresa. Base URL fisse (vedi
  // RegistroImpreseService), solo purposeId configurabile.
  'registroImprese.test.purposeId': { type: 'string', default: '' },
  'registroImprese.prod.purposeId': { type: 'string', default: '' },
```

- [ ] **Step 2: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun nuovo errore.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts
git commit -m "feat(registro-imprese): chiavi settings purposeId PDND

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `RegistroImpreseModule` + branch PIVA in `DomicilioService`

**Files:**
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese.module.ts`
- Modify: `apps/backend/src/channels/domicilio/domicilio.module.ts`
- Modify: `apps/backend/src/channels/domicilio/domicilio.service.ts`
- Modify: `apps/backend/src/channels/domicilio/domicilio.service.spec.ts`

**Interfaces:**
- Consumes: `RegistroImpreseService.dettaglioImpresa(partitaIva): Promise<RegistroImpreseDettaglioResult>` (Task 2), `isPartitaIva(value): boolean` (Task 1).
- Produces: `DomicilioRegistroImpreseResult { success: boolean; found: boolean; pec?: string; denominazione?: string; message?: string }`, `DomicilioSearchResult` esteso con `registroImprese?: DomicilioRegistroImpreseResult` e `inad`/`appIo`/`anpr` ora **opzionali** (assenti per una Partita IVA — non interrogati).

- [ ] **Step 1: Write the failing test**

Aggiungi in fondo a `apps/backend/src/channels/domicilio/domicilio.service.spec.ts` (dentro un nuovo `describe`, dopo l'ultimo test esistente, riga 107):

```ts
describe('DomicilioService.cercaDomicilio — Partita IVA', () => {
  let service: DomicilioService;
  const mockRegistroImprese = { dettaglioImpresa: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
        { provide: RegistroImpreseService, useValue: mockRegistroImprese },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  it('per una Partita IVA interroga solo Registro Imprese, non ANPR/INAD/AppIO', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it', denominazione: 'ACME SRL' });

    const result = await service.cercaDomicilio('12345678901', 'mario.rossi');

    expect(result.codiceFiscale).toBe('12345678901');
    expect(result.registroImprese).toEqual({ success: true, found: true, pec: 'acme@pec.it', denominazione: 'ACME SRL' });
    expect(result.inad).toBeUndefined();
    expect(result.appIo).toBeUndefined();
    expect(result.anpr).toBeUndefined();
    expect(mockInad.extractDigitalAddress).not.toHaveBeenCalled();
    expect(mockIoServices.verifyProfile).not.toHaveBeenCalled();
    expect(mockAnpr.getResidenza).not.toHaveBeenCalled();
  });

  it('gestisce un fallimento di Registro Imprese senza propagare eccezione', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new Error('Registro Imprese: limite richieste superato'));

    const result = await service.cercaDomicilio('12345678901', 'mario.rossi');

    expect(result.registroImprese).toEqual({ success: false, found: false, message: 'Registro Imprese: limite richieste superato' });
  });
});
```

Aggiungi anche l'import in cima al file:

```ts
import { RegistroImpreseService } from '../registro-imprese/registro-imprese.service';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest domicilio.service --maxWorkers=2`
Expected: FAIL — `RegistroImpreseService` non esiste come dipendenza di `DomicilioService` / risultato non contiene `registroImprese`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese.module.ts
import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { RegistroImpreseService } from './registro-imprese.service';

@Module({
  imports: [PdndModule],
  providers: [RegistroImpreseService],
  exports: [RegistroImpreseService],
})
export class RegistroImpreseModule {}
```

Modifica `apps/backend/src/channels/domicilio/domicilio.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { InadModule } from '../inad/inad.module';
import { AnprModule } from '../anpr/anpr.module';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { DomicilioService } from './domicilio.service';
import { DomicilioController } from './domicilio.controller';

// IoServicesService è iniettabile senza importare IoServicesModule: è
// @Global() (vedi io-services.module.ts).
@Module({
  imports: [InadModule, AnprModule, RegistroImpreseModule, AuditLogsModule],
  controllers: [DomicilioController],
  providers: [DomicilioService],
  exports: [DomicilioService],
})
export class DomicilioModule {}
```

Modifica `apps/backend/src/channels/domicilio/domicilio.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InadService, InadDigitalAddressElement } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';
import type { AnprGeneralita, AnprResidenza, AnprInfoSoggettoEnte } from '../anpr/anpr.types';
import { RegistroImpreseService } from '../registro-imprese/registro-imprese.service';
import { isPartitaIva } from '../tax-id.util';

export interface DomicilioInadResult {
  success: boolean;
  found: boolean;
  digitalAddress?: InadDigitalAddressElement[];
  message?: string;
}

export interface DomicilioAppIoResult {
  success: boolean;
  active: boolean;
  message: string;
}

export interface DomicilioAnprResult {
  success: boolean;
  found: boolean;
  idANPR?: string;
  generalita?: AnprGeneralita;
  residenza?: AnprResidenza[];
  infoSoggettoEnte?: AnprInfoSoggettoEnte[];
  message?: string;
}

export interface DomicilioEsistenzaInVitaResult {
  success: boolean;
  dataDecesso?: string;
  message?: string;
}

export interface DomicilioRegistroImpreseResult {
  success: boolean;
  found: boolean;
  pec?: string;
  denominazione?: string;
  message?: string;
}

export interface DomicilioSearchResult {
  codiceFiscale: string;
  // Assenti (non interrogati) quando il valore è una Partita IVA — vedi
  // registroImprese in quel caso.
  inad?: DomicilioInadResult;
  appIo?: DomicilioAppIoResult;
  anpr?: DomicilioAnprResult;
  anprEsistenzaInVita?: DomicilioEsistenzaInVitaResult;
  registroImprese?: DomicilioRegistroImpreseResult;
}

/**
 * Orchestratore "Cerca Domicilio": interroga INAD + App IO + ANPR in
 * parallelo per un CF persona fisica, oppure Registro Imprese (PDND) per una
 * Partita IVA — mai entrambi gli insiemi di fonti per lo stesso input.
 * Nessuna persistenza — query live ogni volta. Un fallimento di una fonte
 * non deve azzerare le altre, quindi ogni ramo cattura il proprio errore
 * invece di propagarlo.
 *
 * ANPR C019 (data decesso) è una finalità PDND separata da C002 — viene
 * interrogata SOLO se C002 ha già segnalato il soggetto deceduto (mai per
 * soggetti in vita), per non consumare quota C019 inutilmente.
 */
@Injectable()
export class DomicilioService {
  constructor(
    private readonly inadService: InadService,
    private readonly ioServicesService: IoServicesService,
    private readonly anprService: AnprService,
    private readonly registroImpreseService: RegistroImpreseService,
  ) {}

  async cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult> {
    if (isPartitaIva(codiceFiscale)) {
      return this.cercaDomicilioImpresa(codiceFiscale);
    }

    const [inad, appIo, anpr] = await Promise.allSettled([
      this.inadService.extractDigitalAddress(codiceFiscale),
      this.ioServicesService.verifyProfile(codiceFiscale),
      this.anprService.getResidenza(codiceFiscale, operatorUsername),
    ]);

    const result: DomicilioSearchResult = {
      codiceFiscale,
      inad:
        inad.status === 'fulfilled'
          ? { success: true, found: inad.value.found, digitalAddress: inad.value.data?.digitalAddress }
          : { success: false, found: false, message: inad.reason?.message ?? 'Errore sconosciuto' },
      appIo:
        appIo.status === 'fulfilled'
          ? appIo.value
          : { success: false, active: false, message: appIo.reason?.message ?? 'Errore sconosciuto' },
      anpr:
        anpr.status === 'fulfilled'
          ? {
              success: true,
              found: anpr.value.found,
              idANPR: anpr.value.data?.idANPR,
              generalita: anpr.value.data?.generalita,
              residenza: anpr.value.data?.residenza,
              infoSoggettoEnte: anpr.value.data?.infoSoggettoEnte,
            }
          : { success: false, found: false, message: anpr.reason?.message ?? 'Errore sconosciuto' },
    };

    const vitaInfo =
      anpr.status === 'fulfilled'
        ? anpr.value.data?.infoSoggettoEnte?.find((i) => (i.chiave ?? '').toLowerCase().includes('vita'))
        : undefined;
    const isDeceduto = anpr.status === 'fulfilled' && anpr.value.found && vitaInfo?.valore === 'N';

    if (isDeceduto) {
      try {
        const esistenza = await this.anprService.getEsistenzaInVita(codiceFiscale, operatorUsername);
        result.anprEsistenzaInVita = { success: true, dataDecesso: esistenza.data?.dataDecesso };
      } catch (error: any) {
        result.anprEsistenzaInVita = { success: false, message: error?.message ?? 'Errore sconosciuto' };
      }
    }

    return result;
  }

  private async cercaDomicilioImpresa(partitaIva: string): Promise<DomicilioSearchResult> {
    try {
      const dettaglio = await this.registroImpreseService.dettaglioImpresa(partitaIva);
      return {
        codiceFiscale: partitaIva,
        registroImprese: { success: true, found: dettaglio.found, pec: dettaglio.pec, denominazione: dettaglio.denominazione },
      };
    } catch (error: any) {
      return {
        codiceFiscale: partitaIva,
        registroImprese: { success: false, found: false, message: error?.message ?? 'Errore sconosciuto' },
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest domicilio.service --maxWorkers=2`
Expected: PASS (7 test — 5 esistenti + 2 nuovi)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/registro-imprese/registro-imprese.module.ts apps/backend/src/channels/domicilio/domicilio.module.ts apps/backend/src/channels/domicilio/domicilio.service.ts apps/backend/src/channels/domicilio/domicilio.service.spec.ts
git commit -m "feat(registro-imprese): branch Partita IVA in DomicilioService

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend admin — pannello risultato Registro Imprese

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1381-1407` (tipo `domicilioResult`)
- Modify: `apps/frontend-admin/src/App.tsx:12463` (render risultato "Cerca Domicilio")

**Interfaces:**
- Consumes: risposta JSON di `POST /admin/domicilio/cerca` = `DomicilioSearchResult` (Task 4) — stessa forma, `inad`/`appIo`/`anpr` ora opzionali, nuovo campo opzionale `registroImprese`.

- [ ] **Step 1: Estendi il tipo `domicilioResult`**

In `apps/frontend-admin/src/App.tsx`, sostituisci il blocco (righe 1381-1407):

```tsx
  const [domicilioResult, setDomicilioResult] = useState<{
    codiceFiscale: string;
    inad: { success: boolean; found: boolean; digitalAddress?: Array<{ digitalAddress: string; practicedProfession?: string }>; message?: string };
    appIo: { success: boolean; active: boolean; message: string };
    anpr: {
```

con:

```tsx
  const [domicilioResult, setDomicilioResult] = useState<{
    codiceFiscale: string;
    registroImprese?: { success: boolean; found: boolean; pec?: string; denominazione?: string; message?: string };
    inad?: { success: boolean; found: boolean; digitalAddress?: Array<{ digitalAddress: string; practicedProfession?: string }>; message?: string };
    appIo?: { success: boolean; active: boolean; message: string };
    anpr?: {
```

(il resto del blocco tipo — `generalita`, `residenza`, `infoSoggettoEnte`, `message` — resta invariato, solo la riga di apertura `anpr:` diventa `anpr?:`).

- [ ] **Step 2: Aggiungi il branch di rendering Registro Imprese**

Nel blocco `{domicilioResult && (() => { ... })()}` (riga 12463), subito dopo la riga `const anpr = domicilioResult.anpr;` aggiungi un early-return per il branch Partita IVA, prima di qualunque uso di `anpr.generalita` ecc.:

```tsx
              {domicilioResult && (() => {
                if (domicilioResult.registroImprese) {
                  const ri = domicilioResult.registroImprese;
                  return (
                    <div className={`card shadow-sm border-0 rounded-3 overflow-hidden ${
                      !ri.success ? 'border-start border-4 border-danger' : !ri.found ? 'border-start border-4 border-secondary' : 'border-start border-4 border-success'
                    }`}>
                      <div className="card-header bg-light bg-gradient py-3 px-4 d-flex align-items-center gap-2 border-bottom-0">
                        {!ri.success ? <AlertCircle className="text-danger" size={18} /> :
                         !ri.found ? <XCircle className="text-secondary" size={18} /> :
                         <CheckCircle2 className="text-success" size={18} />}
                        <h6 className="fw-bold mb-0 text-dark">Registro Imprese</h6>
                      </div>
                      <div className="card-body p-4 bg-white">
                        {!ri.success && <p className="small text-danger mb-0">{ri.message}</p>}
                        {ri.success && !ri.found && <p className="small text-muted mb-0">Nessuna impresa trovata per questa Partita IVA</p>}
                        {ri.success && ri.found && (
                          <div className="d-flex flex-column gap-1">
                            {ri.denominazione && <span className="fw-semibold">{ri.denominazione}</span>}
                            {ri.pec && <span className="small text-muted">PEC: {ri.pec}</span>}
                            {!ri.pec && <span className="small text-muted">Nessun domicilio digitale disponibile</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                const anpr = domicilioResult.anpr!;
```

(la riga originale `const anpr = domicilioResult.anpr;` va sostituita da `const anpr = domicilioResult.anpr!;` dopo l'early-return — il resto del corpo della IIFE, che referenzia `domicilioResult.inad`/`.appIo`/`.anprEsistenzaInVita`, resta invariato: per il branch persona-fisica quei campi sono sempre presenti).

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore (non usare `tsc -b`, vedi CLAUDE.md).

- [ ] **Step 4: Verifica manuale rapida (opzionale, no browser E2E richiesto in questo task)**

Non c'è ancora un backend abilitato per testare una PIVA reale — verificare solo che il type-check passi e che il branch persona-fisica esistente non sia stato alterato (diff limitato all'early-return + tipo opzionali).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(registro-imprese): pannello risultato Partita IVA in Cerca Domicilio

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Migration — colonne PIVA su `inad_verification_jobs`

**Files:**
- Modify: `apps/backend/src/entities/inad-verification-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1786800000000-AddPivaColumnsToInadVerificationJobs.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `InadVerificationJob.pivaTotal: number`, `.pivaDone: number`, `.pivaFoundCount: number`, `.pivaResults: Record<string, string | null>`.

- [ ] **Step 1: Aggiungi le colonne all'entity**

In `apps/backend/src/entities/inad-verification-job.entity.ts`, dopo il campo `notFoundCount` (riga 44):

```ts
  @Column({ name: 'not_found_count', type: 'int', default: 0 })
  notFoundCount!: number;

  /** Totale Partite IVA da verificare via Registro Imprese per questo job (0 se il CSV non ne contiene). */
  @Column({ name: 'piva_total', type: 'int', default: 0 })
  pivaTotal!: number;

  /** Quante verifiche PIVA sono già state completate (aggiornato dal processor Registro Imprese). */
  @Column({ name: 'piva_done', type: 'int', default: 0 })
  pivaDone!: number;

  @Column({ name: 'piva_found_count', type: 'int', default: 0 })
  pivaFoundCount!: number;

  /**
   * Chiave = Partita IVA, valore = PEC trovata o null se non trovata.
   * Scritto SEMPRE con una UPDATE SQL raw che concatena jsonb (mai un
   * read-modify-write sull'intera colonna) — job PIVA paralleli sullo stesso
   * InadVerificationJob altrimenti perderebbero scritture in race.
   */
  @Column({ name: 'piva_results', type: 'jsonb', default: {} })
  pivaResults!: Record<string, string | null>;
```

- [ ] **Step 2: Crea la migration**

```ts
// apps/backend/src/database/migrations/1786800000000-AddPivaColumnsToInadVerificationJobs.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPivaColumnsToInadVerificationJobs1786800000000 implements MigrationInterface {
    name = 'AddPivaColumnsToInadVerificationJobs1786800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_total" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_done" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_found_count" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" ADD "piva_results" jsonb NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_results"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_found_count"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_done"`);
        await queryRunner.query(`ALTER TABLE "inad_verification_jobs" DROP COLUMN "piva_total"`);
    }
}
```

- [ ] **Step 3: Registra la migration**

In `apps/backend/src/database/database.module.ts`, aggiungi l'import dopo `CreateExternalApiClients1786700000000`:

```ts
import { AddPivaColumnsToInadVerificationJobs1786800000000 } from './migrations/1786800000000-AddPivaColumnsToInadVerificationJobs';
```

E aggiungi `AddPivaColumnsToInadVerificationJobs1786800000000` in fondo all'array `migrations: [...]` (dopo `CreateExternalApiClients1786700000000`).

- [ ] **Step 4: Verifica applicando la migration su un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_piva;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_piva" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_piva;"
```

Expected: tutte le migration (incluse quelle esistenti) girano senza errori sul DB pulito.

- [ ] **Step 5: Type-check e applica in dev**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit` — dev usa `synchronize`, le nuove colonne compaiono al prossimo `docker compose restart backend`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/inad-verification-job.entity.ts apps/backend/src/database/migrations/1786800000000-AddPivaColumnsToInadVerificationJobs.ts apps/backend/src/database/database.module.ts
git commit -m "feat(registro-imprese): colonne piva_* su inad_verification_jobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Coda BullMQ `registro-imprese-verify` + processor

**Files:**
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese-job.types.ts`
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese-verify-queue.service.ts`
- Create: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts`
- Test: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts`
- Modify: `apps/backend/src/channels/registro-imprese/registro-imprese.module.ts`

**Interfaces:**
- Consumes: `InadVerificationJob` entity (Task 6, colonne `piva_*`), `RegistroImpreseService.dettaglioImpresa` (Task 2), `RegistroImpreseRateLimitError` (Task 2).
- Produces: `REGISTRO_IMPRESE_QUEUE = 'registro-imprese-verify'`, `VERIFY_PIVA_JOB_NAME = 'verify-piva'`, `RegistroImpreseVerifyJobData { jobId: string; partitaIva: string }`, `RegistroImpreseVerifyQueueService.enqueueVerify(jobId: string, partitaIva: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts
import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';
import { VERIFY_PIVA_JOB_NAME } from './registro-imprese-job.types';

const mockRegistroImprese = { dettaglioImpresa: jest.fn() };
const mockJobRepo = { query: jest.fn() };

describe('RegistroImpreseVerifyProcessor.process', () => {
  let processor: RegistroImpreseVerifyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new RegistroImpreseVerifyProcessor(mockRegistroImprese as any, mockJobRepo as any);
  });

  it('scrive found:true e la PEC su esito positivo', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE inad_verification_jobs'),
      [JSON.stringify({ '12345678901': 'acme@pec.it' }), 1, 'job-1'],
    );
  });

  it('scrive found:false (pec null) quando l\'impresa non è trovata', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: false, raw: '' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.any(String),
      [JSON.stringify({ '12345678901': null }), 0, 'job-1'],
    );
  });

  it('marca not-found (non blocca il job) su un errore generico', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new Error('boom'));

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.any(String),
      [JSON.stringify({ '12345678901': null }), 0, 'job-1'],
    );
  });

  it('rilancia RegistroImpreseRateLimitError (BullMQ deve ritentare con backoff)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new RegistroImpreseRateLimitError(30));

    await expect(
      processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any),
    ).rejects.toThrow(RegistroImpreseRateLimitError);
    expect(mockJobRepo.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest registro-imprese-verify.processor --maxWorkers=2`
Expected: FAIL — Cannot find module './registro-imprese-verify.processor'

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese-job.types.ts
export const REGISTRO_IMPRESE_QUEUE = 'registro-imprese-verify';
export const VERIFY_PIVA_JOB_NAME = 'verify-piva';

export interface RegistroImpreseVerifyJobData {
  jobId: string;
  partitaIva: string;
}
```

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese-verify-queue.service.ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { REGISTRO_IMPRESE_QUEUE, VERIFY_PIVA_JOB_NAME, RegistroImpreseVerifyJobData } from './registro-imprese-job.types';

/**
 * Accoda una verifica Registro Imprese per una singola PIVA. jobId BullMQ =
 * `<InadVerificationJob.id>:<partitaIva>` — dedup naturale, stesso pattern
 * "jobId = attemptId" già in uso per le code di invio (vedi CLAUDE.md).
 * attempts+backoff esponenziale assorbono i 429 senza intervento manuale.
 */
@Injectable()
export class RegistroImpreseVerifyQueueService {
  constructor(@InjectQueue(REGISTRO_IMPRESE_QUEUE) private readonly queue: Queue<RegistroImpreseVerifyJobData>) {}

  async enqueueVerify(jobId: string, partitaIva: string): Promise<void> {
    await this.queue.add(VERIFY_PIVA_JOB_NAME, { jobId, partitaIva }, {
      jobId: `${jobId}:${partitaIva}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
}
```

```ts
// apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { REGISTRO_IMPRESE_QUEUE, VERIFY_PIVA_JOB_NAME, RegistroImpreseVerifyJobData } from './registro-imprese-job.types';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

/**
 * 1 job = 1 Partita IVA. Scrive l'esito con una UPDATE SQL raw che concatena
 * jsonb (mai una read-modify-write sull'intera colonna piva_results — job
 * paralleli sullo stesso InadVerificationJob altrimenti perderebbero
 * scritture in race). Il completamento del job padre (tutti i piva_done
 * raggiunti) è rilevato dal demone Cron InadVerifyBulkSyncService, non qui.
 */
@Injectable()
@Processor(REGISTRO_IMPRESE_QUEUE, { concurrency: 1, limiter: { max: 5, duration: 1000 } })
export class RegistroImpreseVerifyProcessor extends WorkerHost {
  private readonly logger = new Logger(RegistroImpreseVerifyProcessor.name);

  constructor(
    private readonly registroImpreseService: RegistroImpreseService,
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
  ) {
    super();
  }

  async process(job: Job<RegistroImpreseVerifyJobData>): Promise<void> {
    if (job.name !== VERIFY_PIVA_JOB_NAME) return;
    const { jobId, partitaIva } = job.data;

    let pec: string | null = null;
    let found = false;
    try {
      const result = await this.registroImpreseService.dettaglioImpresa(partitaIva);
      found = result.found;
      pec = result.pec ?? null;
    } catch (error) {
      if (error instanceof RegistroImpreseRateLimitError) {
        throw error; // BullMQ ritenta con backoff esponenziale (opts su queue.add)
      }
      this.logger.warn(`Verifica Registro Imprese fallita per ${partitaIva} (job ${jobId}): ${error instanceof Error ? error.message : error}`);
      found = false;
      pec = null;
    }

    await this.jobRepo.query(
      `UPDATE inad_verification_jobs
       SET piva_results = COALESCE(piva_results, '{}'::jsonb) || $1::jsonb,
           piva_done = piva_done + 1,
           piva_found_count = piva_found_count + $2
       WHERE id = $3`,
      [JSON.stringify({ [partitaIva]: pec }), found ? 1 : 0, jobId],
    );
  }
}
```

Aggiorna `apps/backend/src/channels/registro-imprese/registro-imprese.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PdndModule } from '../../pdnd/pdnd.module';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseVerifyQueueService } from './registro-imprese-verify-queue.service';
import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor';
import { REGISTRO_IMPRESE_QUEUE } from './registro-imprese-job.types';

@Module({
  imports: [
    PdndModule,
    TypeOrmModule.forFeature([InadVerificationJob]),
    BullModule.registerQueue({ name: REGISTRO_IMPRESE_QUEUE }),
  ],
  providers: [RegistroImpreseService, RegistroImpreseVerifyQueueService, RegistroImpreseVerifyProcessor],
  exports: [RegistroImpreseService, RegistroImpreseVerifyQueueService],
})
export class RegistroImpreseModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest registro-imprese-verify.processor --maxWorkers=2`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/registro-imprese/registro-imprese-job.types.ts apps/backend/src/channels/registro-imprese/registro-imprese-verify-queue.service.ts apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts apps/backend/src/channels/registro-imprese/registro-imprese.module.ts
git commit -m "feat(registro-imprese): coda BullMQ verifica PIVA + processor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `InadVerifyBulkService` — split CF/PIVA, accoda verifiche Registro Imprese

**Files:**
- Modify: `apps/backend/src/channels/inad/inad-verify-bulk.service.ts`
- Modify: `apps/backend/src/channels/inad/inad.module.ts`
- Test: `apps/backend/src/channels/inad/inad-verify-bulk.service.spec.ts` (nuovo)

**Interfaces:**
- Consumes: `RegistroImpreseVerifyQueueService.enqueueVerify(jobId, partitaIva): Promise<void>` (Task 7), `isPartitaIva(value): boolean` (Task 1).
- Produces: `InadVerifyBulkService.createJob()` ora popola anche `pivaTotal` sul job creato e accoda un job Registro Imprese per ogni PIVA valida trovata nel CSV (prima venivano silenziosamente escluse dalla verifica, finendo comunque in `resultNotFoundCsv` come "non trovate" — bug pre-esistente).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/channels/inad/inad-verify-bulk.service.spec.ts
import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';

const mockJobRepo = {
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => ({ id: 'job-1', ...v })),
  update: jest.fn(),
  findOneBy: jest.fn(),
};
const mockInad = { startBulkExtraction: jest.fn(), getBulkState: jest.fn(), getBulkResult: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };

describe('InadVerifyBulkService.createJob', () => {
  let service: InadVerifyBulkService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InadVerifyBulkService(mockJobRepo as any, mockInad as any, mockRegistroImpreseQueue as any);
  });

  it('smista CF (16 char) su INAD e Partite IVA (11 cifre) su Registro Imprese', async () => {
    const csv = 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n';
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).toHaveBeenCalledWith(['RRANGL74M28R701V'], 'comunicapa-verifica-job-1');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '98765432109');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledTimes(2);
    expect(mockJobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ pivaTotal: 2 }));
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [{ id: 'batch-1', size: 1, done: false }] });
  });

  it('accetta un CSV con sole Partite IVA (nessun CF a 16 char)', async () => {
    const csv = 'cf\n12345678901\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result.jobId).toBe('job-1');
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: InadVerificationJobStatus.PROCESSING, batches: [] });
  });

  it('blocca se non ci sono né CF validi né Partite IVA valide', async () => {
    const csv = 'cf\nnonvalido\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest inad-verify-bulk.service --maxWorkers=2`
Expected: FAIL — costruttore `InadVerifyBulkService` non accetta ancora 3 argomenti / messaggio blocco diverso.

- [ ] **Step 3: Write minimal implementation**

Sostituisci l'intero file `apps/backend/src/channels/inad/inad-verify-bulk.service.ts`:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InadVerificationJob, InadVerificationJobStatus, InadVerificationBatch } from '../../entities/inad-verification-job.entity';
import { parseCsvContent } from '../../io-services/csv.util';
import { InadService } from './inad.service';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service';
import { isPartitaIva } from '../tax-id.util';

const BATCH_SIZE = 1000;

export interface CreateInadBulkVerifyParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
}

export interface CreateInadBulkVerifyResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface InadBulkVerifyStatus {
  status: InadVerificationJobStatus;
  totalRows: number;
  batchesTotal: number;
  batchesDone: number;
  foundCount: number;
  notFoundCount: number;
  errorMessage: string | null;
}

/**
 * Duplicato di AppIoVerifyBulkService ma su INAD (/listDigitalAddress) invece
 * di App IO — stesso schema upload CSV + poll + due CSV risultato, ma
 * l'elaborazione non gira per-riga in un processor BullMQ locale: INAD batcha
 * lato suo (fino a 1000 CF per chiamata, 5-10 minuti), quindi qui si accoda
 * solo la richiesta bulk e il progresso viene sincronizzato da
 * InadVerifyBulkSyncService (demone Cron, stesso pattern di InadCheckSyncService).
 *
 * Le righe a 11 cifre (Partita IVA) non vanno a INAD (nessun dato per
 * imprese) — vengono accodate su registro-imprese-verify (1 job BullMQ per
 * PIVA, rate limiter + backoff su 429). Il job resta PROCESSING finché
 * entrambe le fonti non sono complete (vedi InadVerifyBulkSyncService).
 */
@Injectable()
export class InadVerifyBulkService {
  constructor(
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
  ) {}

  async createJob(params: CreateInadBulkVerifyParams): Promise<CreateInadBulkVerifyResult> {
    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    const rawValues = parsed.rows.map((row) => (row[params.cfColumn] || '').trim().toUpperCase());
    const validCfs = Array.from(new Set(rawValues.filter((v) => v.length === 16)));
    const pivaValues = Array.from(new Set(rawValues.filter((v) => isPartitaIva(v))));
    if (validCfs.length === 0 && pivaValues.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: InadVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      batches: [],
      foundCount: 0,
      notFoundCount: 0,
      pivaTotal: pivaValues.length,
      pivaDone: 0,
      pivaFoundCount: 0,
      pivaResults: {},
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      resultFoundCsv: null,
      resultNotFoundCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    try {
      const batches: InadVerificationBatch[] = [];
      for (let i = 0; i < validCfs.length; i += BATCH_SIZE) {
        const chunk = validCfs.slice(i, i + BATCH_SIZE);
        const { id } = await this.inadService.startBulkExtraction(chunk, `comunicapa-verifica-${saved.id}`);
        batches.push({ id, size: chunk.length, done: false });
      }
      for (const piva of pivaValues) {
        await this.registroImpreseQueue.enqueueVerify(saved.id, piva);
      }
      await this.jobRepo.update(saved.id, { status: InadVerificationJobStatus.PROCESSING, batches });
    } catch (err: any) {
      await this.jobRepo.update(saved.id, {
        status: InadVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<InadBulkVerifyStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      batchesTotal: job.batches.length,
      batchesDone: job.batches.filter((b) => b.done).length,
      foundCount: job.foundCount,
      notFoundCount: job.notFoundCount,
      errorMessage: job.errorMessage,
    };
  }

  async getResultCsv(jobId: string, variant: 'found' | 'notfound'): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== InadVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = variant === 'found' ? job.resultFoundCsv : job.resultNotFoundCsv;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
```

Aggiorna `apps/backend/src/channels/inad/inad.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PdndModule } from '../../pdnd/pdnd.module';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module';
import { InadVerificationJob } from '../../entities/inad-verification-job.entity';
import { InadService } from './inad.service';
import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { InadVerifyBulkSyncService } from './inad-verify-bulk-sync.service';
import { InadVerifyController } from './inad-verify.controller';

@Module({
  imports: [PdndModule, RegistroImpreseModule, TypeOrmModule.forFeature([InadVerificationJob])],
  controllers: [InadVerifyController],
  providers: [InadService, InadVerifyBulkService, InadVerifyBulkSyncService],
  exports: [InadService],
})
export class InadModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest inad-verify-bulk.service --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/inad/inad-verify-bulk.service.ts apps/backend/src/channels/inad/inad-verify-bulk.service.spec.ts apps/backend/src/channels/inad/inad.module.ts
git commit -m "feat(registro-imprese): InadVerifyBulkService smista CF/PIVA, accoda verifiche Registro Imprese

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `InadVerifyBulkSyncService` — attende e fonde la quota PIVA

**Files:**
- Modify: `apps/backend/src/channels/inad/inad-verify-bulk-sync.service.ts`
- Test: `apps/backend/src/channels/inad/inad-verify-bulk-sync.service.spec.ts` (nuovo)

**Interfaces:**
- Consumes: `InadVerificationJob.pivaTotal/pivaDone/pivaResults` (Task 6, popolati da Task 7+8).
- Produces: `InadVerifyBulkSyncService.handleCron()` finalizza il job (status `DONE`, CSV costruiti) solo quando **sia** i batch INAD **sia** la quota PIVA sono completi; le PEC trovate via Registro Imprese confluiscono nella stessa colonna `domicilio_digitale_inad` del CSV risultato.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/channels/inad/inad-verify-bulk-sync.service.spec.ts
import { InadVerifyBulkSyncService } from './inad-verify-bulk-sync.service';
import { InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';

const mockJobRepo = { find: jest.fn(), update: jest.fn() };
const mockInad = { getBulkState: jest.fn(), getBulkResult: jest.fn() };

describe('InadVerifyBulkSyncService.handleCron', () => {
  let service: InadVerifyBulkSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InadVerifyBulkSyncService(mockJobRepo as any, mockInad as any);
  });

  it('non finalizza se i batch INAD sono pronti ma la quota PIVA non è completa', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-1', size: 1, done: false }],
      pivaTotal: 3, pivaDone: 1, pivaResults: {},
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('DISPONIBILE');

    await service.handleCron();

    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { batches: [{ id: 'batch-1', size: 1, done: true }] });
    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: InadVerificationJobStatus.DONE }));
  });

  it('finalizza e fonde i risultati PIVA nel CSV quando entrambe le fonti sono complete', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [{ id: 'batch-1', size: 1, done: true }],
      pivaTotal: 2, pivaDone: 2, pivaResults: { '12345678901': 'acme@pec.it', '98765432109': null },
      sourceCsv: 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkResult.mockResolvedValue([{ codiceFiscale: 'RRANGL74M28R701V', since: '2020', digitalAddress: [{ digitalAddress: 'persona@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01' } }] }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === InadVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    const patch = call![1];
    expect(patch.foundCount).toBe(2); // CF persona + PIVA con PEC trovata
    expect(patch.notFoundCount).toBe(1); // PIVA senza PEC
    expect(patch.resultFoundCsv).toContain('persona@pec.it');
    expect(patch.resultFoundCsv).toContain('acme@pec.it');
    expect(patch.resultNotFoundCsv).toContain('98765432109');
  });

  it('finalizza un job con sole Partite IVA (nessun batch INAD)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: InadVerificationJobStatus.PROCESSING,
      batches: [],
      pivaTotal: 1, pivaDone: 1, pivaResults: { '12345678901': 'acme@pec.it' },
      sourceCsv: 'cf\n12345678901\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === InadVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    expect(call![1].foundCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/jest inad-verify-bulk-sync.service --maxWorkers=2`
Expected: FAIL — job con `pivaDone < pivaTotal` viene finalizzato comunque (logica attuale ignora `piva*`).

- [ ] **Step 3: Write minimal implementation**

Sostituisci l'intero file `apps/backend/src/channels/inad/inad-verify-bulk-sync.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { InadVerificationJob, InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';
import { parseCsvContent, buildCsvContent } from '../../io-services/csv.util';
import { InadService } from './inad.service';

const ADDRESS_COLUMN = 'domicilio_digitale_inad';

/**
 * Poll periodico dei batch bulk INAD per i job di "Verifica INAD massiva" —
 * stesso pattern demone Cron di InadCheckSyncService (nessuna coda BullMQ,
 * solo Cron + repo diretti), ma su InadVerificationJob invece che su Campaign.
 *
 * Un job resta PROCESSING finché ENTRAMBE le fonti non sono complete: i
 * batch INAD (CF persona fisica) e la quota Partita IVA accodata su
 * registro-imprese-verify (vedi InadVerifyBulkService, RegistroImpreseVerifyProcessor
 * — quest'ultimo scrive piva_done/piva_results in autonomia, questo demone
 * si limita a leggerli). Le PEC trovate via Registro Imprese confluiscono
 * nella stessa colonna ADDRESS_COLUMN dei CF trovati via INAD — un solo CSV
 * risultato indipendente dalla fonte.
 */
@Injectable()
export class InadVerifyBulkSyncService {
  private readonly logger = new Logger(InadVerifyBulkSyncService.name);

  constructor(
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    private readonly inadService: InadService,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const jobs = await this.jobRepo.find({ where: { status: InadVerificationJobStatus.PROCESSING } });

    for (const job of jobs) {
      try {
        let allReady = true;
        const batches = job.batches;
        for (const batch of batches) {
          if (batch.done) continue;
          const state = await this.inadService.getBulkState(batch.id);
          if (state === 'DISPONIBILE') {
            batch.done = true;
          } else {
            allReady = false;
          }
        }

        const pivaReady = job.pivaTotal === 0 || job.pivaDone >= job.pivaTotal;
        if (!allReady || !pivaReady) {
          await this.jobRepo.update(job.id, { batches });
          continue;
        }

        const foundAddresses = new Map<string, string>();
        for (const batch of batches) {
          const items = await this.inadService.getBulkResult(batch.id);
          items.forEach((item) => {
            const addresses = (item.digitalAddress ?? []).map((a) => a.digitalAddress).join('; ');
            foundAddresses.set(item.codiceFiscale.toUpperCase(), addresses);
          });
        }
        for (const [piva, pec] of Object.entries(job.pivaResults ?? {})) {
          if (pec) foundAddresses.set(piva, pec);
        }

        const parsed = parseCsvContent(job.sourceCsv, job.hasHeaders);
        const foundHeaders = [...parsed.headers, ADDRESS_COLUMN];
        const foundRows: Record<string, string>[] = [];
        const notFoundRows: Record<string, string>[] = [];
        for (const row of parsed.rows) {
          const cf = (row[job.cfColumn] || '').trim().toUpperCase();
          const address = foundAddresses.get(cf);
          if (address !== undefined) {
            foundRows.push({ ...row, [ADDRESS_COLUMN]: address });
          } else {
            notFoundRows.push(row);
          }
        }

        await this.jobRepo.update(job.id, {
          status: InadVerificationJobStatus.DONE,
          batches,
          foundCount: foundRows.length,
          notFoundCount: notFoundRows.length,
          resultFoundCsv: buildCsvContent(foundHeaders, foundRows),
          resultNotFoundCsv: buildCsvContent(parsed.headers, notFoundRows),
          completedAt: new Date(),
        });
        this.logger.log(`InadVerificationJob ${job.id} completato: ${foundRows.length} trovati, ${notFoundRows.length} non trovati`);
      } catch (err) {
        this.logger.warn(`Errore sync job verifica INAD ${job.id}: ${err instanceof Error ? err.message : err}`);
        await this.jobRepo.update(job.id, {
          status: InadVerificationJobStatus.FAILED,
          errorMessage: err instanceof Error ? err.message : 'Errore sconosciuto',
          completedAt: new Date(),
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/jest inad-verify-bulk-sync.service --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/inad/inad-verify-bulk-sync.service.ts apps/backend/src/channels/inad/inad-verify-bulk-sync.service.spec.ts
git commit -m "feat(registro-imprese): InadVerifyBulkSyncService attende e fonde la quota PIVA

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Verifica finale — suite completa + type-check

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`, vedi CLAUDE.md) + tutti i nuovi test di questo piano passano. Qualunque altro fallimento è una regressione da investigare prima di proseguire.

- [ ] **Step 2: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Rebuild ed avvio stack dev**

```bash
docker compose build backend frontend-admin
docker compose up -d --build backend frontend-admin
```

Verifica che il backend parta senza crash-loop (`docker compose logs -f backend`, cercare eventuali errori DI Nest su `RegistroImpreseModule`/`InadModule`/`DomicilioModule`).

- [ ] **Step 5: Commit finale (se necessario un aggiustamento post-verifica)**

Se la verifica non richiede modifiche, nessun commit aggiuntivo — il piano è completo. Altrimenti, correggere e ripetere Step 1-4 prima di committare.
