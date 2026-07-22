# ANPR C019 data decesso + riordino Impostazioni — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il pannello "Verifica Anagrafica" mostra la data decesso (da ANPR C019) sotto il badge "Deceduto" quando disponibile, chiamando C019 solo se C002 ha già segnalato il soggetto deceduto. La sezione Impostazioni → ANPR viene riorganizzata con due Purpose ID distinti (C002/C019) al posto del fieldset "Collaudo" morto.

**Architecture:** Nuovo metodo `AnprService.getEsistenzaInVita()` (stesso pattern crittografico PDND di `getResidenza()`, URL/aud C019). `DomicilioService` lo invoca in modo condizionale dopo l'esito C002. Frontend: nuova rotta Impostazioni a due Purpose ID, nuovo campo nel pannello di consultazione.

**Tech Stack:** NestJS/TypeScript (backend), React 19/TypeScript (frontend-admin), Jest.

## Global Constraints

- Nessuna modifica al flusso di invio campagne (wizard, strategy canale) — solo pannello "Verifica Anagrafica" e Impostazioni.
- Ambiente ANPR resta solo prod (nessun supporto test/UAT, invariato).
- Rename chiave settings `anpr.prod.purposeId` → `anpr.c002.purposeId`: valore da re-inserire manualmente in UI dopo il deploy (nessuna migrazione dati automatica, decisione esplicita già presa).
- Type-check backend (`docker compose exec backend node_modules/.bin/tsc --noEmit`) e frontend-admin (`docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`) puliti dopo ogni task.
- Suite backend (`docker compose exec backend node_modules/.bin/jest --maxWorkers=2`) con lo stesso failure set della baseline nota (solo `app.controller.spec.ts` `isLdapMock`) dopo ogni task che tocca test.

---

### Task 1: Settings registry + rotte test-connection dedicate

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts:88-89`
- Modify: `apps/backend/src/settings/settings.controller.ts:269-289`

**Interfaces:**
- Produces: chiavi settings `anpr.c002.purposeId`, `anpr.c019.purposeId` (rimossa `anpr.test.purposeId`, rinominata `anpr.prod.purposeId`→`anpr.c002.purposeId`). Rotte `POST admin/settings/anpr/c002/test-connection`, `POST admin/settings/anpr/c019/test-connection`, risposta `{ success: boolean; message: string }` (shape invariato).

- [ ] **Step 1: Aggiornare il registry**

In `apps/backend/src/settings/settings.registry.ts`, sostituire le righe 88-89:

```ts
  'anpr.test.purposeId': { type: 'string', default: '' },
  'anpr.prod.purposeId': { type: 'string', default: '' },
```

con:

```ts
  'anpr.c002.purposeId': { type: 'string', default: '' },
  'anpr.c019.purposeId': { type: 'string', default: '' },
```

- [ ] **Step 2: Sostituire la rotta di test ANPR nel controller**

In `apps/backend/src/settings/settings.controller.ts`, sostituire (righe 269-273):

```ts
  @Post('anpr/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testAnprConnection(@Param('env') env: string) {
    return this.testServicePurposeConnection(env, 'anpr');
  }
