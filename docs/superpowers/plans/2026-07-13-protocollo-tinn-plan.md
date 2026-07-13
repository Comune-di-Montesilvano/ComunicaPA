# Connettore Protocollo Informatico (TINN) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare un connettore SOAP reale verso il servizio di
Protocollo Informatico TINN (Login → Inserimento → Protocollazione),
sostituendo il tab Impostazioni "Protocollo" attualmente finto
(`localStorage`), e collegare un checkbox "Protocolla questo invio" nel
wizard campagne (obbligatorio per SEND) che, quando attivo, registra ogni
invio sul protocollo prima della trasmissione del canale.

**Architecture:** Nuovo modulo backend `apps/backend/src/protocollo/`
(`ProtocolloService`, `ProtocolloModule`) che costruisce a mano gli envelope
SOAP RPC/encoded (fetch + string template, nessuna libreria `soap`), con
cache in memoria del token DST di sessione. Le credenziali/config passano
dal registry `AppSettingsService` esistente (pattern identico a
`pdnd.*`/`send.*`). `SendStrategy` chiama `ProtocolloService.protocolla()`
prima del proprio invio placeholder se `campaign.channelConfig.protocolla`
è `true` (sempre vero per SEND), scrivendo il risultato in
`NotificationAttempt.responsePayload.protocollo` tramite il normale
meccanismo di merge già esistente nel queue processor.

**Tech Stack:** NestJS (backend), `fetch` nativo Node (nessuna nuova
dipendenza), React (frontend-admin), Jest.

## Global Constraints

- Le credenziali reali (URL, Codice Ente, Username, Password) NON vanno mai
  scritte in file versionati (spec, piano, codice, commit) — solo inserite
  da UI admin (cifrate come gli altri secret) o `.env` locale non tracciato.
- L'endpoint fornito dall'utente è di **produzione reale**: nessun test
  automatico in CI/jest deve chiamarlo davvero — solo `fetch` mockato nei
  test. Un singolo test manuale contro l'endpoint reale va fatto insieme
  all'utente, non come parte di questo piano.
- Namespace registry: tutte le nuove chiavi sotto `protocollo.*` (pattern
  piatto a stringa, vedi `apps/backend/src/settings/settings.registry.ts`).
- `protocollo.password` è secret (cifrato AES-256-GCM come gli altri,
  gestito automaticamente da `AppSettingsService`/`settings-crypto.ts` —
  nessun codice nuovo di cifratura da scrivere).
- Segnatura XML solo per `Flusso=U` (uscita) — l'ente è sempre mittente,
  mai destinatario, in questo scenario (ComunicaPA manda comunicazioni al
  cittadino).

---

### Task 1: `ProtocolloService` — Login + cache DST

**Files:**
- Create: `apps/backend/src/protocollo/protocollo.service.ts`
- Create: `apps/backend/src/protocollo/protocollo.service.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get<string>(key)` (esistente,
  `apps/backend/src/settings/app-settings.service.ts`)
- Produces: `ProtocolloService.login(forceRefresh?: boolean): Promise<string>`
  — ritorna il DST, usato dai task successivi.

- [ ] **Step 1: Scrivere il registry con le chiavi protocollo.\***

Modifica `apps/backend/src/settings/settings.registry.ts`, dopo la riga
`'inipec.prod.purposeId': { type: 'string', default: '' },` (riga 60)
inserire:

```ts
  'protocollo.provider': { type: 'string', default: 'tinn' },
  'protocollo.baseUrl': { type: 'string', default: '' },
  'protocollo.codiceEnte': { type: 'string', default: '' },
  'protocollo.username': { type: 'string', default: '' },
  'protocollo.password': { type: 'string', secret: true, default: '' },
  'protocollo.codiceTitolario': { type: 'string', default: '6022' },
  'protocollo.codiceAmministrazione': { type: 'string', default: '1' },
  'protocollo.unitaOrganizzativa': { type: 'string', default: '1' },
  'protocollo.mittenteDenominazione': { type: 'string', default: '' },
```

- [ ] **Step 2: Scrivere il test fallimentare per `login()`**

