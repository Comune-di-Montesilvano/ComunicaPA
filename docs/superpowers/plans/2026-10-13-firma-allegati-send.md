# Firma allegati SEND dal wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dal wizard SEND (massivo step 6/7 e Invio Manuale) l'operatore firma gli allegati non firmati con la firma remota OTP Aruba (ARSS) o, nel massivo, scaricando uno ZIP da firmare e ricaricando i firmati.

**Architecture:** Nuovo modulo backend `remote-sign/` (client SOAP ARSS, job BullMQ con sessione OTP, endpoint ZIP download/ricarico, prova firma). Ogni scrittura di allegato passa da un helper che fa backup dell'originale fuori dalla cartella uploads e scrive in modo atomico; ogni fine lavoro riavvia la verifica firma esistente. Frontend: componenti React separati (`components/signature/`) innestati nel wizard, nella modale dell'Invio Manuale e in una nuova scheda Impostazioni.

**Tech Stack:** NestJS 12 ESM, TypeORM, BullMQ, `soap`, `adm-zip`, `yauzl`, Vitest; React 19 + Vite.

**Spec:** `docs/superpowers/specs/2026-10-13-firma-allegati-send-design.md`

## Global Constraints

- Credenziali Aruba (utente, password, OTP) **mai** salvate in DB, mai loggate; su Redis solo la password cifrata `enc:v1:` (AES-256-GCM, `deriveSettingsKey(jwt.secret)`), job con `removeOnComplete: true, removeOnFail: true`.
- Mai loggare: password, OTP, sessionid, contenuto binario dei PDF.
- Endpoint ARSS default: `https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl`; dominio default `firma`; `typeHSM` default `COSIGN`; `certID` default `AS0`; profilo `PADESBES`; firma invisibile (nessun `Apparence`), `requiredmark=false`, `transport=BYNARYNET`.
- Backup originali in `<attachmentsRoot>/unsigned-backup/<campaignId>/` — **mai** dentro `getUploadsDir(id)` (`finalizeAttachments` cancella ogni voce non referenziata dal CSV).
- Ogni endpoint che può fallire per motivi "attesi" risponde **200** con `{ error }` / `{ blocked, message }` (il reverse proxy di prod sostituisce il body delle risposte non-2xx con una pagina HTML).
- Il CSV della campagna non viene mai modificato: i file firmati prendono sempre il **nome originale**.
- Suffissi accettati al ricarico (case-insensitive, prima di `.pdf`): `-signed`, `_signed`, `.signed`, `-firmato`, `_firmato`, ` (firmato)`.
- `.p7m` mai firmati né accettati al ricarico ("serve firma PAdES (PDF), non CAdES").
- Route operatore sotto `admin/*`, `@Roles('user', 'admin')` salvo Prova firma (`admin`).
- Ownership: admin qualunque campagna, `user` solo `campaign.createdBy === username`.
- Comandi test (stack dev su): `docker compose exec backend node_modules/.bin/vitest run <pattern>`. Se `docker compose ps` mostra lo stack spento, usare il fallback senza toccare lo stack:
  `MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh -v "$(pwd)/apps/backend/src:/app/apps/backend/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_backend_node_modules:/app/node_modules -w /app/apps/backend comunicapa/backend:dev -c 'node_modules/.bin/vitest run <pattern>'`
  (stesso schema per `tsc --noEmit` e `tsc -p tsconfig.spec.json --noEmit`; frontend: immagine `comunicapa/frontend-admin:dev`, mount `apps/frontend-admin/src` e `public`, `node_modules/.bin/tsc -p tsconfig.app.json --noEmit` — errore preesistente noto `App.tsx(5614,77) TS2322`, non è una regressione).
- Baseline backend: suite verde (eventuale fallimento noto `app.controller.spec.ts › isLdapMock` solo con stack dev `LDAP_HOST=mock`).
- Versione: bump `publiccode.yml` nella stessa PR, **numero da confermare con l'utente** prima del tag (proposta: v1.11.0, nuova funzionalità).

## Review Focus

1. **Ordine fine job → nuova verifica.** Il frontend considera "concluso" il job di firma e poi segue la *ultima* verifica: se il processor marca `done` PRIMA di creare la nuova verifica, la UI legge per un istante la verifica vecchia (`invalidCount > 0`) e mostra di nuovo "non firmati" / riapre la modale. Atteso: `startForCampaign` chiamato prima dell'update di stato finale. Test in Task 4 (ordine delle chiamate).
2. **Ricarico con file già firmati validamente** (operatore ricarica tutta la cartella, non solo i non validi). Atteso: quei file rifiutati "già firmato validamente", mai sovrascritti. Test in Task 1 e Task 5.
3. **ZIP con sottocartelle o nomi stile Windows** (`firmati\DOC_1.pdf`). Atteso: nomi appiattiti come già fa `flattenZipEntryName`, abbinamento riuscito. Test in Task 5.
4. **Lancio cliccato mentre la firma è in corso** (seconda scheda, o "Conferma ed Avvia" premuto prima della fine). Atteso: `blocked` "Firma remota in corso", campagna resta in bozza. Test in Task 4.
5. **OTP già usato / scaduto alla seconda pressione di "Firma"** (doppio click). Atteso: un solo job; il secondo invio risponde `{ error: 'Firma remota già in corso…' }` senza aprire una seconda sessione. Test in Task 4.

Limite noto, fuori perimetro: `extractPdfSignature` legge la **prima** firma del PDF; un PDF con una firma preesistente non valida resta "non valido" anche dopo la firma Aruba aggiuntiva. Il caso tipico (PDF senza firma) non è toccato.

---

## File Structure

Backend (`apps/backend/src/`):
- `remote-sign/signed-attachment-matcher.util.ts` — funzione pura di abbinamento nomi (Task 1)
- `remote-sign/arss-errors.ts` — `RemoteSignError` + classificazione codici ARSS (Task 2)
- `remote-sign/aruba-sign.client.ts` — client SOAP ARSS (Task 2)
- `remote-sign/test-pdf.ts` — PDF fisso di prova (Task 2)
- `settings/settings.registry.ts` — 5 chiavi `remoteSign.*` (Task 2)
- `attachments/attachment-paths.ts` — `getUnsignedBackupDir` (Task 3)
- `remote-sign/attachment-writer.util.ts` — backup + scrittura atomica (Task 3)
- `entities/remote-sign-job.entity.ts`, `database/migrations/1790600000000-CreateRemoteSignJobs.ts`, `database/database.module.ts`, `database/data-source.ts` (Task 3)
- `campaigns/campaigns.service.ts`, `campaigns/retention-cleanup.service.ts`, `campaigns/campaign-completion.service.ts` — pulizia backup (Task 3), gate lancio (Task 4)
- `remote-sign/remote-sign-job.types.ts`, `remote-sign/remote-sign.service.ts`, `remote-sign/remote-sign.processor.ts`, `remote-sign/remote-sign.controller.ts`, `remote-sign/dto/remote-sign-credentials.dto.ts`, `remote-sign/remote-sign.module.ts`, `app.module.ts`, `campaigns/campaigns.module.ts` (Task 4)
- `remote-sign/signed-attachments.service.ts`, `remote-sign/signed-attachments.controller.ts` (Task 5)

Frontend (`apps/frontend-admin/src/`):
- `chunked-upload.ts` — `uploadFileInChunks` estratto da `App.tsx` (Task 6)
- `components/signature/types.ts`, `components/signature/RemoteSignModal.tsx`, `components/signature/SignaturePanel.tsx` (Task 6)
- `App.tsx` — pannello step 6/7 (Task 6), modale Invio Manuale (Task 7), scheda Impostazioni (Task 8)

Docs (Task 9): `apps/frontend-admin/public/guida/guida.md`, `docs/claude/remote-sign.md`, `CLAUDE.md`, `docs/claude/ci-cd-deps.md`, `publiccode.yml`.

---

### Task 1: Abbinamento file firmati (funzione pura)

**Files:**
- Create: `apps/backend/src/remote-sign/signed-attachment-matcher.util.ts`
- Test: `apps/backend/src/remote-sign/signed-attachment-matcher.util.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MatchResult {
    matched: Array<{ uploaded: string; original: string }>;
    rejected: Array<{ file: string; reason: string }>;
  }
  export function matchSignedFiles(uploaded: string[], toSign: string[], alreadyValid: string[]): MatchResult;
  export const SIGNED_SUFFIXES: readonly string[];
  ```
  `uploaded` = nomi file già appiattiti; `toSign` = nomi originali da firmare; `alreadyValid` = nomi originali referenziati ma già validi.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/remote-sign/signed-attachment-matcher.util.spec.ts
import { describe, expect, it } from 'vitest';
import { matchSignedFiles } from './signed-attachment-matcher.util.js';

