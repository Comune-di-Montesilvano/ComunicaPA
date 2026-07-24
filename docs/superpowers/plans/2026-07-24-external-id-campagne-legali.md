# External ID tracciati + campagne a valore legale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagare l'identificativo custom "OCR notifica" del tracciato Maggioli come campo `external_id` (mappabile a mano per CSV generici, automatico per i tracciati arricchiti), esporlo in tutti gli export per-destinatario, e introdurre un flag "campagna a valore legale" che impedisca la cancellazione/annullamento di campagne SEND e POSTAL Atto Giudiziario (Agol), oltre che di qualunque altra campagna marcata manualmente.

**Architecture:** Backend: nuovo campo su `MaggioliRecord`/CSV arricchito, un util di risoluzione `externalId` speculare a `resolveSubjectTemplate` (mappatura esplicita con fallback automatico su colonna convenzionale), propagazione nei 3 report per-destinatario esistenti (download/send/postal), nuova colonna persistita `Campaign.isLegalValue` + helper di enforcement runtime (auto-true per SEND/POSTAL-Agol, non richiede sync). Frontend: estensione dei pattern già esistenti nel wizard (`wizMapping`, checkbox stile `wizProtocolla`) — nessuna nuova architettura, solo nuovi campi sui meccanismi già in uso.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 (frontend-admin), Jest (test).

## Global Constraints

- Test backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza `--maxWorkers=2`).
- Type-check backend: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Type-check frontend-admin: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Baseline test nota: 1 fallimento pre-esistente (`app.controller.spec.ts`, `isLdapMock`) — non toccarlo, è artefatto noto di `LDAP_HOST=mock`. Ogni altro fallimento nuovo è una regressione.
- Migration Postgres: mai affidarsi a `typeorm migration:generate` per un `ADD COLUMN` semplice se si può scrivere a mano — qui comunque è un semplice `ADD COLUMN boolean`, si scrive a mano seguendo il pattern di `AddTestCampaignColumns1785000000000`.
- Nessun `<form>` annidata, nessuna nuova dependency di costruttore senza rilanciare la suite completa (non applicabile in questo piano — nessun costruttore tocco).

---

## File Structure

**Backend (nuovi file):**
- `apps/backend/src/channels/external-id-mapping.util.ts` — `resolveExternalId()`, speculare a `subject-mapping.util.ts`.
- `apps/backend/src/channels/external-id-mapping.util.spec.ts` — test.
- `apps/backend/src/database/migrations/1785500000000-AddCampaignIsLegalValueColumn.ts` — nuova colonna.

**Backend (modificati):**
- `apps/backend/src/enrichment/maggioli-parser.ts` — `MaggioliRecord.ocrNotifica`, letto in `parsePagIndice()`.
- `apps/backend/src/enrichment/maggioli-parser.spec.ts` — nuovo test riga con `'ocr notifica`.
- `apps/backend/src/enrichment/enriched-csv.util.ts` — `BASE_CSV_HEADERS` +`'external_id'`.
- `apps/backend/src/enrichment/enrichment.processor.ts` — `baseRow()` calcola `external_id`.
- `apps/backend/src/enrichment/enrichment.processor.spec.ts` — assert su `external_id`.
- `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` — `externalId` sui 3 row DTO, `DownloadReportDto` nuovo wrapper, `hasExternalId` su `SendReportDto`/`PostalReportDto`.
- `apps/backend/src/campaigns/campaigns.service.ts` — `getDownloadReportRows()`/`getSendReportRows()`/`getPostalReportRows()` calcolano `externalId`/`hasExternalId`; `cancel()`/`remove()` bloccano su valore legale; `create()`/`updateDraft()` scrivono `isLegalValue`.
- `apps/backend/src/campaigns/campaigns.service.spec.ts` — nuovi test.
- `apps/backend/src/campaigns/download-report-csv.util.ts` / `send-report-csv.util.ts` / `postal-report-csv.util.ts` — colonna `External ID` condizionale.
- `apps/backend/src/campaigns/download-report-csv.util.spec.ts` / `send-report-csv.util.spec.ts` / `postal-report-csv.util.spec.ts` — nuovi test.
- `apps/backend/src/campaigns/campaigns.controller.ts` — `exportDownloadReportCsv` usa il nuovo wrapper DTO.
- `apps/backend/src/campaigns/dto/create-campaign.dto.ts` / `update-campaign.dto.ts` — `isLegalValue?: boolean`.
- `apps/backend/src/entities/campaign.entity.ts` — colonna `isLegalValue`.
- `apps/backend/src/database/database.module.ts` — registra la nuova migration.

**Frontend-admin (modificato, un solo file):**
- `apps/frontend-admin/src/App.tsx` — `wizMapping.externalId` (stato + euristica + select Step3 + esclusione placeholder), `wizIsLegalValue` (stato + checkbox Step1 + persistenza bozza/lancio + reset/prefill), helper `isCampaignLegalValue()` lato client, disabilitazione bottoni Annulla/Elimina in dettaglio campagna, fix `handleDeleteCampaign` per mostrare il messaggio di errore del backend.

---

### Task 1: Parsing OCR nel tracciato Maggioli

**Files:**
- Modify: `apps/backend/src/enrichment/maggioli-parser.ts`
- Test: `apps/backend/src/enrichment/maggioli-parser.spec.ts`

**Interfaces:**
- Produces: `MaggioliRecord.ocrNotifica: string` (sempre presente sul tipo, stringa vuota se non risolvibile).

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi al file esistente `apps/backend/src/enrichment/maggioli-parser.spec.ts`, dentro `describe('parsePagIndice', ...)`, sostituisci la costante `PAG_INDICE` e il test esistente con:

```ts
const PAG_INDICE = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione;'ocr notifica",
  "'DOC_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000001;'RAV123;'99;'01/02/2026;'5890000000049995",
].join('\n');

const PAG_INDICE_SENZA_OCR = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Num. provv;'Data emissione",
  "'DOC_2.pdf;'BIANCHI ANNA;'BNCNNA80A01H501Y;'VIA ROMA 1;';'00100 ROMA RM;';';'42;'02/02/2026",
].join('\n');
```

Poi aggiungi due nuove `it()` dentro `describe('parsePagIndice', ...)`:

```ts
  it('legge la colonna "ocr notifica" quando presente', () => {
    const records = parsePagIndice(PAG_INDICE);
    expect(records[0].ocrNotifica).toBe('5890000000049995');
  });

  it('ocrNotifica vuota se la colonna non è presente nel tracciato', () => {
    const records = parsePagIndice(PAG_INDICE_SENZA_OCR);
    expect(records[0].ocrNotifica).toBe('');
    expect(records[0].numeroProvvedimento).toBe('42');
  });
```

Aggiungi anche, dentro `describe('parseRubricaPec', ...)`, in fondo:

```ts
  it('ocrNotifica sempre vuota (il formato rubrica PEC non la contiene mai)', () => {
    const records = parseRubricaPec(RUBRICA_ROW_PF);
    expect(records[0].ocrNotifica).toBe('');
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest maggioli-parser --maxWorkers=2
```
Expected: FAIL — `ocrNotifica` è `undefined`, non `''`/valore atteso (la proprietà non esiste ancora sul tipo/sull'oggetto).

- [ ] **Step 3: Implementa**

In `apps/backend/src/enrichment/maggioli-parser.ts`, aggiungi il campo all'interfaccia (dopo `csvNumeroAvvisoAlt`):

```ts
export interface MaggioliRecord {
  codiceFiscale: string;
  nominativo: string;
  tipo: 'PF' | 'PG';
  pec: string;
  numeroProvvedimento: string;
  dataEmissione: string;
  oggetto: string;
  pdfFilename: string;
  csvAddress: ParsedAddress | null;
  csvNumeroAvviso: string;
  csvNumeroAvvisoAlt: string;
  ocrNotifica: string;
}
```

In `parseRubricaPec()`, aggiungi `ocrNotifica: ''` all'oggetto pushato (questo formato non ha mai questa colonna):

```ts
    records.push({
      pec: fields[1].trim(),
      codiceFiscale: fields[5].trim(),
      tipo: tipoFromCf(fields[5]),
      nominativo: fields[7].trim(),
      numeroProvvedimento: fields[8].trim(),
      dataEmissione: fields[9].trim(),
      oggetto: fields[10].trim(),
      pdfFilename: fields[13].trim(),
      csvAddress: null,
      csvNumeroAvviso: '',
      csvNumeroAvvisoAlt: '',
      ocrNotifica: '',
    });
```

In `parsePagIndice()`, aggiungi la lettura della colonna (dopo `csvNumeroAvvisoAlt`):

```ts
      csvNumeroAvviso: (row['Ocr int'] ?? '').trim(),
      csvNumeroAvvisoAlt: (row['Ocr rid'] ?? '').trim(),
      ocrNotifica: (row['ocr notifica'] ?? '').trim(),
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest maggioli-parser --maxWorkers=2
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment/maggioli-parser.ts apps/backend/src/enrichment/maggioli-parser.spec.ts
git commit -m "feat(backend): parsa colonna 'ocr notifica' dal tracciato Maggioli pag_indice"
```

---

### Task 2: Colonna `external_id` nel CSV arricchito

**Files:**
- Modify: `apps/backend/src/enrichment/enriched-csv.util.ts`
- Modify: `apps/backend/src/enrichment/enrichment.processor.ts`
- Test: `apps/backend/src/enrichment/enrichment.processor.spec.ts`

**Interfaces:**
- Consumes: `MaggioliRecord.ocrNotifica`, `MaggioliRecord.numeroProvvedimento` (Task 1).
- Produces: colonna CSV `external_id` (ultima colonna fissa, prima delle `rataN_*` dinamiche).

- [ ] **Step 1: Scrivi il test che fallisce**

Apri `apps/backend/src/enrichment/enrichment.processor.spec.ts` e individua il fixture ZIP/mock usato per i test esistenti (cerca dove viene costruito il `pag_indice.csv` di test, stessa struttura di `PAG_INDICE` in Task 1). Aggiungi un test nel blocco `describe` principale:

```ts
  it('external_id: usa "ocr notifica" quando presente, altrimenti numero_provvedimento', async () => {
    // Riusa lo stesso zip/job setup degli altri test in questo file, con
    // una riga pag_indice.csv che include la colonna 'ocr notifica'.
    // Dopo l'esecuzione del job, leggi il CSV scritto da fs.writeFileSync
    // (stesso pattern già usato dagli altri test in questo file per
    // ispezionare il risultato) e verifica:
    // - la riga con 'ocr notifica' valorizzata ha external_id = quel valore
    // - una riga senza quella colonna ha external_id = numero_provvedimento
  });
```

Nota per chi implementa: questo file ha già un pattern consolidato per costruire lo ZIP di test e leggere l'output — riusa esattamente quel pattern (stesso mock di `PdfExtractorClient`, stesso modo di leggere `fs.writeFileSync` mockato o il path reale) invece di introdurne uno nuovo. Verifica il contenuto reale del file prima di scrivere l'assert esatto: leggi `apps/backend/src/enrichment/enrichment.processor.spec.ts` per intero prima di questo step per riprodurre fedelmente setup/mock esistenti.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2
```
Expected: FAIL — colonna `external_id` assente dall'header/riga prodotta.

- [ ] **Step 3: Implementa**

In `apps/backend/src/enrichment/enriched-csv.util.ts`, aggiungi `'external_id'` in fondo a `BASE_CSV_HEADERS`:

```ts
export const BASE_CSV_HEADERS = [
  'codice_fiscale',
  'nominativo',
  'tipo',
  'pec',
  'indirizzo',
  'cap',
  'comune',
  'provincia',
  'stato_estero',
  'allegato',
  'numero_avviso',
  'numero_avviso_alternativo',
  'importo',
  'scadenza',
  'numero_provvedimento',
  'data_emissione',
  'oggetto',
  'external_id',
] as const;
```

In `apps/backend/src/enrichment/enrichment.processor.ts`, nel metodo `baseRow()`, aggiungi il campo (dopo `oggetto`):

```ts
  private baseRow(rec: MaggioliRecord): EnrichedRow {
    return {
      codice_fiscale: rec.codiceFiscale,
      nominativo: rec.nominativo,
      tipo: rec.tipo,
      pec: rec.pec,
      indirizzo: rec.csvAddress?.indirizzo ?? '',
      cap: rec.csvAddress?.cap ?? '',
      comune: rec.csvAddress?.comune ?? '',
      provincia: rec.csvAddress?.provincia ?? '',
      stato_estero: rec.csvAddress?.statoEstero ?? '',
      allegato: rec.pdfFilename,
      numero_avviso: rec.csvNumeroAvviso,
      numero_avviso_alternativo: rec.csvNumeroAvvisoAlt,
      importo: '',
      scadenza: '',
      numero_provvedimento: rec.numeroProvvedimento,
      data_emissione: rec.dataEmissione,
      oggetto: rec.oggetto,
      external_id: rec.ocrNotifica || rec.numeroProvvedimento,
    };
  }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest enrichment --maxWorkers=2
```
Expected: PASS (include anche `enriched-csv.util` se ha test propri — verifica che non ci siano assert su un numero fisso di colonne in `enriched-csv.util.spec.ts`, se esiste, che vada aggiornato).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment/enriched-csv.util.ts apps/backend/src/enrichment/enrichment.processor.ts apps/backend/src/enrichment/enrichment.processor.spec.ts
git commit -m "feat(backend): propaga external_id (OCR notifica) nel CSV arricchito"
```

---

### Task 3: Util generico di risoluzione `externalId` per CSV non arricchiti

**Files:**
- Create: `apps/backend/src/channels/external-id-mapping.util.ts`
- Test: `apps/backend/src/channels/external-id-mapping.util.spec.ts`

**Interfaces:**
- Consumes: `campaign.channelConfig` (`Record<string, unknown>`), `recipient.extraData` (`Record<string, unknown>`) — stessa forma già usata da `resolveSubjectTemplate` in `subject-mapping.util.ts`.
- Produces: `resolveExternalId(campaign, recipient): string | null` — usato da Task 4.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `apps/backend/src/channels/external-id-mapping.util.spec.ts`:

```ts
import { resolveExternalId } from './external-id-mapping.util';

describe('resolveExternalId', () => {
  it('usa la colonna mappata esplicitamente in csvMapping.externalId', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: 'ABC-123' } };

    expect(resolveExternalId(campaign, recipient)).toBe('ABC-123');
  });

  it('fallback automatico sulla colonna "external_id" se non c\'è mappatura esplicita', () => {
    const campaign = { channelConfig: {} };
    const recipient = { extraData: { external_id: '5890000000049995' } };

    expect(resolveExternalId(campaign, recipient)).toBe('5890000000049995');
  });

  it('la mappatura esplicita ha precedenza sulla colonna convenzionale', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: 'ABC-123', external_id: 'IGNORATO' } };

    expect(resolveExternalId(campaign, recipient)).toBe('ABC-123');
  });

  it('ritorna null se non risolvibile (né mappatura né colonna convenzionale)', () => {
    const campaign = { channelConfig: {} };
    const recipient = { extraData: {} };

    expect(resolveExternalId(campaign, recipient)).toBeNull();
  });

  it('ritorna null se il valore risolto è una stringa vuota o solo spazi', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: '   ' } };

    expect(resolveExternalId(campaign, recipient)).toBeNull();
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest external-id-mapping --maxWorkers=2
```
Expected: FAIL — modulo `./external-id-mapping.util` non esiste.

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/channels/external-id-mapping.util.ts`:

```ts
/**
 * Identificativo esterno per-destinatario (es. "OCR notifica" del gestionale
 * PA), mostrato negli export tracciati. Precedenza: colonna mappata a mano
 * in channelConfig.csvMapping.externalId (wizard, CSV generici); altrimenti
 * fallback automatico sulla colonna letterale "external_id" — quella
 * prodotta dai tracciati arricchiti (vedi enrichment.processor.ts), che
 * quindi non richiede alcuna mappatura manuale.
 */
export function resolveExternalId(
  campaign: { channelConfig: Record<string, unknown> },
  recipient: { extraData: Record<string, unknown> },
): string | null {
  const csvMapping = campaign.channelConfig?.['csvMapping'] as Record<string, unknown> | undefined;
  const mappedColumn = csvMapping?.['externalId'] as string | undefined;
  const column = mappedColumn || 'external_id';
  const value = recipient.extraData?.[column] as string | undefined;
  return value && value.trim() ? value.trim() : null;
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest external-id-mapping --maxWorkers=2
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/external-id-mapping.util.ts apps/backend/src/channels/external-id-mapping.util.spec.ts
git commit -m "feat(backend): util resolveExternalId (mappatura esplicita + fallback automatico)"
```

---

### Task 4: Esposizione `externalId` nei 3 export per-destinatario

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/download-report-csv.util.ts`
- Modify: `apps/backend/src/campaigns/send-report-csv.util.ts`
- Modify: `apps/backend/src/campaigns/postal-report-csv.util.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/download-report-csv.util.spec.ts`
- Test: `apps/backend/src/campaigns/send-report-csv.util.spec.ts`
- Test: `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `resolveExternalId(campaign, recipient)` (Task 3).
- Produces: `DownloadReportDto { hasExternalId: boolean; rows: DownloadReportRowDto[] }` (nuovo — prima `getDownloadReportRows` ritornava `DownloadReportRowDto[]` nudo), `SendReportDto.hasExternalId: boolean`, `PostalReportDto.hasExternalId: boolean`, `externalId: string | null` su tutti e 3 i row DTO.

- [ ] **Step 1: Scrivi i test che falliscono (CSV builder)**

In `apps/backend/src/campaigns/download-report-csv.util.spec.ts`, aggiungi (adattando la firma da array nudo a `DownloadReportDto`):

```ts
  it('aggiunge la colonna External ID solo se almeno una riga la valorizza', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: true,
      rows: [
        { codiceFiscale: 'AAA1', fullName: 'Mario Rossi', email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null, externalId: '5890000000049995' },
      ],
    });
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"External ID"');
    expect(lines[1]).toContain('"5890000000049995"');
  });

  it('non aggiunge la colonna External ID se nessuna riga la valorizza', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: false,
      rows: [
        { codiceFiscale: 'AAA1', fullName: 'Mario Rossi', email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null, externalId: null },
      ],
    });
    expect(csv.split('\n')[0]).not.toContain('External ID');
  });