Crea `apps/backend/src/protocollo/protocollo.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ProtocolloService } from './protocollo.service';
import { AppSettingsService } from '../settings/app-settings.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'protocollo.baseUrl': 'https://proto.test.local/',
  'protocollo.codiceEnte': '0000000000',
  'protocollo.username': 'OPERATORE_WS',
  'protocollo.password': 'segreta',
  'protocollo.codiceTitolario': '6022',
  'protocollo.codiceAmministrazione': '1',
  'protocollo.unitaOrganizzativa': '1',
  'protocollo.mittenteDenominazione': 'Comune di Prova',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

function soapEnvelope(body: string) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

describe('ProtocolloService', () => {
  let service: ProtocolloService;

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        ProtocolloService,
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(ProtocolloService);
  });

  it('esegue il login e ritorna il DST', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-token-123</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });

    const dst = await service.login();
    expect(dst).toBe('dst-token-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://proto.test.local/');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('0000000000');
    expect(init.body).toContain('OPERATORE_WS');
    expect(init.body).toContain('segreta');
  });

  it('riusa il DST in cache finché non forzato', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-1</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });
    await service.login();
    await service.login();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rifà login se forceRefresh è true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-1</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });
    await service.login();
    await service.login(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('lancia errore leggibile se il servizio risponde IngErrNumber != 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST></strDST><IngErrNumber>5</IngErrNumber><strErrString>Credenziali non valide</strErrString></return></LoginResponse>',
      )),
    });
    await expect(service.login()).rejects.toThrow(/Login Protocollo fallito.*Credenziali non valide/);
  });
});
```

- [ ] **Step 2b: Eseguire il test per verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest protocollo.service --maxWorkers=2`
Expected: FAIL — `Cannot find module './protocollo.service'`

- [ ] **Step 3: Implementare `ProtocolloService.login()`**

Crea `apps/backend/src/protocollo/protocollo.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../settings/app-settings.service';
import type { SettingKey } from '../settings/settings.registry';

interface ProtocolloConfig {
  baseUrl: string;
  codiceEnte: string;
  username: string;
  password: string;
  codiceTitolario: string;
  codiceAmministrazione: string;
  unitaOrganizzativa: string;
  mittenteDenominazione: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : '';
}

@Injectable()
export class ProtocolloService {
  private readonly logger = new Logger(ProtocolloService.name);
  private cachedDst: string | null = null;

  constructor(private readonly settings: AppSettingsService) {}

  private async getConfig(): Promise<ProtocolloConfig> {
    const [baseUrl, codiceEnte, username, password, codiceTitolario, codiceAmministrazione, unitaOrganizzativa, mittenteDenominazione] = await Promise.all([
      this.settings.get<string>('protocollo.baseUrl' as SettingKey),
      this.settings.get<string>('protocollo.codiceEnte' as SettingKey),
      this.settings.get<string>('protocollo.username' as SettingKey),
      this.settings.get<string>('protocollo.password' as SettingKey),
      this.settings.get<string>('protocollo.codiceTitolario' as SettingKey),
      this.settings.get<string>('protocollo.codiceAmministrazione' as SettingKey),
      this.settings.get<string>('protocollo.unitaOrganizzativa' as SettingKey),
      this.settings.get<string>('protocollo.mittenteDenominazione' as SettingKey),
    ]);
    const missing = Object.entries({ baseUrl, codiceEnte, username, password })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione Protocollo incompleta: mancano ${missing.join(', ')}`);
    }
    return { baseUrl, codiceEnte, username, password, codiceTitolario, codiceAmministrazione, unitaOrganizzativa, mittenteDenominazione };
  }

  private async soapCall(baseUrl: string, soapAction: string, body: string): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"http://tempuri.org/#${soapAction}"`,
      },
      body: envelope,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Chiamata Protocollo (${soapAction}) fallita: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    return text;
  }

  /** Esegue il login (o riusa il DST in cache) e ritorna il token di sessione. */
  async login(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedDst) {
      return this.cachedDst;
    }
    const config = await this.getConfig();
    const body = `<Login xmlns="http://tempuri.org/"><CodiceEnte>${xmlEscape(config.codiceEnte)}</CodiceEnte><Username>${xmlEscape(config.username)}</Username><UserPassword>${xmlEscape(config.password)}</UserPassword></Login>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Login', body);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Login Protocollo fallito (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    const dst = extractTag(responseXml, 'strDST');
    if (!dst) {
      throw new Error(`Login Protocollo: risposta priva di strDST — ${responseXml.slice(0, 300)}`);
    }
    this.cachedDst = dst;
    this.logger.log('Login Protocollo eseguito, DST ottenuto');
    return dst;
  }

  clearCache(): void {
    this.cachedDst = null;
  }
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest protocollo.service --maxWorkers=2`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts apps/backend/src/protocollo/protocollo.service.ts apps/backend/src/protocollo/protocollo.service.spec.ts
git commit -m "feat(backend): registry protocollo.* e ProtocolloService.login() con cache DST"
```

---

### Task 2: `ProtocolloService` — Inserimento + Protocollazione

**Files:**
- Modify: `apps/backend/src/protocollo/protocollo.service.ts`
- Modify: `apps/backend/src/protocollo/protocollo.service.spec.ts`

**Interfaces:**
- Consumes: `login()` da Task 1, `getConfig()`/`soapCall()`/`extractTag()`
  privati già presenti.
- Produces: `ProtocolloService.protocolla(input: ProtocollaInput): Promise<ProtocollaResult>`
  con:
  ```ts
  export interface ProtocollaInput {
    oggetto: string;
    destinatario: { codiceFiscale: string; nome: string; cognome: string; denominazione: string };
    documentBuffer: Buffer;
    documentFilename: string;
  }
  export interface ProtocollaResult {
    numeroProtocollo: number;
    annoProtocollo: number;
    dataProtocollazione: string;
  }
  ```
  Usato da `SendStrategy` in Task 4.

- [ ] **Step 1: Aggiungere i test per `protocolla()`**

Aggiungi in fondo a `apps/backend/src/protocollo/protocollo.service.spec.ts`
(dentro lo stesso `describe`, dopo i test di `login`):

```ts
  it('esegue Inserimento + Protocollazione e ritorna numero/anno/data', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<LoginResponse><return><strDST>dst-abc</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<InserimentoResponse><return><IngDocID>999</IngDocID><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></InserimentoResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<ProtocollazioneResponse><return><IngNumPG>4321</IngNumPG><IngAnnoPG>2026</IngAnnoPG><StrDataPG>13/07/2026</StrDataPG><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></ProtocollazioneResponse>',
        )),
      });

    const result = await service.protocolla({
      oggetto: 'Avviso TARI 2026',
      destinatario: { codiceFiscale: 'RSSMRA85M01H501Z', nome: 'Mario', cognome: 'Rossi', denominazione: 'Mario Rossi' },
      documentBuffer: Buffer.from('%PDF-1.4 test'),
      documentFilename: 'avviso.pdf',
    });

    expect(result).toEqual({ numeroProtocollo: 4321, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const inserimentoBody = mockFetch.mock.calls[1][1].body as string;
    expect(inserimentoBody).toContain('dst-abc');

    const protocollazioneBody = mockFetch.mock.calls[2][1].body as string;
    expect(protocollazioneBody).toContain('RSSMRA85M01H501Z');
    expect(protocollazioneBody).toContain('<Flusso>U</Flusso>');
    expect(protocollazioneBody).toContain('id="999"');
  });

  it('lancia errore leggibile se Protocollazione fallisce', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<LoginResponse><return><strDST>dst-abc</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<InserimentoResponse><return><IngDocID>999</IngDocID><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></InserimentoResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<ProtocollazioneResponse><return><IngNumPG>0</IngNumPG><IngAnnoPG>0</IngAnnoPG><StrDataPG></StrDataPG><IngErrNumber>7</IngErrNumber><strErrString>Classifica non valida</strErrString></return></ProtocollazioneResponse>',
        )),
      });

    await expect(service.protocolla({
      oggetto: 'Test',
      destinatario: { codiceFiscale: 'CF', nome: 'N', cognome: 'C', denominazione: 'N C' },
      documentBuffer: Buffer.from('x'),
      documentFilename: 'x.pdf',
    })).rejects.toThrow(/Protocollazione fallita.*Classifica non valida/);
  });
