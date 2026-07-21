# Cerca Domicilio (verifica puntuale) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere l'integrazione ANPR C020 (residenza anagrafica via PDND) e unificare la verifica puntuale di INAD + App IO + ANPR in un'unica pagina "Cerca Domicilio", che interroga tutti e tre i canali insieme dato un codice fiscale.

**Architecture:** Nuovo modulo `AnprModule` (client REST C020, pattern 1:1 con `InadModule` esistente) + estensione di `PdndAuthService` con un metodo generico di firma JWS (riusato per i due header `Agid-JWT-Signature`/`Agid-JWT-TrackingEvidence` richiesti da C020). Nuovo modulo `DomicilioModule` che orchestra le tre chiamate (`InadService`, `IoServicesService`, `AnprService`) in parallelo con `Promise.allSettled`, esposto da un unico endpoint. Il frontend aggiunge una pagina unica "Cerca Domicilio" e rimuove solo la tab "Verifica singola" dalle pagine INAD/App IO esistenti (la tab "Verifica massiva CSV" di entrambe resta invariata, fuori scope — vedi spec massiva separata).

**Tech Stack:** NestJS 10 (backend), React 19 + Vite (frontend-admin), `jsonwebtoken` per le firme JWS (già usato da `PdndAuthService`), `node:crypto` per il digest SHA-256, Jest per i test.

## Global Constraints

- Backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per la suite (mai senza `--maxWorkers=2`, satura la RAM su WSL2).
- Backend type-check: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Frontend-admin type-check: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Baseline nota: 1 solo fallimento pre-esistente (`app.controller.spec.ts`, `isLdapMock`) — qualunque altro nuovo fallimento è una regressione.
- Query ANPR reale sempre e solo su ambiente prod (`modipa.anpr.interno.it`), mai test/val — stesso pattern INAD.
- Mai eccezione HTTP non-2xx per un errore "previsto" negli endpoint admin dietro il proxy esterno — sempre `@HttpCode(HttpStatus.OK)` + payload con flag.
- Fuori scope in questo piano: verifica massiva unificata (spec separata `2026-07-21-cerca-domicilio-massiva-design.md`, non implementata qui) e rimozione dello stack INAD/App IO standalone (deferita a quando la massiva sarà implementata).

---

### Task 1: `PdndAuthService.signAgidJwt` — firma JWS generica riusabile

**Files:**
- Modify: `apps/backend/src/pdnd/pdnd-auth.service.ts`
- Test: `apps/backend/src/pdnd/pdnd-auth.service.spec.ts`

**Interfaces:**
- Consumes: nulla di nuovo — riusa `AppSettingsService.get<string>(key: SettingKey)` già iniettato nel costruttore.
- Produces: `PdndAuthService.signAgidJwt(env: PdndEnvironment, aud: string, extraClaims: Record<string, unknown>): Promise<string>` — usato da `AnprService` (Task 2).

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in fondo a `apps/backend/src/pdnd/pdnd-auth.service.spec.ts` (prima della chiusura del `describe` esistente, stesso `mockSettings`/chiavi RSA già generate in cima al file):

```ts
  it('signAgidJwt firma un JWS RS256 con iss/sub/aud/jti/kid ed extraClaims', async () => {
    settingsValues['pdnd.test.clientId'] = 'client-123';

    const token = await service.signAgidJwt('test', 'https://api.esempio.it/rest/qualcosa', {
      signed_headers: [{ digest: 'SHA-256=abc' }],
    });

    const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload & {
      signed_headers: Array<{ digest: string }>;
    };
    expect(decoded.iss).toBe('client-123');
    expect(decoded.sub).toBe('client-123');
    expect(decoded.aud).toBe('https://api.esempio.it/rest/qualcosa');
    expect(decoded.jti).toBeDefined();
    expect(decoded.signed_headers).toEqual([{ digest: 'SHA-256=abc' }]);
    expect(jwt.decode(token, { complete: true })?.header.kid).toBe('kid-abc');
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('RS256');
  });

  it('signAgidJwt lancia errore leggibile se la configurazione PDND è incompleta', async () => {
    await expect(service.signAgidJwt('prod', 'https://api.esempio.it/x', {})).rejects.toThrow(
      /Configurazione PDND \(prod\) incompleta/,
    );
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest pdnd-auth.service --maxWorkers=2`
Expected: FAIL — `service.signAgidJwt is not a function`

- [ ] **Step 3: Implementa `signAgidJwt`**

In `apps/backend/src/pdnd/pdnd-auth.service.ts`, aggiungi il metodo dentro la classe `PdndAuthService` (dopo `getVoucher`, prima di `clearCache`):