```

Aggiorna anche i 3 test esistenti in quel file: `buildDownloadReportCsv([...])` diventa `buildDownloadReportCsv({ hasExternalId: false, rows: [...] })`, e ogni riga inline guadagna `externalId: null`.

In `apps/backend/src/campaigns/send-report-csv.util.spec.ts` (leggi il file per il pattern esatto delle righe esistenti, poi) aggiungi un test analogo per `buildSendReportAttualeCsv`/`buildSendReportStoricoCsv`:

```ts
  it('aggiunge la colonna External ID in coda quando hasExternalId è true', () => {
    const report = {
      hasAppIoCoDelivery: false,
      hasExternalId: true,
      rows: [{
        codiceFiscale: 'AAA1', fullName: 'Mario Rossi', iun: null,
        digitalDomicileType: null, digitalDomicileAddress: null,
        sendStatus: null, sendStatusHistory: [], appIoOutcome: null,
        externalId: '5890000000049995',
      }],
    };
    const csv = buildSendReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"External ID"');
    expect(lines[1]).toContain('"5890000000049995"');
  });
```

In `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`, stesso test per `buildPostalReportAttualeCsv` con i campi propri di `PostalReportRowDto` (`postalTrackingId`, `postalStatus`, `postalStatusHistory`, `codiceErrore`, `descrizioneErrore`) + `externalId` + `hasExternalId: true` sul report.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest report-csv.util --maxWorkers=2
```
Expected: FAIL — tipi/campi non ancora definiti, firma `buildDownloadReportCsv` non ancora cambiata.