```

con:

```ts
  @Post('anpr/c002/test-connection')
  @HttpCode(HttpStatus.OK)
  async testAnprC002Connection() {
    return this.testAnprPurposeConnection('anpr.c002.purposeId');
  }

  @Post('anpr/c019/test-connection')
  @HttpCode(HttpStatus.OK)
  async testAnprC019Connection() {
    return this.testAnprPurposeConnection('anpr.c019.purposeId');
  }

  private async testAnprPurposeConnection(settingKey: SettingKey) {
    const purposeId = await this.appSettings.get<string>(settingKey);
    if (!purposeId) {
      return { success: false, message: `Purpose ID (${settingKey}) non configurato.` };
    }
    try {
      await this.pdndAuth.getVoucher('prod', purposeId, true);
      return { success: true, message: 'Voucher PDND ottenuto correttamente: client e finalità validi.' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante la richiesta del voucher PDND.' };
    }
  }
```

Nota: `testServicePurposeConnection` esistente resta invariato (ancora usato da `inipec`, `send`, `inad` con la logica `test`/`prod`) — non toccarlo, la nuova `testAnprPurposeConnection` è un metodo separato specifico per ANPR (che non ha più il concetto di ambiente test).

- [ ] **Step 3: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts apps/backend/src/settings/settings.controller.ts
git commit -m "$(cat <<'EOF'
refactor(backend): chiavi settings ANPR C002/C019 dedicate, rotte test separate

anpr.prod.purposeId -> anpr.c002.purposeId (rinominata per chiarezza,
C002 e C019 sono finalità PDND distinte), rimossa anpr.test.purposeId
(mai realmente raggiungibile, AnprService chiama sempre prod), nuova
anpr.c019.purposeId per il servizio di accertamento esistenza in vita.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: AnprService.getEsistenzaInVita (C019)

**Files:**
- Modify: `apps/backend/src/channels/anpr/anpr.types.ts`
- Modify: `apps/backend/src/channels/anpr/anpr.service.ts`
- Modify: `apps/backend/src/channels/anpr/anpr.service.spec.ts`

**Interfaces:**
- Consumes: `SettingKey` da `settings.registry.ts` (Task 1), `PdndAuthService.signAgidJwt`/`getVoucherWithDigest` (esistenti, invariati).
- Produces: `AnprEsistenzaInVitaResult` (nuovo export in `anpr.types.ts`), `AnprService.getEsistenzaInVita(codiceFiscale: string, operatorUsername: string): Promise<AnprEsistenzaInVitaResult>`.

- [ ] **Step 1: Aggiornare il test esistente per la chiave rinominata**

In `apps/backend/src/channels/anpr/anpr.service.spec.ts`, riga 11, sostituire:

```ts
  'anpr.prod.purposeId': 'purpose-anpr-prod',
```

con:

```ts
  'anpr.c002.purposeId': 'purpose-anpr-prod',
```

- [ ] **Step 2: Eseguire la suite per verificare che fallisca sulla chiave**

Run: `docker compose exec backend node_modules/.bin/jest anpr.service.spec --maxWorkers=2`
Expected: FAIL — `getResidenza` ancora legge `anpr.prod.purposeId` in `anpr.service.ts`, quindi con la chiave rinominata nel mock il purposeId risulta `undefined` e il test "propaga l'errore se il purposeId prod non è configurato" resta verde ma gli altri (che si aspettano `purpose-anpr-prod` nel voucher) falliscono.

- [ ] **Step 3: Aggiornare `getResidenza()` per usare la chiave rinominata**

In `apps/backend/src/channels/anpr/anpr.service.ts`, riga 65, sostituire:

```ts
      this.settings.get<string>('anpr.prod.purposeId' as SettingKey),
```

con:

```ts
      this.settings.get<string>('anpr.c002.purposeId' as SettingKey),
```

- [ ] **Step 4: Eseguire di nuovo la suite per verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest anpr.service.spec --maxWorkers=2`
Expected: PASS (4 test esistenti).

- [ ] **Step 5: Aggiungere il tipo `AnprEsistenzaInVitaResult`**

In `apps/backend/src/channels/anpr/anpr.types.ts`, in fondo al file, aggiungere:

```ts
export interface AnprEsistenzaInVitaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    esistenzaInVita?: 'S' | 'N';
    dataDecesso?: string;
  };
}
```

- [ ] **Step 6: Scrivere il test per `getEsistenzaInVita` (nuovo describe block)**

In `apps/backend/src/channels/anpr/anpr.service.spec.ts`, aggiungere in fondo al file (dopo la chiusura del `describe('AnprService.getResidenza', ...)` esistente, riga 129):

```ts

describe('AnprService.getEsistenzaInVita', () => {
  let service: AnprService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucherWithDigest.mockClear();
    mockPdndAuth.signAgidJwt.mockClear();
    settingsValues['anpr.c019.purposeId'] = 'purpose-anpr-c019';
    const module = await Test.createTestingModule({
      providers: [
        AnprService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(AnprService);
  });

  it('restituisce found:true, esistenzaInVita e dataDecesso quando ANPR risponde 200', async () => {
    const body = {
      idOperazioneANPR: 'op-2',
      listaSoggetti: {
        datiSoggetto: [
          {
            generalita: { codiceFiscale: { codFiscale: 'BNCCRL70A01H501W' }, cognome: 'Bianchi', nome: 'Carlo' },
            identificativi: { idANPR: 'ANPR-999999' },
            infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'N' }],
            dataDecesso: '2026-01-15',
          },
        ],
      },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

    const result = await service.getEsistenzaInVita('BNCCRL70A01H501W', 'mario.rossi');

    expect(result.found).toBe(true);
    expect(result.data?.idANPR).toBe('ANPR-999999');
    expect(result.data?.esistenzaInVita).toBe('N');
    expect(result.data?.dataDecesso).toBe('2026-01-15');

    const expectedTrackingDigest = createHash('sha256').update('jws-token-tracking').digest('hex');
    expect(mockPdndAuth.getVoucherWithDigest).toHaveBeenCalledWith('prod', 'purpose-anpr-c019', expectedTrackingDigest);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C019-servizioAccertamentoEsistenzaVita/v1/anpr-service-e002',
    );
    const sentBody = JSON.parse(init.body);
    expect(sentBody.datiRichiesta.casoUso).toBe('C019');

    const trackingCallArgs = mockPdndAuth.signAgidJwt.mock.calls[0];
    expect(trackingCallArgs[1]).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C019-servizioAccertamentoEsistenzaVita/v1',
    );
  });

  it('restituisce found:false quando ANPR risponde 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"listaErrori":[]}') });

    const result = await service.getEsistenzaInVita('BNCCRL70A01H501W', 'mario.rossi');

    expect(result).toEqual({ found: false });
  });
});
```

- [ ] **Step 7: Eseguire la suite per verificare che fallisca (metodo non esiste ancora)**

Run: `docker compose exec backend node_modules/.bin/jest anpr.service.spec --maxWorkers=2`
Expected: FAIL — `service.getEsistenzaInVita is not a function`.

- [ ] **Step 8: Implementare `getEsistenzaInVita` in `anpr.service.ts`**

In `apps/backend/src/channels/anpr/anpr.service.ts`, dopo le costanti `ANPR_C002_BASE_URL`/`ANPR_C002_ENDPOINT`/`ANPR_C002_AUD` esistenti (righe 9-18), aggiungere:

```ts
const ANPR_C019_BASE_URL =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C019-servizioAccertamentoEsistenzaVita/v1';
const ANPR_C019_ENDPOINT = `${ANPR_C019_BASE_URL}/anpr-service-e002`;
const ANPR_C019_AUD = 'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C019-servizioAccertamentoEsistenzaVita/v1';
```

Poi aggiungere l'interfaccia di risposta grezza (accanto a `RispostaE002OK` esistente, dopo la riga 30):

```ts
interface RispostaE019OK {
  idOperazioneANPR?: string;
  listaSoggetti?: {
    datiSoggetto?: Array<{
      generalita: AnprGeneralita;
      identificativi?: { idANPR?: string };
      infoSoggettoEnte?: AnprInfoSoggettoEnte[];
      dataDecesso?: string;
    }>;
  };
}
```

Aggiornare l'import in cima al file (riga 7) per includere `AnprEsistenzaInVitaResult`:

```ts
import type { AnprResidenzaResult, AnprGeneralita, AnprResidenza, AnprInfoSoggettoEnte, AnprEsistenzaInVitaResult } from './anpr.types';
```

Infine, aggiungere il metodo nella classe `AnprService`, dopo `getResidenza()` (dopo la chiusura del metodo, riga 160):

```ts

  /**
   * C019 "Servizio di accertamento esistenza in vita" — e-service PDND
   * distinto da C002 (propria finalità/purposeId). Restituisce in più la
   * data decesso, non presente in C002 (confermato da doc ufficiale Sogei,
   * vedi CLAUDE.md). Stesso pattern di sicurezza di getResidenza().
   */
  async getEsistenzaInVita(codiceFiscale: string, operatorUsername: string): Promise<AnprEsistenzaInVitaResult> {
    const [purposeId, userLocation, loA] = await Promise.all([
      this.settings.get<string>('anpr.c019.purposeId' as SettingKey),
      this.settings.get<string>('anpr.trackingUserLocation' as SettingKey),
      this.settings.get<string>('anpr.trackingLoA' as SettingKey),
    ]);
    if (!purposeId) {
      throw new Error('Configurazione ANPR C019 incompleta: purposeId non impostato');
    }

    const trackingEvidence = await this.pdndAuth.signAgidJwt('prod', ANPR_C019_AUD, {
      purposeId,
      dnonce: Date.now().toString(),
      userID: operatorUsername,
      userLocation,
      LoA: loA,
    });
    const trackingDigestHex = createHash('sha256').update(trackingEvidence).digest('hex');

    const voucher = await this.pdndAuth.getVoucherWithDigest('prod', purposeId, trackingDigestHex);

    const idOperazioneClient = `${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const body = {
      idOperazioneClient,
      criteriRicerca: { codiceFiscale },
      datiRichiesta: {
        dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
        motivoRichiesta: 'comunicapa-cerca-domicilio',
        casoUso: 'C019',
      },
    };
    const bodyStr = JSON.stringify(body);
    const digest = `SHA-256=${createHash('sha256').update(bodyStr).digest('base64')}`;

    const signature = await this.pdndAuth.signAgidJwt('prod', ANPR_C019_AUD, {
      signed_headers: [{ digest }, { 'Content-Type': 'application/json' }],
    });

    this.logger.debug(`ANPR C019 request body: ${bodyStr}`);

    const response = await fetch(ANPR_C019_ENDPOINT, {
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

    const text = await response.text();
    this.logger.debug(`ANPR C019 response HTTP ${response.status}: ${text}`);
    if (response.status === 404) {
      return { found: false };
    }
    if (!response.ok) {
      throw new Error(`ANPR C019 fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: RispostaE019OK;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta ANPR C019 non valida (non JSON): ${text.slice(0, 200)}`);
    }

    const soggetto = data.listaSoggetti?.datiSoggetto?.[0];
    if (!soggetto) {
      return { found: false };
    }
    const vitaInfo = soggetto.infoSoggettoEnte?.find((i) => (i.chiave ?? '').toLowerCase().includes('vita'));
    return {
      found: true,
      data: {
        idANPR: soggetto.identificativi?.idANPR,
        generalita: soggetto.generalita,
        esistenzaInVita: vitaInfo?.valore as 'S' | 'N' | undefined,
        dataDecesso: soggetto.dataDecesso,
      },
    };
  }
```

**Nota per l'implementatore:** il campo `dataDecesso` letto da `soggetto.dataDecesso` (primo livello, fuori da `infoSoggettoEnte`) è un'ipotesi basata sulla prosa della documentazione Sogei ("La risposta del servizio prevede... data decesso" elencata come voce a sé, non dentro il gruppo `infoSoggettoEnte`) — lo yaml C019 non lo tipizza esplicitamente in `TipoDatiSoggettiEnte`. **Prima di considerare questo task concluso**, verificare con una chiamata reale (`LOG_LEVEL=debug`, CF deceduto reale con data decesso nota) la forma esatta del campo nel JSON grezzo e correggere il parsing se necessario (es. potrebbe essere dentro `infoSoggettoEnte` con chiave dedicata invece che a livello soggetto).

- [ ] **Step 9: Eseguire la suite per verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest anpr.service.spec --maxWorkers=2`
Expected: PASS (6 test totali).

- [ ] **Step 10: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 11: Verifica manuale dal vivo (conferma forma campo dataDecesso)**

Con `LOG_LEVEL=debug` attivo in `.env` (già presente in questo repo) e backend riavviato, chiamare `getEsistenzaInVita` per un CF deceduto reale (es. tramite lo script temporaneo usato in sessione precedente, o direttamente dopo il Task 3 tramite il pannello). Controllare nei log backend la riga `ANPR C019 response HTTP 200: ...` — se `dataDecesso` non compare a livello soggetto come atteso nello Step 8, correggere il parsing di conseguenza prima di proseguire.

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/channels/anpr/anpr.types.ts apps/backend/src/channels/anpr/anpr.service.ts apps/backend/src/channels/anpr/anpr.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): AnprService.getEsistenzaInVita (C019, data decesso)

C002 non restituisce mai la data decesso (confermato da doc ufficiale
Sogei) - C019 e' l'e-service PDND dedicato che la fornisce, stesso
pattern di sicurezza AUDIT_REST_02 di getResidenza() ma finalita'/
purposeId distinti.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: DomicilioService — chiamata condizionale a C019

**Files:**
- Modify: `apps/backend/src/channels/domicilio/domicilio.service.ts`
- Modify: `apps/backend/src/channels/domicilio/domicilio.service.spec.ts`

**Interfaces:**
- Consumes: `AnprService.getEsistenzaInVita(cf, operatorUsername): Promise<AnprEsistenzaInVitaResult>` (Task 2).
- Produces: nuovo campo `DomicilioSearchResult.anprEsistenzaInVita?: { success: boolean; dataDecesso?: string; message?: string }`.

- [ ] **Step 1: Scrivere il test per il nuovo comportamento**

In `apps/backend/src/channels/domicilio/domicilio.service.spec.ts`, aggiornare il mock `mockAnpr` (riga 9):

```ts
const mockAnpr = { getResidenza: jest.fn(), getEsistenzaInVita: jest.fn() };
```

Aggiungere due nuovi test dopo il test esistente "un fallimento di una fonte non impedisce la risposta delle altre due" (dopo riga 60, prima della chiusura del `describe`):

```ts

  it('chiama C019 e include la data decesso quando C002 segnala il soggetto deceduto', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Mingione' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'N' }] },
    });
    mockAnpr.getEsistenzaInVita.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Mingione' }, esistenzaInVita: 'N', dataDecesso: '2026-01-15' },
    });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(mockAnpr.getEsistenzaInVita).toHaveBeenCalledWith('CF1', 'mario.rossi');
    expect(result.anprEsistenzaInVita).toEqual({ success: true, dataDecesso: '2026-01-15' });
  });

  it('non chiama C019 quando il soggetto risulta in vita', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Rossi' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'S' }] },
    });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(mockAnpr.getEsistenzaInVita).not.toHaveBeenCalled();
    expect(result.anprEsistenzaInVita).toBeUndefined();
  });

  it('include un messaggio di errore esplicito se C019 fallisce', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Mingione' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'N' }] },
    });
    mockAnpr.getEsistenzaInVita.mockRejectedValue(new Error('Configurazione ANPR C019 incompleta: purposeId non impostato'));

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.anprEsistenzaInVita).toEqual({ success: false, message: 'Configurazione ANPR C019 incompleta: purposeId non impostato' });
  });
```

- [ ] **Step 2: Eseguire la suite per verificare che i 3 nuovi test falliscano**

Run: `docker compose exec backend node_modules/.bin/jest domicilio.service.spec --maxWorkers=2`
Expected: FAIL sui 3 nuovi test (`result.anprEsistenzaInVita` sempre `undefined`, il campo non esiste ancora).

- [ ] **Step 3: Implementare la logica in `domicilio.service.ts`**

Sostituire l'intero contenuto del metodo `cercaDomicilio` (e aggiungere il campo al tipo `DomicilioSearchResult`) — file completo aggiornato:

```ts
import { Injectable } from '@nestjs/common';
import { InadService, InadDigitalAddressElement } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';
import type { AnprGeneralita, AnprResidenza, AnprInfoSoggettoEnte } from '../anpr/anpr.types';

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

export interface DomicilioSearchResult {
  codiceFiscale: string;
  inad: DomicilioInadResult;
  appIo: DomicilioAppIoResult;
  anpr: DomicilioAnprResult;
  anprEsistenzaInVita?: DomicilioEsistenzaInVitaResult;
}

/**
 * Orchestratore "Cerca Domicilio": interroga INAD + App IO + ANPR in
 * parallelo per lo stesso CF. Nessuna persistenza — query live ogni volta.
 * Un fallimento di una fonte non deve azzerare le altre due già arrivate,
 * quindi ogni ramo cattura il proprio errore invece di propagarlo.
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
  ) {}

  async cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult> {
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
}
```

- [ ] **Step 4: Eseguire la suite per verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest domicilio.service.spec --maxWorkers=2`
Expected: PASS (5 test totali).

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/domicilio/domicilio.service.ts apps/backend/src/channels/domicilio/domicilio.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): DomicilioService interroga C019 solo se C002 segnala deceduto

Nuovo campo anprEsistenzaInVita su DomicilioSearchResult - la chiamata
C019 (finalita' PDND separata da C002) scatta solo quando il soggetto
risulta gia' deceduto secondo C002, mai per risparmiare quota su
soggetti in vita.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Impostazioni — Purpose ID C002/C019 dedicati

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (righe 61, 1489-1494, 1723-1726, 2636-2637, 2748-2749, 10645, 11221-11288)

**Interfaces:**
- Consumes: rotte backend `POST /admin/settings/anpr/c002/test-connection`, `POST /admin/settings/anpr/c019/test-connection` (Task 1), chiavi settings `anpr.c002.purposeId`/`anpr.c019.purposeId` (Task 1).
- Produces: nessuna nuova interfaccia esportata (componente applicativo, non un modulo consumato altrove).

- [ ] **Step 1: Rinominare lo stato React**

In `apps/frontend-admin/src/App.tsx`, righe 1489-1494, sostituire:

```ts
  const [settAnprTestPurposeId, setSettAnprTestPurposeId] = useState('');
  const [settAnprProdPurposeId, setSettAnprProdPurposeId] = useState('');
  const [settAnprTracingUserLocation, setSettAnprTracingUserLocation] = useState('');
  const [settAnprTracingLoA, setSettAnprTracingLoA] = useState('');
  const [settAnprTesting, setSettAnprTesting] = useState<'test' | 'prod' | null>(null);
  const [settAnprTestResult, setSettAnprTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);
```

con:

```ts
  const [settAnprC002PurposeId, setSettAnprC002PurposeId] = useState('');
  const [settAnprC019PurposeId, setSettAnprC019PurposeId] = useState('');
  const [settAnprTracingUserLocation, setSettAnprTracingUserLocation] = useState('');
  const [settAnprTracingLoA, setSettAnprTracingLoA] = useState('');
  const [settAnprTesting, setSettAnprTesting] = useState<'c002' | 'c019' | null>(null);
  const [settAnprTestResult, setSettAnprTestResult] = useState<{ key: 'c002' | 'c019'; ok: boolean; message: string } | null>(null);
```

- [ ] **Step 2: Aggiornare l'effect di caricamento impostazioni**

Riga 1723-1724, sostituire:

```ts
        setSettAnprTestPurposeId(String(s['anpr.test.purposeId'] ?? ''));
        setSettAnprProdPurposeId(String(s['anpr.prod.purposeId'] ?? ''));
```

con:

```ts
        setSettAnprC002PurposeId(String(s['anpr.c002.purposeId'] ?? ''));
        setSettAnprC019PurposeId(String(s['anpr.c019.purposeId'] ?? ''));
```

- [ ] **Step 3: Aggiornare il payload di salvataggio**

Righe 2636-2637, sostituire:

```ts
    'anpr.test.purposeId': settAnprTestPurposeId,
    'anpr.prod.purposeId': settAnprProdPurposeId,
```

con:

```ts
    'anpr.c002.purposeId': settAnprC002PurposeId,
    'anpr.c019.purposeId': settAnprC019PurposeId,
```

- [ ] **Step 4: Sostituire l'handler di test (non riusa più `runPdndTest`)**

Righe 2748-2749, sostituire:

```ts
  const handleTestAnprConnection = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/anpr/${env}/test-connection`, env, setSettAnprTesting, setSettAnprTestResult);
```

con:

```ts
  const handleTestAnprConnection = async (key: 'c002' | 'c019') => {
    setSettAnprTesting(key);
    setSettAnprTestResult(null);
    try {
      const saveRes = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: buildSettingsPayload() }),
      });
      if (!saveRes.ok) {
        const err = (await saveRes.json()) as { message?: string };
        setSettAnprTestResult({ key, ok: false, message: `Errore salvataggio: ${err.message ?? saveRes.status}` });
        return;
      }
      const res = await apiFetch(`/settings/anpr/${key}/test-connection`, { method: 'POST' });
      const data = (await res.json()) as { success: boolean; message: string };
      setSettAnprTestResult({ key, ok: data.success, message: data.message });
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setSettAnprTestResult({ key, ok: false, message: err.message || 'Errore di rete durante il test.' });
    } finally {
      setSettAnprTesting(null);
    }
  };
```

(`runPdndTest` resta invariato — usato da `pdnd`/`send`/`inad`, non toccarlo. `buildSettingsPayload` e `ApiAuthError` sono già disponibili nello scope del componente, usati identicamente altrove nel file.)

- [ ] **Step 5: Rinominare il tab/etichetta**

Riga 61, sostituire:

```ts
  { tab: 'anpr',             icon: MapPin,                 label: 'ANPR (C002)' },
```

con:

```ts
  { tab: 'anpr',             icon: MapPin,                 label: 'ANPR (C002/C019)' },
```

- [ ] **Step 6: Rinominare l'header pannello**

Riga 10645, sostituire:

```ts
                        {activeSettingsTab === 'anpr' && 'Integrazione ANPR (Servizio C002 - Servizio di Comunicazione)'}
```

con:

```ts
                        {activeSettingsTab === 'anpr' && 'Integrazione ANPR (C002 - Comunicazione, C019 - Esistenza in Vita)'}
```

- [ ] **Step 7: Riscrivere la sezione JSX Impostazioni ANPR**

Righe 11221-11288, sostituire l'intero blocco:

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

con:

```tsx
                        {activeSettingsTab === 'anpr' && (
                          <div>
                            <div className="alert alert-warning small mb-3">
                              Interrogazione disponibile solo in ambiente Produzione. Richiede lo stesso
                              client PDND già configurato nella tab "Client PDND" (kid/chiave privata) —
                              qui vanno impostati i due Purpose ID: C002 (Servizio di Comunicazione) e
                              C019 (Accertamento Esistenza in Vita), finalità PDND distinte.
                            </div>
                            {([
                              { label: 'C002 - Servizio di Comunicazione', key: 'c002' as const,
                                purposeId: settAnprC002PurposeId, setPurposeId: setSettAnprC002PurposeId },
                              { label: 'C019 - Accertamento Esistenza in Vita', key: 'c019' as const,
                                purposeId: settAnprC019PurposeId, setPurposeId: setSettAnprC019PurposeId },
                            ]).map((e) => (
                              <fieldset key={e.key} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`anpr_${e.key}_purposeid`}>Purpose ID</label>
                                  <input
                                    type="text"
                                    id={`anpr_${e.key}_purposeid`}
                                    className="form-control form-control-sm"
                                    value={e.purposeId}
                                    onChange={(ev) => e.setPurposeId(ev.target.value)}
                                  />
                                </div>
                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={settAnprTesting === e.key}
                                  onClick={() => handleTestAnprConnection(e.key)}
                                >
                                  {settAnprTesting === e.key ? 'Test in corso…' : 'Test connessione (voucher PDND)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e prova a ottenere un voucher PDND reale con client PDND + Purpose ID.</div>
                                {settAnprTestResult?.key === e.key && (
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
                              <div className="form-text small text-muted">Condiviso tra C002 e C019 (stesso claim Agid-JWT-TrackingEvidence). Valori di default non ancora verificati contro un ambiente PDND reale.</div>
                            </fieldset>
                          </div>
                        )}
```

- [ ] **Step 8: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 9: Verifica manuale in browser**

Impostazioni → tab "ANPR (C002/C019)": verificare che compaiano solo due fieldset (C002, C019), nessun "Collaudo". Re-inserire il Purpose ID C002 esistente (perso dal rename chiave), inserire il Purpose ID C019
(`d84007fd-8ac0-413c-bbce-46eeaf411ef0`, verificato funzionante in sessione precedente), premere "Salva Impostazioni", poi entrambi i bottoni "Test connessione" — atteso: entrambi `alert-success`.

- [ ] **Step 10: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
refactor(frontend-admin): Impostazioni ANPR, Purpose ID C002/C019 dedicati

Rimosso il fieldset "Collaudo (UAT)" mai realmente raggiungibile
(AnprService chiama sempre prod) - sostituito con due Purpose ID
distinti (C002, C019), ciascuno col proprio test di connessione.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pannello "Verifica Anagrafica" — data decesso

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (righe 897-918, 9884-9903)

**Interfaces:**
- Consumes: campo `anprEsistenzaInVita` nella response `POST /admin/domicilio/cerca` (Task 3), già propagato senza modifiche a `runCercaDomicilio` (assegna la response grezza a `domicilioResult` via `setDomicilioResult(data)`, riga 2010).

- [ ] **Step 1: Estendere il tipo di stato `domicilioResult`**

In `apps/frontend-admin/src/App.tsx`, dopo la chiusura del campo `anpr` (riga 917-918), che oggi è:

```ts
      message?: string;
    };
  } | null>(null);
```

sostituire con:

```ts
      message?: string;
    };
    anprEsistenzaInVita?: { success: boolean; dataDecesso?: string; message?: string };
  } | null>(null);
```

- [ ] **Step 2: Mostrare la data decesso sotto il badge**

Nel blocco badge "Deceduto"/"In vita" (righe 9897-9902), oggi:

```tsx
                        {anpr.success && anpr.found && vitaInfo && (
                          <span className={`badge px-3 py-2 rounded-pill ${vitaInfo.valore === 'S' ? 'bg-success-subtle text-success border border-success-subtle' : vitaInfo.valore === 'N' ? 'bg-danger-subtle text-danger border border-danger-subtle' : 'bg-secondary-subtle text-secondary'}`}>
                            {vitaInfo.valore === 'S' ? 'In vita' : vitaInfo.valore === 'N' ? 'Deceduto' : 'Non specificato'}
                            {vitaInfo.valore === 'N' && vitaInfo.valoreData ? ` il ${fmtDate(vitaInfo.valoreData)}` : ''}
                          </span>
                        )}
```

sostituire con:

```tsx
                        {anpr.success && anpr.found && vitaInfo && (
                          <div className="d-flex flex-column align-items-end gap-1">
                            <span className={`badge px-3 py-2 rounded-pill ${vitaInfo.valore === 'S' ? 'bg-success-subtle text-success border border-success-subtle' : vitaInfo.valore === 'N' ? 'bg-danger-subtle text-danger border border-danger-subtle' : 'bg-secondary-subtle text-secondary'}`}>
                              {vitaInfo.valore === 'S' ? 'In vita' : vitaInfo.valore === 'N' ? 'Deceduto' : 'Non specificato'}
                            </span>
                            {vitaInfo.valore === 'N' && domicilioResult.anprEsistenzaInVita?.success && domicilioResult.anprEsistenzaInVita.dataDecesso && (
                              <span className="small text-muted">Decesso avvenuto il {fmtDate(domicilioResult.anprEsistenzaInVita.dataDecesso)}</span>
                            )}
                            {vitaInfo.valore === 'N' && domicilioResult.anprEsistenzaInVita && !domicilioResult.anprEsistenzaInVita.success && (
                              <span className="small text-warning">Data decesso non disponibile ({domicilioResult.anprEsistenzaInVita.message})</span>
                            )}
                          </div>
                        )}
```

(`vitaInfo.valoreData` non è mai popolato da ANPR — il tentativo esistente di leggerlo è dead code, ora sostituito dalla lettura reale da C019.)

- [ ] **Step 3: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Verifica Anagrafica → un CF deceduto reale (non riportare il CF in commit/documentazione). Atteso: badge "Deceduto" con sotto "Decesso avvenuto il ..." se C019 restituisce la data (dipende dal Task 2 Step 11 — se la forma del campo richiede aggiustamenti, verificarlo qui), altrimenti riga di avviso gialla col messaggio d'errore. Poi un CF in vita (es. un CF AIRE reale) — atteso: nessuna riga aggiuntiva, badge "In vita" invariato.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): pannello Verifica Anagrafica mostra data decesso (C019)

Sotto il badge "Deceduto" (da C002) mostra la data decesso quando C019
la restituisce, o un avviso esplicito se C019 fallisce/non e'
configurato - mai silenzioso, il badge "Deceduto" da C002 resta
comunque affidabile in ogni caso.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
