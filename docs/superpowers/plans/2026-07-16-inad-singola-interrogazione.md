# INAD singola interrogazione — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far funzionare una singola interrogazione reale all'API INAD
(`GET /extract/{codice_fiscale}`) verificabile a mano da un bottone nella tab
Impostazioni → INAD dell'admin.

**Architecture:** `InadService.extractDigitalAddress()` ottiene un voucher
PDND (già esistente via `PdndAuthService`, purpose `inad.prod.purposeId`) e
chiama l'endpoint INAD reale. Un nuovo endpoint su `SettingsController`
espone la chiamata come test manuale (HTTP sempre 200, esito nel body).
Il frontend admin aggiunge un input CF + bottone nel fieldset "Produzione"
già esistente del tab INAD.

**Tech Stack:** NestJS 10, `fetch` nativo (Node 22, come `pdnd-auth.service.ts`), Jest.

## Global Constraints

- Solo ambiente **prod** per questa chiamata — nessun toggle test/UAT (spec: `docs/superpowers/specs/2026-07-16-inad-singola-interrogazione-design.md`).
- Nessuna scrittura DB: pura lettura, risultato mostrato solo a video.
- `practicalReference` è costante hardcoded lato backend: `'comunicapa-verifica-domicilio'` — non input utente, non setting.
- Nessun campo API Key in UI: INAD usa solo `bearerAuth` (voucher PDND), niente `x-api-key`.
- Host fisso: `https://api.inad.gov.it/rest/inad/v1/domiciliodigitale`.
- Test suite gira con `--maxWorkers=2` (vincolo RAM, vedi CLAUDE.md) — non serve fare nulla di diverso qui, solo da ricordare quando si lancia jest.

---

### Task 1: `InadService.extractDigitalAddress`

**Files:**
- Modify: `apps/backend/src/channels/inad/inad.service.ts`
- Test: `apps/backend/src/channels/inad/inad.service.spec.ts` (nuovo)