```

- [ ] **Step 2: Eseguire i test e verificare che i 2 nuovi falliscano**

Run: `docker compose exec backend node_modules/.bin/jest protocollo.service --maxWorkers=2`
Expected: FAIL — `service.protocolla is not a function`

- [ ] **Step 3: Implementare `protocolla()`**

In `apps/backend/src/protocollo/protocollo.service.ts`, aggiungi in cima al
file (dopo gli import esistenti) le due interfacce esportate:

```ts
export interface ProtocollaInput {
  oggetto: string;
  destinatario: { codiceFiscale: string; nome: string; cognome: string; denominazione: string };
  documentBuffer: Buffer;
  documentFilename: string;
}

export interface ProtocollaResult {
  numeroProtocollo: number;
  annoProtocollo: number;
  dataProtocollazione: string;
}
```

Poi aggiungi, dentro la classe `ProtocolloService`, dopo il metodo `login()`:

```ts
  private async inserimento(config: ProtocolloConfig, dst: string, fileBuffer: Buffer): Promise<number> {
    const base64 = fileBuffer.toString('base64');
    const body = `<Inserimento xmlns="http://tempuri.org/"><Username>${xmlEscape(config.username)}</Username><DSTLogin>${xmlEscape(dst)}</DSTLogin><FileBinario>${base64}</FileBinario></Inserimento>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Inserimento', body);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Inserimento Protocollo fallito (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    const docId = extractTag(responseXml, 'IngDocID');
    if (!docId) {
      throw new Error(`Inserimento Protocollo: risposta priva di IngDocID — ${responseXml.slice(0, 300)}`);
    }
    return Number(docId);
  }

  private buildSegnatura(config: ProtocolloConfig, input: ProtocollaInput, docId: number): string {
    const { destinatario } = input;
    return `<?xml version="1.0" encoding="utf-8"?><Segnatura versione="2001-05-07" xml:lang="it"><Intestazione><Oggetto>${xmlEscape(input.oggetto)}</Oggetto><Identificatore><NumeroRegistrazione>0</NumeroRegistrazione><DataRegistrazione>0</DataRegistrazione><Flusso>U</Flusso></Identificatore><Mittente><Amministrazione><Denominazione>${xmlEscape(config.mittenteDenominazione)}</Denominazione><IndirizzoTelematico tipo="smtp"></IndirizzoTelematico><UnitaOrganizzativa id="${xmlEscape(config.unitaOrganizzativa)}" /></Amministrazione></Mittente><Destinatario><Persona id="${xmlEscape(destinatario.codiceFiscale)}"><Nome>${xmlEscape(destinatario.nome)}</Nome><Cognome>${xmlEscape(destinatario.cognome)}</Cognome><CodiceFiscale>${xmlEscape(destinatario.codiceFiscale)}</CodiceFiscale><Denominazione>${xmlEscape(destinatario.denominazione)}</Denominazione><IndirizzoTelematico tipo="smtp"></IndirizzoTelematico></Persona></Destinatario><Classifica><CodiceAmministrazione>${xmlEscape(config.codiceAmministrazione)}</CodiceAmministrazione><CodiceTitolario>${xmlEscape(config.codiceTitolario)}</CodiceTitolario></Classifica></Intestazione><Descrizione><Documento id="${docId}" nome="${xmlEscape(input.documentFilename)}"><DescrizioneDocumento>${xmlEscape(input.oggetto)}</DescrizioneDocumento></Documento></Descrizione></Segnatura>`;
  }

  private async protocollazione(config: ProtocolloConfig, dst: string, segnaturaXml: string): Promise<ProtocollaResult> {
    const base64 = Buffer.from(segnaturaXml, 'utf-8').toString('base64');
    const body = `<Protocollazione xmlns="http://tempuri.org/"><Username>${xmlEscape(config.username)}</Username><DSTLogin>${xmlEscape(dst)}</DSTLogin><FileXML>${base64}</FileXML></Protocollazione>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Protocollazione', body);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Protocollazione fallita (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    return {
      numeroProtocollo: Number(extractTag(responseXml, 'IngNumPG')),
      annoProtocollo: Number(extractTag(responseXml, 'IngAnnoPG')),
      dataProtocollazione: extractTag(responseXml, 'StrDataPG'),
    };
  }

  /** Orchestratore: login (se serve) → Inserimento → Protocollazione (Flusso=U). */
  async protocolla(input: ProtocollaInput): Promise<ProtocollaResult> {
    const config = await this.getConfig();
    const dst = await this.login();
    const docId = await this.inserimento(config, dst, input.documentBuffer);
    const segnaturaXml = this.buildSegnatura(config, input, docId);
    const result = await this.protocollazione(config, dst, segnaturaXml);
    this.logger.log(`Protocollazione OK: ${result.numeroProtocollo}/${result.annoProtocollo}`);
    return result;
  }
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest protocollo.service --maxWorkers=2`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/protocollo/protocollo.service.ts apps/backend/src/protocollo/protocollo.service.spec.ts
git commit -m "feat(backend): ProtocolloService.protocolla() — Inserimento + Protocollazione Flusso=U"
```

