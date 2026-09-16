# Validazione + correzione CF/Partita IVA in Arricchimento Tracciati — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validare/correggere il Codice Fiscale/Partita IVA durante "Arricchimento Tracciati" invece di scoprirlo solo al lancio campagna, correggendo di massa il caso più comune (PIVA con zero iniziale perso nel CSV) senza intervento operatore, e rendere il campo modificabile ed effettivamente verificabile su Registro Imprese nel form di correzione.

**Architecture:** Tre livelli indipendenti, ciascuno testabile a sé: (1) zero-pad silenzioso lato parsing CSV Maggioli per il caso deterministico PIVA-10-cifre; (2) validazione formato + fallback automatico da estrazione PDF per i casi rimasti, stesso meccanismo warning già esistente in `EnrichmentProcessor`; (3) form di correzione frontend con campo CF editabile e fix di un bug di stato stantio che oggi impedisce "Verifica ANPR"/Registro Imprese di funzionare su un CF appena corretto.

**Tech Stack:** NestJS/TypeScript (backend), FastAPI/Python (pdf-extractor), React (frontend-admin), Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-09-16-cf-piva-arricchimento-design.md`

## Global Constraints

- Nessuna modifica a schema DB/entity — CF/PIVA passa già per `extraFields` generico dell'override esistente.
- Nessun nuovo stato bloccante sul job di arricchimento — solo warning informativi, stessa severità di quelli esistenti (Paese/Città/CAP).
- Zero-pad PIVA 10→11 cifre è **silenzioso** (nessun warning) — stesso trattamento già in uso per il CAP (`_pad_cap`).
- Fallback PDF→CSV per CF/PIVA è **auto-applicato** (scrive la riga), non solo proposto — ma resta sempre accompagnato da un warning in lista.
- Tutti i comandi di test/tsc vanno eseguiti in Docker (`docker compose exec backend ...` / `docker compose exec pdf-extractor ...`), mai su un runtime locale — vedi CLAUDE.md.

---

## Task 1: `isValidCfOrPiva` in `tax-id.util.ts`

**Files:**
- Modify: `apps/backend/src/channels/tax-id.util.ts`
- Test: `apps/backend/src/channels/tax-id.util.spec.ts`

**Interfaces:**
- Produces: `isValidCfOrPiva(value: string): boolean` — `true` se `value.trim()` è 16 alfanumerici (CF persona fisica, case-insensitive) OPPURE 11 cifre numeriche (PIVA/CF persona giuridica). Usata da Task 4 (backend) e riportata (non importata — file separato) in `App.tsx` per il gate frontend in Task 5.

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi in fondo a `apps/backend/src/channels/tax-id.util.spec.ts` (nuovo `describe`, stesso file dei test di `isPartitaIva` già presenti):

```ts
import { isPartitaIva, isValidCfOrPiva } from './tax-id.util.js';

// ... describe('isPartitaIva', ...) esistente resta invariato ...