**Interfaces:**
- Consumes: `PdndAuthService.getVoucher(env: PdndEnvironment, purposeId: string, forceRefresh?: boolean): Promise<string>` (esistente, non modificato); `AppSettingsService.get<T>(key: SettingKey): Promise<T>` (esistente).
- Produces: `InadService.extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult>`, dove:
  ```ts
  interface InadDigitalAddressElement {
    digitalAddress: string;
    practicedProfession?: string;
    usageInfo: { motivation: 'CESSAZIONE_UFFICIO' | 'CESSAZIONE_VOLONTARIA'; dateEndValidity: string };
  }
  interface InadExtractResult {
    found: boolean;
    data?: { codiceFiscale: string; since: string; digitalAddress: InadDigitalAddressElement[] };
  }
  ```
  Usato dal Task 2 (controller).

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/channels/inad/inad.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { InadService } from './inad.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSettings = { get: jest.fn(async (key: string) => (key === 'inad.prod.purposeId' ? 'purpose-inad-prod' : undefined)) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('InadService.extractDigitalAddress', () => {
  let service: InadService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        InadService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(InadService);
  });

  it('restituisce found:true e i dati quando INAD risponde 200', async () => {
    const body = {
      codiceFiscale: 'RRANGL74M28R701V',
      since: '2017-07-21T17:32:28Z',
      digitalAddress: [
        { digitalAddress: 'example@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01T00:00:00Z' } },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

    const result = await service.extractDigitalAddress('RRANGL74M28R701V');

    expect(result).toEqual({ found: true, data: body });
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-inad-prod');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/extract/RRANGL74M28R701V?practicalReference=comunicapa-verifica-domicilio',
    );
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('restituisce found:false quando INAD risponde 404 (nessun domicilio)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"status":"404","type":"NOT_FOUND"}') });

    const result = await service.extractDigitalAddress('RRANGL74M28R701V');

    expect(result).toEqual({ found: false });
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('{"status":"401","type":"UNAUTHORIZED"}') });

    await expect(service.extractDigitalAddress('RRANGL74M28R701V')).rejects.toThrow(
      /INAD extract fallito: HTTP 401/,
    );
  });

  it('propaga l\'errore se il purposeId prod non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.extractDigitalAddress('RRANGL74M28R701V')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest inad.service --maxWorkers=2`
Expected: FAIL — `extractDigitalAddress is not a function`.

- [ ] **Step 3: Implementa `extractDigitalAddress` in `inad.service.ts`**

Sostituisci il contenuto del file con:

```ts
import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';

const INAD_BASE_URL = 'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale';
const PRACTICAL_REFERENCE = 'comunicapa-verifica-domicilio';

export interface InadDigitalAddressElement {
  digitalAddress: string;
  practicedProfession?: string;
  usageInfo: { motivation: 'CESSAZIONE_UFFICIO' | 'CESSAZIONE_VOLONTARIA'; dateEndValidity: string };
}

export interface InadExtractResult {
  found: boolean;
  data?: { codiceFiscale: string; since: string; digitalAddress: InadDigitalAddressElement[] };
}

/**
 * Integrazione INAD (Indice Nazionale Domicili Digitali). Solo interrogazione
 * singola per ora (GET /extract/{cf}), sempre in prod, nessuna persistenza —
 * la logica "domicilio eletto = canale unico" è fase successiva.
 */
@Injectable()
export class InadService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`inad.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione INAD (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult> {
    const voucher = await this.getVoucher('prod');
    const url = `${INAD_BASE_URL}/extract/${codiceFiscale}?practicalReference=${PRACTICAL_REFERENCE}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });

    if (response.status === 404) {
      return { found: false };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`INAD extract fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text) as InadExtractResult['data'];
    return { found: true, data };
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest inad.service --maxWorkers=2`
Expected: PASS (4 test).

- [ ] **Step 5: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/inad/inad.service.ts apps/backend/src/channels/inad/inad.service.spec.ts
git commit -m "feat(backend): interrogazione singola INAD via GET /extract/{cf}"
```

---

### Task 2: endpoint controller `POST admin/settings/inad/prod/extract`

**Files:**
- Modify: `apps/backend/src/settings/settings.controller.ts`
- Modify: `apps/backend/src/settings/settings.module.ts`

**Interfaces:**
- Consumes: `InadService.extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult>` (Task 1).
- Produces: endpoint HTTP `POST admin/settings/inad/prod/extract`, body `{ codiceFiscale: string }`, risposta sempre `200 OK` con body:
  ```ts
  { success: boolean; found?: boolean; data?: InadExtractResult['data']; message?: string }
  ```
  Consumato dal Task 3 (frontend).

- [ ] **Step 1: Importa `InadModule` in `SettingsModule`**

In `apps/backend/src/settings/settings.module.ts`, aggiungi l'import:

```ts
import { InadModule } from '../channels/inad/inad.module';
```

e aggiungi `InadModule` all'array `imports`:

```ts
  imports: [TypeOrmModule.forFeature([AppSetting]), PdndModule, InadModule],
```

- [ ] **Step 2: Inietta `InadService` nel controller e aggiungi l'endpoint**

In `apps/backend/src/settings/settings.controller.ts`, aggiungi l'import:

```ts
import { InadService } from '../channels/inad/inad.service';
```

Aggiungi il parametro al costruttore esistente:

```ts
  constructor(
    private readonly appSettings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly inadService: InadService,
  ) {}
```

Aggiungi il nuovo endpoint subito dopo `testInadConnection` (riga 245 circa):

```ts
  @Post('inad/prod/extract')
  @HttpCode(HttpStatus.OK)
  async extractInadDigitalAddress(@Body() body: { codiceFiscale?: string }) {
    if (!body.codiceFiscale) {
      throw new BadRequestException('codiceFiscale obbligatorio');
    }
    try {
      const result = await this.inadService.extractDigitalAddress(body.codiceFiscale);
      return { success: true, found: result.found, data: result.data };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante l\'interrogazione INAD.' };
    }
  }
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Restart backend e verifica manuale con curl**

Il watch di NestJS su bind mount Windows spesso non vede le modifiche — riavvia esplicitamente:

```bash
docker compose restart backend
docker compose exec backend ls -la dist/settings/settings.controller.js src/settings/settings.controller.ts
```

Poi, con un token admin di debug (vedi CLAUDE.md sezione Test per generarlo):

```bash
curl -s -X POST http://localhost:8080/admin/settings/inad/prod/extract \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"codiceFiscale":"RRANGL74M28R701V"}'
```

Expected: risposta 200 JSON — `{"success":false,"message":"..."}` se `inad.prod.purposeId` non è ancora configurato in questo ambiente (atteso, nessuna credenziale INAD reale disponibile in dev) oppure `{"success":true,...}` se lo è.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/settings/settings.controller.ts apps/backend/src/settings/settings.module.ts
git commit -m "feat(backend): endpoint test interrogazione INAD in Impostazioni"
```

---

### Task 3: UI Impostazioni → INAD (bottone interrogazione)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST admin/settings/inad/prod/extract` (Task 2), risposta `{ success, found?, data?, message? }`.
- Produces: nessuna nuova interfaccia consumata da altri task (ultimo task del piano).

- [ ] **Step 1: Aggiungi lo stato React**

Vicino alle righe esistenti 938-941 (stato test voucher INAD), aggiungi:

```ts
  const [settInadExtractCf, setSettInadExtractCf] = useState('');
  const [settInadExtracting, setSettInadExtracting] = useState(false);
  const [settInadExtractResult, setSettInadExtractResult] = useState<
    { success: boolean; found?: boolean; data?: { codiceFiscale: string; since: string; digitalAddress: Array<{ digitalAddress: string; practicedProfession?: string; usageInfo: { motivation: string; dateEndValidity: string } }> }; message?: string } | null
  >(null);
```

- [ ] **Step 2: Aggiungi l'handler**

Vicino a `handleTestInadConnection` (riga 1908-1909 circa), aggiungi — usa
l'helper `apiFetch` già definito nel componente (riga 1192, imposta da solo
l'header `Authorization` da `token` in scope e gestisce il 401):

```ts
  const handleExtractInad = async () => {
    if (!settInadExtractCf.trim()) return;
    setSettInadExtracting(true);
    setSettInadExtractResult(null);
    try {
      const res = await apiFetch('/settings/inad/prod/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: settInadExtractCf.trim() }),
      });
      const data = await res.json();
      setSettInadExtractResult(data);
    } catch (error: any) {
      if (error instanceof ApiAuthError) return;
      setSettInadExtractResult({ success: false, message: error.message || 'Errore di rete' });
    } finally {
      setSettInadExtracting(false);
    }
  };
```

- [ ] **Step 3: Aggiungi il pannello UI**

Nel fieldset "Produzione" del tab INAD (dentro il blocco `{activeSettingsTab === 'inad' && (...)}`, righe 7274-7316), il `.map((e) => ...)` itera su Collaudo e Produzione. Aggiungi il nuovo pannello **solo quando `e.prefix === 'prod'`**, subito dopo il blocco `settInadTestResult` esistente (prima della chiusura `</fieldset>`, riga 7313):

```tsx
                                {e.prefix === 'prod' && (
                                  <>
                                    <hr className="my-3" />
                                    <label className="form-label small fw-semibold text-muted" htmlFor="inad_extract_cf">Codice Fiscale</label>
                                    <input
                                      type="text"
                                      id="inad_extract_cf"
                                      className="form-control form-control-sm mb-2"
                                      value={settInadExtractCf}
                                      onChange={(ev) => setSettInadExtractCf(ev.target.value.toUpperCase())}
                                      placeholder="RSSMRA80A01H501U"
                                    />
                                    <button
                                      type="button"
                                      className="btn btn-outline-primary btn-sm"
                                      disabled={settInadExtracting || !settInadExtractCf.trim()}
                                      onClick={handleExtractInad}
                                    >
                                      {settInadExtracting ? 'Interrogazione in corso…' : 'Interroga domicilio digitale'}
                                    </button>
                                    {settInadExtractResult && (
                                      <div className={`alert ${settInadExtractResult.success ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                        {!settInadExtractResult.success && (settInadExtractResult.message || 'Errore sconosciuto')}
                                        {settInadExtractResult.success && settInadExtractResult.found === false && 'Nessun domicilio digitale associato a questo Codice Fiscale.'}
                                        {settInadExtractResult.success && settInadExtractResult.found && settInadExtractResult.data && (
                                          <ul className="mb-0 ps-3">
                                            {settInadExtractResult.data.digitalAddress.map((d, i) => (
                                              <li key={i}>
                                                {d.digitalAddress}
                                                {d.practicedProfession ? ` (${d.practicedProfession})` : ''}
                                              </li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
```

- [ ] **Step 4: Aggiorna l'alert in cima al tab**

Sostituisci il testo dell'alert esistente (righe 7276-7279):

```tsx
                            <div className="alert alert-warning small mb-3">
                              Integrazione INAD in attesa di approvazione PDND: le specifiche non sono
                              ancora definite. Solo il Purpose ID è configurabile per ora.
                            </div>
```

con:

```tsx
                            <div className="alert alert-warning small mb-3">
                              Interrogazione singola disponibile (solo ambiente Produzione). La logica
                              di scelta canale in base al domicilio digitale eletto non è ancora
                              implementata.
                            </div>
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser**

Avvia/verifica `docker compose up -d frontend-admin backend`, apri `http://localhost:3000`, login admin, Impostazioni → INAD → fieldset Produzione → inserisci un CF → premi "Interroga domicilio digitale" → verifica che compaia un messaggio (errore atteso se `inad.prod.purposeId` non configurato in questo ambiente: "Configurazione INAD (prod) incompleta: purposeId non impostato").

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): bottone interrogazione singola INAD in Impostazioni"
```

---

## Spec coverage check

- API reale `/extract/{cf}` con `practicalReference` hardcoded → Task 1. ✓
- Solo prod, nessuna persistenza → Task 1 (`getVoucher('prod')`, nessuna scrittura DB). ✓
- Endpoint HTTP sempre 200 → Task 2. ✓
- UI: solo CF + bottone, niente API key, alert aggiornato → Task 3. ✓
- Estrazione multipla, verifica puntuale stile App IO, comportamento canale unico → esplicitamente fuori scope, nessun task. ✓