- [ ] **Step 3: Implementa i DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, sostituisci:

```ts
export interface DownloadReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
}
```
con:
```ts
export interface DownloadReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
  externalId: string | null;
}

export interface DownloadReportDto {
  /** Determina se i CSV builder devono includere la colonna "External ID". */
  hasExternalId: boolean;
  rows: DownloadReportRowDto[];
}
```

E aggiorna `SendReportRowDto`/`PostalReportRowDto` (+`externalId: string | null`) e `SendReportDto`/`PostalReportDto` (+`hasExternalId: boolean`):

```ts
export interface SendReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  iun: string | null;
  digitalDomicileType: string | null;
  digitalDomicileAddress: string | null;
  sendStatus: string | null;
  sendStatusHistory: Array<{ status: string; activeFrom: string }>;
  appIoOutcome: { success: boolean; error: string | null } | null;
  externalId: string | null;
}

export interface SendReportDto {
  hasAppIoCoDelivery: boolean;
  hasExternalId: boolean;
  rows: SendReportRowDto[];
}
```
```ts
export interface PostalReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  postalTrackingId: string | null;
  postalStatus: string | null;
  postalStatusHistory: Array<{ stato: string; rilevatoIl: string }>;
  codiceErrore: string | null;
  descrizioneErrore: string | null;
  appIoOutcome: { success: boolean; error: string | null } | null;
  externalId: string | null;
}

export interface PostalReportDto {
  hasAppIoCoDelivery: boolean;
  hasExternalId: boolean;
  rows: PostalReportRowDto[];
}
```

- [ ] **Step 4: Implementa i CSV builder**

In `apps/backend/src/campaigns/download-report-csv.util.ts`:

```ts
import type { DownloadReportDto } from './dto/campaign-stats.dto';
import { escapeCsvField } from './csv.util';

export function buildDownloadReportCsv(report: DownloadReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'Email', 'PEC', 'Stato Invio', 'Download Effettuati', 'Data Ultimo Download'];
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.email ?? '',
      r.pec ?? '',
      r.status,
      String(r.downloadCount),
      r.lastDownloadedAt ? new Date(r.lastDownloadedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '',
    ];
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
```

In `apps/backend/src/campaigns/send-report-csv.util.ts`, in entrambe le funzioni aggiungi, subito dopo la riga `if (report.hasAppIoCoDelivery) headers.push('Esito App IO');`:
```ts
  if (report.hasExternalId) headers.push('External ID');
```
e subito dopo ogni `if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));`:
```ts
    if (report.hasExternalId) fields.push(r.externalId ?? '');
```

Applica la stessa identica modifica (stesso ordine: header dopo App IO, field dopo App IO) in `apps/backend/src/campaigns/postal-report-csv.util.ts`, in entrambe le funzioni `buildPostalReportAttualeCsv`/`buildPostalReportStoricoCsv`.

- [ ] **Step 5: Esegui i test CSV e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest report-csv.util --maxWorkers=2
```
Expected: PASS

- [ ] **Step 6: Scrivi i test che falliscono (service)**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, trova i test esistenti di `getSendReportRows`/`getPostalReportRows`/`getDownloadReportRows` (cerca `describe('getSendReportRows'` ecc.) e aggiungi in ciascun blocco un test come:

```ts
  it('espone externalId risolto da resolveExternalId e imposta hasExternalId', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: { csvMapping: { externalId: 'id_pratica' } } });
    mockRecipientRepo.find.mockResolvedValueOnce([
      { id: 'r1', codiceFiscale: 'AAA1', fullName: 'Mario Rossi', extraData: { id_pratica: 'X-1' } },
    ]);
    mockAttemptRepo.find.mockResolvedValueOnce([]);

    const report = await service.getSendReportRows('c1');

    expect(report.hasExternalId).toBe(true);
    expect(report.rows[0].externalId).toBe('X-1');
  });
```

Adatta i nomi dei mock (`mockAttemptRepo.find` per SEND filtra `channelType: 'SEND'`, per POSTAL `channelType: 'POSTAL'` — segui il pattern già presente nei test esistenti dello stesso blocco `describe`) e per `getDownloadReportRows` adatta il mock a `mockRecipientRepo.find` senza `attemptRepo` (quel metodo non usa gli attempt).

- [ ] **Step 7: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Expected: FAIL — `externalId`/`hasExternalId` non ancora calcolati dal service.

- [ ] **Step 8: Implementa nel service**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi l'import:

```ts
import { resolveExternalId } from '../channels/external-id-mapping.util';
```

Sostituisci `getDownloadReportRows()`:

```ts
  async getDownloadReportRows(campaignId: string): Promise<DownloadReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const rows = await this.recipientRepo.find({
      where: { campaignId },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt', 'extraData'],
      order: { createdAt: 'ASC' },
    });

    const mapped = rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      email: r.email,
      pec: r.pec,
      status: r.status,
      downloadCount: r.downloadCount,
      lastDownloadedAt: r.lastDownloadedAt ? r.lastDownloadedAt.toISOString() : null,
      externalId: resolveExternalId(campaign, r),
    }));

    return { hasExternalId: mapped.some((r) => r.externalId !== null), rows: mapped };
  }