describe('isValidCfOrPiva', () => {
  it('accetta un CF persona fisica valido (16 alfanumerici)', () => {
    expect(isValidCfOrPiva('RSSMRA80A01H501U')).toBe(true);
  });

  it('accetta CF minuscolo (case-insensitive)', () => {
    expect(isValidCfOrPiva('rssmra80a01h501u')).toBe(true);
  });

  it('accetta una Partita IVA valida (11 cifre)', () => {
    expect(isValidCfOrPiva('12345678901')).toBe(true);
  });

  it('accetta spazi ai bordi', () => {
    expect(isValidCfOrPiva('  12345678901  ')).toBe(true);
  });

  it('rifiuta una PIVA a 10 cifre (zero iniziale perso, non ancora normalizzata)', () => {
    expect(isValidCfOrPiva('2333900682')).toBe(false);
  });

  it('rifiuta un CF a 15 caratteri', () => {
    expect(isValidCfOrPiva('RSSMRA80A01H50')).toBe(false);
  });

  it('rifiuta stringa vuota', () => {
    expect(isValidCfOrPiva('')).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui i test, verifica il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run tax-id.util`
Expected: FAIL — `isValidCfOrPiva is not a function` (o errore di import).

- [ ] **Step 3: Implementa**

In `apps/backend/src/channels/tax-id.util.ts`, aggiungi in fondo al file (dopo `isPartitaIva`, che resta invariata):

```ts
/**
 * Formato valido per CF persona fisica (16 alfanumerici) o PIVA/CF persona
 * giuridica (11 cifre) — stesso regex già in uso lato frontend (App.tsx,
 * isValidCfOrPiva locale, mai condivisa fino ad ora). Solo controllo di
 * FORMATO, nessun checksum — stesso principio di isPartitaIva sopra.
 */
export function isValidCfOrPiva(value: string): boolean {
  const v = value.trim();
  return /^[A-Z0-9]{16}$/i.test(v) || /^\d{11}$/.test(v);
}
```

- [ ] **Step 4: Esegui i test, verifica il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run tax-id.util`
Expected: PASS, tutti i test (esistenti + nuovi).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/tax-id.util.ts apps/backend/src/channels/tax-id.util.spec.ts
git commit -m "$(cat <<'EOF'
feat(channels): aggiungi isValidCfOrPiva a tax-id.util

Stesso regex già in uso lato frontend (App.tsx), ora disponibile
anche al backend per la validazione CF/PIVA in arricchimento
tracciati (Task 4).
EOF
)"
```

---

## Task 2: Zero-pad automatico PIVA 10→11 cifre in `maggioli-parser.ts`

**Files:**
- Modify: `apps/backend/src/enrichment/maggioli-parser.ts`
- Test: `apps/backend/src/enrichment/maggioli-parser.spec.ts`

**Interfaces:**
- Consumes: nessuna dipendenza da Task 1.
- Produces: `normalizeCodiceFiscale(value: string): string` (funzione interna, non esportata — usata solo dentro `maggioli-parser.ts`). Il comportamento osservabile da fuori è che `MaggioliRecord.codiceFiscale` per un CSV con PIVA a 10 cifre numeriche torna già zero-paddato a 11.

- [ ] **Step 1: Scrivi i test falliti**

Aggiungi in `apps/backend/src/enrichment/maggioli-parser.spec.ts`, dentro `describe('parseRubricaPec', ...)` esistente (nuovi `it`, usa le costanti `RUBRICA_ROW_PG`/`RUBRICA_ROW_TARI_SALDO` già presenti in cima al file):

```ts
  it('PIVA a 10 cifre nel formato PG (14 campi) viene zero-paddata a 11', () => {
    const row = '36044;beta@pec.it;;;;2333900682;;BETA SRL;19009034;13/03/2026;Oggetto PG;;;PROVV_36044_1.pdf';
    const records = parseRubricaPec(row);
    expect(records[0].codiceFiscale).toBe('02333900682');
    expect(records[0].tipo).toBe('PG');
  });

  it('PIVA già a 11 cifre resta invariata', () => {
    const records = parseRubricaPec(RUBRICA_ROW_PG);
    expect(records[0].codiceFiscale).toBe('00123456789');
  });

  it('CF persona fisica (16 alfanumerici) non viene toccato dallo zero-pad', () => {
    const records = parseRubricaPec(RUBRICA_ROW_PF);
    expect(records[0].codiceFiscale).toBe('RSSMRA80A01H501U');
  });

  it('variante TARI saldo 18 campi: PIVA a 10 cifre zero-paddata', () => {
    const row = '708806;rsu;D;pizzanuova@pec.it;0;;;2333900682;;PIZZANUOVA SRLS;708806;25;8;2026;SALDO TARI 2026;;;DOC_708806_161219.pdf';
    const records = parseRubricaPec(row);
    expect(records[0].codiceFiscale).toBe('02333900682');
  });

  it('variante TARI saldo 16 campi (email): PIVA a 10 cifre zero-paddata', () => {
    const row = '733460;rsu;D;gamma@example.com;1;;;2333900682;;GAMMA SRL;733460;25/08/2026;SALDO TARI 2026;;;DOC_733460_16514.pdf';
    const records = parseRubricaPec(row);
    expect(records[0].codiceFiscale).toBe('02333900682');
  });
```

Aggiungi in `describe('parsePagIndice', ...)` esistente (o crealo se non presente accanto ai test di `parseRubricaPec` — verifica prima con `grep -n "describe('parsePagIndice'" apps/backend/src/enrichment/maggioli-parser.spec.ts`):

```ts
  it('PIVA a 10 cifre in "cod. fisc. dest" viene zero-paddata a 11', () => {
    const csv = [
      "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione;'ocr notifica",
      "'DOC_3.pdf;'GAMMA SRL;'2333900682;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000002;'RAV124;'98;'01/02/2026;'5890000000049996",
    ].join('\n');
    const records = parsePagIndice(csv);
    expect(records[0].codiceFiscale).toBe('02333900682');
  });
```

- [ ] **Step 2: Esegui i test, verifica il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run maggioli-parser`
Expected: FAIL sui nuovi test con PIVA a 10 cifre (`codiceFiscale` resta `'2333900682'`, non paddato).

- [ ] **Step 3: Implementa**

In `apps/backend/src/enrichment/maggioli-parser.ts`, aggiungi dopo `tipoFromCf` (riga 40) la nuova funzione:

```ts
/**
 * Una PIVA italiana valida è SEMPRE 11 cifre numeriche; un CF persona
 * fisica è SEMPRE 16 alfanumerici — non esiste un identificativo valido di
 * esattamente 10 cifre numeriche in questo dominio. Un valore CSV a 10
 * cifre numeriche è quindi un caso non ambiguo di zero iniziale perso a
 * monte (stesso ragionamento già in uso per il CAP, vedi _pad_cap in
 * pdf_extractor.py) — zero-pad silenzioso, nessun warning: il pattern è
 * altrettanto non ambiguo.
 */
function normalizeCodiceFiscale(value: string): string {
  const v = value.trim();
  return /^\d{10}$/.test(v) ? v.padStart(11, '0') : v;
}
```

Poi sostituisci i 4 punti che leggono `codiceFiscale` da CSV, applicando `normalizeCodiceFiscale` sia al valore assegnato a `codiceFiscale` sia all'input di `tipoFromCf` (così `tipo` resta coerente col valore finale):

Riga 53 (variante 18 campi), dentro il primo blocco `if (fields.length >= 18)`:

```ts
        codiceFiscale: normalizeCodiceFiscale(fields[7]),
        tipo: tipoFromCf(normalizeCodiceFiscale(fields[7])),
```

Riga 76 (variante 16 campi), dentro `if (fields.length === 16)`:

```ts
        codiceFiscale: normalizeCodiceFiscale(fields[7]),
        tipo: tipoFromCf(normalizeCodiceFiscale(fields[7])),
```

Riga 93 (variante standard 14 campi, ramo finale della funzione):

```ts
      codiceFiscale: normalizeCodiceFiscale(fields[5]),
      tipo: tipoFromCf(normalizeCodiceFiscale(fields[5])),
```

Riga 132-133 (`parsePagIndice`):

```ts
      codiceFiscale: normalizeCodiceFiscale(row['cod. fisc. dest'] ?? ''),
      tipo: tipoFromCf(normalizeCodiceFiscale(row['cod. fisc. dest'] ?? '')),
```

- [ ] **Step 4: Esegui i test, verifica il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run maggioli-parser`
Expected: PASS, tutti i test (esistenti + nuovi) — verifica in particolare che i test esistenti con CF 16 alfanumerici o PIVA già a 11 cifre non siano cambiati (nessuna regressione, `normalizeCodiceFiscale` è no-op fuori dal caso 10 cifre).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment/maggioli-parser.ts apps/backend/src/enrichment/maggioli-parser.spec.ts
git commit -m "$(cat <<'EOF'
fix(enrichment): zero-pad automatico PIVA a 10 cifre nel CSV Maggioli

Una PIVA valida è sempre 11 cifre numeriche — un valore CSV a 10
cifre ha perso lo zero iniziale a monte, stesso pattern già gestito
per il CAP. Zero-pad silenzioso, nessun warning: risolve di massa il
caso reale osservato (~700 righe su un singolo tracciato) senza
alcuna correzione manuale.
EOF
)"
```

---

## Task 3: Estrazione CF/PIVA dal PDF (`pdf_extractor.py` + `main.py`)

**Files:**
- Modify: `services/pdf-extractor/app/pdf_extractor.py`
- Modify: `services/pdf-extractor/app/main.py`
- Modify: `services/pdf-extractor/tests/conftest.py`
- Test: `services/pdf-extractor/tests/test_pdf_extractor.py`
- Test: `services/pdf-extractor/tests/test_api.py`

**Interfaces:**
- Produces: `PdfExtractor.extract_fiscal_code(self) -> Optional[str]` (metodo pubblico, stesso stile di `extract_address`/`extract_payment`). Risposta JSON di `POST /extract` guadagna il campo `"fiscalCode": str | None` — consumato da Task 4 lato Node (`ExtractResult.fiscalCode`).

- [ ] **Step 1: Aggiungi le fixture di test**

In `services/pdf-extractor/tests/conftest.py`, aggiungi dopo `pdf_header_block_after_contribuente` (riga 100):

```python
@pytest.fixture
def pdf_cf_persona_giuridica() -> bytes:
    """Template PG: 'C.F.: P.Iva:<piva>' (label C.F. seguita da P.Iva sulla
    stessa riga) — formato osservato dal vivo, dati anonimizzati."""
    return _make_pdf(
        ["Contribuente:ACME SRL\nC.F.: P.Iva:01234567890\nSede:65126 PESCARA PE VIA MARCO POLO 12\nOggetto: Saldo TARI 2026\n"]
    )
```

- [ ] **Step 2: Scrivi i test falliti**

In `services/pdf-extractor/tests/test_pdf_extractor.py`, aggiungi in fondo al file:

```python
def test_extract_fiscal_code_persona_fisica(pdf_residenza_inline_label):
    cf = PdfExtractor(pdf_residenza_inline_label).extract_fiscal_code()
    assert cf == "RSSMRA70A01G482X"


def test_extract_fiscal_code_persona_giuridica(pdf_cf_persona_giuridica):
    cf = PdfExtractor(pdf_cf_persona_giuridica).extract_fiscal_code()
    assert cf == "01234567890"


def test_extract_fiscal_code_assente(pdf_no_address):
    cf = PdfExtractor(pdf_no_address).extract_fiscal_code()
    assert cf is None
```

(`pdf_residenza_inline_label` contiene già `C.F.:RSSMRA70A01G482X`, vedi `conftest.py` riga 54 — nessuna nuova fixture necessaria per il caso persona fisica.)

In `services/pdf-extractor/tests/test_api.py`, aggiungi in fondo al file:

```python
def test_extract_includes_fiscal_code(pdf_residenza_inline_label):
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", pdf_residenza_inline_label, "application/pdf")},
    )
    assert res.status_code == 200
    assert res.json()["fiscalCode"] == "RSSMRA70A01G482X"


def test_extract_fiscal_code_null_quando_assente(pdf_no_address):
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", pdf_no_address, "application/pdf")},
    )
    assert res.status_code == 200
    assert res.json()["fiscalCode"] is None
```

- [ ] **Step 3: Esegui i test, verifica il fallimento**

Setup deps dev (una tantum se non già presenti, vedi CLAUDE.md — persiste finché il container non viene ricreato):

```bash
docker cp services/pdf-extractor/requirements-dev.txt comunicapa-pdf-extractor-1:/svc/
docker cp services/pdf-extractor/tests comunicapa-pdf-extractor-1:/svc/tests
docker compose exec pdf-extractor pip install -r requirements-dev.txt
```

Run: `docker compose exec pdf-extractor python -m pytest tests/test_pdf_extractor.py tests/test_api.py -v -k fiscal_code`
Expected: FAIL — `AttributeError: 'PdfExtractor' object has no attribute 'extract_fiscal_code'` (e KeyError `'fiscalCode'` per i test API).

- [ ] **Step 4: Implementa `extract_fiscal_code`**

In `services/pdf-extractor/app/pdf_extractor.py`, aggiungi la regex vicino alle altre regex di classe (dopo `_RE_HEADER_BLOCK_AFTER_CONTRIBUENTE`, riga 145):

```python
    # Etichetta CF/PIVA: "C.F.:<CF16>" (persona fisica) oppure
    # "C.F.: P.Iva:<piva11>" (persona giuridica, label P.Iva subito dopo
    # C.F. sulla stessa riga) — verificato dal vivo su documento reale.
    # Il gruppo "P.Iva:" opzionale copre entrambi i formati con la stessa
    # regex: se assente, il valore catturato è comunque quello dopo "C.F.:".
    _RE_CF_LABEL = re.compile(
        r"C\.F\.\s*:\s*(?:P\.?\s*Iva\s*:\s*)?([A-Z0-9]{11,16})",
        re.IGNORECASE,
    )
```

Aggiungi il metodo dopo `extract_address` (dopo riga 316, prima di `_parse_foreign_address`):

```python
    def extract_fiscal_code(self) -> Optional[str]:
        """Estrae CF/PIVA dal testo pagina 0 — fallback per righe dove il CSV
        del tracciato riporta un CF/PIVA malformato in modo non recuperabile
        dal solo zero-pad (vedi normalizeCodiceFiscale lato Node)."""
        with self._open() as pdf:
            if not pdf.pages:
                return None
            text = pdf.pages[0].extract_text() or ""
        m = self._RE_CF_LABEL.search(text)
        return m.group(1).upper() if m else None
```

- [ ] **Step 5: Aggiorna l'endpoint `/extract`**

In `services/pdf-extractor/app/main.py`, dentro la funzione `extract` (riga 28), aggiungi `fiscal_code = None` all'inizializzazione delle variabili in cima alla funzione (riga 31-33, insieme a `warnings`/`address`/`payment_body`):

```python
    warnings: list[str] = []
    address = None
    payment_body = None
    fiscal_code = None
```

Poi, subito dopo il blocco indirizzo (dopo riga 40, prima di `if search_payments:`), aggiungi l'estrazione CF:

```python
        try:
            fiscal_code = extractor.extract_fiscal_code()
        except Exception as e:
            warnings.append(f"Estrazione CF/PIVA fallita: {e}")
```

Aggiungi `"fiscalCode": fiscal_code` al dizionario di ritorno (riga 55-59):

```python
    return {
        "address": asdict(address) if address else None,
        "payment": payment_body,
        "fiscalCode": fiscal_code,
        "warnings": warnings,
    }
```

- [ ] **Step 6: Esegui i test, verifica il successo**

Run: `docker compose exec pdf-extractor python -m pytest tests/ -v`
Expected: PASS su tutti (incluso il baseline noto `test_extract_address_foreign_cap_embedded_in_street`, che resta l'unico fallimento pre-esistente non correlato — vedi CLAUDE.md).

- [ ] **Step 7: Commit**

```bash
git add services/pdf-extractor/app/pdf_extractor.py services/pdf-extractor/app/main.py services/pdf-extractor/tests/conftest.py services/pdf-extractor/tests/test_pdf_extractor.py services/pdf-extractor/tests/test_api.py
git commit -m "$(cat <<'EOF'
feat(pdf-extractor): estrai CF/Partita IVA dal testo del PDF

Nuovo campo fiscalCode nella risposta /extract, stesso approccio
testuale già in uso per l'indirizzo — fallback per CF/PIVA CSV
malformati in modo non recuperabile dal solo zero-pad (Task 4 lo
userà come fallback automatico in EnrichmentProcessor).
EOF
)"
```

---

## Task 4: Validazione CF/PIVA + fallback PDF in `EnrichmentProcessor`

**Files:**
- Modify: `apps/backend/src/enrichment/pdf-extractor.client.ts`
- Modify: `apps/backend/src/enrichment/enrichment.processor.ts`
- Test: `apps/backend/src/enrichment/enrichment.processor.spec.ts`

**Interfaces:**
- Consumes: `isValidCfOrPiva` da Task 1 (`../channels/tax-id.util.js`); `fiscalCode` nel payload `/extract` da Task 3.
- Produces: nessuna nuova interfaccia pubblica — comportamento osservabile: `EnrichmentJob.warnings` guadagna messaggi `'Codice Fiscale/Partita IVA mancante'`, `'Codice Fiscale/Partita IVA non valido ("...")'`, `'Codice Fiscale/Partita IVA CSV non valido ("...") — sostituito con valore estratto dal PDF'`; nel terzo caso `row.codice_fiscale` (e quindi il CSV finale) riflette il valore PDF.

- [ ] **Step 1: Aggiorna il tipo `ExtractResult`**

In `apps/backend/src/enrichment/pdf-extractor.client.ts`, aggiungi `fiscalCode` all'interfaccia (dopo riga 29, campo `warnings`):

```ts
export interface ExtractResult {
  address: ExtractedAddress | null;
  payment: ExtractedPayment | null;
  fiscalCode: string | null;
  warnings: string[];
}
```

- [ ] **Step 2: Scrivi i test falliti**

In `apps/backend/src/enrichment/enrichment.processor.spec.ts`, aggiungi un nuovo `describe` dopo `describe('validazione Paese/Città/CAP ...)` esistente (stesso file, stesso `beforeEach`/fixture `RUBRICA`/`setupJobDir` già definiti in cima):

```ts
  describe('validazione Codice Fiscale/Partita IVA', () => {
    function setupJobDirWithCf(jobId: string, cf: string): void {
      const rubrica = [
        `id;pec1@pec.it;;MARIO;ROSSI;${cf};;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;PROVV_1.pdf`,
      ].join('\n');
      const zip = new AdmZip();
      zip.addFile('rubrica.csv', Buffer.from(rubrica, 'utf-8'));
      zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
      const dir = getEnrichmentSourcesDir(jobId);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      zip.writeZip(join(dir, '0000_pezzo.zip'));
    }

    it('CF vuoto → warning "mancante", nessun fallback tentato', async () => {
      setupJobDirWithCf('j1', '');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA mancante' })]),
      );
    });

    it('CF invalido nel CSV, PDF ne estrae uno valido → auto-sostituito + warning', async () => {
      setupJobDirWithCf('j1', 'CFINVALIDO');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: 'RSSMRA80A01H501U',
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Codice Fiscale/Partita IVA CSV non valido ("CFINVALIDO") — sostituito con valore estratto dal PDF',
          }),
        ]),
      );
      const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
      expect(csv).toContain('RSSMRA80A01H501U');
      expect(csv).not.toContain('CFINVALIDO');
    });

    it('CF invalido nel CSV, PDF non ne estrae uno valido → solo warning, riga invariata', async () => {
      setupJobDirWithCf('j1', 'CFINVALIDO');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA non valido ("CFINVALIDO")' })]),
      );
      const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
      expect(csv).toContain('CFINVALIDO');
    });

    it('CF valido nel CSV → nessun warning CF/PIVA, anche se il PDF non estrae nulla', async () => {
      setupJobDirWithCf('j1', 'RSSMRA80A01H501U');
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        fiscalCode: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('Codice Fiscale') })]),
      );
    });

    it('PDF non trovato nello ZIP → warning CF/PIVA comunque valutato su riga base (nessun fallback disponibile)', async () => {
      const rubrica = 'id;pec1@pec.it;;MARIO;ROSSI;CFINVALIDO;;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;MANCANTE.pdf';
      const zip = new AdmZip();
      zip.addFile('rubrica.csv', Buffer.from(rubrica, 'utf-8'));
      const dir = getEnrichmentSourcesDir('j1');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      zip.writeZip(join(dir, '0000_pezzo.zip'));

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Codice Fiscale/Partita IVA non valido ("CFINVALIDO")' })]),
      );
    });
  });
```

Nota: il mock esistente in `beforeEach` (righe 80-89 del file) va aggiornato per includere `fiscalCode: null` — altrimenti i test esistenti (che non impostano un `codice_fiscale` invalido, quindi non attraversano il ramo fallback) restano comunque compatibili col nuovo campo tipizzato di `ExtractResult`; aggiornalo comunque per coerenza:

```ts
    client = {
      extract: jest.fn(async () => ({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: {
          totale: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
          rate: [],
        },
        fiscalCode: null,
        warnings: [],
      })),
    };
```

- [ ] **Step 3: Esegui i test, verifica il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run enrichment.processor`
Expected: FAIL sui 5 nuovi test del describe "validazione Codice Fiscale/Partita IVA" (nessun warning CF/PIVA generato oggi).

- [ ] **Step 4: Implementa**

In `apps/backend/src/enrichment/enrichment.processor.ts`:

Aggiungi l'import in cima al file (dopo riga 9, `matchCountry, isValidCap`):

```ts
import { isValidCfOrPiva } from '../channels/tax-id.util.js';
```

Hoista la dichiarazione di `result` fuori dal blocco try interno. Sostituisci (righe 169-176):

```ts
        } else {
          try {
            // Buffer letto una sola volta: ...
            const pdfBuffer = entry.getData();
```

con:

```ts
        } else {
          let result: Awaited<ReturnType<PdfExtractorClient['extract']>> | undefined;
          try {
            // Buffer letto una sola volta: ...
            const pdfBuffer = entry.getData();
```

E sostituisci la riga 181 (`const result = await this.extractor.extract(...)`) rimuovendo `const`:

```ts
            result = await this.extractor.extract(pdfBuffer, rec.pdfFilename, {
              searchPayments: record.searchPayments ?? true,
            });
```

Il resto del blocco try (righe 184-233, uso di `result.warnings`/`result.address`/`result.payment`) resta invariato — `result` è ora accessibile anche dopo il blocco try/catch, per la sezione di validazione sotto.

Aggiungi la validazione CF/PIVA nella sezione "Stesse 3 regole del wizard campagne" (dopo il blocco CAP, righe 269-271, prima di `rows.push(row)` riga 273):

```ts
        const csvCf = (row.codice_fiscale || '').trim();
        if (!csvCf) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'Codice Fiscale/Partita IVA mancante' });
        } else if (!isValidCfOrPiva(csvCf)) {
          const pdfCf = result?.fiscalCode ? result.fiscalCode.trim() : '';
          if (pdfCf && isValidCfOrPiva(pdfCf)) {
            row.codice_fiscale = pdfCf;
            warnings.push({
              row: rowNum,
              pdf: rec.pdfFilename,
              message: `Codice Fiscale/Partita IVA CSV non valido ("${csvCf}") — sostituito con valore estratto dal PDF`,
            });
          } else {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Codice Fiscale/Partita IVA non valido ("${csvCf}")` });
          }
        }
```

- [ ] **Step 5: Esegui i test, verifica il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run enrichment.processor`
Expected: PASS, tutti i test (esistenti + 5 nuovi).

- [ ] **Step 6: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

Run: `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun errore (copre anche `enrichment.processor.spec.ts`).

- [ ] **Step 7: Suite completa (verifica nessuna regressione su costruttori/moduli condivisi)**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: stesso failure set noto della baseline (`app.controller.spec.ts`/`isLdapMock`), nessun nuovo fallimento.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/enrichment/pdf-extractor.client.ts apps/backend/src/enrichment/enrichment.processor.ts apps/backend/src/enrichment/enrichment.processor.spec.ts
git commit -m "$(cat <<'EOF'
feat(enrichment): valida CF/Partita IVA con fallback automatico da PDF

Dopo il zero-pad di massa (task precedente), le righe con CF/PIVA
ancora invalido dopo il parsing CSV vengono validate qui: se il PDF
ne estrae uno valido viene auto-applicato alla riga (stesso pattern
già in uso per l'indirizzo mancante), sempre con un warning in lista
per la revisione operatore. Nessun nuovo stato bloccante.
EOF
)"
```

---

## Task 5: Form "Correggi dati" — CF/PIVA editabile + fix bottone Verifica ANPR

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: nessuna dipendenza diretta da Task 1-4 (il campo `codice_fiscale` è già disponibile via `GET /enrichment/jobs/:id/rows/:pdfFilename` — endpoint esistente, invariato da questo piano; i warning generati da Task 4 appaiono automaticamente in UI tramite il meccanismo esistente `renderWarningRow`, nessuna modifica lì necessaria).
- Produces: nessuna nuova interfaccia — comportamento frontend osservabile.

Non esistono test unitari frontend in questo repo (`apps/frontend-admin` non ha file `*.spec.tsx`/`*.test.tsx`) — verifica tramite `tsc --noEmit` più verifica manuale in browser (dev server).

- [ ] **Step 1: Rendi `codice_fiscale` editabile nel form**

In `apps/frontend-admin/src/App.tsx`, trova il filtro degli header editabili (circa riga 15051-15052):

```tsx
                                      {enrichAddressEditHeaders
                                        .filter((h) => h !== 'allegato' && h !== 'codice_fiscale')
```

Sostituisci con:

```tsx
                                      {enrichAddressEditHeaders
                                        .filter((h) => h !== 'allegato')
```

- [ ] **Step 2: Aggiungi gate client-side sul bottone Verifica**

Trova il bottone "Carica da ANPR"/"Carica da Registro Imprese" (circa riga 15033-15046):

```tsx
                                    <button
                                      className="btn btn-sm btn-outline-primary mb-3"
                                      type="button"
                                      disabled={!enrichAddressEditCf || enrichAddressEditAnprLoading}
                                      onClick={runEnrichAddressAnprCheck}
                                    >
                                      {enrichAddressEditAnprLoading ? (
                                        <><Loader2 className="icon-spin me-1" size={16} />Verifica in corso...</>
                                      ) : /^\d{11}$/.test((enrichAddressEditCf || '').trim()) ? (
                                        'Carica da Registro Imprese'
                                      ) : (
                                        'Carica da ANPR'
                                      )}
                                    </button>
```

Sostituisci con (il valore da usare per abilitazione/etichetta/query diventa il campo del form corrente, non lo stato fissato all'apertura — vedi Step 3 per il motivo):

```tsx
                                    <button
                                      className="btn btn-sm btn-outline-primary mb-3"
                                      type="button"
                                      disabled={!isValidCfOrPiva(enrichAddressEditFields['codice_fiscale'] || '') || enrichAddressEditAnprLoading}
                                      onClick={runEnrichAddressAnprCheck}
                                    >
                                      {enrichAddressEditAnprLoading ? (
                                        <><Loader2 className="icon-spin me-1" size={16} />Verifica in corso...</>
                                      ) : /^\d{11}$/.test((enrichAddressEditFields['codice_fiscale'] || '').trim()) ? (
                                        'Carica da Registro Imprese'
                                      ) : (
                                        'Carica da ANPR'
                                      )}
                                    </button>
```

- [ ] **Step 3: Fix stato stantio in `runEnrichAddressAnprCheck`**

Trova la funzione (circa riga 3649-3714). Sostituisci l'intero corpo così che legga il CF dal campo form corrente invece che dallo stato fissato all'apertura riga:

```tsx
  const runEnrichAddressAnprCheck = async () => {
    const cf = (enrichAddressEditFields['codice_fiscale'] || '').trim();
    if (!cf || !isValidCfOrPiva(cf)) return;
    setEnrichAddressEditAnprLoading(true);
    try {
      const res = await apiFetch('/domicilio/cerca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: cf }),
      });
      const data = await res.json();
      // Persona giuridica (PIVA/CF 11 cifre) — backend instrada su Registro
      // Imprese, mai su ANPR: leggere data.registroImprese, non data.anpr.
      if (/^\d{11}$/.test(cf)) {
        const ri = data?.registroImprese;
        const ind = ri?.data?.sede?.indirizzo;
        if (ri?.success && ri?.found && ind) {
          const via = [ind.toponimo, ind.via].filter(Boolean).join(' ');
          setEnrichAddressEditFields((f) => ({
            ...f,
            indirizzo: [via, ind.nCivico].filter(Boolean).join(', '),
            cap: ind.cap || '',
            comune: ind.comune || '',
            provincia: ind.provincia || '',
            stato_estero: '',
            ...(f.pec !== undefined ? { pec: ri.pec || '' } : {}),
          }));
        } else if (ri?.success && !ri?.found) {
          alert('Registro Imprese: nessuna impresa trovata per questo Codice Fiscale/Partita IVA.');
        } else {
          alert(formatExternalErrorMessage(ri?.message));
        }
        return;
      }
      const residenza = data?.anpr?.residenza?.[0];
      if (data?.anpr?.success && data?.anpr?.found && residenza?.indirizzo) {
        const ind = residenza.indirizzo;
        const via = [ind.toponimo?.specie, ind.toponimo?.denominazioneToponimo].filter(Boolean).join(' ');
        const civico = [ind.numeroCivico?.numero, ind.numeroCivico?.lettera].filter(Boolean).join('');
        setEnrichAddressEditFields((f) => ({
          ...f,
          indirizzo: [via, civico].filter(Boolean).join(', '),
          cap: ind.cap || '',
          comune: ind.comune?.nomeComune || '',
          provincia: ind.comune?.siglaProvinciaIstat || '',
          stato_estero: '',
        }));
      } else if (data?.anpr?.success && data?.anpr?.found && residenza?.localitaEstera?.indirizzoEstero) {
        const ind = residenza.localitaEstera.indirizzoEstero;
        const via = [ind.toponimo?.denominazione, ind.toponimo?.numeroCivico].filter(Boolean).join(' ');
        setEnrichAddressEditFields((f) => ({
          ...f,
          indirizzo: via,
          cap: ind.cap || '',
          comune: ind.localita?.descrizioneLocalita || '',
          provincia: '',
          stato_estero: ind.localita?.descrizioneStato || '',
        }));
      } else {
        alert('ANPR: nessun indirizzo di residenza trovato per questo CF.');
      }
    } catch {
      alert('Errore di connessione durante la verifica ANPR.');
    } finally {
      setEnrichAddressEditAnprLoading(false);
    }
  };
```

(unica differenza rispetto all'originale: le prime 2 righe della funzione e ogni occorrenza di `enrichAddressEditCf` sostituita da `cf`, la costante locale letta dal campo form corrente — nessun'altra modifica di comportamento.)

- [ ] **Step 4: Inizializza `enrichAddressEditCf` dal valore riconciliato (non dal CSV grezzo)**

Trova `openEnrichAddressEdit` (circa riga 3591-3627). Trova la riga:

```tsx
      setEnrichAddressEditCf(row.codiceFiscale || '');
```

Sostituiscila spostandola DOPO il blocco che calcola `fields` (che già riconcilia override/CSV per ogni header, incluso ora `codice_fiscale` da Step 1), leggendo da lì:

```tsx
      setEnrichAddressEditHeaders(headers);
      setEnrichAddressEditFields(fields);
      setEnrichAddressEditCf(fields['codice_fiscale'] || row.codiceFiscale || '');
```

rimuovendo la vecchia riga `setEnrichAddressEditCf(row.codiceFiscale || '');` dalla sua posizione originale (subito dopo `const override = row.override;`, prima del loop `for (const h of headers)`).

- [ ] **Step 5: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser**

1. `docker compose up -d --build frontend-admin backend` (assicurati che entrambi girino con le modifiche).
2. Login admin (vedi CLAUDE.md, sezione Test, per il token o login LDAP mock `admin`/`admin`).
3. Carica lo ZIP di test disponibile su richiesta dell'utente (`Postalizzazione Saldo PEC.zip`, riga 1 con PIVA `2333900682` → deve arrivare già zero-paddata a `02333900682` nel CSV risultato, **nessun warning CF/PIVA** su quella riga specifica).
4. Se il job produce comunque righe con warning CF/PIVA (CF/PIVA corrotto in altro modo), apri "Correggi dati" su una di quelle: verifica che il campo "Codice fiscale" sia ora editabile, che digitando un valore a 11 cifre il bottone diventi "Carica da Registro Imprese" (non "Carica da ANPR") e che il click interroghi effettivamente Registro Imprese col valore appena digitato (non un valore precedente).
5. Salva la correzione, riapri la stessa riga: verifica che il CF mostrato rifletta il valore corretto salvato (non il valore CSV originale).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
fix(frontend-admin): CF/PIVA editabile in Correggi dati + fix Verifica ANPR

Il campo Codice Fiscale era escluso dal form di correzione riga
(Arricchimento Tracciati) e il bottone Verifica ANPR/Registro Imprese
leggeva un valore fissato all'apertura riga, mai aggiornato se
l'operatore modificava il campo — interrogare Registro Imprese dopo
aver corretto un CF a mano non funzionava. Il backend instradava già
correttamente (DomicilioService.cercaDomicilio), il bug era solo lo
stato stantio lato form.
EOF
)"
```

---

## Self-Review (eseguita dall'autore del piano)

**Spec coverage:**
- §1 zero-pad → Task 2. ✓
- §2 validazione formato + fallback PDF → Task 4 (+ Task 1 per `isValidCfOrPiva`). ✓
- §3 estrazione CF dal PDF → Task 3. ✓
- Form correzione (editabile + fix bottone + gate + init) → Task 5, tutti e 4 i punti della spec coperti (Step 1-4). ✓
- Testing: tax-id (Task 1), maggioli-parser (Task 2), enrichment.processor (Task 4), pdf-extractor pytest (Task 3) — tutti presenti. Frontend: nessun test automatico nel repo, sostituito con tsc + verifica manuale (coerente con l'assenza di suite frontend esistente).

**Placeholder scan:** nessun TBD/TODO, ogni step ha codice completo o comando eseguibile esplicito.

**Type consistency:** `isValidCfOrPiva` stesso nome/firma in Task 1 (backend) e riferimento locale già esistente in `App.tsx` (Task 5, nessuna nuova definizione — la funzione locale in `App.tsx:1121` è già quella usata). `ExtractResult.fiscalCode` (Task 3 Python → Task 4 TS type) stesso nome in entrambi i lati. `normalizeCodiceFiscale` usata solo internamente a `maggioli-parser.ts` (Task 2), nessun consumer esterno da verificare.