describe('matchSignedFiles', () => {
  const toSign = ['DOC_000001_00001.pdf', 'DOC_000002_00001.pdf'];

  it('abbina il nome identico (case-insensitive) al nome originale', () => {
    const r = matchSignedFiles(['doc_000001_00001.PDF'], toSign, []);
    expect(r.matched).toEqual([{ uploaded: 'doc_000001_00001.PDF', original: 'DOC_000001_00001.pdf' }]);
    expect(r.rejected).toEqual([]);
  });

  it.each(['-signed', '_signed', '.signed', '-firmato', '_firmato', ' (firmato)'])(
    'abbina togliendo il suffisso %s',
    (suffix) => {
      const r = matchSignedFiles([`DOC_000002_00001${suffix}.pdf`], toSign, []);
      expect(r.matched).toEqual([{ uploaded: `DOC_000002_00001${suffix}.pdf`, original: 'DOC_000002_00001.pdf' }]);
    },
  );

  it('rifiuta i .p7m con motivo CAdES', () => {
    const r = matchSignedFiles(['DOC_000001_00001.pdf.p7m'], toSign, []);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([{ file: 'DOC_000001_00001.pdf.p7m', reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' }]);
  });

  it('rifiuta i file non PDF', () => {
    const r = matchSignedFiles(['note.txt'], toSign, []);
    expect(r.rejected).toEqual([{ file: 'note.txt', reason: 'Non è un PDF' }]);
  });

  it('rifiuta i file senza abbinamento', () => {
    const r = matchSignedFiles(['ALTRO.pdf'], toSign, []);
    expect(r.rejected).toEqual([{ file: 'ALTRO.pdf', reason: 'Nessun allegato da firmare con questo nome' }]);
  });

  it('rifiuta tutti i file ambigui sullo stesso originale', () => {
    const r = matchSignedFiles(['DOC_000001_00001.pdf', 'DOC_000001_00001-signed.pdf'], toSign, []);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([
      { file: 'DOC_000001_00001.pdf', reason: 'Più file per lo stesso allegato DOC_000001_00001.pdf' },
      { file: 'DOC_000001_00001-signed.pdf', reason: 'Più file per lo stesso allegato DOC_000001_00001.pdf' },
    ]);
  });

  it('rifiuta i file il cui originale è già firmato validamente', () => {
    const r = matchSignedFiles(['DOC_000009_00001-signed.pdf'], toSign, ['DOC_000009_00001.pdf']);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([{ file: 'DOC_000009_00001-signed.pdf', reason: 'Allegato già firmato validamente' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run signed-attachment-matcher`
Expected: FAIL — `Failed to resolve import "./signed-attachment-matcher.util.js"`

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backend/src/remote-sign/signed-attachment-matcher.util.ts

/**
 * Suffissi che i software di firma (Dike, ArubaSign, …) aggiungono al nome
 * del PDF firmato. Al ricarico si tolgono per ritrovare il nome originale,
 * l'unico referenziato dal CSV della campagna (colonna allegato).
 */
export const SIGNED_SUFFIXES = ['-signed', '_signed', '.signed', '-firmato', '_firmato', ' (firmato)'] as const;

export interface MatchResult {
  matched: Array<{ uploaded: string; original: string }>;
  rejected: Array<{ file: string; reason: string }>;
}

function candidateOriginal(lowerName: string): string[] {
  const base = lowerName.slice(0, -'.pdf'.length);
  const out = [lowerName];
  for (const suffix of SIGNED_SUFFIXES) {
    if (base.endsWith(suffix)) out.push(`${base.slice(0, -suffix.length)}.pdf`);
  }
  return out;
}

/**
 * Abbina i file caricati dall'operatore agli allegati da firmare. Mai
 * indovinare: un file senza abbinamento certo viene rifiutato con il motivo,
 * mai salvato a caso. Ambigui (più file sullo stesso originale) tutti
 * rifiutati. Un originale già valido non si sovrascrive mai.
 */
export function matchSignedFiles(uploaded: string[], toSign: string[], alreadyValid: string[]): MatchResult {
  const toSignByLower = new Map(toSign.map((f) => [f.toLowerCase(), f]));
  const validByLower = new Map(alreadyValid.map((f) => [f.toLowerCase(), f]));
  const rejected: MatchResult['rejected'] = [];
  const byOriginal = new Map<string, string[]>();

  for (const file of uploaded) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.p7m')) {
      rejected.push({ file, reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' });
      continue;
    }
    if (!lower.endsWith('.pdf')) {
      rejected.push({ file, reason: 'Non è un PDF' });
      continue;
    }
    const candidates = candidateOriginal(lower);
    const original = candidates.map((c) => toSignByLower.get(c)).find((o): o is string => !!o);
    if (original) {
      byOriginal.set(original, [...(byOriginal.get(original) ?? []), file]);
      continue;
    }
    if (candidates.some((c) => validByLower.has(c))) {
      rejected.push({ file, reason: 'Allegato già firmato validamente' });
      continue;
    }
    rejected.push({ file, reason: 'Nessun allegato da firmare con questo nome' });
  }

  const matched: MatchResult['matched'] = [];
  for (const [original, files] of byOriginal) {
    if (files.length === 1) {
      matched.push({ uploaded: files[0], original });
    } else {
      for (const file of files) rejected.push({ file, reason: `Più file per lo stesso allegato ${original}` });
    }
  }
  return { matched, rejected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run signed-attachment-matcher`
Expected: PASS (12 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/remote-sign/signed-attachment-matcher.util.ts apps/backend/src/remote-sign/signed-attachment-matcher.util.spec.ts
git commit -m "feat(remote-sign): abbinamento file firmati per nome"
```

---

### Task 2: Client ARSS, errori, impostazioni

**Files:**
- Create: `apps/backend/src/remote-sign/arss-errors.ts`
- Create: `apps/backend/src/remote-sign/aruba-sign.client.ts`
- Create: `apps/backend/src/remote-sign/test-pdf.ts`
- Modify: `apps/backend/src/settings/settings.registry.ts` (dentro `SETTING_DEFS`, dopo le chiavi `pec.*`)
- Test: `apps/backend/src/remote-sign/arss-errors.spec.ts`, `apps/backend/src/remote-sign/aruba-sign.client.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // arss-errors.ts
  export type RemoteSignErrorKind = 'credentials' | 'domain' | 'session' | 'file' | 'network';
  export class RemoteSignError extends Error { constructor(readonly kind: RemoteSignErrorKind, message: string); }
  export function classifyArssError(stage: 'open' | 'sign', returnCode: string | null, description: string | null): RemoteSignError;
  // aruba-sign.client.ts
  export interface ArssCredentials { user: string; password: string; }
  @Injectable() export class ArubaSignClient {
    openSession(creds: ArssCredentials, otp: string): Promise<string>;
    signPdf(sessionId: string, creds: ArssCredentials, pdf: Buffer): Promise<Buffer>;
    closeSession(sessionId: string, creds: ArssCredentials): Promise<void>; // mai lancia
  }
  // test-pdf.ts
  export function buildTestPdf(): Buffer;
  ```
  Chiavi settings: `remoteSign.enabled`, `remoteSign.wsdlUrl`, `remoteSign.otpDomain`, `remoteSign.typeHsm`, `remoteSign.certId`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/src/remote-sign/arss-errors.spec.ts
import { describe, expect, it } from 'vitest';
import { classifyArssError } from './arss-errors.js';

describe('classifyArssError', () => {
  it('0030 → dominio', () => {
    const e = classifyArssError('open', '0030', 'Domain Not Allowed');
    expect(e.kind).toBe('domain');
    expect(e.message).toBe('Dominio non abilitato: verifica Impostazioni → Firma remota');
  });
  it('descrizione con session → sessione', () => {
    expect(classifyArssError('sign', '0001', 'Invalid session id').kind).toBe('session');
  });
  it('in apertura, errori di autenticazione → credenziali', () => {
    const e = classifyArssError('open', '0001', 'OTP not valid');
    expect(e.kind).toBe('credentials');
    expect(e.message).toBe('Credenziali o OTP non validi');
  });
  it('in firma, errore generico → file', () => {
    const e = classifyArssError('sign', '0001', 'Errore generico');
    expect(e.kind).toBe('file');
    expect(e.message).toBe('Aruba ha rifiutato il file (codice 0001: Errore generico)');
  });
  it('in apertura, errore sconosciuto → credenziali col codice', () => {
    expect(classifyArssError('open', null, null).message).toBe('Credenziali o OTP non validi');
  });
});
```

```ts
// apps/backend/src/remote-sign/aruba-sign.client.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const soapClient = {
  opensessionAsync: vi.fn(),
  pdfsignatureV2Async: vi.fn(),
  closesessionAsync: vi.fn(),
};
vi.mock('soap', () => ({ createClientAsync: vi.fn(async () => soapClient) }));

import * as soap from 'soap';
import { ArubaSignClient } from './aruba-sign.client.js';

const settings = {
  get: vi.fn(async (key: string) => ({
    'remoteSign.wsdlUrl': 'https://arss.example/ArubaSignService/ArubaSignService?wsdl',
    'remoteSign.otpDomain': 'firma',
    'remoteSign.typeHsm': 'COSIGN',
    'remoteSign.certId': 'AS0',
  } as Record<string, string>)[key]),
};
const creds = { user: 'mario', password: 'segreta' };

describe('ArubaSignClient', () => {
  let client: ArubaSignClient;
  beforeEach(() => {
    vi.clearAllMocks();
    client = new ArubaSignClient(settings as any);
  });

  it('openSession invia user/password/otp/dominio e restituisce il sessionid', async () => {
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'SESS-1' }]);
    await expect(client.openSession(creds, '123456')).resolves.toBe('SESS-1');
    expect(soap.createClientAsync).toHaveBeenCalledWith(
      'https://arss.example/ArubaSignService/ArubaSignService?wsdl',
      { endpoint: 'https://arss.example/ArubaSignService/ArubaSignService' },
    );
    expect(soapClient.opensessionAsync).toHaveBeenCalledWith({
      Identity: { user: 'mario', userPWD: 'segreta', otpPwd: '123456', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
    });
  });

  it('openSession con status KO → RemoteSignError credentials', async () => {
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'KO-0001', status: 'KO', return_code: '0001', description: 'OTP not valid' }]);
    await expect(client.openSession(creds, '000000')).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('openSession con errore di rete → network', async () => {
    soapClient.opensessionAsync.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(client.openSession(creds, '123456')).rejects.toMatchObject({ kind: 'network' });
  });

  it('signPdf usa session_id, PADESBES, nessun otpPwd, e restituisce il binario', async () => {
    soapClient.pdfsignatureV2Async.mockResolvedValueOnce([{ return: { status: 'OK', return_code: '0000', binaryoutput: Buffer.from('FIRMATO').toString('base64') } }]);
    const out = await client.signPdf('SESS-1', creds, Buffer.from('PDF'));
    expect(out.toString()).toBe('FIRMATO');
    const arg = soapClient.pdfsignatureV2Async.mock.calls[0][0];
    expect(arg.pdfprofile).toBe('PADESBES');
    expect(arg.SignRequestV2).toMatchObject({
      certID: 'AS0', requiredmark: false, session_id: 'SESS-1', transport: 'BYNARYNET',
      binaryinput: Buffer.from('PDF').toString('base64'),
      identity: { user: 'mario', userPWD: 'segreta', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
    });
    expect(arg.SignRequestV2.identity.otpPwd).toBeUndefined();
    expect(arg.Apparence).toBeUndefined();
  });

  it('signPdf con KO su sessione → session', async () => {
    soapClient.pdfsignatureV2Async.mockResolvedValueOnce([{ return: { status: 'KO', return_code: '0001', description: 'Session expired' } }]);
    await expect(client.signPdf('SESS-1', creds, Buffer.from('PDF'))).rejects.toMatchObject({ kind: 'session' });
  });

  it('closeSession non lancia mai', async () => {
    soapClient.closesessionAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(client.closeSession('SESS-1', creds)).resolves.toBeUndefined();
    expect(soapClient.closesessionAsync).toHaveBeenCalledWith({
      Identity: { user: 'mario', userPWD: 'segreta', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
      sessionid: 'SESS-1',
    });
  });

  it('non logga mai password, OTP o sessionid', async () => {
    const spy = vi.spyOn((client as any).logger, 'warn');
    soapClient.opensessionAsync.mockResolvedValueOnce([{ status: 'KO', return_code: '0001', description: 'bad' }]);
    await client.openSession(creds, '987654').catch(() => undefined);
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('segreta');
    expect(logged).not.toContain('987654');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec backend node_modules/.bin/vitest run arss-errors aruba-sign.client`
Expected: FAIL — moduli `./arss-errors.js` / `./aruba-sign.client.js` non trovati

- [ ] **Step 3: Add settings keys**

In `apps/backend/src/settings/settings.registry.ts`, dentro `SETTING_DEFS` dopo `'pec.from'`:

```ts
  // Firma remota Aruba (ARSS): solo parametri di servizio. Credenziali e OTP
  // del firmatario si digitano al momento e non vengono mai salvati.
  'remoteSign.enabled': { type: 'boolean', default: false },
  'remoteSign.wsdlUrl': { type: 'string', default: 'https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl' },
  'remoteSign.otpDomain': { type: 'string', default: 'firma' },
  'remoteSign.typeHsm': { type: 'string', default: 'COSIGN' },
  'remoteSign.certId': { type: 'string', default: 'AS0' },
```

- [ ] **Step 4: Write `arss-errors.ts`**

```ts
// apps/backend/src/remote-sign/arss-errors.ts
export type RemoteSignErrorKind = 'credentials' | 'domain' | 'session' | 'file' | 'network';

export class RemoteSignError extends Error {
  constructor(readonly kind: RemoteSignErrorKind, message: string) {
    super(message);
    this.name = 'RemoteSignError';
  }
}

/**
 * I codici ARSS non sono documentati pubblicamente: classificazione per
 * codice noto (0030 = dominio non abilitato) e per testo della descrizione.
 * Il codice/descrizione grezzi vanno loggati dal chiamante (non contengono
 * segreti) per affinare la mappatura sui casi reali.
 */
export function classifyArssError(stage: 'open' | 'sign', returnCode: string | null, description: string | null): RemoteSignError {
  const desc = description ?? '';
  if (returnCode === '0030' || /domain/i.test(desc)) {
    return new RemoteSignError('domain', 'Dominio non abilitato: verifica Impostazioni → Firma remota');
  }
  if (/session/i.test(desc)) {
    return new RemoteSignError('session', 'Sessione di firma scaduta o non valida');
  }
  if (stage === 'open') {
    return new RemoteSignError('credentials', 'Credenziali o OTP non validi');
  }
  return new RemoteSignError('file', `Aruba ha rifiutato il file (codice ${returnCode ?? '?'}: ${desc || 'nessuna descrizione'})`);
}
```

- [ ] **Step 5: Write `test-pdf.ts`**

```ts
// apps/backend/src/remote-sign/test-pdf.ts

/** PDF A4 minimale "Test firma ComunicaPA" per la Prova firma: nessun dato reale. */
export function buildTestPdf(): Buffer {
  const content = 'BT /F1 18 Tf 72 720 Td (Test firma ComunicaPA) Tj ET';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj${obj}endobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
```

- [ ] **Step 6: Write `aruba-sign.client.ts`**

```ts
// apps/backend/src/remote-sign/aruba-sign.client.ts
import { Injectable, Logger } from '@nestjs/common';
import * as soap from 'soap';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { classifyArssError, RemoteSignError } from './arss-errors.js';

export interface ArssCredentials {
  user: string;
  password: string;
}

/**
 * Client SOAP Aruba Remote Sign Service (ARSS). Flusso verificato dal vivo
 * (spike 2026-10-13, docs/claude/remote-sign.md): opensession con OTP →
 * pdfsignatureV2 con session_id (identity senza otpPwd) → closesession.
 * MAI loggare password, OTP, sessionid o binari.
 */
@Injectable()
export class ArubaSignClient {
  private readonly logger = new Logger(ArubaSignClient.name);

  constructor(private readonly settings: AppSettingsService) {}

  private async client(): Promise<any> {
    const wsdlUrl = await this.settings.get<string>('remoteSign.wsdlUrl');
    try {
      return await soap.createClientAsync(wsdlUrl, { endpoint: wsdlUrl.replace(/\?wsdl$/i, '') });
    } catch (err: any) {
      this.logger.warn(`WSDL ARSS non raggiungibile: ${err?.code ?? err?.message ?? err}`);
      throw new RemoteSignError('network', 'Servizio di firma Aruba non raggiungibile');
    }
  }

  private async identity(creds: ArssCredentials): Promise<Record<string, string>> {
    return {
      user: creds.user,
      userPWD: creds.password,
      typeOtpAuth: await this.settings.get<string>('remoteSign.otpDomain'),
      typeHSM: await this.settings.get<string>('remoteSign.typeHsm'),
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err instanceof RemoteSignError) throw err;
      this.logger.warn(`Chiamata ARSS fallita: ${err?.code ?? err?.message ?? 'errore sconosciuto'}`);
      throw new RemoteSignError('network', 'Servizio di firma Aruba non raggiungibile');
    }
  }

  async openSession(creds: ArssCredentials, otp: string): Promise<string> {
    const client = await this.client();
    const identity = { ...(await this.identity(creds)), otpPwd: otp };
    const [res] = await this.call(() => client.opensessionAsync({ Identity: identity }));
    const sessionId: unknown = res?.return;
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId.startsWith('KO') || res?.status === 'KO') {
      this.logger.warn(`opensession ARSS rifiutata: codice=${res?.return_code ?? '?'} descrizione=${res?.description ?? '?'}`);
      throw classifyArssError('open', res?.return_code ?? null, res?.description ?? null);
    }
    return sessionId;
  }

  async signPdf(sessionId: string, creds: ArssCredentials, pdf: Buffer): Promise<Buffer> {
    const client = await this.client();
    const [res] = await this.call(async () => client.pdfsignatureV2Async({
      SignRequestV2: {
        binaryinput: pdf.toString('base64'),
        certID: await this.settings.get<string>('remoteSign.certId'),
        identity: await this.identity(creds),
        requiredmark: false,
        session_id: sessionId,
        transport: 'BYNARYNET',
      },
      pdfprofile: 'PADESBES',
    }));
    const ret = res?.return ?? res;
    if (ret?.status !== 'OK' || !ret?.binaryoutput) {
      this.logger.warn(`pdfsignatureV2 ARSS rifiutata: codice=${ret?.return_code ?? '?'} descrizione=${ret?.description ?? '?'}`);
      throw classifyArssError('sign', ret?.return_code ?? null, ret?.description ?? null);
    }
    return Buffer.from(ret.binaryoutput, 'base64');
  }

  async closeSession(sessionId: string, creds: ArssCredentials): Promise<void> {
    try {
      const client = await this.client();
      await client.closesessionAsync({ Identity: await this.identity(creds), sessionid: sessionId });
    } catch (err: any) {
      this.logger.warn(`closesession ARSS fallita: ${err?.code ?? err?.message ?? 'errore sconosciuto'}`);
    }
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `docker compose exec backend node_modules/.bin/vitest run arss-errors aruba-sign.client`
Expected: PASS (5 + 7 test)

- [ ] **Step 8: Type-check and commit**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit` → nessun errore.

```bash
git add apps/backend/src/remote-sign/arss-errors.ts apps/backend/src/remote-sign/arss-errors.spec.ts apps/backend/src/remote-sign/aruba-sign.client.ts apps/backend/src/remote-sign/aruba-sign.client.spec.ts apps/backend/src/remote-sign/test-pdf.ts apps/backend/src/settings/settings.registry.ts
git commit -m "feat(remote-sign): client SOAP Aruba ARSS e impostazioni firma remota"
```

---

### Task 3: Entità job, backup originali, pulizia

**Files:**
- Create: `apps/backend/src/entities/remote-sign-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1790600000000-CreateRemoteSignJobs.ts`
- Create: `apps/backend/src/remote-sign/attachment-writer.util.ts`
- Modify: `apps/backend/src/attachments/attachment-paths.ts` (dopo `getUploadsDir`)
- Modify: `apps/backend/src/database/database.module.ts` (import entity + migration, array `entities` e `migrations`)
- Modify: `apps/backend/src/database/data-source.ts` (import + array `entities`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`remove`, ~riga 3923)
- Modify: `apps/backend/src/campaigns/retention-cleanup.service.ts:53`
- Modify: `apps/backend/src/campaigns/campaign-completion.service.ts:91`
- Test: `apps/backend/src/remote-sign/attachment-writer.util.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function getUnsignedBackupDir(campaignId: string): string; // <root>/unsigned-backup/<id>
  export function replaceAttachment(campaignId: string, filename: string, content: Buffer): void;
  export enum RemoteSignJobStatus { QUEUED='queued', PROCESSING='processing', DONE='done', FAILED='failed' }
  export class RemoteSignJob { id; campaignId; status; totalFiles; signedCount; failedCount; errorMessage: string|null; errorKind: string|null; operator; signerCn: string|null; createdAt; completedAt: Date|null; }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/remote-sign/attachment-writer.util.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { replaceAttachment } from './attachment-writer.util.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '11111111-1111-1111-1111-111111111111';

describe('replaceAttachment', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sign-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    fs.writeFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'ORIGINALE');
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('salva il backup FUORI da uploads e sostituisce il file', () => {
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO'));
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('FIRMATO');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('ORIGINALE');
    expect(getUnsignedBackupDir(CAMPAIGN).startsWith(getUploadsDir(CAMPAIGN))).toBe(false);
    expect(fs.readdirSync(getUploadsDir(CAMPAIGN))).toEqual(['DOC_1.pdf']);
  });

  it('non sovrascrive il backup alla seconda sostituzione', () => {
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO-1'));
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO-2'));
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('ORIGINALE');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('FIRMATO-2');
  });

  it('rifiuta nomi con path traversal', () => {
    expect(() => replaceAttachment(CAMPAIGN, '../x.pdf', Buffer.from('X'))).toThrow('Nome allegato non valido');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run attachment-writer`
Expected: FAIL — `getUnsignedBackupDir` non esportato / modulo writer mancante

- [ ] **Step 3: Implement paths + writer**

In `apps/backend/src/attachments/attachment-paths.ts`, dopo `getUploadsDir`:

```ts
/**
 * Originali sostituiti da una versione firmata (firma remota o ricarico ZIP).
 * Cartella SORELLA di uploads, mai dentro: finalizeAttachments() cancella
 * ogni voce di uploads non referenziata dal CSV, sottocartelle comprese.
 */
export function getUnsignedBackupDir(campaignId: string): string {
  return join(getAttachmentsRoot(), 'unsigned-backup', campaignId);
}
```

```ts
// apps/backend/src/remote-sign/attachment-writer.util.ts
import * as fs from 'fs';
import { basename, join } from 'path';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

/**
 * Sostituisce un allegato della campagna con `content` (versione firmata):
 * backup dell'originale alla prima sostituzione, poi scrittura atomica
 * (tmp + rename) — un crash a metà non lascia mai un PDF troncato.
 */
export function replaceAttachment(campaignId: string, filename: string, content: Buffer): void {
  if (!filename || basename(filename) !== filename || filename.startsWith('.')) {
    throw new Error('Nome allegato non valido');
  }
  const target = join(getUploadsDir(campaignId), filename);
  const backupDir = getUnsignedBackupDir(campaignId);
  const backup = join(backupDir, filename);
  if (fs.existsSync(target) && !fs.existsSync(backup)) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(target, backup);
  }
  const tmp = join(getUploadsDir(campaignId), `.${filename}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec backend node_modules/.bin/vitest run attachment-writer`
Expected: PASS (3 test)

- [ ] **Step 5: Entity + migration**

```ts
// apps/backend/src/entities/remote-sign-job.entity.ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum RemoteSignJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity('remote_sign_jobs')
@Index('IDX_remote_sign_jobs_campaign', ['campaignId', 'createdAt'])
export class RemoteSignJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ type: 'varchar', default: RemoteSignJobStatus.QUEUED })
  status!: RemoteSignJobStatus;

  @Column({ name: 'total_files', type: 'int', default: 0 })
  totalFiles!: number;

  @Column({ name: 'signed_count', type: 'int', default: 0 })
  signedCount!: number;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount!: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'error_kind', type: 'varchar', length: 20, nullable: true })
  errorKind!: string | null;

  @Column({ type: 'varchar', length: 255 })
  operator!: string;

  @Column({ name: 'signer_cn', type: 'varchar', length: 255, nullable: true })
  signerCn!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
```

```ts
// apps/backend/src/database/migrations/1790600000000-CreateRemoteSignJobs.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRemoteSignJobs1790600000000 implements MigrationInterface {
    name = 'CreateRemoteSignJobs1790600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "remote_sign_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaign_id" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'queued',
                "total_files" integer NOT NULL DEFAULT 0,
                "signed_count" integer NOT NULL DEFAULT 0,
                "failed_count" integer NOT NULL DEFAULT 0,
                "error_message" text,
                "error_kind" character varying(20),
                "operator" character varying(255) NOT NULL,
                "signer_cn" character varying(255),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_remote_sign_jobs" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_remote_sign_jobs_campaign" ON "remote_sign_jobs" ("campaign_id", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "remote_sign_jobs"`);
    }
}
```

Registrazione:
- `database.module.ts`: `import { RemoteSignJob } from '../entities/remote-sign-job.entity.js';` e `import { CreateRemoteSignJobs1790600000000 } from './migrations/1790600000000-CreateRemoteSignJobs.js';`; aggiungere `RemoteSignJob` in fondo all'array `entities` e `CreateRemoteSignJobs1790600000000` in fondo all'array `migrations` (dopo `AddNotificationReviews1790500000000`).
- `data-source.ts`: stesso import entity, `RemoteSignJob` in fondo all'array `entities`.

- [ ] **Step 6: Cleanup backup**

`campaigns.service.ts`, in `remove()`, subito dopo `await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });`:

```ts
    await fs.promises.rm(getUnsignedBackupDir(campaignId), { recursive: true, force: true });
```

`retention-cleanup.service.ts`, subito dopo la riga 53 `await rm(getUploadsDir(campaignId), …)`:

```ts
        await rm(getUnsignedBackupDir(campaignId), { recursive: true, force: true });
```

`campaign-completion.service.ts`, subito dopo la riga 91 `fs.rmSync(getUploadsDir(child.id), …)`:

```ts
      fs.rmSync(getUnsignedBackupDir(child.id), { recursive: true, force: true });
```

In tutti e tre i file aggiungere `getUnsignedBackupDir` all'import esistente da `'../attachments/attachment-paths.js'`.

- [ ] **Step 7: Verify migration on a throwaway DB**

Solo se lo stack dev è su. Il backend dev usa `synchronize`, la migration va provata a parte (CLAUDE.md, sezione worktree):

```bash
docker compose restart backend
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
MSYS_NO_PATHCONV=1 docker exec -w /app/apps/backend comunicapa-backend-1 node --input-type=module -e "import { DataSource } from 'typeorm'; const ds = await new DataSource({ type: 'postgres', url: process.env.DATABASE_URL.replace(/\/[^/]+\$/, '/migration_test'), migrations: ['/app/apps/backend/dist/database/migrations/*.js'] }).initialize(); console.log((await ds.runMigrations()).length); await ds.destroy();"
docker exec comunicapa-postgres-1 psql -U comunicapa -d migration_test -c "\d remote_sign_jobs"
docker exec comunicapa-postgres-1 psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```

Expected: tabella con le 12 colonne. Se lo stack è spento: annotarlo nel report, verifica rinviata a E2E (Task 9).

- [ ] **Step 8: Run full backend suite + tsc**

Run: `docker compose exec backend node_modules/.bin/vitest run` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: verde (failure set identico alla baseline), tsc pulito

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/entities/remote-sign-job.entity.ts apps/backend/src/database apps/backend/src/attachments/attachment-paths.ts apps/backend/src/remote-sign/attachment-writer.util.ts apps/backend/src/remote-sign/attachment-writer.util.spec.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/retention-cleanup.service.ts apps/backend/src/campaigns/campaign-completion.service.ts
git commit -m "feat(remote-sign): job firma remota, backup originali fuori da uploads"
```

---

### Task 4: Servizio, processor, controller firma Aruba + gate lancio

**Files:**
- Create: `apps/backend/src/remote-sign/remote-sign-job.types.ts`
- Create: `apps/backend/src/remote-sign/dto/remote-sign-credentials.dto.ts`
- Create: `apps/backend/src/remote-sign/remote-sign.service.ts`
- Create: `apps/backend/src/remote-sign/remote-sign.processor.ts`
- Create: `apps/backend/src/remote-sign/remote-sign.controller.ts`
- Create: `apps/backend/src/remote-sign/remote-sign.module.ts`
- Modify: `apps/backend/src/app.module.ts` (import + `RemoteSignModule` dopo `SignatureVerificationModule`)
- Modify: `apps/backend/src/campaigns/campaigns.module.ts:27` (`RemoteSignJob` in `forFeature`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (costruttore `@Optional` repo + gate in `launch()`)
- Test: `apps/backend/src/remote-sign/remote-sign.service.spec.ts`, `apps/backend/src/remote-sign/remote-sign.processor.spec.ts`, `apps/backend/src/campaigns/campaigns.service.spec.ts` (2 test)

**Interfaces:**
- Consumes: `ArubaSignClient` (Task 2), `RemoteSignError` (Task 2), `buildTestPdf` (Task 2), `replaceAttachment` (Task 3), `RemoteSignJob`/`RemoteSignJobStatus` (Task 3), `SignatureVerificationBulkService.getLatestStatus/startForCampaign`, `SignatureVerificationService.verify`, `encryptValue/decryptValue/deriveSettingsKey`.
- Produces:
  ```ts
  export const REMOTE_SIGN_QUEUE = 'remote-sign-jobs';
  export interface RemoteSignQueueJobData { jobId: string; campaignId: string; sessionId: string; user: string; passwordEnc: string; }
  export interface RemoteSignStatusDto { status: RemoteSignJobStatus; totalFiles: number; signedCount: number; failedCount: number; errorKind: string | null; errorMessage: string | null; signerCn: string | null; }
  class RemoteSignService {
    listFilesToSign(campaignId: string): Promise<{ toSign: string[]; alreadyValid: string[] }>;
    assertCanModify(campaignId: string, requester: CampaignRequester): Promise<Campaign>; // throws
    hasActiveJob(campaignId: string): Promise<boolean>;
    start(campaignId: string, requester: CampaignRequester, dto: RemoteSignCredentialsDto): Promise<{ jobId: string } | { error: string; errorKind?: string }>;
    getLatestStatus(campaignId: string): Promise<RemoteSignStatusDto | null>;
    isEnabled(): Promise<boolean>;
    testSign(dto: RemoteSignCredentialsDto): Promise<{ ok: true; signerCn: string | null } | { ok: false; error: string }>;
    decryptPassword(enc: string): string;
  }
  ```
  Route: `POST/GET admin/campaigns/:id/remote-sign`, `GET admin/remote-sign/config`, `POST admin/settings/remote-sign/test`.

- [ ] **Step 1: Types + DTO**

```ts
// apps/backend/src/remote-sign/remote-sign-job.types.ts
export const REMOTE_SIGN_QUEUE = 'remote-sign-jobs';

export interface RemoteSignQueueJobData {
  jobId: string;
  campaignId: string;
  sessionId: string;
  user: string;
  /** Cifrata enc:v1: (AES-256-GCM, chiave dei secret di settings): mai in chiaro su Redis. */
  passwordEnc: string;
}
```

```ts
// apps/backend/src/remote-sign/dto/remote-sign-credentials.dto.ts
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class RemoteSignCredentialsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  user!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password!: string;

  @IsString()
  @Matches(/^\d{6,8}$/, { message: "L'OTP deve essere di 6-8 cifre" })
  otp!: string;
}
```

- [ ] **Step 2: Write failing service tests**

```ts
// apps/backend/src/remote-sign/remote-sign.service.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { CampaignStatus } from '../entities/campaign.entity.js';

const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN = { username: 'admin', role: 'admin' as const };
const sendCampaign = {
  id: CAMPAIGN_ID, channelType: 'SEND', status: CampaignStatus.DRAFT, createdBy: 'mario',
  channelConfig: { attachments: [{ key: 'allegato', label: 'Avviso' }] },
};

function build() {
  const campaignRepo = { findOneBy: vi.fn().mockResolvedValue(sendCampaign) };
  const recipientRepo = {
    find: vi.fn().mockResolvedValue([
      { extraData: { allegato: 'A.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: 'A.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: 'B.pdf' }, signatureCheck: { valid: true } },
      { extraData: { allegato: 'C.pdf.p7m' }, signatureCheck: { valid: false } },
    ]),
  };
  const jobRepo = {
    exists: vi.fn().mockResolvedValue(false),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ ...x, id: 'job-1' })),
    findOne: vi.fn(),
  };
  const queue = { add: vi.fn() };
  const client = { openSession: vi.fn().mockResolvedValue('SESS-1'), signPdf: vi.fn(), closeSession: vi.fn() };
  const bulk = { getLatestStatus: vi.fn().mockResolvedValue({ status: 'done', invalidCount: 2, totalRows: 4 }) };
  const verification = { verify: vi.fn() };
  const settings = { get: vi.fn().mockResolvedValue(true) };
  const config = { get: vi.fn().mockReturnValue('jwt-secret-di-test') };
  const audit = { log: vi.fn() };
  const svc = new RemoteSignService(
    campaignRepo as any, recipientRepo as any, jobRepo as any, queue as any, client as any,
    bulk as any, verification as any, settings as any, config as any, audit as any,
  );
  return { svc, campaignRepo, recipientRepo, jobRepo, queue, client, bulk, verification, settings, audit };
}

describe('RemoteSignService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listFilesToSign: solo invalidi, deduplicati, senza .p7m; validi a parte', async () => {
    const { svc } = build();
    await expect(svc.listFilesToSign(CAMPAIGN_ID)).resolves.toEqual({ toSign: ['A.pdf'], alreadyValid: ['B.pdf'] });
  });

  it('start: apre la sessione nella richiesta e accoda senza password in chiaro', async () => {
    const { svc, queue, client } = build();
    const res = await svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'segreta', otp: '123456' });
    expect(res).toEqual({ jobId: 'job-1' });
    expect(client.openSession).toHaveBeenCalledWith({ user: 'mario', password: 'segreta' }, '123456');
    const [, data, opts] = queue.add.mock.calls[0];
    expect(data).toMatchObject({ jobId: 'job-1', campaignId: CAMPAIGN_ID, sessionId: 'SESS-1', user: 'mario' });
    expect(data.passwordEnc).toMatch(/^enc:v1:/);
    expect(JSON.stringify(data)).not.toContain('segreta');
    expect(opts).toMatchObject({ jobId: 'job-1', removeOnComplete: true, removeOnFail: true });
    expect(svc.decryptPassword(data.passwordEnc)).toBe('segreta');
  });

  it('start: OTP errato → { error } e nessun job', async () => {
    const { svc, client, jobRepo, queue } = build();
    client.openSession.mockRejectedValueOnce(new RemoteSignError('credentials', 'Credenziali o OTP non validi'));
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'x', otp: '000000' }))
      .resolves.toEqual({ error: 'Credenziali o OTP non validi', errorKind: 'credentials' });
    expect(jobRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('start: job già attivo → { error } senza aprire una seconda sessione', async () => {
    const { svc, jobRepo, client } = build();
    jobRepo.exists.mockResolvedValueOnce(true);
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Firma remota già in corso per questa campagna' });
    expect(client.openSession).not.toHaveBeenCalled();
  });

  it('start: verifica non conclusa → { error }', async () => {
    const { svc, bulk } = build();
    bulk.getLatestStatus.mockResolvedValueOnce({ status: 'processing', invalidCount: 0 });
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'm', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Attendi la fine della verifica firma prima di firmare' });
  });

  it('start: firma remota disattivata → { error }', async () => {
    const { svc, settings } = build();
    settings.get.mockResolvedValueOnce(false);
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'm', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Firma remota non attiva: abilitala da Impostazioni → Firma remota' });
  });

  it('assertCanModify: un user non può firmare la campagna di un altro', async () => {
    const { svc } = build();
    await expect(svc.assertCanModify(CAMPAIGN_ID, { username: 'luigi', role: 'user' })).rejects.toThrow('altro operatore');
  });

  it('assertCanModify: campagna non SEND o non in bozza → errore', async () => {
    const { svc, campaignRepo } = build();
    campaignRepo.findOneBy.mockResolvedValueOnce({ ...sendCampaign, status: CampaignStatus.QUEUED });
    await expect(svc.assertCanModify(CAMPAIGN_ID, ADMIN)).rejects.toThrow('bozza');
  });

  it('testSign: firma il PDF di prova, verifica, chiude la sessione', async () => {
    const { svc, client, verification } = build();
    client.signPdf.mockResolvedValueOnce(Buffer.from('FIRMATO'));
    verification.verify.mockResolvedValueOnce({ valid: true, reason: null, signerCn: 'MARIO ROSSI' });
    await expect(svc.testSign({ user: 'mario', password: 'x', otp: '123456' })).resolves.toEqual({ ok: true, signerCn: 'MARIO ROSSI' });
    expect(client.closeSession).toHaveBeenCalledWith('SESS-1', { user: 'mario', password: 'x' });
  });

  it('testSign: firma non valida → ok false col motivo', async () => {
    const { svc, client, verification } = build();
    client.signPdf.mockResolvedValueOnce(Buffer.from('FIRMATO'));
    verification.verify.mockResolvedValueOnce({ valid: false, reason: 'CA non riconosciuta' });
    await expect(svc.testSign({ user: 'mario', password: 'x', otp: '123456' }))
      .resolves.toEqual({ ok: false, error: 'Firma creata ma non valida: CA non riconosciuta' });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run remote-sign.service`
Expected: FAIL — `./remote-sign.service.js` non trovato

- [ ] **Step 4: Implement `remote-sign.service.ts`**

```ts
// apps/backend/src/remote-sign/remote-sign.service.ts
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import type { AppConfiguration } from '../config/configuration.js';
import type { CampaignRequester } from '../campaigns/campaigns.service.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignError } from './arss-errors.js';
import { buildTestPdf } from './test-pdf.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';
import type { RemoteSignCredentialsDto } from './dto/remote-sign-credentials.dto.js';

export interface RemoteSignStatusDto {
  status: RemoteSignJobStatus;
  totalFiles: number;
  signedCount: number;
  failedCount: number;
  errorKind: string | null;
  errorMessage: string | null;
  signerCn: string | null;
}

const ACTIVE = [RemoteSignJobStatus.QUEUED, RemoteSignJobStatus.PROCESSING];

@Injectable()
export class RemoteSignService {
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient) private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(RemoteSignJob) private readonly jobRepo: Repository<RemoteSignJob>,
    @InjectQueue(REMOTE_SIGN_QUEUE) private readonly queue: Queue<RemoteSignQueueJobData>,
    private readonly client: ArubaSignClient,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly verification: SignatureVerificationService,
    private readonly settings: AppSettingsService,
    config: ConfigService<AppConfiguration, true>,
    private readonly audit: AuditLogsService,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  decryptPassword(enc: string): string {
    return decryptValue(enc, this.cryptoKey);
  }

  isEnabled(): Promise<boolean> {
    return this.settings.get<boolean>('remoteSign.enabled');
  }

  /** SEND in bozza (massivo o Invio Manuale), ownership come assertOwnership di CampaignsService. */
  async assertCanModify(campaignId: string, requester: CampaignRequester): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (requester.role !== 'admin' && campaign.createdBy !== requester.username) {
      throw new ForbiddenException('Non puoi modificare una campagna creata da un altro operatore');
    }
    if (campaign.channelType !== 'SEND' || campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Firma allegati disponibile solo per campagne SEND in bozza');
    }
    return campaign;
  }

  hasActiveJob(campaignId: string): Promise<boolean> {
    return this.jobRepo.exists({ where: { campaignId, status: In(ACTIVE) } });
  }

  /**
   * Allegati da firmare = file dei destinatari PENDING con signatureCheck
   * invalido (ultima verifica), deduplicati, .p7m esclusi (PAdES impossibile).
   * alreadyValid = file referenziati SOLO da destinatari validi.
   */
  async listFilesToSign(campaignId: string): Promise<{ toSign: string[]; alreadyValid: string[] }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const slots = resolveAttachmentsConfig(campaign.channelConfig).length;
    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: { extraData: true, signatureCheck: true },
    });
    const toSign = new Set<string>();
    const valid = new Set<string>();
    for (const r of recipients) {
      for (let i = 0; i < slots; i++) {
        const f = resolveCustomAttachmentFilename({ campaign, extraData: r.extraData } as unknown as Recipient, i);
        if (!f) continue;
        if (r.signatureCheck?.valid === false) toSign.add(f);
        else valid.add(f);
      }
    }
    const signable = [...toSign].filter((f) => !f.toLowerCase().endsWith('.p7m'));
    return { toSign: signable, alreadyValid: [...valid].filter((f) => !toSign.has(f)) };
  }

  async start(
    campaignId: string,
    requester: CampaignRequester,
    dto: RemoteSignCredentialsDto,
  ): Promise<{ jobId: string } | { error: string; errorKind?: string }> {
    if (!(await this.isEnabled())) {
      return { error: 'Firma remota non attiva: abilitala da Impostazioni → Firma remota' };
    }
    await this.assertCanModify(campaignId, requester);
    if (await this.hasActiveJob(campaignId)) {
      return { error: 'Firma remota già in corso per questa campagna' };
    }
    const verification = await this.verificationBulk.getLatestStatus(campaignId);
    if (!verification || verification.status !== SignatureVerificationJobStatus.DONE) {
      return { error: 'Attendi la fine della verifica firma prima di firmare' };
    }
    const { toSign } = await this.listFilesToSign(campaignId);
    if (toSign.length === 0) {
      return { error: 'Nessun allegato PDF da firmare' };
    }

    const creds = { user: dto.user, password: dto.password };
    let sessionId: string;
    try {
      sessionId = await this.client.openSession(creds, dto.otp);
    } catch (err) {
      if (err instanceof RemoteSignError) return { error: err.message, errorKind: err.kind };
      throw err;
    }

    const job = await this.jobRepo.save(this.jobRepo.create({
      campaignId,
      status: RemoteSignJobStatus.QUEUED,
      totalFiles: toSign.length,
      operator: requester.username,
    }));
    await this.queue.add(
      'sign',
      { jobId: job.id, campaignId, sessionId, user: dto.user, passwordEnc: encryptValue(dto.password, this.cryptoKey) },
      { jobId: job.id, removeOnComplete: true, removeOnFail: true, attempts: 1 },
    );
    return { jobId: job.id };
  }

  async getLatestStatus(campaignId: string): Promise<RemoteSignStatusDto | null> {
    const job = await this.jobRepo.findOne({ where: { campaignId }, order: { createdAt: 'DESC' } });
    if (!job) return null;
    return {
      status: job.status,
      totalFiles: job.totalFiles,
      signedCount: job.signedCount,
      failedCount: job.failedCount,
      errorKind: job.errorKind,
      errorMessage: job.errorMessage,
      signerCn: job.signerCn,
    };
  }

  /** Prova firma da Impostazioni: nulla su disco, sessione sempre chiusa. */
  async testSign(dto: RemoteSignCredentialsDto): Promise<{ ok: true; signerCn: string | null } | { ok: false; error: string }> {
    const creds = { user: dto.user, password: dto.password };
    let sessionId: string | null = null;
    try {
      sessionId = await this.client.openSession(creds, dto.otp);
      const signed = await this.client.signPdf(sessionId, creds, buildTestPdf());
      const result = await this.verification.verify(signed, 'prova-firma.pdf');
      if (!result.valid) return { ok: false, error: `Firma creata ma non valida: ${result.reason}` };
      return { ok: true, signerCn: result.signerCn ?? null };
    } catch (err) {
      if (err instanceof RemoteSignError) return { ok: false, error: err.message };
      throw err;
    } finally {
      if (sessionId) await this.client.closeSession(sessionId, creds);
    }
  }
}
```

- [ ] **Step 5: Run service tests**

Run: `docker compose exec backend node_modules/.bin/vitest run remote-sign.service`
Expected: PASS (10 test)

- [ ] **Step 6: Write failing processor tests**

```ts
// apps/backend/src/remote-sign/remote-sign.processor.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { RemoteSignProcessor } from './remote-sign.processor.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '33333333-3333-3333-3333-333333333333';
const jobData = { jobId: 'job-1', campaignId: CAMPAIGN, sessionId: 'SESS-1', user: 'mario', passwordEnc: 'enc' };