---

### Task 3: `ProtocolloModule` + wiring in `SettingsModule`

**Files:**
- Create: `apps/backend/src/protocollo/protocollo.module.ts`
- Modify: `apps/backend/src/settings/settings.module.ts`

**Interfaces:**
- Consumes: `ProtocolloService` da Task 1-2.
- Produces: `ProtocolloModule` esportato, importabile da `ChannelModule`
  (Task 4).

- [ ] **Step 1: Creare il modulo**

Crea `apps/backend/src/protocollo/protocollo.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ProtocolloService } from './protocollo.service';

@Module({
  providers: [ProtocolloService],
  exports: [ProtocolloService],
})
export class ProtocolloModule {}
```

- [ ] **Step 2: Verificare che il modulo compili**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/protocollo/protocollo.module.ts
git commit -m "feat(backend): ProtocolloModule"
```

---

### Task 4: `SendStrategy` consuma `protocolla` dal channelConfig

**Files:**
- Modify: `apps/backend/src/channels/send/send.strategy.ts`
- Modify: `apps/backend/src/channels/send/send.strategy.spec.ts`
- Modify: `apps/backend/src/channels/channel.module.ts`

**Interfaces:**
- Consumes: `ProtocolloService.protocolla(input): Promise<ProtocollaResult>`
  (Task 2), `AttachmentService.generatePdfBuffer(recipient, index = 0): Promise<Buffer>`
  (esistente e invariato, `apps/backend/src/attachments/attachment.service.ts:61`).
- Produces: nessuna nuova interfaccia pubblica — modifica interna a
  `SendStrategy.send()`.

- [ ] **Step 1: Aggiungere il test per il branch `protocolla=true`**

In `apps/backend/src/channels/send/send.strategy.spec.ts`, aggiungi
l'import e un mock di `ProtocolloService` e `AttachmentService`, poi un
nuovo test. Sostituisci l'intero file con:

```ts
import { Test } from '@nestjs/testing';
import { SendStrategy } from './send.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockProtocollo = { protocolla: jest.fn(async () => ({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' })) };
const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockProtocollo.protocolla.mockClear();
    mockAttachments.generatePdfBuffer.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notificationRequestId: 'send-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        SendStrategy,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('send() chiama SEND API con recipientTaxId', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/notifications/sent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer voucher-abc' }),
        body: JSON.stringify({
          recipientTaxId: 'RSSMRA85M01H501Z',
          subject: 'Avviso',
          notificationBody: 'Testo notifica.',
        }),
      }),
    );
    expect(result.messageId).toBe('send-001');
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('test', 'purpose-test');
    expect(mockProtocollo.protocolla).not.toHaveBeenCalled();
  });

  it('send() lancia Error se SEND API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('SEND API error: 503');
  });

  it('send() protocolla prima dell\'invio se channelConfig.protocolla è true', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.', protocolla: true } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockProtocollo.protocolla).toHaveBeenCalledWith(expect.objectContaining({
      oggetto: 'Avviso',
      destinatario: expect.objectContaining({ codiceFiscale: 'RSSMRA85M01H501Z' }),
    }));
    expect(result.responsePayload).toEqual(expect.objectContaining({
      protocollo: { numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' },
    }));
  });

  it('send() fallisce se protocolla è true e la protocollazione fallisce', async () => {
    mockProtocollo.protocolla.mockRejectedValueOnce(new Error('Protocollazione fallita (7): Classifica non valida'));
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo.', protocolla: true } };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/Protocollazione fallita/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Eseguire i test e verificare che i nuovi falliscano**

Run: `docker compose exec backend node_modules/.bin/jest send.strategy --maxWorkers=2`
Expected: FAIL — `campaign.channelConfig.protocolla` non gestito,
`recipient.fullName` non splittato in nome/cognome, `AttachmentService`
non iniettato.

- [ ] **Step 3: Implementare il branch `protocolla` in `SendStrategy`**

Sostituisci il contenuto di `apps/backend/src/channels/send/send.strategy.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';

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
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

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
    const cfg = campaign.channelConfig as Record<string, unknown>;
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
    const notificationBody = interpolate((cfg['body'] as string) ?? '', vars);

    const extraResponsePayload: Record<string, unknown> = {};
    if (cfg['protocolla'] === true) {
      log(`Protocollazione SEND per CF ${recipient.codiceFiscale}`);
      const { nome, cognome } = splitFullName(recipient.fullName);
      const documentBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
      const protocolloResult = await this.protocollo.protocolla({
        oggetto: subject,
        destinatario: {
          codiceFiscale: recipient.codiceFiscale,
          nome,
          cognome,
          denominazione: recipient.fullName ?? recipient.codiceFiscale,
        },
        documentBuffer,
        documentFilename: `${recipient.codiceFiscale}.pdf`,
      });
      extraResponsePayload.protocollo = protocolloResult;
      log(`Protocollazione OK: ${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`);
    }

    log(`Invio notifica SEND a CF ${recipient.codiceFiscale} via ${baseUrl} (subject="${subject}")`);
    // TODO: endpoint e payload reali sono /delivery/v2.6/requests con schema
    // multipart (allegati via preload) — questo resta un placeholder in attesa
    // dell'implementazione del payload notifica completo (sotto-progetto 2).
    const response = await fetch(`${baseUrl}/delivery/notifications/sent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voucher}`,
      },
      body: JSON.stringify({
        recipientTaxId: recipient.codiceFiscale,
        subject,
        notificationBody,
      }),
    });
    log(`Risposta SEND per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      throw new Error(`SEND API error: ${response.status}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND inviata a CF ${recipient.codiceFiscale}: messageId=${data.notificationRequestId}`);
    return {
      messageId: data.notificationRequestId,
      responsePayload: { ...data, ...extraResponsePayload } as unknown as Record<string, unknown>,
    };
  }
}
```

`AttachmentService.generatePdfBuffer(recipient, index = 0)` è `async`,
ritorna `Promise<Buffer>` (`apps/backend/src/attachments/attachment.service.ts:61`)
— il codice sopra usa già `await` correttamente.

- [ ] **Step 4: Wiring in `channel.module.ts`**

Modifica `apps/backend/src/channels/channel.module.ts`: aggiungi
`import { ProtocolloModule } from '../protocollo/protocollo.module';` e
`import { AttachmentModule } from '../attachments/attachment.module';`
(nome esatto verificato: `AttachmentModule`, providers `[AttachmentService]`,
exports `[AttachmentService]` — `apps/backend/src/attachments/attachment.module.ts`).
Aggiungi entrambi all'array `imports: [PdfModule, PdndModule, ...]`.

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest send.strategy --maxWorkers=2`
Expected: PASS (5 test)