```ts
  /**
   * Firma JWS generica RS256 riusata sia per Agid-JWT-Signature (pattern
   * INTEGRITY_REST_02) sia per Agid-JWT-TrackingEvidence (pattern
   * AUDIT_REST_02) — stessa chiave/kid del client PDND, claim extra
   * (signed_headers, userID/userLocation/LoA...) passati dal chiamante.
   */
  async signAgidJwt(env: PdndEnvironment, aud: string, extraClaims: Record<string, unknown>): Promise<string> {
    const prefix = `pdnd.${env}`;
    const [clientId, kid, privateKey] = await Promise.all([
      this.settings.get<string>(`${prefix}.clientId` as SettingKey),
      this.settings.get<string>(`${prefix}.kid` as SettingKey),
      this.settings.get<string>(`${prefix}.privateKey` as SettingKey),
    ]);

    const missing = Object.entries({ clientId, kid, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione PDND (${env}) incompleta: mancano ${missing.join(', ')}`);
    }

    return jwt.sign(
      { iss: clientId, sub: clientId, aud, jti: randomUUID(), ...extraClaims },
      privateKey!,
      { algorithm: 'RS256', keyid: kid!, expiresIn: 60, notBefore: 0 },
    );
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest pdnd-auth.service --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi quelli preesistenti)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/pdnd/pdnd-auth.service.ts apps/backend/src/pdnd/pdnd-auth.service.spec.ts
git commit -m "feat(backend): aggiungi signAgidJwt a PdndAuthService per firma JWS ANPR C020"
```

---

### Task 2: `AnprService` — client REST C020

**Files:**
- Create: `apps/backend/src/channels/anpr/anpr.types.ts`
- Create: `apps/backend/src/channels/anpr/anpr.service.ts`
- Create: `apps/backend/src/channels/anpr/anpr.module.ts`
- Test: `apps/backend/src/channels/anpr/anpr.service.spec.ts`

**Interfaces:**
- Consumes: `PdndAuthService.getVoucher(env, purposeId)` (esistente), `PdndAuthService.signAgidJwt(env, aud, extraClaims)` (Task 1), `AppSettingsService.get<T>(key)`.
- Produces: `AnprService.getResidenza(codiceFiscale: string, operatorUsername: string): Promise<AnprResidenzaResult>` — usato da `DomicilioService` (Task 4). `AnprModule` esporta `AnprService`.

- [ ] **Step 1: Crea i tipi di dominio**

Crea `apps/backend/src/channels/anpr/anpr.types.ts`:

```ts
export interface AnprComune {
  nomeComune?: string;
  codiceIstat?: string;
  siglaProvinciaIstat?: string;
  descrizioneLocalita?: string;
}

export interface AnprToponimo {
  specie?: string;
  denominazioneToponimo?: string;
}

export interface AnprNumeroCivico {
  numero?: string;
  lettera?: string;
}

export interface AnprIndirizzo {
  cap?: string;
  comune?: AnprComune;
  frazione?: string;
  toponimo?: AnprToponimo;
  numeroCivico?: AnprNumeroCivico;
}

export interface AnprResidenza {
  tipoIndirizzo?: string;
  indirizzo?: AnprIndirizzo;
  dataDecorrenzaResidenza?: string;
  presso?: string;
}

export interface AnprGeneralita {
  codiceFiscale?: { codFiscale?: string };
  cognome?: string;
  nome?: string;
  dataNascita?: string;
}

export interface AnprResidenzaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    residenza: AnprResidenza[];
  };
}
```

- [ ] **Step 2: Scrivi il test che fallisce**

Crea `apps/backend/src/channels/anpr/anpr.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { AnprService } from './anpr.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'anpr.prod.purposeId': 'purpose-anpr-prod',
  'anpr.trackingUserLocation': 'comunicapa-backend',
  'anpr.trackingLoA': 'https://www.spid.gov.it/SpidL2',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = {
  getVoucher: jest.fn(async () => 'voucher-abc'),
  signAgidJwt: jest.fn(async () => 'jws-token'),
};