function build(files: string[]) {
  const calls: string[] = [];
  const jobRepo = {
    update: vi.fn(async (_id: unknown, patch: any) => { if (patch.status) calls.push(`status:${patch.status}`); }),
    findOneBy: vi.fn().mockResolvedValue({ operator: 'operatore.comune' }),
  };
  const client = {
    signPdf: vi.fn(async (_s: string, _c: unknown, pdf: Buffer) => Buffer.concat([pdf, Buffer.from('+FIRMA')])),
    closeSession: vi.fn(async () => { calls.push('close'); }),
  };
  const service = {
    listFilesToSign: vi.fn().mockResolvedValue({ toSign: files, alreadyValid: [] }),
    decryptPassword: vi.fn().mockReturnValue('segreta'),
  };
  const bulk = { startForCampaign: vi.fn(async () => { calls.push('verify'); return { jobId: 'v-2' }; }) };
  const verification = { verify: vi.fn().mockResolvedValue({ valid: true, reason: null, signerCn: 'MARIO ROSSI' }) };
  const audit = { log: vi.fn() };
  const campaignRepo = { findOneBy: vi.fn().mockResolvedValue({ id: CAMPAIGN, name: 'Prova' }) };
  const p = new RemoteSignProcessor(jobRepo as any, campaignRepo as any, client as any, service as any, bulk as any, verification as any, audit as any);
  return { p, jobRepo, client, service, bulk, audit, calls };
}