- [ ] **Step 6: `tsc --noEmit` completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send.strategy.ts apps/backend/src/channels/send/send.strategy.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): SendStrategy protocolla via ProtocolloService se channelConfig.protocolla"
```

---

### Task 5: Tab Impostazioni "Protocollo" reale (frontend-admin)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna nuova — segue esattamente il pattern dei tab già reali
  (`settPdndTest*`, load da `s['pdnd.*']`, save via `buildSettingsPayload`).
- Produces: nessuna interfaccia nuova — solo UI.

- [ ] **Step 1: Sostituire lo state fittizio**

In `apps/frontend-admin/src/App.tsx`, cerca (righe 645-648):

```ts
  const [settProtoProvider, setSettProtoProvider] = useState(localStorage.getItem('sett_proto_provider') || 'Maggioli');
  const [settProtoUrl, setSettProtoUrl] = useState(localStorage.getItem('sett_proto_url') || 'https://protocollo.comune.montesilvano.pe.it/api');
  const [settProtoUser, setSettProtoUser] = useState(localStorage.getItem('sett_proto_user') || 'api_user');
  const [settProtoPass, setSettProtoPass] = useState(localStorage.getItem('sett_proto_pass') || '••••••••');
```

Sostituisci con:

```ts
  const [settProtoProvider, setSettProtoProvider] = useState('tinn');
  const [settProtoUrl, setSettProtoUrl] = useState('');
  const [settProtoCodiceEnte, setSettProtoCodiceEnte] = useState('');
  const [settProtoUser, setSettProtoUser] = useState('');
  const [settProtoPass, setSettProtoPass] = useState('');
  const [settProtoCodiceTitolario, setSettProtoCodiceTitolario] = useState('6022');
  const [settProtoCodiceAmministrazione, setSettProtoCodiceAmministrazione] = useState('1');
  const [settProtoUnitaOrganizzativa, setSettProtoUnitaOrganizzativa] = useState('1');
  const [settProtoMittenteDenominazione, setSettProtoMittenteDenominazione] = useState('');