```

Aggiungi `'extraData'` al `select` in `getSendReportRows()` (riga con `select: ['id', 'codiceFiscale', 'fullName']`) e nel `map` finale aggiungi `externalId: resolveExternalId(campaign, r)`, poi cambia il `return` finale:

```ts
    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName', 'extraData'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, hasExternalId: false, rows: [] };
```
```ts
    const rows: SendReportRowDto[] = recipients.map((r) => {
      const latest = latestByRecipient.get(r.id);
      const first = firstByRecipient.get(r.id);
      const appIo = hasAppIoCoDelivery
        ? ((first?.responsePayload as Record<string, unknown> | undefined)?.['appIo'] as { success?: boolean; error?: string } | undefined)
        : undefined;

      return {
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        iun: latest?.iun ?? null,
        digitalDomicileType: latest?.sendDigitalDomicile?.type ?? null,
        digitalDomicileAddress: latest?.sendDigitalDomicile?.address ?? null,
        sendStatus: latest?.status === AttemptStatus.FAILED ? 'FAILED' : (latest?.sendStatus ?? null),
        sendStatusHistory: latest?.sendStatusHistory ?? [],
        appIoOutcome: appIo ? { success: !!appIo.success, error: appIo.error ?? null } : null,
        externalId: resolveExternalId(campaign, r),
      };
    });

    return { hasAppIoCoDelivery, hasExternalId: rows.some((r) => r.externalId !== null), rows };
```

Applica la stessa modifica (select +`'extraData'`, riga `return` con `hasAppIoCoDelivery: false` → +`hasExternalId: false`, `map` finale +`externalId: resolveExternalId(campaign, r)`, `return` finale +`hasExternalId: rows.some(...)`) in `getPostalReportRows()`.

Aggiorna gli import in testa al file: `DownloadReportRowDto` nell'elenco di tipi importati da `./dto/campaign-stats.dto'` diventa `DownloadReportDto` (rimuovi `DownloadReportRowDto` se non più usato altrove nel file, altrimenti tienilo).

- [ ] **Step 9: Aggiorna il controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, il metodo `exportDownloadReportCsv` non richiede modifiche di firma (il service ora ritorna il tipo giusto e `buildDownloadReportCsv` lo accetta direttamente) — verifica solo che l'import del tipo `DownloadReportRowDto`, se presente nel controller, non causi errori di compilazione (probabilmente il controller non importa quel tipo direttamente, essendo solo un pass-through `res.send(buildDownloadReportCsv(rows))` dove `rows` diventa ora l'intero oggetto `DownloadReportDto` — rinomina la variabile locale da `rows` a `report` per chiarezza, non obbligatorio ma consigliato).

- [ ] **Step 10: Esegui tutta la suite e verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: PASS, nessun fallimento oltre alla baseline nota (`app.controller.spec.ts`/`isLdapMock`).

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```
Expected: nessun errore.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/download-report-csv.util.ts apps/backend/src/campaigns/download-report-csv.util.spec.ts apps/backend/src/campaigns/send-report-csv.util.ts apps/backend/src/campaigns/send-report-csv.util.spec.ts apps/backend/src/campaigns/postal-report-csv.util.ts apps/backend/src/campaigns/postal-report-csv.util.spec.ts apps/backend/src/campaigns/campaigns.controller.ts
git commit -m "feat(backend): esponi External ID negli export download/send/postal report"
```

---

### Task 5: Mappatura `externalId` nel wizard (frontend)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna dipendenza da task backend (il wizard scrive semplicemente `channelConfig.csvMapping`, già consumato da Task 3/4).
- Produces: `wizMapping.externalId: string` — chiave aggiuntiva nello stesso oggetto già scritto in `cfg.csvMapping`/`channelConfig.csvMapping` (righe 5075 e 5491, nessuna modifica necessaria lì: è già `cfg.csvMapping = wizMapping` sull'intero oggetto).

- [ ] **Step 1: Aggiungi la chiave allo stato iniziale**

In `apps/frontend-admin/src/App.tsx` riga ~1244:

```tsx
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
    subject: '',
    externalId: '',
  });
```

- [ ] **Step 2: Aggiungi l'euristica di auto-detect in `parseCsvFile`**

Riga ~4312, nell'oggetto `newMapping`:

```tsx
      const newMapping = {
        codice_fiscale: '',
        full_name: '',
        full_name_2: '',
        email: '',
        pec: '',
        subject: '',
        externalId: '',
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
        else if (hLower === 'externalid') newMapping.externalId = h;
      });
```

(la colonna prodotta dal tracciato arricchito si chiama letteralmente `external_id`, che dopo `.replace(/[\s_-]/g, '')` diventa `externalid` — combacia con l'euristica sopra senza bisogno di un caso speciale.)

- [ ] **Step 3: Aggiungi il reset (riga ~4737) e il reset da "duplica template" (riga ~8044)**

Riga ~4737:
```tsx
    setWizMapping({
      codice_fiscale: '',
      full_name: '',
      full_name_2: '',
      email: '',
      pec: '',
      subject: '',
      externalId: '',
    });
```

Riga ~8044, stessa modifica sull'oggetto inline:
```tsx
setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', subject: '', externalId: '' });
```

- [ ] **Step 4: Aggiungi la select nello Step 3**

Riga ~8199-8212, subito dopo il blocco `{wizChannel === 'SEND' && (...)}` della select "Oggetto", aggiungi un nuovo blocco **non condizionato dal canale** (l'external ID è utile per qualunque canale, non solo SEND):

```tsx
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted">External ID (Opzionale)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.externalId}
                        onChange={e => handleWizMappingChange('externalId', e.target.value)}
                      >
                        <option value="">-- Nessuna colonna (o auto-rilevata da tracciato arricchito) --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                      <div className="form-text small text-muted">Identificativo custom mostrato negli export (es. OCR notifica). Se il CSV ha una colonna "external_id" viene rilevata automaticamente.</div>
                    </div>
```

- [ ] **Step 5: Escludi la colonna dai "placeholder extra" del body editor**

Riga ~8698-8713, nel filtro `isMappedToSystem`, aggiungi `h === wizMapping.externalId ||` accanto alle altre chiavi di `wizMapping`:

```tsx
                                const isMappedToSystem =
                                  h === wizMapping.codice_fiscale ||
                                  h === wizMapping.full_name ||
                                  h === wizMapping.full_name_2 ||
                                  h === wizMapping.email ||
                                  h === wizMapping.pec ||
                                  h === wizMapping.subject ||
                                  h === wizMapping.externalId ||
```

- [ ] **Step 6: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore.

- [ ] **Step 7: Verifica manuale nel browser**

Avvia (se non già in esecuzione) `docker compose up -d frontend-admin backend`, apri il wizard "Invio Massivo" → carica un CSV con colonna `external_id` (o `id_pratica`) → verifica allo Step 3 che compaia la select "External ID" e che, se la colonna si chiama `external_id`, venga pre-selezionata automaticamente.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): mappatura External ID nel wizard (manuale + auto-detect)"
```

---

### Task 6: Colonna `Campaign.isLegalValue`

**Files:**
- Modify: `apps/backend/src/entities/campaign.entity.ts`
- Create: `apps/backend/src/database/migrations/1785500000000-AddCampaignIsLegalValueColumn.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `Campaign.isLegalValue: boolean` (default `false`), usato da Task 7.

- [ ] **Step 1: Aggiungi la colonna all'entity**

In `apps/backend/src/entities/campaign.entity.ts`, dopo il campo `isTest`:

```ts
  @Column({ type: 'boolean', name: 'is_test', default: false })
  isTest!: boolean;

  @Column({ type: 'boolean', name: 'is_legal_value', default: false })
  isLegalValue!: boolean;
```

- [ ] **Step 2: Crea la migration**

Crea `apps/backend/src/database/migrations/1785500000000-AddCampaignIsLegalValueColumn.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignIsLegalValueColumn1785500000000 implements MigrationInterface {
    name = 'AddCampaignIsLegalValueColumn1785500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "is_legal_value" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "is_legal_value"`);
    }
}
```

- [ ] **Step 3: Registra la migration**

In `apps/backend/src/database/database.module.ts`, aggiungi l'import (dopo `CreateOperatorDirectory1785400000000`):

```ts
import { AddCampaignIsLegalValueColumn1785500000000 } from './migrations/1785500000000-AddCampaignIsLegalValueColumn';
```

E aggiungi `AddCampaignIsLegalValueColumn1785500000000` in fondo all'array `migrations: [...]` (stessa riga lunga, in coda dopo `CreateOperatorDirectory1785400000000`).

- [ ] **Step 4: Verifica la migration su un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_legalvalue;"
```
Prendi la password:
```bash
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
```
Esegui tutte le migration (compresa la nuova) sul DB temporaneo:
```bash
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_legalvalue" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```
Expected: tutte le migration, inclusa `AddCampaignIsLegalValueColumn1785500000000`, vanno a buon fine senza errori.