describe('RemoteSignProcessor', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-rsp-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    for (const f of ['A.pdf', 'B.pdf', 'C.pdf']) fs.writeFileSync(join(getUploadsDir(CAMPAIGN), f), f);
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('firma i file, fa backup fuori da uploads, chiude, riavvia la verifica PRIMA di marcare done', async () => {
    const { p, client, calls, jobRepo, audit } = build(['A.pdf', 'B.pdf']);
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(client.signPdf.mock.calls[0][1]).toEqual({ user: 'mario', password: 'segreta' });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf+FIRMA');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'C.pdf'), 'utf8')).toBe('C.pdf');
    expect(calls).toEqual(['status:processing', 'close', 'verify', 'status:done']);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 2, failedCount: 0, signerCn: 'MARIO ROSSI',
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'REMOTE_SIGN', operator: 'operatore.comune' }));
  });

  it('errore file: conta e prosegue', async () => {
    const { p, client, jobRepo } = build(['A.pdf', 'B.pdf']);
    client.signPdf.mockRejectedValueOnce(new RemoteSignError('file', 'rifiutato'));
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf');
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 1, failedCount: 1,
    }));
  });

  it('errore sessione: si ferma, failed con conteggio e secondi, chiude e riverifica comunque', async () => {
    const { p, client, calls, jobRepo } = build(['A.pdf', 'B.pdf', 'C.pdf']);
    client.signPdf
      .mockResolvedValueOnce(Buffer.from('ok'))
      .mockRejectedValueOnce(new RemoteSignError('session', 'Sessione di firma scaduta o non valida'));
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['status:processing', 'close', 'verify', 'status:failed']);
    const last = jobRepo.update.mock.calls.at(-1)![1];
    expect(last).toMatchObject({ status: RemoteSignJobStatus.FAILED, errorKind: 'session', signedCount: 1 });
    expect(last.errorMessage).toMatch(/^Sessione scaduta dopo 1 file su 3 \(\d+ s\): inserisci un nuovo OTP per i rimanenti$/);
  });

  it('file sparito da disco: conta come fallito', async () => {
    const { p, jobRepo } = build(['MANCANTE.pdf']);
    await p.process({ data: jobData } as any);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({ failedCount: 1, signedCount: 0 }));
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run remote-sign.processor`
Expected: FAIL — `./remote-sign.processor.js` non trovato

- [ ] **Step 8: Implement processor**

```ts
// apps/backend/src/remote-sign/remote-sign.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { join } from 'path';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { captureException } from '../common/sentry.util.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignService } from './remote-sign.service.js';
import { replaceAttachment } from './attachment-writer.util.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';

@Injectable()
@Processor(REMOTE_SIGN_QUEUE, { concurrency: 1 })
export class RemoteSignProcessor extends WorkerHost {
  private readonly logger = new Logger(RemoteSignProcessor.name);

  constructor(
    @InjectRepository(RemoteSignJob) private readonly jobRepo: Repository<RemoteSignJob>,
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    private readonly client: ArubaSignClient,
    private readonly service: RemoteSignService,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly verification: SignatureVerificationService,
    private readonly audit: AuditLogsService,
  ) {
    super();
  }

  async process(job: Job<RemoteSignQueueJobData>): Promise<void> {
    const { jobId, campaignId, sessionId, user, passwordEnc } = job.data;
    const creds = { user, password: this.service.decryptPassword(passwordEnc) };
    const startedAt = Date.now();
    let signedCount = 0;
    let failedCount = 0;
    let signerCn: string | null = null;
    let stop: RemoteSignError | null = null;
    let total = 0;

    await this.jobRepo.update({ id: jobId }, { status: RemoteSignJobStatus.PROCESSING });
    try {
      const { toSign } = await this.service.listFilesToSign(campaignId);
      total = toSign.length;
      for (const filename of toSign) {
        const path = join(getUploadsDir(campaignId), filename);
        if (!fs.existsSync(path)) {
          failedCount++;
          continue;
        }
        try {
          const signed = await this.client.signPdf(sessionId, creds, fs.readFileSync(path));
          replaceAttachment(campaignId, filename, signed);
          signedCount++;
          if (!signerCn) signerCn = (await this.verification.verify(signed, filename)).signerCn ?? null;
        } catch (err) {
          if (err instanceof RemoteSignError && err.kind === 'file') {
            failedCount++;
          } else {
            stop = err instanceof RemoteSignError ? err : new RemoteSignError('network', 'Errore imprevisto durante la firma');
            if (!(err instanceof RemoteSignError)) captureException(err, { jobId, campaignId, stage: 'remoteSign' });
            break;
          }
        }
        await this.jobRepo.update({ id: jobId }, { signedCount, failedCount });
      }
    } finally {
      await this.client.closeSession(sessionId, creds);
      // PRIMA della nuova verifica, POI lo stato finale: la UI legge "job
      // concluso" e subito dopo l'ultima verifica — deve già essere la nuova.
      await this.verificationBulk.startForCampaign(campaignId);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const errorMessage = stop
        ? stop.kind === 'session'
          ? `Sessione scaduta dopo ${signedCount} file su ${total} (${seconds} s): inserisci un nuovo OTP per i rimanenti`
          : stop.message
        : null;
      if (stop) this.logger.warn(`Firma remota ${jobId} interrotta (${stop.kind}) dopo ${signedCount}/${total} file in ${seconds} s`);
      else this.logger.log(`Firma remota ${jobId}: ${signedCount} firmati, ${failedCount} falliti su ${total} in ${seconds} s`);
      await this.jobRepo.update({ id: jobId }, {
        status: stop ? RemoteSignJobStatus.FAILED : RemoteSignJobStatus.DONE,
        signedCount,
        failedCount,
        signerCn,
        errorKind: stop?.kind ?? null,
        errorMessage,
        completedAt: new Date(),
      });
      const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
      // Operatore ComunicaPA che ha avviato la firma (non lo username Aruba).
      const jobRow = await this.jobRepo.findOneBy({ id: jobId });
      await this.audit.log({
        campaignId,
        campaignName: campaign?.name ?? null,
        operator: jobRow?.operator ?? user,
        action: 'REMOTE_SIGN',
        details: { jobId, signerCn, signed: signedCount, failed: failedCount, total, errorKind: stop?.kind ?? null, seconds },
      });
    }
  }
}
```

- [ ] **Step 9: Run processor tests**

Run: `docker compose exec backend node_modules/.bin/vitest run remote-sign.processor`
Expected: PASS (4 test)

- [ ] **Step 10: Controller + module + wiring**

```ts
// apps/backend/src/remote-sign/remote-sign.controller.ts
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignCredentialsDto } from './dto/remote-sign-credentials.dto.js';