describe('AnprService.getResidenza', () => {
  let service: AnprService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockPdndAuth.signAgidJwt.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        AnprService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(AnprService);
  });

  it('restituisce found:true e i dati quando ANPR risponde 200 con un soggetto', async () => {
    const body = {
      idOperazioneANPR: 'op-1',
      listaSoggetti: {
        datiSoggetto: [
          {
            generalita: { codiceFiscale: { codFiscale: 'RRANGL74M28R701V' }, cognome: 'Rossi', nome: 'Angela', dataNascita: '1974-08-28' },
            residenza: [{ tipoIndirizzo: '1', indirizzo: { cap: '65015', comune: { nomeComune: 'Montesilvano' } }, dataDecorrenzaResidenza: '2020-01-01' }],
            identificativi: { idANPR: 'ANPR-123' },
          },
        ],
      },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result.found).toBe(true);
    expect(result.data?.idANPR).toBe('ANPR-123');
    expect(result.data?.generalita.cognome).toBe('Rossi');
    expect(result.data?.residenza[0].indirizzo?.comune?.nomeComune).toBe('Montesilvano');

    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-anpr-prod');
    expect(mockPdndAuth.signAgidJwt).toHaveBeenCalledTimes(2);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C020-servizioAccertamentoResidenza/v1/anpr-service-e002',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
    expect(init.headers['Agid-JWT-Signature']).toBe('jws-token');
    expect(init.headers['Agid-JWT-TrackingEvidence']).toBe('jws-token');
    expect(init.headers.Digest).toMatch(/^SHA-256=/);

    const sentBody = JSON.parse(init.body);
    expect(sentBody.criteriRicerca).toEqual({ codiceFiscale: 'RRANGL74M28R701V' });
    expect(sentBody.datiRichiesta.casoUso).toBe('C020');
    expect(sentBody.datiRichiesta.motivoRichiesta).toBe('comunicapa-cerca-domicilio');

    // Il secondo argomento della TrackingEvidence deve contenere l'operatore.
    const trackingCallArgs = mockPdndAuth.signAgidJwt.mock.calls[1];
    expect(trackingCallArgs[2]).toEqual(
      expect.objectContaining({ userID: 'mario.rossi', userLocation: 'comunicapa-backend', LoA: 'https://www.spid.gov.it/SpidL2' }),
    );
  });

  it('restituisce found:false quando ANPR risponde 404 (posizione non presente)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"listaErrori":[]}') });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result).toEqual({ found: false });
  });

  it('restituisce found:false quando ANPR risponde 200 senza soggetti in lista', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"idOperazioneANPR":"op-1","listaSoggetti":{"datiSoggetto":[]}}') });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result).toEqual({ found: false });
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"listaErrori":[{"testoErroreAnomalia":"bad request"}]}') });

    await expect(service.getResidenza('RRANGL74M28R701V', 'mario.rossi')).rejects.toThrow(/ANPR C020 fallito: HTTP 400/);
  });

  it('propaga l\'errore se il purposeId prod non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.getResidenza('RRANGL74M28R701V', 'mario.rossi')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest channels/anpr --maxWorkers=2`
Expected: FAIL — `Cannot find module './anpr.service'`

- [ ] **Step 4: Implementa `AnprService`**

Crea `apps/backend/src/channels/anpr/anpr.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import type { AnprResidenzaResult, AnprGeneralita, AnprResidenza } from './anpr.types';

const ANPR_C020_BASE_URL =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C020-servizioAccertamentoResidenza/v1';
const ANPR_C020_ENDPOINT = `${ANPR_C020_BASE_URL}/anpr-service-e002`;

interface RispostaE002OK {
  idOperazioneANPR?: string;
  listaSoggetti?: {
    datiSoggetto?: Array<{
      generalita: AnprGeneralita;
      residenza?: AnprResidenza[];
      identificativi?: { idANPR?: string };
    }>;
  };
}

/**
 * Integrazione ANPR C020 "Servizio di accertamento residenza" via PDND.
 * Solo interrogazione puntuale per ora (query sempre su prod, mai test/val —
 * stesso pattern di InadService). Richiede, oltre al bearer voucher PDND, i
 * due header Agid-JWT-Signature/Agid-JWT-TrackingEvidence (pattern PDND
 * INTEGRITY_REST_02/AUDIT_REST_02) firmati con la stessa chiave del client.
 */
@Injectable()
export class AnprService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getResidenza(codiceFiscale: string, operatorUsername: string): Promise<AnprResidenzaResult> {
    const [purposeId, userLocation, loA] = await Promise.all([
      this.settings.get<string>('anpr.prod.purposeId' as SettingKey),
      this.settings.get<string>('anpr.trackingUserLocation' as SettingKey),
      this.settings.get<string>('anpr.trackingLoA' as SettingKey),
    ]);
    if (!purposeId) {
      throw new Error('Configurazione ANPR (prod) incompleta: purposeId non impostato');
    }

    const voucher = await this.pdndAuth.getVoucher('prod', purposeId);

    const body = {
      idOperazioneClient: randomUUID(),
      criteriRicerca: { codiceFiscale },
      datiRichiesta: {
        dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
        motivoRichiesta: 'comunicapa-cerca-domicilio',
        casoUso: 'C020',
      },
    };
    const bodyStr = JSON.stringify(body);
    const digest = `SHA-256=${createHash('sha256').update(bodyStr).digest('base64')}`;

    const [signature, trackingEvidence] = await Promise.all([
      this.pdndAuth.signAgidJwt('prod', ANPR_C020_ENDPOINT, {
        signed_headers: [{ digest }, { 'content-type': 'application/json' }],
      }),
      this.pdndAuth.signAgidJwt('prod', ANPR_C020_ENDPOINT, {
        userID: operatorUsername,
        userLocation,
        LoA: loA,
      }),
    ]);

    const response = await fetch(ANPR_C020_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${voucher}`,
        Digest: digest,
        'Agid-JWT-Signature': signature,
        'Agid-JWT-TrackingEvidence': trackingEvidence,
        'Content-Type': 'application/json',
      },
      body: bodyStr,
    });

    if (response.status === 404) {
      return { found: false };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ANPR C020 fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: RispostaE002OK;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta ANPR non valida (non JSON): ${text.slice(0, 200)}`);
    }

    const soggetto = data.listaSoggetti?.datiSoggetto?.[0];
    if (!soggetto) {
      return { found: false };
    }
    return {
      found: true,
      data: {
        idANPR: soggetto.identificativi?.idANPR,
        generalita: soggetto.generalita,
        residenza: soggetto.residenza ?? [],
      },
    };
  }
}
```

Crea `apps/backend/src/channels/anpr/anpr.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { AnprService } from './anpr.service';

@Module({
  imports: [PdndModule],
  providers: [AnprService],
  exports: [AnprService],
})
export class AnprModule {}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest channels/anpr --maxWorkers=2`
Expected: PASS (5 test)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/anpr
git commit -m "feat(backend): aggiungi AnprService, client REST ANPR C020 via PDND"
```

---

### Task 3: Settings — tab ANPR (backend + frontend)

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts`
- Modify: `apps/backend/src/settings/settings.controller.ts`
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `PdndAuthService` (già iniettato in `SettingsController`), pattern `runPdndTest`/`buildSettingsPayload` già esistenti in `App.tsx`.
- Produces: chiavi settings `anpr.test.purposeId`, `anpr.prod.purposeId`, `anpr.trackingUserLocation`, `anpr.trackingLoA` — consumate da `AnprService` (Task 2, già scritto assumendo queste chiavi).

- [ ] **Step 1: Aggiungi le chiavi al registry**

In `apps/backend/src/settings/settings.registry.ts`, subito dopo il blocco `inipec.*` (dopo la riga `'inipec.prod.purposeId': ...`):

```ts
  'anpr.test.purposeId': { type: 'string', default: '' },
  'anpr.prod.purposeId': { type: 'string', default: '' },
  'anpr.trackingUserLocation': { type: 'string', default: 'comunicapa-backend' },
  'anpr.trackingLoA': { type: 'string', default: 'https://www.spid.gov.it/SpidL2' },
```

- [ ] **Step 2: Aggiungi la rotta di test connessione**

In `apps/backend/src/settings/settings.controller.ts`, modifica la union type del metodo privato:

```ts
  private async testServicePurposeConnection(env: string, service: 'send' | 'inad' | 'inipec' | 'anpr') {
```

Aggiungi il nuovo endpoint pubblico subito dopo `testInipecConnection`:

```ts
  @Post('anpr/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testAnprConnection(@Param('env') env: string) {
    return this.testServicePurposeConnection(env, 'anpr');
  }
```

- [ ] **Step 3: Verifica che la suite backend passi ancora**

Run: `docker compose exec backend node_modules/.bin/jest settings --maxWorkers=2`
Expected: PASS (nessuna modifica al costruttore di `SettingsController`, nessuna spec da aggiornare)

- [ ] **Step 4: Frontend — aggiungi lo stato e il caricamento impostazioni**

In `apps/frontend-admin/src/App.tsx`, subito dopo la dichiarazione di `settInipecProdPurposeId` (vicino alla riga con `settInipecTestPurposeId`/`settInipecProdPurposeId`, cerca `const [settInipecProdPurposeId`), aggiungi:

```ts
  const [settAnprTestPurposeId, setSettAnprTestPurposeId] = useState('');
  const [settAnprProdPurposeId, setSettAnprProdPurposeId] = useState('');
  const [settAnprTracingUserLocation, setSettAnprTracingUserLocation] = useState('');
  const [settAnprTracingLoA, setSettAnprTracingLoA] = useState('');
  const [settAnprTesting, setSettAnprTesting] = useState<'test' | 'prod' | null>(null);
  const [settAnprTestResult, setSettAnprTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);
```

Nel blocco di caricamento impostazioni (cerca `setSettInipecProdPurposeId(String(s['inipec.prod.purposeId'] ?? ''));`), aggiungi subito dopo:

```ts
        setSettAnprTestPurposeId(String(s['anpr.test.purposeId'] ?? ''));
        setSettAnprProdPurposeId(String(s['anpr.prod.purposeId'] ?? ''));
        setSettAnprTracingUserLocation(String(s['anpr.trackingUserLocation'] ?? 'comunicapa-backend'));
        setSettAnprTracingLoA(String(s['anpr.trackingLoA'] ?? 'https://www.spid.gov.it/SpidL2'));
```

Nel `buildSettingsPayload` (cerca `'inipec.prod.purposeId': settInipecProdPurposeId,`), aggiungi subito dopo:

```ts
    'anpr.test.purposeId': settAnprTestPurposeId,
    'anpr.prod.purposeId': settAnprProdPurposeId,
    'anpr.trackingUserLocation': settAnprTracingUserLocation,
    'anpr.trackingLoA': settAnprTracingLoA,
```

Dopo `handleTestInadConnection` (cerca la riga `runPdndTest(\`/settings/inad/${env}/test-connection\`, ...)`), aggiungi:

```ts
  const handleTestAnprConnection = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/anpr/${env}/test-connection`, env, setSettAnprTesting, setSettAnprTestResult);