```

- [ ] **Step 2: Rimuovere il salvataggio su localStorage**

Cerca (righe 1353-1356):

```ts
    localStorage.setItem('sett_proto_provider', settProtoProvider);
    localStorage.setItem('sett_proto_url', settProtoUrl);
    localStorage.setItem('sett_proto_user', settProtoUser);
    localStorage.setItem('sett_proto_pass', settProtoPass);
```

Elimina queste 4 righe (nessuna sostituzione — il salvataggio ora passa dal
payload settings standard, vedi Step 4).

- [ ] **Step 3: Aggiungere il load da `AppSettingsService`**

Nel blocco di load (dove si trova, dopo la riga
`setSettInipecProdPurposeId(String(s['inipec.prod.purposeId'] ?? ''));`,
circa riga 792), aggiungi subito dopo:

```ts
        setSettProtoProvider(String(s['protocollo.provider'] ?? 'tinn'));
        setSettProtoUrl(String(s['protocollo.baseUrl'] ?? ''));
        setSettProtoCodiceEnte(String(s['protocollo.codiceEnte'] ?? ''));
        setSettProtoUser(String(s['protocollo.username'] ?? ''));
        setSettProtoPass(String(s['protocollo.password'] ?? ''));
        setSettProtoCodiceTitolario(String(s['protocollo.codiceTitolario'] ?? '6022'));
        setSettProtoCodiceAmministrazione(String(s['protocollo.codiceAmministrazione'] ?? '1'));
        setSettProtoUnitaOrganizzativa(String(s['protocollo.unitaOrganizzativa'] ?? '1'));
        setSettProtoMittenteDenominazione(String(s['protocollo.mittenteDenominazione'] ?? ''));
```

- [ ] **Step 4: Aggiungere il payload di save**

Cerca `'inipec.prod.purposeId': settInipecProdPurposeId,` (riga 1339) nel
blocco `buildSettingsPayload` e aggiungi subito dopo:

```ts
    'protocollo.provider': settProtoProvider,
    'protocollo.baseUrl': settProtoUrl,
    'protocollo.codiceEnte': settProtoCodiceEnte,
    'protocollo.username': settProtoUser,
    'protocollo.password': settProtoPass,
    'protocollo.codiceTitolario': settProtoCodiceTitolario,
    'protocollo.codiceAmministrazione': settProtoCodiceAmministrazione,
    'protocollo.unitaOrganizzativa': settProtoUnitaOrganizzativa,
    'protocollo.mittenteDenominazione': settProtoMittenteDenominazione,