@Controller('admin')
export class RemoteSignController {
  constructor(private readonly service: RemoteSignService) {}

  @Get('remote-sign/config')
  @Roles('user', 'admin')
  async config(): Promise<{ enabled: boolean }> {
    return { enabled: await this.service.isEnabled() };
  }

  @Post('campaigns/:id/remote-sign')
  @HttpCode(200)
  @Roles('user', 'admin')
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoteSignCredentialsDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.service.start(id, { username: req.user.username, role: req.user.role }, dto);
  }

  @Get('campaigns/:id/remote-sign')
  @Roles('user', 'admin')
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const status = await this.service.getLatestStatus(id);
    if (!status) throw new NotFoundException('Nessuna firma remota avviata per questa campagna');
    return status;
  }

  @Post('settings/remote-sign/test')
  @HttpCode(200)
  @Roles('admin')
  test(@Body() dto: RemoteSignCredentialsDto) {
    return this.service.testSign(dto);
  }
}
```

```ts
// apps/backend/src/remote-sign/remote-sign.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { RemoteSignJob } from '../entities/remote-sign-job.entity.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignProcessor } from './remote-sign.processor.js';
import { RemoteSignController } from './remote-sign.controller.js';
import { REMOTE_SIGN_QUEUE } from './remote-sign-job.types.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, RemoteSignJob]),
    BullModule.registerQueue({ name: REMOTE_SIGN_QUEUE }),
    AuditLogsModule,
  ],
  controllers: [RemoteSignController],
  providers: [ArubaSignClient, RemoteSignService, RemoteSignProcessor],
  exports: [RemoteSignService],
})
export class RemoteSignModule {}
```

`app.module.ts`: `import { RemoteSignModule } from './remote-sign/remote-sign.module.js';` e `RemoteSignModule,` subito dopo `SignatureVerificationModule,` negli `imports`.

Verificare con `grep -n "@Global\|exports" apps/backend/src/audit-logs/audit-logs.module.ts` che `AuditLogsModule` esporti `AuditLogsService` (sì, riga 11).

- [ ] **Step 11: Write failing launch-gate tests**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`:
1. in cima, accanto agli altri mock: `const mockRemoteSignJobRepo = { exists: vi.fn().mockResolvedValue(false) };`
2. nei `providers` del `Test.createTestingModule` (vicino a `{ provide: SignatureVerificationBulkService, … }`, riga ~125): `{ provide: getRepositoryToken(RemoteSignJob), useValue: mockRemoteSignJobRepo },` + import `RemoteSignJob` da `'../entities/remote-sign-job.entity.js'`.
3. dopo il test `'launch(): SEND massivo con verifica in corso resta bloccato anche se forzato'`:

```ts
  it('launch(): SEND massivo bloccato se la firma remota è in corso', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      channelType: 'SEND',
      channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }], wizSingleMode: false },
    });
    mockRemoteSignJobRepo.exists.mockResolvedValueOnce(true);

    const result = await service.launch('c-send-signing', ADMIN_REQUESTER, { forceUnsignedAttachments: true });

    expect(result.blocked).toBe(true);
    expect(result.message).toBe('Firma remota in corso: attendi la fine prima di lanciare.');
    expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-send-signing' }, { status: CampaignStatus.DRAFT });
  });

  it('launch(): Invio Manuale SEND bloccato se la firma remota è in corso', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      channelType: 'SEND',
      channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }], wizSingleMode: true },
    });
    mockRemoteSignJobRepo.exists.mockResolvedValueOnce(true);

    const result = await service.launch('c-single-signing', ADMIN_REQUESTER);

    expect(result.blocked).toBe(true);
    expect(result.message).toBe('Firma remota in corso: attendi la fine prima di lanciare.');
  });
```

Run: `docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec`
Expected: FAIL (2 nuovi test) — `blocked` undefined

- [ ] **Step 12: Implement gate**

`campaigns.module.ts:27`: aggiungere `RemoteSignJob` all'array di `TypeOrmModule.forFeature([...])` + import entity.

`campaigns.service.ts`, costruttore, dopo `posteTrackingRepo`:

```ts
    // @Optional: come posteTrackingRepo — le spec che non lo forniscono
    // vedono "nessuna firma remota in corso".
    @Optional() @InjectRepository(RemoteSignJob)
    private readonly remoteSignJobRepo?: Repository<RemoteSignJob>,
```

`launch()`, all'inizio del blocco `if (campaign.channelType === 'SEND') {` (prima di `if (isSingleRecipientFlow(campaign))`):

```ts
      // Firma remota in corso: l'ultima verifica "done" è quella PRIMA della
      // firma — senza questo blocco si lancerebbe a metà sostituzione file.
      if (this.remoteSignJobRepo && await this.remoteSignJobRepo.exists({
        where: { campaignId, status: In([RemoteSignJobStatus.QUEUED, RemoteSignJobStatus.PROCESSING]) },
      })) {
        await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
        return { launched: 0, campaignId, blocked: true, message: 'Firma remota in corso: attendi la fine prima di lanciare.' };
      }
```

Import: `import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';` (`In` è già importato da `typeorm` — verificare).

- [ ] **Step 13: Run all backend tests + both tsc**

Run: `docker compose exec backend node_modules/.bin/vitest run` ; `docker compose exec backend node_modules/.bin/tsc --noEmit` ; `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: tutto verde, failure set = baseline

- [ ] **Step 14: Commit**

```bash
git add apps/backend/src/remote-sign apps/backend/src/app.module.ts apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(remote-sign): firma remota Aruba in background con sessione OTP"
```

---

### Task 5: ZIP da firmare e ricarico firmati

**Files:**
- Create: `apps/backend/src/remote-sign/signed-attachments.service.ts`
- Create: `apps/backend/src/remote-sign/signed-attachments.controller.ts`
- Modify: `apps/backend/src/remote-sign/remote-sign.module.ts` (controller + provider)
- Test: `apps/backend/src/remote-sign/signed-attachments.service.spec.ts`

**Interfaces:**
- Consumes: `RemoteSignService.listFilesToSign/assertCanModify/hasActiveJob` (Task 4), `matchSignedFiles` (Task 1), `replaceAttachment` (Task 3), `extractZipWithYauzl`/`flattenZipEntryName` (`campaigns/zip-extract.util.ts`), `assembleChunkedUpload`/`initChunkedUpload`/`safeChunkUploadDir`/`isValidChunkIndex`/`MAX_CHUNK_SIZE_BYTES` (`campaigns/chunked-upload.util.ts`), `SignatureVerificationBulkService.getLatestStatus/startForCampaign`.
- Produces:
  ```ts
  class SignedAttachmentsService {
    buildUnsignedZip(campaignId: string, requester: CampaignRequester): Promise<Buffer | { error: string }>;
    applySignedUpload(campaignId: string, requester: CampaignRequester, uploadedPath: string, uploadedName: string): Promise<{ replaced: number; rejected: Array<{ file: string; reason: string }> } | { error: string }>;
  }
  ```
  Route: `GET admin/campaigns/:id/signature/unsigned.zip`, `POST admin/campaigns/:id/signed-attachments/upload/init`, `.../chunk/:uploadId/:index`, `.../complete/:uploadId`.

- [ ] **Step 1: Write failing tests**

```ts
// apps/backend/src/remote-sign/signed-attachments.service.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { SignedAttachmentsService } from './signed-attachments.service.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const ADMIN = { username: 'admin', role: 'admin' as const };

function build() {
  const remoteSign = {
    assertCanModify: vi.fn().mockResolvedValue({ id: CAMPAIGN, name: 'Prova' }),
    hasActiveJob: vi.fn().mockResolvedValue(false),
    listFilesToSign: vi.fn().mockResolvedValue({ toSign: ['A.pdf', 'B.pdf'], alreadyValid: ['V.pdf'] }),
  };
  const bulk = {
    getLatestStatus: vi.fn().mockResolvedValue({ status: 'done', invalidCount: 2 }),
    startForCampaign: vi.fn().mockResolvedValue({ jobId: 'v-2' }),
  };
  const audit = { log: vi.fn() };
  return { svc: new SignedAttachmentsService(remoteSign as any, bulk as any, audit as any), remoteSign, bulk, audit };
}

describe('SignedAttachmentsService', () => {
  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sa-'));
    scratch = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sa-up-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    for (const f of ['A.pdf', 'B.pdf', 'V.pdf']) fs.writeFileSync(join(getUploadsDir(CAMPAIGN), f), `orig-${f}`);
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('buildUnsignedZip contiene solo i file da firmare col nome originale', async () => {
    const { svc } = build();
    const zip = await svc.buildUnsignedZip(CAMPAIGN, ADMIN);
    expect(Buffer.isBuffer(zip)).toBe(true);
    const names = new AdmZip(zip as Buffer).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['A.pdf', 'B.pdf']);
  });

  it('buildUnsignedZip con verifica non conclusa → error', async () => {
    const { svc, bulk } = build();
    bulk.getLatestStatus.mockResolvedValueOnce({ status: 'processing' });
    await expect(svc.buildUnsignedZip(CAMPAIGN, ADMIN)).resolves.toEqual({ error: 'Attendi la fine della verifica firma' });
  });

  it('ricarico ZIP: sottocartelle Windows, suffissi, p7m, già validi; backup e nuova verifica', async () => {
    const { svc, bulk, audit } = build();
    const zip = new AdmZip();
    zip.addFile('firmati\\A-signed.pdf', Buffer.from('firmato-A'));
    zip.addFile('B.pdf.p7m', Buffer.from('p7m'));
    zip.addFile('V_firmato.pdf', Buffer.from('firmato-V'));
    const zipPath = join(scratch, 'firmati.zip');
    zip.writeZip(zipPath);

    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, zipPath, 'firmati.zip');

    expect(res).toEqual({
      replaced: 1,
      rejected: [
        { file: 'B.pdf.p7m', reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' },
        { file: 'V_firmato.pdf', reason: 'Allegato già firmato validamente' },
      ],
    });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('firmato-A');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'V.pdf'), 'utf8')).toBe('orig-V.pdf');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('orig-A.pdf');
    expect(fs.readdirSync(getUploadsDir(CAMPAIGN)).sort()).toEqual(['A.pdf', 'B.pdf', 'V.pdf']);
    expect(bulk.startForCampaign).toHaveBeenCalledWith(CAMPAIGN);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPLOAD_SIGNED_ATTACHMENTS' }));
  });

  it('ricarico singolo PDF col nome originale', async () => {
    const { svc } = build();
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'firmato-B');
    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'B.pdf');
    expect(res).toEqual({ replaced: 1, rejected: [] });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'B.pdf'), 'utf8')).toBe('firmato-B');
  });

  it('nessun file abbinato: niente nuova verifica', async () => {
    const { svc, bulk } = build();
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'x');
    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'ALTRO.pdf');
    expect(res).toEqual({ replaced: 0, rejected: [{ file: 'ALTRO.pdf', reason: 'Nessun allegato da firmare con questo nome' }] });
    expect(bulk.startForCampaign).not.toHaveBeenCalled();
  });

  it('firma remota in corso → error, nessuna scrittura', async () => {
    const { svc, remoteSign } = build();
    remoteSign.hasActiveJob.mockResolvedValueOnce(true);
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'x');
    await expect(svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'A.pdf'))
      .resolves.toEqual({ error: 'Firma remota in corso: attendi la fine prima di ricaricare' });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('orig-A.pdf');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec backend node_modules/.bin/vitest run signed-attachments.service`
Expected: FAIL — modulo mancante

- [ ] **Step 3: Implement service**

```ts
// apps/backend/src/remote-sign/signed-attachments.service.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { extractZipWithYauzl, flattenZipEntryName } from '../campaigns/zip-extract.util.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import type { CampaignRequester } from '../campaigns/campaigns.service.js';
import { RemoteSignService } from './remote-sign.service.js';
import { matchSignedFiles } from './signed-attachment-matcher.util.js';
import { replaceAttachment } from './attachment-writer.util.js';