Pulisci:
```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_legalvalue;"
```

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/campaign.entity.ts apps/backend/src/database/migrations/1785500000000-AddCampaignIsLegalValueColumn.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiunge colonna campaigns.is_legal_value"
```

---

### Task 7: Enforcement valore legale su `cancel()`/`remove()` + DTO

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/dto/create-campaign.dto.ts`
- Modify: `apps/backend/src/campaigns/dto/update-campaign.dto.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `Campaign.isLegalValue`, `Campaign.channelType`, `Campaign.channelConfig['postalServiceType']` (Task 6, entity già esistente).
- Produces: `isCampaignLegalValue(campaign: Campaign): boolean` (funzione esportata, usata anche dal frontend come riferimento di logica — non importabile da lì, va replicata in JS in Task 8, ma la firma/logica deve restare identica).

- [ ] **Step 1: Scrivi i test che falliscono**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, dentro `describe('cancel', ...)`, aggiungi:

```ts
    it('blocca l\'annullamento se la campagna è a valore legale (flag esplicito)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, isLegalValue: true });
      await expect(service.cancel('c1', ADMIN_REQUESTER)).rejects.toThrow('Campagna a valore legale');
    });

    it('blocca l\'annullamento per canale SEND anche senza flag esplicito', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'SEND' });
      await expect(service.cancel('c1', ADMIN_REQUESTER)).rejects.toThrow('Campagna a valore legale');
    });

    it('blocca l\'annullamento per POSTAL con Servizio Agol', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'POSTAL', channelConfig: { postalServiceType: 'AgolMarket' } });
      await expect(service.cancel('c1', ADMIN_REQUESTER)).rejects.toThrow('Campagna a valore legale');
    });

    it('non blocca POSTAL con Servizio non-Agol', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata1000' } });
      mockRecipientRepo.find.mockResolvedValueOnce([]);
      await expect(service.cancel('c1', ADMIN_REQUESTER)).resolves.toEqual({ cancelled: 0, campaignId: 'c1' });
    });