```

- [ ] **Step 5: Frontend — aggiungi la tab al menu Impostazioni**

Modifica il tipo `SettingsTab` (riga con `type SettingsTab = ...`):

```ts
type SettingsTab = 'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'pdnd' | 'send' | 'inad' | 'inipec' | 'anpr' | 'protocollo' | 'postalizzazione' | 'oidc' | 'motori';
```

Aggiorna anche la union identica usata da `useState` dell'`activeSettingsTab` (cerca `const [activeSettingsTab, setActiveSettingsTab] = useState<...>`) — stessa lista, aggiungi `'anpr'` dopo `'inad'`.

In `SETTINGS_NAV`, aggiungi subito dopo la riga `{ tab: 'inad', ... }`:

```ts
  { tab: 'anpr',             icon: MapPin,                 label: 'ANPR (residenza)' },
```

Aggiungi il titolo pagina (cerca `{activeSettingsTab === 'inad' && 'Integrazione INAD ...'}`) subito dopo:

```tsx
                        {activeSettingsTab === 'anpr' && 'Integrazione ANPR (Servizio C020 - Accertamento Residenza)'}
```

- [ ] **Step 6: Frontend — render della tab**

Cerca il blocco `{activeSettingsTab === 'inad' && (` ... fino alla sua chiusura `)}` (contiene il fieldset test/prod di INAD). Subito dopo la chiusura di quel blocco, aggiungi:

```tsx
                        {activeSettingsTab === 'anpr' && (
                          <div>
                            <div className="alert alert-warning small mb-3">
                              Interrogazione disponibile solo in ambiente Produzione. Richiede lo stesso
                              client PDND già configurato nella tab "Client PDND" (kid/chiave privata) —
                              qui va impostato solo il Purpose ID specifico per ANPR C020.
                            </div>
                            {([
                              { label: 'Collaudo (UAT)', prefix: 'test' as const,
                                purposeId: settAnprTestPurposeId, setPurposeId: setSettAnprTestPurposeId },
                              { label: 'Produzione', prefix: 'prod' as const,
                                purposeId: settAnprProdPurposeId, setPurposeId: setSettAnprProdPurposeId },
                            ]).map((e) => (
                              <fieldset key={e.prefix} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`anpr_${e.prefix}_purposeid`}>Purpose ID</label>
                                  <input
                                    type="text"
                                    id={`anpr_${e.prefix}_purposeid`}
                                    className="form-control form-control-sm"
                                    value={e.purposeId}
                                    onChange={(ev) => e.setPurposeId(ev.target.value)}
                                  />
                                </div>
                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={settAnprTesting === e.prefix}
                                  onClick={() => handleTestAnprConnection(e.prefix)}
                                >
                                  {settAnprTesting === e.prefix ? 'Test in corso…' : 'Test connessione (voucher PDND)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e prova a ottenere un voucher PDND reale con client PDND + Purpose ID ANPR.</div>
                                {settAnprTestResult?.env === e.prefix && (
                                  <div className={`alert ${settAnprTestResult.ok ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                    {settAnprTestResult.message}
                                  </div>
                                )}
                              </fieldset>
                            ))}
                            <fieldset className="border rounded p-3">
                              <legend className="float-none w-auto px-2 small fw-bold text-dark">Tracciamento (Agid-JWT-TrackingEvidence)</legend>
                              <div className="mb-2">
                                <label className="form-label small fw-semibold text-muted" htmlFor="anpr_tracking_location">User Location</label>
                                <input
                                  type="text"
                                  id="anpr_tracking_location"
                                  className="form-control form-control-sm"
                                  value={settAnprTracingUserLocation}
                                  onChange={(ev) => setSettAnprTracingUserLocation(ev.target.value)}
                                />
                              </div>
                              <div className="mb-1">
                                <label className="form-label small fw-semibold text-muted" htmlFor="anpr_tracking_loa">LoA (Level of Assurance)</label>
                                <input
                                  type="text"
                                  id="anpr_tracking_loa"
                                  className="form-control form-control-sm"
                                  value={settAnprTracingLoA}
                                  onChange={(ev) => setSettAnprTracingLoA(ev.target.value)}
                                />
                              </div>
                              <div className="form-text small text-muted">Valori di default non ancora verificati contro un ambiente PDND reale — vedi rischi noti nella spec di design.</div>
                            </fieldset>
                          </div>
                        )}
```

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore rispetto a prima della modifica

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts apps/backend/src/settings/settings.controller.ts apps/frontend-admin/src/App.tsx
git commit -m "feat(backend,frontend): aggiungi tab Impostazioni ANPR (Purpose ID + tracking)"
```

---

### Task 4: `DomicilioService` — orchestratore

**Files:**
- Create: `apps/backend/src/channels/domicilio/domicilio.service.ts`
- Test: `apps/backend/src/channels/domicilio/domicilio.service.spec.ts`

**Interfaces:**
- Consumes: `InadService.extractDigitalAddress(cf: string): Promise<InadExtractResult>` (esistente), `IoServicesService.verifyProfile(cf: string, ioServiceId?: string): Promise<{success, active, message}>` (esistente), `AnprService.getResidenza(cf, operatorUsername): Promise<AnprResidenzaResult>` (Task 2).
- Produces: `DomicilioService.cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult>` — usato da `DomicilioController` (Task 5).

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `apps/backend/src/channels/domicilio/domicilio.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { DomicilioService } from './domicilio.service';
import { InadService } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';

const mockInad = { extractDigitalAddress: jest.fn() };
const mockIoServices = { verifyProfile: jest.fn() };
const mockAnpr = { getResidenza: jest.fn() };

describe('DomicilioService.cercaDomicilio', () => {
  let service: DomicilioService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  it('combina i tre esiti quando tutte e tre le fonti rispondono correttamente', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: true, data: { codiceFiscale: 'CF1', since: '2020', digitalAddress: [] } });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: true, message: 'ok' });
    mockAnpr.getResidenza.mockResolvedValue({ found: true, data: { generalita: { cognome: 'Rossi' }, residenza: [] } });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.codiceFiscale).toBe('CF1');
    expect(result.inad).toEqual({ success: true, found: true, digitalAddress: [] });
    expect(result.appIo).toEqual({ success: true, active: true, message: 'ok' });
    expect(result.anpr).toEqual({ success: true, found: true, generalita: { cognome: 'Rossi' }, residenza: [] });
    expect(mockAnpr.getResidenza).toHaveBeenCalledWith('CF1', 'mario.rossi');
  });

  it('un fallimento di una fonte non impedisce la risposta delle altre due', async () => {
    mockInad.extractDigitalAddress.mockRejectedValue(new Error('INAD giù'));
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({ found: false });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.inad).toEqual({ success: false, found: false, message: 'INAD giù' });
    expect(result.appIo).toEqual({ success: true, active: false, message: 'non attivo' });
    expect(result.anpr).toEqual({ success: true, found: false });
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest channels/domicilio --maxWorkers=2`
Expected: FAIL — `Cannot find module './domicilio.service'`

- [ ] **Step 3: Implementa `DomicilioService`**

Crea `apps/backend/src/channels/domicilio/domicilio.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InadService, InadDigitalAddressElement } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';
import type { AnprGeneralita, AnprResidenza } from '../anpr/anpr.types';

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
  generalita?: AnprGeneralita;
  residenza?: AnprResidenza[];
  message?: string;
}

export interface DomicilioSearchResult {
  codiceFiscale: string;
  inad: DomicilioInadResult;
  appIo: DomicilioAppIoResult;
  anpr: DomicilioAnprResult;
}

/**
 * Orchestratore "Cerca Domicilio": interroga INAD + App IO + ANPR in
 * parallelo per lo stesso CF. Nessuna persistenza — query live ogni volta.
 * Un fallimento di una fonte non deve azzerare le altre due già arrivate,
 * quindi ogni ramo cattura il proprio errore invece di propagarlo.
 */
@Injectable()
export class DomicilioService {
  constructor(
    private readonly inadService: InadService,
    private readonly ioServicesService: IoServicesService,
    private readonly anprService: AnprService,
  ) {}

  async cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult> {
    const [inad, appIo, anpr] = await Promise.allSettled([
      this.inadService.extractDigitalAddress(codiceFiscale),
      this.ioServicesService.verifyProfile(codiceFiscale),
      this.anprService.getResidenza(codiceFiscale, operatorUsername),
    ]);

    return {
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
          ? { success: true, found: anpr.value.found, generalita: anpr.value.data?.generalita, residenza: anpr.value.data?.residenza }
          : { success: false, found: false, message: anpr.reason?.message ?? 'Errore sconosciuto' },
    };
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest channels/domicilio --maxWorkers=2`
Expected: PASS (2 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/domicilio/domicilio.service.ts apps/backend/src/channels/domicilio/domicilio.service.spec.ts
git commit -m "feat(backend): aggiungi DomicilioService, orchestratore INAD+App IO+ANPR"
```

---

### Task 5: `DomicilioController` + `DomicilioModule` — endpoint API

**Files:**
- Create: `apps/backend/src/channels/domicilio/domicilio.controller.ts`
- Create: `apps/backend/src/channels/domicilio/dto/cerca-domicilio.dto.ts`
- Create: `apps/backend/src/channels/domicilio/domicilio.module.ts`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Consumes: `DomicilioService.cercaDomicilio(cf, operatorUsername)` (Task 4).
- Produces: `POST admin/domicilio/cerca` — usato dal frontend (Task 6).

- [ ] **Step 1: Crea il DTO**

Crea `apps/backend/src/channels/domicilio/dto/cerca-domicilio.dto.ts`:

```ts
import { IsString, MinLength } from 'class-validator';

export class CercaDomicilioDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;
}
```

- [ ] **Step 2: Crea il controller**

Crea `apps/backend/src/channels/domicilio/domicilio.controller.ts`:

```ts
import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DomicilioService } from './domicilio.service';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto';

@Controller('admin/domicilio')
export class DomicilioController {
  constructor(private readonly domicilioService: DomicilioService) {}

  @Post('cerca')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  cerca(@Body() dto: CercaDomicilioDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    return this.domicilioService.cercaDomicilio(cf, req.user.username);
  }
}
```

- [ ] **Step 3: Crea il modulo**

Crea `apps/backend/src/channels/domicilio/domicilio.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { InadModule } from '../inad/inad.module';
import { AnprModule } from '../anpr/anpr.module';
import { DomicilioService } from './domicilio.service';
import { DomicilioController } from './domicilio.controller';

// IoServicesService è iniettabile senza importare IoServicesModule: è
// @Global() (vedi io-services.module.ts).
@Module({
  imports: [InadModule, AnprModule],
  controllers: [DomicilioController],
  providers: [DomicilioService],
})
export class DomicilioModule {}
```

- [ ] **Step 4: Registra il modulo in `AppModule`**

In `apps/backend/src/app.module.ts`, aggiungi l'import:

```ts
import { DomicilioModule } from './channels/domicilio/domicilio.module';
```

E aggiungi `DomicilioModule` all'array `imports` (dopo `IoServicesModule`):

```ts
    IoServicesModule,
    DomicilioModule,
```

- [ ] **Step 5: Verifica che il backend si avvii senza errori di DI**

Run: `docker compose up -d --build backend`
Run: `docker compose logs backend --tail 50`
Expected: nessun errore `Nest can't resolve dependencies` — il backend si avvia normalmente

- [ ] **Step 6: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/domicilio/domicilio.controller.ts apps/backend/src/channels/domicilio/dto apps/backend/src/channels/domicilio/domicilio.module.ts apps/backend/src/app.module.ts
git commit -m "feat(backend): endpoint POST admin/domicilio/cerca"
```

---

### Task 6: Frontend — pagina "Cerca Domicilio" e rimozione tab singola INAD/App IO

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST admin/domicilio/cerca` (Task 5), risposta `DomicilioSearchResult` (stessa forma di `DomicilioService.cercaDomicilio`, Task 4) — nel frontend viene ridichiarata come tipo locale (il frontend non importa tipi dal backend in questo repo, stesso pattern già usato per `verificaInadResult`/`verificaResult`).

- [ ] **Step 1: Aggiungi lo stato della nuova pagina**

In `apps/frontend-admin/src/App.tsx`, subito dopo la dichiarazione di `verificaInadTab` (cerca `const [verificaInadTab, setVerificaInadTab] = useState<'singola' | 'massiva'>('singola');`), aggiungi:

```ts
  const [domicilioCf, setDomicilioCf] = useState('');
  const [domicilioLoading, setDomicilioLoading] = useState(false);
  const [domicilioResult, setDomicilioResult] = useState<{
    codiceFiscale: string;
    inad: { success: boolean; found: boolean; digitalAddress?: Array<{ digitalAddress: string; practicedProfession?: string }>; message?: string };
    appIo: { success: boolean; active: boolean; message: string };
    anpr: { success: boolean; found: boolean; generalita?: { cognome?: string; nome?: string; dataNascita?: string }; residenza?: Array<{ dataDecorrenzaResidenza?: string; indirizzo?: { cap?: string; comune?: { nomeComune?: string }; toponimo?: { specie?: string; denominazioneToponimo?: string }; numeroCivico?: { numero?: string } } }>; message?: string };
  } | null>(null);
```

- [ ] **Step 2: Aggiungi l'handler di ricerca**

Subito dopo la funzione `runVerificaInad` esistente (cerca `const runVerificaInad = async () => {` e la sua chiusura `};`), aggiungi:

```ts
  const runCercaDomicilio = async () => {
    if (!domicilioCf.trim()) return;
    setDomicilioLoading(true);
    setDomicilioResult(null);
    try {
      const res = await apiFetch('/domicilio/cerca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: domicilioCf }),
      });
      const data = await res.json();
      setDomicilioResult(data);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message || 'Errore di connessione durante la ricerca');
    } finally {
      setDomicilioLoading(false);
    }
  };
```

- [ ] **Step 3: Aggiungi il tipo view e la voce di menu**

Modifica la union del `view` (cerca `const [view, setView] = useState<'dashboard' | ...`), aggiungi `'cerca-domicilio'` dopo `'notifiche-ricerca'`:

```ts
  const [view, setView] = useState<'dashboard' | 'invio-massivo' | 'invio-massivo-wizard' | 'statistiche' | 'notifiche-ricerca' | 'cerca-domicilio' | 'verifica-appio' | 'verifica-inad' | 'template-dashboard' | 'impostazioni' | 'campaign-detail' | 'audit-logs' | 'arricchimento'>('dashboard');
```

Nel menu laterale, subito prima della voce `<a className={\`bo-nav-item ${view === 'verifica-appio' ...}\`}>` (sezione "Utility"), aggiungi:

```tsx
          <a
            className={`bo-nav-item ${view === 'cerca-domicilio' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('cerca-domicilio'); setDomicilioCf(''); setDomicilioResult(null); }}
          >
            <MapPin />
            <span>Cerca Domicilio</span>
          </a>
```

- [ ] **Step 4: Rimuovi la tab "Verifica singola" da App IO**

Nel blocco `{view === 'verifica-appio' && (`, sostituisci l'intera `<ul className="nav nav-tabs mb-4">...</ul>` e il blocco `{verificaTab === 'singola' && (...)}` (righe 8660–8745 circa) in modo che resti solo il contenuto massivo, rinominando il titolo. Il blocco diventa:

```tsx
          {view === 'verifica-appio' && (
            <div style={{ maxWidth: '700px', margin: '0 auto' }}>
              <h3 className="h5 fw-bold text-dark mb-3">
                <UserCheck className="me-2" size={16} />Verifica massiva App IO
              </h3>

              <div className="card shadow-sm p-4 mb-4">
                <p className="small text-muted mb-3">
                  Carica un CSV con un elenco di codici fiscali: la verifica gira in background (può richiedere alcuni minuti su elenchi ampi) e produce due CSV scaricabili, con le stesse colonne del file originale — destinatari raggiungibili su App IO e tutti gli altri. Per una verifica puntuale su un singolo codice fiscale, usa "Cerca Domicilio" nel menu.
                </p>
```

(la `<p>` sostituisce quella già presente dentro il vecchio blocco `{verificaTab === 'massiva' && (`, che va rimosso — resta solo il contenuto del `<div className="card...">`, tolto il wrapping condizionale `{verificaTab === 'massiva' && (` / relativa chiusura `)}`).

Rimuovi anche, più in alto nel file, gli state ora inutilizzati: `verificaTab`, `verificaCf`, `verificaResult`, `verificaLoading` e la funzione `runVerificaAppIo` — **ATTENZIONE**: prima di rimuoverli, verifica con una ricerca (`grep -n "verificaTab\|verificaCf\b\|verificaResult\b\|verificaLoading\|runVerificaAppIo"`) che non restino altri riferimenti nel file oltre a quelli già mostrati in questo piano; se un riferimento non era previsto, non rimuovere quello state, segnalarlo.

- [ ] **Step 5: Rimuovi la tab "Verifica singola" da INAD**

Stessa operazione sul blocco `{view === 'verifica-inad' && (`: rimuovi `<ul className="nav nav-tabs mb-4">...</ul>` e il blocco `{verificaInadTab === 'singola' && (...)}`, lasciando solo il contenuto di `{verificaInadTab === 'massiva' && (...)}` (tolto il wrapping condizionale). Il titolo diventa:

```tsx
              <h3 className="h5 fw-bold text-dark mb-3">
                <Contact className="me-2" size={16} />Verifica massiva INAD
              </h3>

              <div className="card shadow-sm p-4 mb-4">
                <p className="small text-muted mb-3">
                  Carica un CSV con un elenco di codici fiscali: la verifica gira in background su INAD (batch fino a 1000 CF, 5-10 minuti per elaborazione) e produce due CSV scaricabili, con le stesse colonne del file originale — destinatari con domicilio digitale trovato (con colonna aggiuntiva "domicilio_digitale_inad") e tutti gli altri. Per una verifica puntuale su un singolo codice fiscale, usa "Cerca Domicilio" nel menu.
                </p>
```

Rimuovi gli state ora inutilizzati: `verificaInadTab`, `verificaInadCf`, `verificaInadResult`, `verificaInadLoading` e la funzione `runVerificaInad` — stessa verifica preventiva con `grep` del passo precedente prima di rimuoverli, e aggiorna anche l'`onClick` della voce di menu "Verifica INAD" (righe ~5496-5503) rimuovendo `setVerificaInadCf('')`/`setVerificaInadResult(null)` (lo state non esiste più):

```tsx
          <a
            className={`bo-nav-item ${view === 'verifica-inad' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('verifica-inad'); }}
          >
            <img src={EMBEDDED_LOGOS.INAD} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
            <span>Verifica INAD</span>
          </a>
```

Stessa modifica per la voce di menu "Verifica App IO" (rimuovi `setVerificaCf('')`/`setVerificaResult(null)`).

- [ ] **Step 6: Aggiungi la nuova pagina "Cerca Domicilio"**

Subito dopo la chiusura del blocco `{view === 'verifica-inad' && (...)}`, aggiungi la nuova view:

```tsx
          {view === 'cerca-domicilio' && (
            <div style={{ maxWidth: '900px', margin: '0 auto' }}>
              <h3 className="h5 fw-bold text-dark mb-3">
                <MapPin className="me-2" size={16} />Cerca Domicilio
              </h3>
              <p className="small text-muted mb-4">
                Inserisci il codice fiscale di un cittadino per interrogare insieme INAD (domicilio digitale eletto),
                App IO (stato di attivazione) e ANPR (residenza anagrafica) e vedere la scheda completa.
              </p>

              <div className="card shadow-sm p-4 mb-4">
                <div className="mb-3">
                  <label className="form-label small fw-bold">Codice Fiscale</label>
                  <div className="input-group input-group-sm">
                    <span className="input-group-text"><Contact size={16} /></span>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Inserisci il codice fiscale (16 caratteri)"
                      maxLength={16}
                      value={domicilioCf}
                      onChange={e => setDomicilioCf(e.target.value.toUpperCase().trim())}
                      onKeyDown={e => { if (e.key === 'Enter') runCercaDomicilio(); }}
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={runCercaDomicilio}
                      disabled={domicilioLoading || !domicilioCf.trim()}
                    >
                      {domicilioLoading ? (
                        <>
                          <Loader2 className="icon-spin me-1" size={16} />Ricerca...
                        </>
                      ) : (
                        <>
                          <Search className="me-1" size={16} />Cerca
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {domicilioResult && (
                <div className="row g-3">
                  <div className="col-md-4">
                    <div className={`card shadow-sm p-3 h-100 border ${
                      !domicilioResult.inad.success ? 'border-danger' :
                      !domicilioResult.inad.found ? 'border-secondary' : 'border-success'
                    }`}>
                      <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
                        {!domicilioResult.inad.success ? <AlertCircle className="text-danger" size={16} /> :
                         !domicilioResult.inad.found ? <XCircle className="text-secondary" size={16} /> :
                         <CheckCircle2 className="text-success" size={16} />}
                        INAD
                      </h6>
                      {!domicilioResult.inad.success && <p className="small text-danger mb-0">{domicilioResult.inad.message}</p>}
                      {domicilioResult.inad.success && !domicilioResult.inad.found && <p className="small text-muted mb-0">Nessun domicilio digitale eletto</p>}
                      {domicilioResult.inad.success && domicilioResult.inad.found && (
                        <ul className="small mb-0 ps-3">
                          {(domicilioResult.inad.digitalAddress ?? []).map((a, i) => <li key={i}>{a.digitalAddress}</li>)}
                        </ul>
                      )}
                    </div>
                  </div>

                  <div className="col-md-4">
                    <div className={`card shadow-sm p-3 h-100 border ${
                      !domicilioResult.appIo.success ? 'border-danger' :
                      !domicilioResult.appIo.active ? 'border-secondary' : 'border-success'
                    }`}>
                      <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
                        {!domicilioResult.appIo.success ? <AlertCircle className="text-danger" size={16} /> :
                         !domicilioResult.appIo.active ? <XCircle className="text-secondary" size={16} /> :
                         <CheckCircle2 className="text-success" size={16} />}
                        App IO
                      </h6>
                      <p className="small text-muted mb-0">{domicilioResult.appIo.message}</p>
                    </div>
                  </div>

                  <div className="col-md-4">
                    <div className={`card shadow-sm p-3 h-100 border ${
                      !domicilioResult.anpr.success ? 'border-danger' :
                      !domicilioResult.anpr.found ? 'border-secondary' : 'border-success'
                    }`}>
                      <h6 className="fw-bold mb-2 d-flex align-items-center gap-2">
                        {!domicilioResult.anpr.success ? <AlertCircle className="text-danger" size={16} /> :
                         !domicilioResult.anpr.found ? <XCircle className="text-secondary" size={16} /> :
                         <CheckCircle2 className="text-success" size={16} />}
                        ANPR (residenza)
                      </h6>
                      {!domicilioResult.anpr.success && <p className="small text-danger mb-0">{domicilioResult.anpr.message}</p>}
                      {domicilioResult.anpr.success && !domicilioResult.anpr.found && <p className="small text-muted mb-0">Nessuna residenza trovata in ANPR</p>}
                      {domicilioResult.anpr.success && domicilioResult.anpr.found && domicilioResult.anpr.residenza?.[0] && (
                        <p className="small mb-0">
                          {domicilioResult.anpr.residenza[0].indirizzo?.toponimo?.specie} {domicilioResult.anpr.residenza[0].indirizzo?.toponimo?.denominazioneToponimo}
                          {domicilioResult.anpr.residenza[0].indirizzo?.numeroCivico?.numero ? `, ${domicilioResult.anpr.residenza[0].indirizzo.numeroCivico.numero}` : ''}
                          <br />
                          {domicilioResult.anpr.residenza[0].indirizzo?.cap} {domicilioResult.anpr.residenza[0].indirizzo?.comune?.nomeComune}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 7: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (in particolare nessun riferimento residuo a `verificaCf`/`verificaResult`/`verificaTab`/`verificaLoading`/`runVerificaAppIo`/`verificaInadCf`/`verificaInadResult`/`verificaInadTab`/`verificaInadLoading`/`runVerificaInad`)

- [ ] **Step 8: Verifica manuale in browser**

Run: `docker compose up -d frontend-admin` (se non già attivo)
Apri `http://localhost:3000`, login come operatore/admin (dev: `operator`/`operator` con `LDAP_HOST=mock`), verifica:
- Voce menu "Cerca Domicilio" presente e cliccabile
- "Verifica INAD" e "Verifica App IO" mostrano solo il contenuto massivo, senza tab
- La ricerca su "Cerca Domicilio" con un CF qualunque mostra le 3 card (fallirà su INAD/ANPR se le credenziali PDND non sono configurate in questo ambiente — atteso, verifica solo che la UI non si rompa e mostri gli errori nelle card)

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): pagina Cerca Domicilio unificata, rimuove tab singola INAD/App IO"
```

---

### Task 7: Verifica finale — suite completa

**Files:** nessuno (solo comandi di verifica)

**Interfaces:** N/A

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts` / `isLdapMock`) — nessun nuovo fallimento. Se emerge un fallimento nuovo, è una regressione da investigare prima di proseguire.

- [ ] **Step 2: Type-check backend completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 3: Type-check frontend-admin completo**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 4: Verifica config produzione**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: nessun errore (nessuna nuova variabile d'ambiente introdotta da questo piano — le chiavi ANPR vivono solo in `app_settings`, non in `.env`)

- [ ] **Step 5: Nota per il collaudo reale (non automatizzabile qui)**

Prima del rilascio, con credenziali PDND reali configurate: testare "Cerca Domicilio" su un CF vero e verificare in particolare la risposta ANPR C020 — i rischi noti di `2026-07-21-cerca-domicilio-anpr-design.md` (formato `Agid-JWT-TrackingEvidence`, `x5c` non necessario) vanno confermati qui. Se la risposta reale ha una forma diversa da quella assunta in `anpr.types.ts` (Task 2), aggiornare i tipi e il rendering delle card (Task 6) di conseguenza.