@Injectable()
export class SignedAttachmentsService {
  constructor(
    private readonly remoteSign: RemoteSignService,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly audit: AuditLogsService,
  ) {}

  async buildUnsignedZip(campaignId: string, requester: CampaignRequester): Promise<Buffer | { error: string }> {
    await this.remoteSign.assertCanModify(campaignId, requester);
    const verification = await this.verificationBulk.getLatestStatus(campaignId);
    if (!verification || verification.status !== SignatureVerificationJobStatus.DONE) {
      return { error: 'Attendi la fine della verifica firma' };
    }
    const { toSign } = await this.remoteSign.listFilesToSign(campaignId);
    const zip = new AdmZip();
    for (const f of toSign) {
      const path = join(getUploadsDir(campaignId), f);
      if (fs.existsSync(path)) zip.addLocalFile(path);
    }
    return zip.toBuffer();
  }

  /**
   * Ricarico firmati: estrazione in cartella temporanea (MAI in uploads —
   * finalizeAttachments/estrazione diretta svuoterebbe la cartella su un
   * nome sbagliato), abbinamento per nome, sostituzione col nome originale.
   */
  async applySignedUpload(
    campaignId: string,
    requester: CampaignRequester,
    uploadedPath: string,
    uploadedName: string,
  ): Promise<{ replaced: number; rejected: Array<{ file: string; reason: string }> } | { error: string }> {
    const campaign = await this.remoteSign.assertCanModify(campaignId, requester);
    if (await this.remoteSign.hasActiveJob(campaignId)) {
      fs.rmSync(uploadedPath, { force: true });
      return { error: 'Firma remota in corso: attendi la fine prima di ricaricare' };
    }
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-signed-'));
    try {
      let names: string[];
      if (uploadedName.toLowerCase().endsWith('.zip')) {
        // Elenco completo (anche non-PDF/.p7m, che extractZipWithYauzl salta
        // in silenzio) per poterli riportare come rifiutati col motivo.
        names = new AdmZip(uploadedPath).getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => flattenZipEntryName(e.entryName));
        await extractZipWithYauzl(uploadedPath, tmp);
      } else {
        names = [uploadedName];
        fs.copyFileSync(uploadedPath, join(tmp, uploadedName));
      }

      const { toSign, alreadyValid } = await this.remoteSign.listFilesToSign(campaignId);
      const { matched, rejected } = matchSignedFiles(names, toSign, alreadyValid);
      for (const m of matched) {
        replaceAttachment(campaignId, m.original, fs.readFileSync(join(tmp, m.uploaded)));
      }
      if (matched.length > 0) await this.verificationBulk.startForCampaign(campaignId);
      await this.audit.log({
        campaignId,
        campaignName: campaign.name ?? null,
        operator: requester.username,
        action: 'UPLOAD_SIGNED_ATTACHMENTS',
        details: { filename: uploadedName, replaced: matched.length, rejected: rejected.length },
      });
      return { replaced: matched.length, rejected };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(uploadedPath, { force: true });
    }
  }
}
```

Nota: `extractZipWithYauzl` estrae i PDF con nome appiattito (`flattenZipEntryName`), quindi `join(tmp, m.uploaded)` esiste per ogni PDF abbinato. Se `flattenZipEntryName` collide (due PDF con lo stesso nome in cartelle diverse) il matcher li vede come duplicati → ambigui → rifiutati: corretto.

- [ ] **Step 4: Run tests**

Run: `docker compose exec backend node_modules/.bin/vitest run signed-attachments.service`
Expected: PASS (6 test)

- [ ] **Step 5: Controller**

```ts
// apps/backend/src/remote-sign/signed-attachments.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  assembleChunkedUpload,
  initChunkedUpload,
  isValidChunkIndex,
  MAX_CHUNK_SIZE_BYTES,
  safeChunkUploadDir,
} from '../campaigns/chunked-upload.util.js';
import { SignedAttachmentsService } from './signed-attachments.service.js';

@Controller('admin/campaigns/:id')
@Roles('user', 'admin')
export class SignedAttachmentsController {
  constructor(private readonly service: SignedAttachmentsService) {}

  @Get('signature/unsigned.zip')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.service.buildUnsignedZip(id, { username: req.user.username, role: req.user.role });
    if (!Buffer.isBuffer(result)) {
      res.status(200).json(result);
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="allegati-da-firmare.zip"');
    res.send(result);
  }