```

- [ ] **Step 5: Riscrivere il JSX del tab**

Sostituisci il blocco (righe 5379-5427):

```tsx
                        {activeSettingsTab === 'protocollo' && (
                          <div className="row g-3">
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_provider">Provider Protocollo</label>
                              <select
                                id="proto_provider"
                                className="form-select form-select-sm"
                                value={settProtoProvider}
                                onChange={(e) => setSettProtoProvider(e.target.value)}
                              >
                                <option value="Maggioli">Maggioli (ApriPA)</option>
                                <option value="Saga">Saga (Siger)</option>
                                <option value="Halley">Halley Protocollo</option>
                                <option value="Custom">Strategia Custom (Plugin)</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_url">Endpoint Webservice</label>
                              <input
                                type="text"
                                id="proto_url"
                                className="form-control form-control-sm"
                                value={settProtoUrl}
                                onChange={(e) => setSettProtoUrl(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_user">User ID</label>
                              <input
                                type="text"
                                id="proto_user"
                                className="form-control form-control-sm"
                                value={settProtoUser}
                                onChange={(e) => setSettProtoUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_pass">Chiave/Password</label>
                              <input
                                type="password"
                                id="proto_pass"
                                className="form-control form-control-sm"
                                value={settProtoPass}
                                onChange={(e) => setSettProtoPass(e.target.value)}
                              />
                            </div>
                          </div>
                        )}
```

con:

```tsx
                        {activeSettingsTab === 'protocollo' && (
                          <div className="row g-3">
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_provider">Provider Protocollo</label>
                              <select
                                id="proto_provider"
                                className="form-select form-select-sm"
                                value={settProtoProvider}
                                onChange={(e) => setSettProtoProvider(e.target.value)}
                              >
                                <option value="tinn">TINN (Affari Generali)</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_url">URL Protocollazione</label>
                              <input
                                type="text"
                                id="proto_url"
                                className="form-control form-control-sm"
                                value={settProtoUrl}
                                onChange={(e) => setSettProtoUrl(e.target.value)}
                                placeholder="https://protows01.esempio.it/"
                                required
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_codice_ente">Codice Ente</label>
                              <input
                                type="text"
                                id="proto_codice_ente"
                                className="form-control form-control-sm"
                                value={settProtoCodiceEnte}
                                onChange={(e) => setSettProtoCodiceEnte(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_user">Username</label>
                              <input
                                type="text"
                                id="proto_user"
                                className="form-control form-control-sm"
                                value={settProtoUser}
                                onChange={(e) => setSettProtoUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_pass">Password</label>
                              <input
                                type="password"
                                id="proto_pass"
                                className="form-control form-control-sm"
                                value={settProtoPass}
                                onChange={(e) => setSettProtoPass(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_gerarchia">Gerarchia di Classificazione (Codice Titolario)</label>
                              <input
                                type="text"
                                id="proto_gerarchia"
                                className="form-control form-control-sm"
                                value={settProtoCodiceTitolario}
                                onChange={(e) => setSettProtoCodiceTitolario(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_codice_amm">Codice Amministrazione (Classifica)</label>
                              <input
                                type="text"
                                id="proto_codice_amm"
                                className="form-control form-control-sm"
                                value={settProtoCodiceAmministrazione}
                                onChange={(e) => setSettProtoCodiceAmministrazione(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_unita_org">Unità Organizzativa</label>
                              <input
                                type="text"
                                id="proto_unita_org"
                                className="form-control form-control-sm"
                                value={settProtoUnitaOrganizzativa}
                                onChange={(e) => setSettProtoUnitaOrganizzativa(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_mittente">Denominazione Mittente (Ente)</label>
                              <input
                                type="text"
                                id="proto_mittente"
                                className="form-control form-control-sm"
                                value={settProtoMittenteDenominazione}
                                onChange={(e) => setSettProtoMittenteDenominazione(e.target.value)}
                                placeholder="Es: Comune di Montesilvano"
                              />
                            </div>
                          </div>
                        )}
```

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): tab Protocollo reale, non piu' localStorage fittizio"
```

---

### Task 6: Checkbox "Protocolla questo invio" nel wizard

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna.
- Produces: `campaign.channelConfig.protocolla: boolean`, consumato da
  `SendStrategy` (Task 4).

- [ ] **Step 1: Aggiungere lo state**

Vicino a `const [wizSubject, setWizSubject] = useState('');` (riga 471),
aggiungi:

```ts
  const [wizProtocolla, setWizProtocolla] = useState(false);
```

- [ ] **Step 2: Reset dello state al reset del wizard**

Cerca `setWizSubject('');` (riga 2305, dentro la funzione di reset wizard)
e aggiungi subito dopo:

```ts
    setWizProtocolla(false);
```

- [ ] **Step 3: Caricare il valore quando si riprende una bozza**

Cerca `setWizSubject(source.channelConfig?.subject || '');` (riga 2351) e
aggiungi subito dopo:

```ts
    setWizProtocolla(Boolean(source.channelConfig?.protocolla));
```

- [ ] **Step 4: Forzare `true` quando il canale è SEND**

In `apps/frontend-admin/src/App.tsx` riga ~3515-3526, il select "Canale di
Invio Principale" ha un `onChange` inline. Cerca:

```tsx
                      onChange={(e: any) => {
                        const newChan = e.target.value as any;
                        setWizChannel(newChan);
                        const activeCfg = mailConfigs.find(c => c.type === newChan && c.active);
                        setWizMailConfigId(activeCfg?.id || '');
                        setWizBlockedChannels(prev => prev.filter(x => x !== newChan));
                      }}
```

sostituisci con:

```tsx
                      onChange={(e: any) => {
                        const newChan = e.target.value as any;
                        setWizChannel(newChan);
                        const activeCfg = mailConfigs.find(c => c.type === newChan && c.active);
                        setWizMailConfigId(activeCfg?.id || '');
                        setWizBlockedChannels(prev => prev.filter(x => x !== newChan));
                        if (newChan === 'SEND') setWizProtocolla(true);
                      }}
```

- [ ] **Step 5: Aggiungere il checkbox nello step 4 del wizard**

In `apps/frontend-admin/src/App.tsx`, dentro il blocco `{wizStep === 4 && (`
(riga 4130), subito dopo il blocco `{wizAppIoBodyLenInvalid && (...)}`
(righe 4164-4170) e prima di `<div className="mt-4 pt-3 border-top ...">`
(riga 4172), inserisci:

```tsx
                    <div className="form-check mt-3">
                      <input
                        type="checkbox"
                        className="form-check-input"
                        id="wiz_protocolla"
                        checked={wizProtocolla}
                        disabled={wizChannel === 'SEND'}
                        onChange={(e) => setWizProtocolla(e.target.checked)}
                      />
                      <label className="form-check-label small" htmlFor="wiz_protocolla">
                        Protocolla questo invio
                        {wizChannel === 'SEND' && (
                          <span className="text-muted"> (obbligatorio per SEND: ogni invio viene registrato sul Protocollo Informatico prima della trasmissione)</span>
                        )}
                      </label>
                    </div>
```

- [ ] **Step 6: Includere `protocolla` in `buildWizChannelConfigDraft`**

In `buildWizChannelConfigDraft` (righe 2437-2467), nella riga iniziale:

```ts
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId };
```

sostituisci con:

```ts
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId, protocolla: wizProtocolla };
```

- [ ] **Step 7: Includere `protocolla` in `handleWizLaunch`**

Cerca il branch SEND in `handleWizLaunch` (riga 2550-2552):

```ts
      } else if (wizChannel === 'SEND') {
        channelConfig = {};
      }
```

sostituisci con:

```ts
      } else if (wizChannel === 'SEND') {
        channelConfig = { subject: wizSubject, body: wizBody, protocolla: true };
      }
```

Poi, subito dopo il blocco `if (wizPaymentEnabled) { ... }` (righe
2554-2565) e prima di `if (wizBlockedChannels.length > 0) {` (riga 2567),
aggiungi per gli altri canali:

```ts
      if (wizChannel !== 'SEND') {
        channelConfig.protocolla = wizProtocolla;
      }
```

- [ ] **Step 8: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): checkbox 'Protocolla questo invio' nel wizard, obbligatorio per SEND"
```

---

### Task 7: Verifica end-to-end

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite completa backend**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set del baseline noto (solo
`app.controller.spec.ts` per `LDAP_HOST=mock`, pre-esistente e non
correlato), nessun nuovo fallimento.

- [ ] **Step 2: Type-check completo**

Run:
```
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore in entrambi.

- [ ] **Step 3: Verifica UI manuale**

Dev server attivo (`docker compose up -d`), login admin, Impostazioni →
tab "Protocollo": verificare che i campi si carichino/salvino tramite
"Salva Impostazioni" (non più `localStorage` — controllare in
`app_settings` via `psql` che le chiavi `protocollo.*` compaiano dopo il
salvataggio). Wizard → selezionare canale SEND: verificare che il
checkbox "Protocolla questo invio" risulti spuntato e disabilitato;
cambiare canale a EMAIL: verificare che torni libero/deselezionabile.

- [ ] **Step 4: Nessuna chiamata reale al servizio Protocollo in questa fase**

Non testare `ProtocolloService.protocolla()` contro l'endpoint reale come
parte di questo piano — richiede le credenziali reali inserite da UI e va
fatto con l'utente presente, fuori da questo ciclo di implementazione
automatizzato.