```

Dentro `describe('remove', ...)`, aggiungi:

```ts
    it('blocca l\'eliminazione se la campagna è a valore legale', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c-legal', createdBy: 'op1', isLegalValue: true });
      await expect(service.remove('c-legal', ADMIN_REQUESTER)).rejects.toThrow('Campagna a valore legale');
      expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
    });

    it('blocca l\'eliminazione per canale SEND anche senza flag esplicito', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c-send', createdBy: 'op1', channelType: 'SEND' });
      await expect(service.remove('c-send', ADMIN_REQUESTER)).rejects.toThrow('Campagna a valore legale');
    });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Expected: FAIL — nessun blocco implementato, i test su SEND/Agol/flag esplicito passano a vuoto (l'operazione va a buon fine invece di lanciare).

- [ ] **Step 3: Implementa l'helper e l'enforcement**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi la funzione esportata (fuori dalla classe, vicino alle costanti in testa al file, dopo `const INAD_BULK_THRESHOLD = 100;`):

```ts
/**
 * SEND e POSTAL Servizio Agol (Atto Giudiziario) sono invii a valore legale:
 * calcolato a runtime da channelType/channelConfig, non richiede di tenere
 * isLegalValue sincronizzato ogni volta che channelConfig.postalServiceType
 * cambia durante il wizard.
 */
export function isCampaignLegalValue(campaign: Pick<Campaign, 'isLegalValue' | 'channelType' | 'channelConfig'>): boolean {
  if (campaign.isLegalValue) return true;
  if (campaign.channelType === 'SEND') return true;
  if (campaign.channelType === 'POSTAL') {
    const servizio = String(campaign.channelConfig?.['postalServiceType'] ?? '');
    if (servizio.startsWith('Agol')) return true;
  }
  return false;
}
```

In `cancel()`, subito dopo `this.assertOwnership(campaign, requester);` (riga ~812):

```ts
    this.assertOwnership(campaign, requester);
    if (isCampaignLegalValue(campaign)) {
      throw new BadRequestException('Campagna a valore legale: annullamento non consentito');
    }
```

In `remove()`, subito dopo `this.assertOwnership(campaign, requester);` (riga ~2040):

```ts
    this.assertOwnership(campaign, requester);
    if (isCampaignLegalValue(campaign)) {
      throw new BadRequestException('Campagna a valore legale: eliminazione non consentita');
    }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Expected: PASS

- [ ] **Step 5: Aggiungi il campo ai DTO**

In `apps/backend/src/campaigns/dto/create-campaign.dto.ts`:

```ts
import { IsBoolean, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { NotificationChannel } from '@comunicapa/shared-types';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsEnum(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  @IsObject()
  @IsOptional()
  channelConfig?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  isLegalValue?: boolean;
}
```

In `apps/backend/src/campaigns/dto/update-campaign.dto.ts`:

```ts
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(255)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsObject()
  channelConfig?: Record<string, unknown>;

  @IsOptional() @IsBoolean()
  isLegalValue?: boolean;
}
```

- [ ] **Step 6: Scrivi il test che il valore venga persistito da create/updateDraft**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, cerca il `describe` di `create`/`updateDraft` esistente e aggiungi:

```ts
  it('create(): persiste isLegalValue quando passato nel dto', async () => {
    await service.create({ name: 'X', channelType: 'EMAIL', isLegalValue: true } as any, 'op1');
    expect(mockCampaignRepo.create).toHaveBeenCalledWith(expect.objectContaining({ isLegalValue: true }));
  });

  it('updateDraft(): aggiorna isLegalValue quando passato nel dto', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
    await service.updateDraft('c1', { isLegalValue: true } as any);
    expect(mockCampaignRepo.save).toHaveBeenCalledWith(expect.objectContaining({ isLegalValue: true }));
  });
```

- [ ] **Step 7: Esegui i test e verifica che falliscano, poi implementa**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2
```
Expected: FAIL

In `create()` (riga ~235):

```ts
  create(dto: CreateCampaignDto, createdBy: string): Promise<Campaign> {
    const campaign = this.campaignRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      channelType: dto.channelType,
      channelConfig: dto.channelConfig ?? {},
      status: CampaignStatus.DRAFT,
      createdBy,
      isLegalValue: dto.isLegalValue ?? false,
    });
    return this.campaignRepo.save(campaign);
  }
```

In `updateDraft()` (riga ~81):

```ts
  async updateDraft(id: string, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Solo le campagne in bozza possono essere modificate');
    }
    if (dto.name !== undefined) campaign.name = dto.name;
    if (dto.description !== undefined) campaign.description = dto.description;
    if (dto.channelConfig !== undefined) campaign.channelConfig = dto.channelConfig;
    if (dto.isLegalValue !== undefined) campaign.isLegalValue = dto.isLegalValue;
    return this.campaignRepo.save(campaign);
  }
```

- [ ] **Step 8: Esegui tutta la suite e type-check**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
```
Expected: PASS / nessun errore (baseline nota invariata).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/dto/create-campaign.dto.ts apps/backend/src/campaigns/dto/update-campaign.dto.ts
git commit -m "feat(backend): blocca cancel/remove per campagne a valore legale (SEND, POSTAL Agol, flag manuale)"
```

---

### Task 8: Checkbox "Campagna a valore legale" nel wizard + disabilitazione bottoni (frontend)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: stessa logica di `isCampaignLegalValue()` (Task 7), replicata lato client in JS (channelType/channelConfig non sono raggiungibili dal backend in tempo reale nel form, serve calcolo locale identico).
- Produces: `wizIsLegalValue: boolean` (stato), incluso nel body POST/PATCH di creazione/salvataggio bozza e nel lancio campagna.

- [ ] **Step 1: Aggiungi lo stato**

Vicino a `const [wizProtocolla, setWizProtocolla] = useState(false);` (riga ~1263):

```tsx
  const [wizIsLegalValue, setWizIsLegalValue] = useState(false);
```

- [ ] **Step 2: Aggiungi l'helper client-side**

Vicino alla funzione `postalServiceTypeLabel` (riga ~533) o in un punto di utility condiviso del file, aggiungi:

```tsx
// Stessa logica di isCampaignLegalValue() in campaigns.service.ts — SEND e
// POSTAL Servizio Agol (Atto Giudiziario) sono sempre a valore legale, non
// disattivabile dall'operatore.
function isChannelAlwaysLegalValue(channelType: string, postalServiceType?: string): boolean {
  if (channelType === 'SEND') return true;
  if (channelType === 'POSTAL' && (postalServiceType || '').startsWith('Agol')) return true;
  return false;
}
```

- [ ] **Step 3: Aggiungi la checkbox nello Step 1**

Dopo il blocco `wiz_protocolla` (riga ~7721-7736), aggiungi:

```tsx
                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz-legal-value"
                      checked={isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue}
                      disabled={isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType)}
                      onChange={(e) => setWizIsLegalValue(e.target.checked)}
                    />
                    <label className="form-check-label small fw-bold" htmlFor="wiz-legal-value">
                      Campagna a valore legale
                      {isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) && (
                        <span className="text-muted"> (sempre attivo per {wizChannel === 'SEND' ? 'SEND' : 'Atto Giudiziario'}: non può essere annullata o eliminata)</span>
                      )}
                    </label>
                    <div className="form-text small text-muted">Se attiva, la campagna non potrà mai essere annullata o eliminata (anche a invio completato).</div>
                  </div>
```

- [ ] **Step 4: Includi il campo nelle chiamate di salvataggio bozza**

In `syncWizDraftAndRecipients` (corpo già letto, righe ~5155-5178), aggiungi `isLegalValue` a entrambi i body:

```tsx
      if (!wizCampaignId) {
        const res = await apiFetch('/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelType: wizChannel,
            channelConfig,
            isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue,
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
        const created = await res.json();
        activeCampaignId = created.id;
        setWizCampaignId(created.id);
      } else {
        const res = await apiFetch(`/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelConfig,
            isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue,
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
      }
```

- [ ] **Step 5: Includi il campo nel lancio campagna (`handleWizLaunch`)**

Righe ~5494-5519, aggiungi `isLegalValue` a entrambi i body:

```tsx
      let campaignObj: { id: string };
      if (wizCampaignId) {
        const patchRes = await fetch(`${ADMIN_API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc || wizSubject || wizName,
            channelConfig,
            isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue,
          }),
        });
        if (!patchRes.ok) throw new Error('Errore durante l\'aggiornamento della bozza');
        campaignObj = { id: wizCampaignId };
      } else {
        const res = await fetch(`${ADMIN_API_BASE}/campaigns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc || wizSubject || wizName,
            channelType: wizChannel,
            channelConfig,
            isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue,
          }),
        });
        if (!res.ok) throw new Error('Errore durante la creazione della campagna');
        campaignObj = await res.json();
      }
```

- [ ] **Step 6: Reset e prefill**

Nel reset del wizard (vicino a riga ~4725-4744, stessa funzione che azzera `wizPostalAgolTipoNotificante` ecc.), aggiungi:

```tsx
    setWizIsLegalValue(false);
```

Nel prefill da campagna sorgente (funzione che legge `source.channelConfig?.postalAgolTipoNotificante` ecc., riga ~4821), aggiungi la lettura dal campo diretto della campagna (non da `channelConfig`, è colonna separata — verifica la firma del parametro `source` di questa funzione: se è tipizzato con solo `channelConfig` andrà esteso per includere anche `isLegalValue` dalla risposta dell'API campagna):

```tsx
    setWizIsLegalValue(Boolean((source as any).isLegalValue));
```

- [ ] **Step 7: Disabilita i bottoni Annulla/Elimina in dettaglio campagna**

Vicino a `handleDeleteCampaign` (riga ~4995), aggiungi l'helper (o riusa `isChannelAlwaysLegalValue` + leggi `campaign.isLegalValue` direttamente, dato che qui è disponibile l'oggetto `campaign` completo dall'API):

```tsx
  const campaignIsLegalValue = (c: { channelType: string; channelConfig?: any; isLegalValue?: boolean }): boolean => {
    if (c.isLegalValue) return true;
    return isChannelAlwaysLegalValue(c.channelType, c.channelConfig?.postalServiceType);
  };
```

Modifica `handleDeleteCampaign` per mostrare il messaggio reale del backend invece del generico fisso (bug esistente, non solo per questa feature — il backend già risponde con un `message` nel body su 400):

```tsx
  const handleDeleteCampaign = async (id: string, name: string) => {
    if (!confirm(`Eliminare definitivamente la campagna "${name}"? Verranno cancellati destinatari, tentativi di invio e allegati. Azione irreversibile.`)) {
      return;
    }
    const res = await apiFetch(`/campaigns/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      alert(errData.message || 'Impossibile eliminare la campagna.');
      return;
    }
    fetchCampaigns();
    if (selectedCampaignId === id) {
      setView('invio-massivo');
    }
  };
```

Nel blocco di dettaglio campagna (righe ~12970-13013), aggiungi `disabled` e un `title` esplicativo su entrambi i bottoni quando `campaignIsLegalValue(campaign)` è vero:

```tsx
                          {campaign.status === 'queued' && (role === 'admin' || campaign.createdBy === username) && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold"
                              disabled={cancelling || campaignIsLegalValue(campaign)}
                              title={campaignIsLegalValue(campaign) ? 'Campagna a valore legale: non annullabile' : undefined}
                              onClick={handleCancelCampaign}
                            >
```

```tsx
                          {(role === 'admin' || campaign.createdBy === username) && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold mt-2"
                              disabled={campaignIsLegalValue(campaign)}
                              title={campaignIsLegalValue(campaign) ? 'Campagna a valore legale: non eliminabile' : undefined}
                              onClick={() => handleDeleteCampaign(campaign.id, campaign.name)}
                            >
```

- [ ] **Step 8: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore.

- [ ] **Step 9: Verifica manuale nel browser**

Crea una campagna SEND (o POSTAL con Servizio Atto Giudiziario) nel wizard → verifica che la checkbox "Campagna a valore legale" sia spuntata e disabilitata allo Step 1 → completa il lancio → apri il dettaglio campagna e verifica che i bottoni "Annulla Campagna"/"Elimina Campagna" siano disabilitati col tooltip corretto. Ripeti con una campagna EMAIL con la checkbox lasciata deselezionata: i bottoni devono restare cliccabili.

- [ ] **Step 10: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): checkbox campagna a valore legale, blocco annulla/elimina in UI"
```

---

## Self-Review (svolto durante la stesura del piano)

**Copertura spec:**
- Sezione A (parsing OCR) → Task 1.
- Sezione B (mapping generico + auto-detect) → Task 3, Task 5.
- Sezione C (export) → Task 2 (arricchito), Task 4 (report).
- Sezione D (valore legale) → Task 6, Task 7, Task 8.
- Nota: lo spec cita `channelConfig.servizio` come chiave POSTAL — verificato nel codice reale (`postal.strategy.ts:74`, `App.tsx:546`) che la chiave corretta è `channelConfig.postalServiceType`; il piano usa il nome corretto ovunque (lo spec ha un refuso minore su questo punto, non bloccante).

**Placeholder:** nessuno — ogni step ha codice completo o istruzioni concrete (Task 2 Step 1 lascia esplicitamente il compito di riprodurre il pattern di mock esistente perché il file va letto per intero prima di scrivere l'assert esatto, non è un placeholder ma un'istruzione di ricerca guidata).

**Coerenza tipi:** `resolveExternalId(campaign, recipient)` (Task 3) usato identico in Task 4; `DownloadReportDto`/`SendReportDto.hasExternalId`/`PostalReportDto.hasExternalId` (Task 4) coerenti con i builder CSV; `isCampaignLegalValue()` (Task 7) e `isChannelAlwaysLegalValue()`/`campaignIsLegalValue()` lato client (Task 8) implementano la stessa logica con nomi distinti (backend vs frontend, linguaggi diversi, nessun import condiviso possibile) — comportamento verificato identico riga per riga.