  // Stesso schema chunked di :id/attachments/upload/* (limite body del
  // reverse proxy esterno): init/chunk identici, complete dedicato.
  @Post('signed-attachments/upload/init')
  @HttpCode(200)
  init(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('signed-attachments/upload/chunk/:uploadId/:index')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = safeChunkUploadDir(req.params['uploadId']);
          if (!dir || !fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = req.params['index'];
          if (!isValidChunkIndex(index)) {
            cb(new BadRequestException('index non valido'), '');
            return;
          }
          cb(null, `${index}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  chunk(): { ok: true } {
    return { ok: true };
  }

  @Post('signed-attachments/upload/complete/:uploadId')
  @HttpCode(200)
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const { path, filename } = await assembleChunkedUpload(uploadId);
    return this.service.applySignedUpload(id, { username: req.user.username, role: req.user.role }, path, filename);
  }
}
```

`remote-sign.module.ts`: aggiungere `SignedAttachmentsController` a `controllers` e `SignedAttachmentsService` a `providers`.

Prima di committare, confrontare con `campaigns.controller.ts:405-443` che le firme di `initChunkedUpload`/`assembleChunkedUpload` coincidano (stesso uso).

- [ ] **Step 6: Full suite + tsc, commit**

Run: vitest completo + `tsc --noEmit` + `tsc -p tsconfig.spec.json --noEmit` → verde.

```bash
git add apps/backend/src/remote-sign
git commit -m "feat(remote-sign): ZIP allegati da firmare e ricarico dei firmati"
```

---

### Task 6: Frontend — pannello firma step 6/7 e modale Aruba

**Files:**
- Create: `apps/frontend-admin/src/chunked-upload.ts`
- Create: `apps/frontend-admin/src/components/signature/types.ts`
- Create: `apps/frontend-admin/src/components/signature/RemoteSignModal.tsx`
- Create: `apps/frontend-admin/src/components/signature/SignaturePanel.tsx`
- Modify: `apps/frontend-admin/src/App.tsx` — rimuovere `UPLOAD_CHUNK_SIZE`/`uploadChunkXhr`/`uploadFileInChunks` (righe ~1078-1158) e importarli; sostituire i due blocchi `{wizChannel === 'SEND' && !wizSingleMode && ( <div className={`alert …` … )}` (righe ~12615 e ~12780, cercare `Verifica firma digitale allegati in corso...`) con `<SignaturePanel …/>`.

**Interfaces:**
- Consumes: route Task 4/5; `ApiFetch` type (`components/legal-attention/types.ts`).
- Produces:
  ```ts
  // chunked-upload.ts
  export const UPLOAD_CHUNK_SIZE: number;
  export function uploadFileInChunks(baseUrl: string, token: string, file: Blob, filename: string, onProgress: (loaded: number) => void, onCompleteStart?: () => void, completeBody?: Record<string, unknown>): Promise<any>;
  // components/signature/types.ts
  export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
  export interface SignatureJobStatus { status: string; totalRows: number; validCount: number; invalidCount: number; errorMessage: string | null; }
  export interface RemoteSignStatus { status: 'queued' | 'processing' | 'done' | 'failed'; totalFiles: number; signedCount: number; failedCount: number; errorKind: string | null; errorMessage: string | null; signerCn: string | null; }
  // RemoteSignModal.tsx
  export function RemoteSignModal(props: { apiFetch: ApiFetch; mode: { kind: 'campaign'; campaignId: string } | { kind: 'test' }; onClose: () => void; onFinished?: (s: RemoteSignStatus) => void }): JSX.Element;
  // SignaturePanel.tsx
  export function SignaturePanel(props: { apiFetch: ApiFetch; token: string; adminApiBase: string; campaignId: string; status: SignatureJobStatus | null }): JSX.Element;
  ```

- [ ] **Step 1: Extract chunked upload**

Creare `apps/frontend-admin/src/chunked-upload.ts` spostando **senza modifiche** da `App.tsx` il commento + `const UPLOAD_CHUNK_SIZE = 800 * 1024;`, `function uploadChunkXhr(...)` e `async function uploadFileInChunks(...)` (con il loro commento JSDoc), aggiungendo `export` a `UPLOAD_CHUNK_SIZE` e `uploadFileInChunks`. In `App.tsx` cancellare quei blocchi e aggiungere in cima `import { uploadFileInChunks } from './chunked-upload';` (aggiungere anche `UPLOAD_CHUNK_SIZE` all'import solo se `grep -n UPLOAD_CHUNK_SIZE apps/frontend-admin/src/App.tsx` trova altri usi).

Run tsc frontend (comando in Global Constraints). Expected: solo l'errore preesistente `App.tsx(5614,77)` (numero di riga può spostarsi: stesso messaggio `TS2322 Type 'string' is not assignable to type 'string[]'`).

- [ ] **Step 2: Types**

```ts
// apps/frontend-admin/src/components/signature/types.ts
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SignatureJobStatus {
  status: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errorMessage: string | null;
}

export interface RemoteSignStatus {
  status: 'queued' | 'processing' | 'done' | 'failed';
  totalFiles: number;
  signedCount: number;
  failedCount: number;
  errorKind: string | null;
  errorMessage: string | null;
  signerCn: string | null;
}

export const ARUBA_USER_STORAGE_KEY = 'comunicapa.arubaSignUser';
```

- [ ] **Step 3: RemoteSignModal**

```tsx
// apps/frontend-admin/src/components/signature/RemoteSignModal.tsx
import { useEffect, useRef, useState } from 'react';
import { Loader2, PenLine } from 'lucide-react';
import { ARUBA_USER_STORAGE_KEY } from './types';
import type { ApiFetch, RemoteSignStatus } from './types';

type Mode = { kind: 'campaign'; campaignId: string } | { kind: 'test' };

interface Props {
  apiFetch: ApiFetch;
  mode: Mode;
  onClose: () => void;
  /** Solo mode campaign: job concluso (done o failed). */
  onFinished?: (status: RemoteSignStatus) => void;
}

function readSavedUser(): string {
  try { return localStorage.getItem(ARUBA_USER_STORAGE_KEY) ?? ''; } catch { return ''; }
}
function saveUser(user: string): void {
  try { localStorage.setItem(ARUBA_USER_STORAGE_KEY, user); } catch { /* storage non disponibile */ }
}

/**
 * Credenziali firma remota Aruba: utente ricordato nel browser, password e
 * OTP MAI salvati (svuotati alla chiusura). In mode campaign avvia il job e
 * ne segue l'avanzamento; in mode test esegue la Prova firma.
 */
export function RemoteSignModal({ apiFetch, mode, onClose, onFinished }: Props) {
  const [user, setUser] = useState(readSavedUser);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<RemoteSignStatus | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);

  const polling = progress !== null && (progress.status === 'queued' || progress.status === 'processing');
  const campaignId = mode.kind === 'campaign' ? mode.campaignId : null;

  useEffect(() => {
    if (!polling || !campaignId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`/campaigns/${campaignId}/remote-sign`);
        if (!res.ok || cancelled) return;
        const s: RemoteSignStatus = await res.json();
        setProgress(s);
        if (s.status === 'done' || s.status === 'failed') {
          if (s.status === 'failed') {
            setError(s.errorMessage ?? 'Firma interrotta');
            setOtp('');
          }
          onFinishedRef.current?.(s);
        }
      } catch {
        // silenzioso: stesso principio degli altri polling di stato
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [polling, campaignId, apiFetch]);

  const close = () => {
    setPassword('');
    setOtp('');
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setTestResult(null);
    saveUser(user.trim());
    try {
      const path = mode.kind === 'campaign' ? `/campaigns/${mode.campaignId}/remote-sign` : '/settings/remote-sign/test';
      const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user.trim(), password, otp: otp.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
        setError(msg || `Errore (HTTP ${res.status})`);
        return;
      }
      if (mode.kind === 'test') {
        if (body?.ok) setTestResult(`Firma valida. Firmatario: ${body.signerCn ?? 'non letto'}`);
        else setError(body?.error ?? 'Prova firma fallita');
        setOtp('');
        return;
      }
      if (body?.error) {
        setError(body.error);
        setOtp('');
        return;
      }
      setPassword('');
      setOtp('');
      setProgress({ status: 'queued', totalFiles: 0, signedCount: 0, failedCount: 0, errorKind: null, errorMessage: null, signerCn: null });
    } catch (err: any) {
      setError(err?.message ?? 'Errore di rete');
    } finally {
      setBusy(false);
    }
  };

  const finished = progress && (progress.status === 'done' || progress.status === 'failed');
  const showForm = !polling && !(finished && progress?.status === 'done');

  return (
    <div className="modal d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title d-flex align-items-center gap-2"><PenLine size={18} /> {mode.kind === 'test' ? 'Prova firma remota Aruba' : 'Firma con Aruba'}</h5>
            <button type="button" className="btn-close" aria-label="Chiudi" onClick={close} disabled={polling} />
          </div>
          <div className="modal-body">
            {progress && (
              <div className="mb-3">
                {polling ? (
                  <div className="d-flex align-items-center gap-2"><Loader2 className="icon-spin" size={16} /> Firma in corso {progress.signedCount}/{progress.totalFiles || '…'}</div>
                ) : progress.status === 'done' ? (
                  <div className="alert alert-success mb-0">Firmati {progress.signedCount} file{progress.failedCount > 0 ? `, ${progress.failedCount} non firmati` : ''}{progress.signerCn ? ` — firmatario ${progress.signerCn}` : ''}. Verifica firma in corso…</div>
                ) : null}
              </div>
            )}
            {error && <div className="alert alert-danger">{error}</div>}
            {testResult && <div className="alert alert-success">{testResult}</div>}
            {showForm && (
              <form id="remote-sign-form" onSubmit={submit} autoComplete="off">
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_user">Utente firma remota</label>
                  <input id="rs_user" className="form-control form-control-sm" value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="off" />
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_password">Password</label>
                  <input id="rs_password" type="password" className="form-control form-control-sm" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_otp">OTP</label>
                  <input id="rs_otp" className="form-control form-control-sm" inputMode="numeric" pattern="\d{6,8}" value={otp} onChange={(e) => setOtp(e.target.value)} required autoComplete="one-time-code" />
                  <div className="form-text small">Genera l'OTP per ultimo: dura pochi secondi. Un solo OTP firma tutto il lotto.</div>
                </div>
              </form>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline-secondary" onClick={close} disabled={polling}>Chiudi</button>
            {showForm && (
              <button type="submit" form="remote-sign-form" className="btn btn-primary" disabled={busy}>
                {busy ? <Loader2 className="icon-spin" size={16} /> : null} {mode.kind === 'test' ? 'Prova firma' : 'Firma'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: SignaturePanel**

```tsx
// apps/frontend-admin/src/components/signature/SignaturePanel.tsx
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, PenLine, Upload } from 'lucide-react';
import { uploadFileInChunks } from '../../chunked-upload';
import { RemoteSignModal } from './RemoteSignModal';
import type { ApiFetch, SignatureJobStatus } from './types';

interface Props {
  apiFetch: ApiFetch;
  token: string;
  adminApiBase: string;
  campaignId: string;
  /** Ultima verifica firma, già pollata da App (step 6/7). */
  status: SignatureJobStatus | null;
}

const MAX_REJECTED_SHOWN = 20;

export function SignaturePanel({ apiFetch, token, adminApiBase, campaignId, status }: Props) {
  const [arubaEnabled, setArubaEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'danger'; text: string; rejected?: Array<{ file: string; reason: string }> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch('/remote-sign/config')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((b) => setArubaEnabled(Boolean(b.enabled)))
      .catch(() => setArubaEnabled(false));
  }, [apiFetch]);

  const downloadZip = async () => {
    setBusy('Preparazione ZIP…');
    setMessage(null);
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/signature/unsigned.zip`);
      const type = res.headers.get('Content-Type') ?? '';
      if (!res.ok || type.includes('application/json')) {
        const body = await res.json().catch(() => null);
        setMessage({ kind: 'danger', text: body?.error ?? body?.message ?? 'Download non riuscito' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'allegati-da-firmare.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const uploadSigned = async (file: File) => {
    setBusy('Caricamento firmati…');
    setMessage(null);
    try {
      const body = await uploadFileInChunks(
        `${adminApiBase}/campaigns/${campaignId}/signed-attachments/upload`,
        token,
        file,
        file.name,
        () => undefined,
        () => setBusy('Abbinamento file firmati…'),
      );
      if (body?.error) {
        setMessage({ kind: 'danger', text: body.error });
      } else {
        setMessage({
          kind: body.replaced > 0 ? 'success' : 'danger',
          text: `Sostituiti ${body.replaced} allegati${body.rejected.length > 0 ? `, ${body.rejected.length} file scartati` : ''}. ${body.replaced > 0 ? 'Verifica firma in corso…' : ''}`,
          rejected: body.rejected,
        });
      }
    } catch (err: any) {
      setMessage({ kind: 'danger', text: err?.message ?? 'Caricamento non riuscito' });
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const allValid = status?.status === 'done' && status.invalidCount === 0;
  const hasInvalid = status?.status === 'done' && status.invalidCount > 0;

  return (
    <div className={`alert ${allValid ? 'alert-success' : 'alert-warning'} mb-3`}>
      <div className="d-flex align-items-center gap-2">
        {!status ? (
          <>Verifica firma digitale allegati in corso...</>
        ) : status.status !== 'done' ? (
          <><Loader2 className="icon-spin" size={16} /> Verifica firma digitale in corso...</>
        ) : hasInvalid ? (
          <><AlertTriangle size={16} /> {status.invalidCount} allegato/i non firmati validamente su {status.totalRows} — firmali qui sotto o lancia comunque confermando sotto la tua responsabilità.</>
        ) : (
          <><CheckCircle2 size={16} /> Tutti gli allegati ({status.totalRows}) risultano firmati validamente.</>
        )}
      </div>

      {hasInvalid && (
        <div className="d-flex flex-wrap gap-2 mt-2">
          {arubaEnabled && (
            <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => setModalOpen(true)}>
              <PenLine size={14} className="me-1" />Firma con Aruba
            </button>
          )}
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!!busy} onClick={downloadZip}>
            <Download size={14} className="me-1" />Scarica ZIP da firmare
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}>
            <Upload size={14} className="me-1" />Carica firmati
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.pdf"
            className="d-none"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadSigned(f); }}
          />
          {busy && <span className="small d-flex align-items-center gap-1"><Loader2 className="icon-spin" size={14} />{busy}</span>}
        </div>
      )}

      {message && (
        <div className={`alert alert-${message.kind} mt-2 mb-0 small`}>
          {message.text}
          {message.rejected && message.rejected.length > 0 && (
            <ul className="mb-0 mt-1">
              {message.rejected.slice(0, MAX_REJECTED_SHOWN).map((r) => <li key={r.file}><code>{r.file}</code>: {r.reason}</li>)}
              {message.rejected.length > MAX_REJECTED_SHOWN && <li>e altri {message.rejected.length - MAX_REJECTED_SHOWN}</li>}
            </ul>
          )}
        </div>
      )}

      {modalOpen && (
        <RemoteSignModal
          apiFetch={apiFetch}
          mode={{ kind: 'campaign', campaignId }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
```

Il pannello non ripolla la verifica: lo fa già l'effetto esistente di App (step 6/7, ogni 3 s, `wizSignatureJobStatus`). La nuova verifica è creata dal backend prima della fine del job (Task 4), quindi il polling di App la vede da solo.

- [ ] **Step 5: Wire into App.tsx**

In `App.tsx` aggiungere `import { SignaturePanel } from './components/signature/SignaturePanel';`. Sostituire **entrambi** i blocchi (cercare con `grep -n "Verifica firma digitale allegati in corso" apps/frontend-admin/src/App.tsx`; il blocco inizia con `{wizChannel === 'SEND' && !wizSingleMode && (` e termina con il `)}` dopo il `</div>` dell'alert) con:

```tsx
                  {wizChannel === 'SEND' && !wizSingleMode && wizCampaignId && (
                    <SignaturePanel
                      apiFetch={apiFetch}
                      token={token!}
                      adminApiBase={ADMIN_API_BASE}
                      campaignId={wizCampaignId}
                      status={wizSignatureJobStatus}
                    />
                  )}
```

Lasciare invariate le condizioni `disabled` dei bottoni di lancio (forzatura v1.10.2).

- [ ] **Step 6: tsc frontend**

Run: tsc frontend (Global Constraints). Expected: solo l'errore preesistente.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/chunked-upload.ts apps/frontend-admin/src/components/signature apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): firma allegati SEND dallo step 6 (Aruba, ZIP)"
```

---

### Task 7: Frontend — Invio Manuale, scelta firma/invia/annulla

**Files:**
- Create: `apps/frontend-admin/src/components/signature/UnsignedDecisionModal.tsx`
- Modify: `apps/frontend-admin/src/App.tsx` — `triggerAndAlertSignatureVerification` (cercare `const triggerAndAlertSignatureVerification = async`), stato modale, render

**Interfaces:**
- Consumes: `RemoteSignModal` (Task 6), `GET admin/remote-sign/config`.
- Produces:
  ```ts
  export type UnsignedDecision = 'continue' | 'cancel';
  export function UnsignedDecisionModal(props: { apiFetch: ApiFetch; campaignId: string; invalidCount: number; totalRows: number; arubaEnabled: boolean; onDecision: (d: UnsignedDecision) => void }): JSX.Element;
  ```
  `onDecision('continue')` dopo firma riuscita e nuova verifica tutta valida, o su "Invia comunque"; `'cancel'` su Annulla.

- [ ] **Step 1: UnsignedDecisionModal**

```tsx
// apps/frontend-admin/src/components/signature/UnsignedDecisionModal.tsx
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, PenLine } from 'lucide-react';
import { RemoteSignModal } from './RemoteSignModal';
import type { ApiFetch, RemoteSignStatus, SignatureJobStatus } from './types';

export type UnsignedDecision = 'continue' | 'cancel';

interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  invalidCount: number;
  totalRows: number;
  arubaEnabled: boolean;
  onDecision: (d: UnsignedDecision) => void;
}

/**
 * Invio Manuale SEND con allegato non firmato validamente: firma con Aruba
 * (e l'invio riprende da solo se la nuova verifica è tutta valida), invia
 * comunque sotto la responsabilità dell'operatore, o annulla.
 */
export function UnsignedDecisionModal({ apiFetch, campaignId, invalidCount, totalRows, arubaEnabled, onDecision }: Props) {
  const [signing, setSigning] = useState(false);
  const [waitingVerification, setWaitingVerification] = useState(false);
  const [counts, setCounts] = useState({ invalidCount, totalRows });
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!waitingVerification) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`/campaigns/${campaignId}/signature-verification`);
        if (!res.ok || cancelled) return;
        const s: SignatureJobStatus = await res.json();
        if (s.status === 'failed') {
          setWaitingVerification(false);
          setNote('Verifica firma non riuscita: riprova o invia comunque.');
        } else if (s.status === 'done') {
          setWaitingVerification(false);
          if (s.invalidCount === 0) onDecision('continue');
          else {
            setCounts({ invalidCount: s.invalidCount, totalRows: s.totalRows });
            setNote('Dopo la firma restano allegati non validi.');
          }
        }
      } catch {
        // silenzioso
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [waitingVerification, apiFetch, campaignId, onDecision]);

  const onSignFinished = (s: RemoteSignStatus) => {
    if (s.status === 'done') {
      setSigning(false);
      setWaitingVerification(true);
    }
  };

  if (signing) {
    return (
      <RemoteSignModal
        apiFetch={apiFetch}
        mode={{ kind: 'campaign', campaignId }}
        onClose={() => setSigning(false)}
        onFinished={onSignFinished}
      />
    );
  }

  return (
    <div className="modal d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title d-flex align-items-center gap-2"><AlertTriangle size={18} /> Allegato non firmato validamente</h5>
          </div>
          <div className="modal-body">
            <p>{counts.invalidCount} allegato/i su {counts.totalRows} non risulta/no firmato/i digitalmente in modo valido.</p>
            <p className="small text-muted mb-2">Per SEND l'allegato è il documento legale notificato: senza firma digitale valida la notifica rischia di essere contestata (autenticità dell'atto, decorrenza dei termini).</p>
            {note && <div className="alert alert-warning small">{note}</div>}
            {waitingVerification && <div className="d-flex align-items-center gap-2"><Loader2 className="icon-spin" size={16} /> Verifica della firma in corso…</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline-secondary" disabled={waitingVerification} onClick={() => onDecision('cancel')}>Annulla</button>
            <button type="button" className="btn btn-outline-danger" disabled={waitingVerification} onClick={() => onDecision('continue')}>Invia comunque</button>
            {arubaEnabled && (
              <button type="button" className="btn btn-primary" disabled={waitingVerification} onClick={() => { setNote(null); setSigning(true); }}>
                <PenLine size={14} className="me-1" />Firma con Aruba
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Promise-based decision in App.tsx**

Vicino agli altri `useState` del wizard (accanto a `wizSignatureJobStatus`, riga ~2439):

```tsx
  // Invio Manuale SEND: decisione dell'operatore su allegati non firmati,
  // risolta da UnsignedDecisionModal (firma Aruba / invia comunque / annulla).
  const [unsignedDecision, setUnsignedDecision] = useState<{
    campaignId: string;
    invalidCount: number;
    totalRows: number;
    arubaEnabled: boolean;
    resolve: (d: UnsignedDecision) => void;
  } | null>(null);

  const askUnsignedDecision = async (campaignId: string, invalidCount: number, totalRows: number): Promise<boolean> => {
    let arubaEnabled = false;
    try {
      const res = await apiFetch('/remote-sign/config');
      if (res.ok) arubaEnabled = Boolean((await res.json()).enabled);
    } catch {
      // senza config: solo Invia comunque / Annulla
    }
    const decision = await new Promise<UnsignedDecision>((resolve) => {
      setUnsignedDecision({ campaignId, invalidCount, totalRows, arubaEnabled, resolve });
    });
    setUnsignedDecision(null);
    return decision === 'continue';
  };
```

Import: `import { UnsignedDecisionModal, type UnsignedDecision } from './components/signature/UnsignedDecisionModal';`.

In `triggerAndAlertSignatureVerification`, sostituire:

```tsx
            if (isSingolo) {
              return confirmContinueDespiteInvalidSignature(status.invalidCount, status.totalRows);
            }
```

con:

```tsx
            if (isSingolo) {
              return askUnsignedDecision(campaignId, status.invalidCount, status.totalRows);
            }
```

Lasciare `confirmContinueDespiteInvalidSignature` (usata da `handleWizLaunch` per la forzatura del massivo).

Render, accanto alle altre modali globali del wizard (cercare `{wizStep === 6` o in fondo al JSX del wizard, prima della chiusura del contenitore `invio-massivo-wizard`):

```tsx
      {unsignedDecision && (
        <UnsignedDecisionModal
          apiFetch={apiFetch}
          campaignId={unsignedDecision.campaignId}
          invalidCount={unsignedDecision.invalidCount}
          totalRows={unsignedDecision.totalRows}
          arubaEnabled={unsignedDecision.arubaEnabled}
          onDecision={unsignedDecision.resolve}
        />
      )}
```

Nota: `triggerAndAlertSignatureVerification` ha un timeout di 20 s sulla verifica; la modale arriva solo dentro quel ramo `status === 'done'`, quindi l'attesa della firma Aruba (tempo indefinito) avviene dopo, dentro la Promise — nessun timeout la interrompe.

- [ ] **Step 3: tsc frontend + commit**

Run: tsc frontend. Expected: solo l'errore preesistente.

```bash
git add apps/frontend-admin/src/components/signature/UnsignedDecisionModal.tsx apps/frontend-admin/src/App.tsx
git commit -m "feat(admin): Invio Manuale SEND, firma Aruba prima dell'invio"
```

---

### Task 8: Frontend — Impostazioni "Firma remota"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` — `SettingsTab` (riga ~46), `SETTINGS_NAV` (sezione Integrazioni API, dopo `postalizzazione`), titolo scheda (blocco `{activeSettingsTab === 'oidc' && 'SPID / CIE …'}`), stato `settRemoteSign*`, caricamento (vicino a `setSettOidcLegalEntityEnabled(Boolean(s['oidc.legalEntityEnabled']))`, riga ~3282), `buildSettingsPayload` (dopo `'oidc.legalEntityEnabled'`), render scheda (prima di `{activeSettingsTab === 'oidc' && (`).

**Interfaces:**
- Consumes: `RemoteSignModal` mode `test` (Task 6), chiavi `remoteSign.*` (Task 2).

- [ ] **Step 1: Tab + nav + title**

```tsx
type SettingsTab = 'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'pdnd' | 'send' | 'inad' | 'anpr' | 'protocollo' | 'postalizzazione' | 'firma-remota' | 'external-api' | 'oidc' | 'motori';
```

In `SETTINGS_NAV`, dopo la riga `postalizzazione`:

```tsx
  { tab: 'firma-remota',     icon: PenLine,                 label: 'Firma remota (Aruba)' },
```

(`PenLine` da `lucide-react`: aggiungerlo all'import esistente se assente.)

Titolo, accanto alla riga `{activeSettingsTab === 'oidc' && 'SPID / CIE (OIDC) - Autenticazione Cittadini'}`:

```tsx
                        {activeSettingsTab === 'firma-remota' && 'Firma remota Aruba - Firma allegati SEND'}
```

- [ ] **Step 2: State, load, save**

Stato (vicino a `settOidcLegalEntityEnabled`):

```tsx
  const [settRemoteSignEnabled, setSettRemoteSignEnabled] = useState(false);
  const [settRemoteSignWsdlUrl, setSettRemoteSignWsdlUrl] = useState('');
  const [settRemoteSignOtpDomain, setSettRemoteSignOtpDomain] = useState('firma');
  const [settRemoteSignTypeHsm, setSettRemoteSignTypeHsm] = useState('COSIGN');
  const [settRemoteSignCertId, setSettRemoteSignCertId] = useState('AS0');
  const [remoteSignTestOpen, setRemoteSignTestOpen] = useState(false);
```

Caricamento (dopo `setSettOidcLegalEntityEnabled(...)`):

```tsx
        setSettRemoteSignEnabled(Boolean(s['remoteSign.enabled']));
        setSettRemoteSignWsdlUrl(String(s['remoteSign.wsdlUrl'] ?? ''));
        setSettRemoteSignOtpDomain(String(s['remoteSign.otpDomain'] ?? 'firma'));
        setSettRemoteSignTypeHsm(String(s['remoteSign.typeHsm'] ?? 'COSIGN'));
        setSettRemoteSignCertId(String(s['remoteSign.certId'] ?? 'AS0'));
```

`buildSettingsPayload`, dopo `'oidc.legalEntityEnabled': settOidcLegalEntityEnabled,`:

```tsx
    'remoteSign.enabled': settRemoteSignEnabled,
    'remoteSign.wsdlUrl': settRemoteSignWsdlUrl,
    'remoteSign.otpDomain': settRemoteSignOtpDomain,
    'remoteSign.typeHsm': settRemoteSignTypeHsm,
    'remoteSign.certId': settRemoteSignCertId,
```

- [ ] **Step 3: Render**

Prima di `{activeSettingsTab === 'oidc' && (`:

```tsx
                        {activeSettingsTab === 'firma-remota' && (
                          <div className="row g-3">
                            <div className="col-12">
                              <div className="form-text small text-muted mb-2">Firma digitale PAdES degli allegati SEND con la firma remota OTP Aruba. Utente, password e OTP si inseriscono al momento della firma e non vengono mai salvati.</div>
                              <div className="form-check form-switch">
                                <input className="form-check-input" type="checkbox" id="rs_enabled" checked={settRemoteSignEnabled} onChange={(e) => setSettRemoteSignEnabled(e.target.checked)} />
                                <label className="form-check-label small fw-bold" htmlFor="rs_enabled">Abilita "Firma con Aruba" nel wizard SEND</label>
                              </div>
                            </div>
                            <div className="col-md-8">
                              <label className="form-label small fw-bold text-dark" htmlFor="rs_wsdl">Endpoint servizio (WSDL)</label>
                              <input type="text" id="rs_wsdl" className="form-control form-control-sm" value={settRemoteSignWsdlUrl} onChange={(e) => setSettRemoteSignWsdlUrl(e.target.value)} />
                              <div className="form-text small text-muted">Servizio ARSS di Aruba. Cambiare solo per un'installazione ATP dell'ente.</div>
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="rs_domain">Dominio OTP</label>
                              <input type="text" id="rs_domain" className="form-control form-control-sm" value={settRemoteSignOtpDomain} onChange={(e) => setSettRemoteSignOtpDomain(e.target.value)} />
                              <div className="form-text small text-muted"><code>firma</code> per la firma remota personale Aruba.</div>
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="rs_hsm">Tipo HSM</label>
                              <input type="text" id="rs_hsm" className="form-control form-control-sm" value={settRemoteSignTypeHsm} onChange={(e) => setSettRemoteSignTypeHsm(e.target.value)} />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="rs_cert">ID certificato</label>
                              <input type="text" id="rs_cert" className="form-control form-control-sm" value={settRemoteSignCertId} onChange={(e) => setSettRemoteSignCertId(e.target.value)} />
                            </div>
                            <div className="col-12">
                              <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => setRemoteSignTestOpen(true)}>
                                <PenLine size={14} className="me-1" />Prova firma
                              </button>
                              <div className="form-text small text-muted">Salva prima le impostazioni: la prova firma un PDF di test con i parametri salvati e mostra il firmatario.</div>
                            </div>
                            {remoteSignTestOpen && (
                              <RemoteSignModal apiFetch={apiFetch} mode={{ kind: 'test' }} onClose={() => setRemoteSignTestOpen(false)} />
                            )}
                          </div>
                        )}
```

Import: `import { RemoteSignModal } from './components/signature/RemoteSignModal';`.

Attenzione (docs/claude/frontend-ui.md, "form non annidate"): la scheda Impostazioni è dentro un `<form onSubmit={handleSaveSettings}>`. `RemoteSignModal` contiene un `<form>`: verificare con `grep -n "<form" apps/frontend-admin/src/App.tsx` intorno al render delle impostazioni. Se è annidato, renderizzare la modale fuori dal form tramite portal: in `RemoteSignModal` avvolgere il return in `createPortal(<…/>, document.body)` (`import { createPortal } from 'react-dom';`). Applicarlo comunque: rende la modale sicura in ogni contesto (anche Task 6/7).

- [ ] **Step 4: tsc + commit**

Run: tsc frontend. Expected: solo l'errore preesistente.

```bash
git add apps/frontend-admin/src/App.tsx apps/frontend-admin/src/components/signature/RemoteSignModal.tsx
git commit -m "feat(admin): impostazioni firma remota Aruba con prova firma"
```

---

### Task 9: Documentazione, versione, verifica finale

**Files:**
- Modify: `apps/frontend-admin/public/guida/guida.md`
- Create: `docs/claude/remote-sign.md`
- Modify: `CLAUDE.md` (indice `docs/claude/`)
- Modify: `docs/claude/ci-cd-deps.md:104`
- Modify: `publiccode.yml` (`softwareVersion`, `releaseDate`) — **numero confermato dall'utente**

- [ ] **Step 1: Guida operatori**

`_Ultimo aggiornamento: <data del giorno>_` in testa. In "Operazioni frequenti" (cercare `## Operazioni frequenti`, aggiungere in fondo alla sezione):

```markdown
### Firmare gli allegati SEND

Se la verifica firma segnala allegati non firmati validamente:

- **Invio massivo, Passo 6:** nel riquadro arancione scegli
  - **Firma con Aruba**: inserisci utente e password della firma remota, genera l'OTP e premi **Firma**. Un solo OTP firma tutti i file; al termine la verifica riparte da sola.
  - **Scarica ZIP da firmare**: firma i PDF con il tuo programma (firma PAdES, il file resta un PDF), poi **Carica firmati** con lo ZIP o il singolo PDF. I nomi possono restare uguali o avere il suffisso `-signed` / `_firmato`.
- **Invio Manuale:** se l'allegato non è firmato compare la scelta **Firma con Aruba**, **Invia comunque** o **Annulla**. Dopo la firma l'invio prosegue da solo.

La firma con Aruba compare solo se attivata in **Impostazioni → Firma remota (Aruba)**.
```

In "Problemi frequenti", aggiornare la voce `### SEND: «allegato/i non firmati validamente» al Passo 6` — Soluzione:

```markdown
**Soluzione:** firma gli allegati dal riquadro (vedi [Firmare gli allegati SEND](#firmare-gli-allegati-send)). Se devi inviare comunque, premi **Conferma ed Avvia Campagna** e conferma l'avviso: l'invio parte sotto la tua responsabilità e la forzatura resta registrata nel registro attività. Senza firma valida la notifica può essere contestata.
```

e aggiungere in fondo a Problemi frequenti (prima di `### Non riesco a modificare o eliminare una campagna`):

```markdown
### Firma con Aruba: «Sessione scaduta dopo X file»

**Causa:** la sessione di firma Aruba ha una durata limitata; con molti file può scadere prima della fine.

**Soluzione:** premi di nuovo **Firma con Aruba** e inserisci un nuovo OTP: vengono firmati solo i file rimasti.

**Apri un ticket se:** la sessione scade sempre entro i primi file.

### Firma con Aruba: «Credenziali o OTP non validi» o «Dominio non abilitato»

**Causa:** utente, password o OTP errati (l'OTP scade in pochi secondi), oppure il dominio in Impostazioni non corrisponde alla tua firma.

**Soluzione:** genera l'OTP subito prima di premere **Firma**. Per il dominio chiedi all'amministratore di verificare **Impostazioni → Firma remota** con **Prova firma**.

**Apri un ticket se:** la **Prova firma** fallisce con credenziali corrette.
```

Run: tsc non serve; `node scripts/check-guida.mjs` nel container frontend (comando: `MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/apps/frontend-admin/public:/app/apps/frontend-admin/public" comunicapa/frontend-admin:dev -c 'node scripts/check-guida.mjs'`). Expected: `Check-guida: ok`.

- [ ] **Step 2: docs/claude/remote-sign.md + indice + nota merge**

```markdown
# Firma remota Aruba (ARSS) e ricarico allegati firmati

**ARSS verificato dal vivo (2026-10-13)** con firma remota OTP personale, senza contratto dedicato:
endpoint SOAP pubblico `https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl`
(schema inline; `ping` → `pong` senza auth). L'URL REST di ArubaSign
(`app1.firma-remota.it/ArubaSignerService/webresources/signerservice`) risponde
500 a tutto senza auth: non usato.

- `auth`: `user`, `userPWD`, `otpPwd`, `typeOtpAuth` (= dominio, `firma`), `typeHSM=COSIGN`.
- `opensession{Identity}` → `return` = sessionid (nessuno status/return_code nella risposta riuscita). L'OTP serve SOLO qui.
- `pdfsignatureV2{SignRequestV2{binaryinput, certID=AS0, identity (senza otpPwd, con userPWD), requiredmark=false, session_id, transport=BYNARYNET}, pdfprofile=PADESBES}` → `return.status=OK`, `return_code=0000`, `binaryoutput` base64. Non verificato se basti la sessione senza `userPWD`: per questo la password viaggia nel job cifrata `enc:v1:`.
- `closesession{Identity, sessionid}` → `OK`.
- Output `/SubFilter /ETSI.CAdES.detached`, valido per `SignatureVerificationService` (TSL AgID).
- Durata sessione NON nota: il job logga "Firma remota … N/M file in S s" e su scadenza scrive in `errorMessage` "Sessione scaduta dopo X file su N (S s)". Leggere i log prod per tararla; se troppo breve valutare `pdfsignatureV2_multiple`.
- Codici ARSS non documentati pubblicamente: `classifyArssError` usa `0030` = dominio e il testo della descrizione; i warning loggano codice+descrizione grezzi (senza segreti) per affinare.

**Backup originali fuori da uploads.** `replaceAttachment` copia l'originale in
`<attachmentsRoot>/unsigned-backup/<campaignId>/` alla prima sostituzione. Mai
dentro `getUploadsDir`: `finalizeAttachments` cancella ogni voce non
referenziata dal CSV (una sottocartella romperebbe `unlinkSync`) e in caso di
blocco svuota tutta la cartella. Pulizia insieme a uploads in `remove()`,
`retention-cleanup.service.ts`, `campaign-completion.service.ts`.

**Ordine a fine job:** `closeSession` → `startForCampaign` (nuova verifica) →
update stato `done`/`failed`. Invertendo, la UI legge per un istante la verifica
vecchia e riapre la modale "non firmati".

**Ricarico firmati** (`signed-attachments/upload/*`): mai `finalizeAttachments`,
estrazione in tmp, `matchSignedFiles` (nome identico o suffissi
`-signed`/`_signed`/`.signed`/`-firmato`/`_firmato`/` (firmato)`, ambigui e già
validi rifiutati), elenco entry da `adm-zip` perché `extractZipWithYauzl`
scarta in silenzio i non-PDF (`.p7m` compresi).

**Limite noto:** `extractPdfSignature` legge la PRIMA firma del PDF: un PDF con
una firma preesistente non valida resta invalido anche dopo la firma Aruba.
```

`CLAUDE.md`, nell'elenco "Documentazione dettagliata", dopo la riga `pades-signature.md`:

```markdown
- `docs/claude/remote-sign.md` — firma remota Aruba ARSS (campi SOAP verificati, sessione OTP), backup originali fuori da uploads, ricarico firmati
```

`docs/claude/ci-cd-deps.md:104`, sostituire la riga `**Merge**: …` con:

```markdown
**Merge**: `gh pr merge N --squash -R Comune-di-Montesilvano/ComunicaPA`, poi verificare `gh pr view N --json state` prima del tag. In auto mode il classificatore di Claude Code può negarlo (`[Merge Without Review]`, anche dopo `/permissions`; un comando composto con attesa CI + merge viene negato più spesso del comando da solo): in quel caso lo lancia l'utente con `! gh pr merge N --squash -R Comune-di-Montesilvano/ComunicaPA`.
```

- [ ] **Step 3: Versione**

Chiedere all'utente il numero (proposta v1.11.0). Poi in `publiccode.yml`: `softwareVersion: "vX.Y.Z"`, `releaseDate: "<data>"`.

- [ ] **Step 4: Verifica finale completa**

```bash
docker compose exec backend node_modules/.bin/vitest run
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: backend verde (baseline), tsc backend pulito, tsc frontend solo errore preesistente.

E2E manuale in dev (stack su, `docker compose restart backend` dopo le modifiche, verificare `dist/` più recente di `src/`):
1. Campagna SEND massiva di prova con 3 PDF non firmati → step 6: banner arancione con i 3 bottoni ("Firma con Aruba" solo se abilitata in Impostazioni).
2. **Scarica ZIP da firmare** → ZIP con i 3 PDF, nomi originali.
3. Rinominare un PDF in `-signed.pdf`, aggiungere un `.txt`, ricaricare lo ZIP → 1 sostituito… (con PDF non firmati realmente la nuova verifica resta invalida: verificare solo abbinamento, elenco scartati, backup in `unsigned-backup/`, nessuna voce extra in `uploads/`).
4. Lancio mentre una verifica è in corso → bottone disabilitato; lancio forzato v1.10.2 ancora funzionante.
5. Firma Aruba reale: in produzione (decisione utente), su massivo e Invio Manuale; leggere nei log la riga "Firma remota … in S s".

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/public/guida/guida.md docs/claude/remote-sign.md CLAUDE.md docs/claude/ci-cd-deps.md publiccode.yml
git commit -m "docs: firma allegati SEND (guida, note Aruba ARSS), vX.Y.Z"
```
