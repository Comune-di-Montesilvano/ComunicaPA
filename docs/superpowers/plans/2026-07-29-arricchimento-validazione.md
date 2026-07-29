# Validazione Paese/Città/CAP in Arricchimento Tracciati Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fixare il bug di normalizzazione in `matchCountry` (apostrofo finale, spazi non rimossi — causa reale di "PERU'"/"SUD AFRICA" non riconosciuti) e portare le stesse regole di validazione Paese/Città/CAP già usate dal wizard campagne dentro "Arricchimento Tracciati", così l'operatore scopre e corregge i problemi dove ha i dati originali (PDF/CSV), non solo al momento di creare la campagna.

**Architecture:** Fix + nuovo export `isValidCap` in `packages/shared-types` (single source riusata da entrambi i lati). `apps/frontend-admin/src/App.tsx` importa `isValidCap` condiviso al posto della copia locale. `EnrichmentProcessor.processEnrich` (Node, stesso runtime del wizard) applica le 3 regole subito prima di accodare ogni riga, generando warning nello stesso formato `{row, pdf, message}` già esistente — nessuna modifica al microservizio Python.

**Tech Stack:** TypeScript, NestJS 10, React 19, Jest.

## Global Constraints

- Nessuna modifica al controllo "contratto POSTAL supporta estero" (resta solo nel wizard, dipende dal canale scelto a valle).
- Warning nuovi = solo informativi, stessa severità di "PDF non trovato nel ZIP"/"Estrazione fallita" — mai bloccanti su "Crea bozza campagna" o "Scarica Righe Errate CSV".
- Nessuna modifica al microservizio Python `pdf_extractor.py`.
- Suite completa (`jest --maxWorkers=2`, sia backend che le suite dei due frontend dove applicabile) va lanciata a fine piano — baseline nota: 1 solo fallimento pre-esistente (`app.controller.spec.ts`/`isLdapMock`).
- Spec di riferimento: `docs/superpowers/specs/2026-07-29-arricchimento-validazione-design.md`.

---

### Task 1: Fix `matchCountry` + nuovo export `isValidCap` in shared-types

**Files:**
- Modify: `packages/shared-types/src/index.ts:106-113` (funzione `normalizeCountryName`)
- Modify: `packages/shared-types/src/index.spec.ts`

**Interfaces:**
- Produce: `normalizeCountryName` corretta (uso interno, non esportata) e nuovo export `isValidCap(value: string): boolean` — consumati dai Task 2 e 3.

- [ ] **Step 1: Scrivere i test falliti per `matchCountry` (bug apostrofo/spazi)**

In `packages/shared-types/src/index.spec.ts`, aggiungere dentro il blocco `describe('matchCountry', ...)` esistente, dopo il test con `'Costa d’Avorio'` (riga 46):

```ts
  it('riconosce "PERU\'" (apostrofo finale al posto della vocale accentata, dato PA comune)', () => {
    expect(matchCountry("PERU'")).toBe('Perù');
  });

  it('riconosce "SUD AFRICA" (due parole) come "Sudafrica" (una parola in COUNTRIES)', () => {
    expect(matchCountry('SUD AFRICA')).toBe('Sudafrica');
  });

  it('riconosce "CITTA\' DEL VATICANO" (apostrofo + spazi) come "Città del Vaticano"', () => {
    expect(matchCountry("CITTA' DEL VATICANO")).toBe('Città del Vaticano');
  });
```

- [ ] **Step 2: Scrivere i test falliti per il nuovo export `isValidCap`**

Nello stesso file, aggiungere in fondo (dopo la chiusura dell'ultimo `describe`):

```ts

describe('isValidCap', () => {
  it('accetta un CAP di 5 cifre', () => {
    expect(isValidCap('65015')).toBe(true);
  });

  it('rifiuta un valore non numerico o di lunghezza diversa', () => {
    expect(isValidCap('LA')).toBe(false);
    expect(isValidCap('123')).toBe(false);
    expect(isValidCap('123456')).toBe(false);
  });

  it('ignora spazi superflui', () => {
    expect(isValidCap('  65015  ')).toBe(true);
  });
});
```

E aggiungere `isValidCap` all'import in cima al file (riga 1):
```ts
import { COUNTRIES, matchCountry, isValidCap } from './index';
```

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

Run: `docker run --rm -v "$(pwd)/packages/shared-types:/app/packages/shared-types" -v comunicapa_backend_node_modules:/app/node_modules -w /app comunicapa/backend:dev node_modules/.bin/jest packages/shared-types --maxWorkers=2`

Expected: FAIL — `matchCountry("PERU'")` ritorna `null` invece di `'Perù'`; `isValidCap is not a function` (o `undefined`).

- [ ] **Step 4: Implementare il fix + il nuovo export**

In `packages/shared-types/src/index.ts`, sostituire la funzione `normalizeCountryName` (righe 106-113):

```ts
function normalizeCountryName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "'") // normalizza apostrofo tipografico/curly a quello dritto
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '') // rimuove diacritici (é->e, ù->u, ...)
    .replace(/'/g, '') // rimuove apostrofi — dato PA comune: vocale accentata
    // sostituita con lettera base + apostrofo finale (es. "PERU'" per "Perù")
    .replace(/\s+/g, ''); // rimuove spazi — es. "SUD AFRICA" vs "Sudafrica"
}
```

E aggiungere, subito dopo la definizione di `matchCountry` (dopo la riga
129, fine file):

```ts

/**
 * CAP domestico italiano — 5 cifre. Stessa regola richiesta sia dal wizard
 * campagne sia dalla validazione in Arricchimento Tracciati (vedi
 * docs/superpowers/specs/2026-07-29-arricchimento-validazione-design.md) —
 * unica definizione condivisa invece di una copia locale per consumer.
 */
export function isValidCap(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker run --rm -v "$(pwd)/packages/shared-types:/app/packages/shared-types" -v comunicapa_backend_node_modules:/app/node_modules -w /app comunicapa/backend:dev node_modules/.bin/jest packages/shared-types --maxWorkers=2`

Expected: PASS, tutti i test (esistenti + nuovi) di `index.spec.ts`.

- [ ] **Step 6: Rebuild del pacchetto (CJS+ESM) e type-check**

`@comunicapa/shared-types` è consumato via build duale (dist/cjs + dist/esm, vedi CLAUDE.md) — i container backend/frontend che lo usano leggono solo `dist/`, mai `src/` direttamente in produzione. In dev il bind mount espone `src/` via symlink, quindi per verificare basta type-check:

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (il backend non usa ancora `isValidCap`, solo verifica che `matchCountry`/`COUNTRIES` restino validi).

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/index.ts packages/shared-types/src/index.spec.ts
git commit -m "fix(shared-types): matchCountry riconosce apostrofo finale e spazi (PERU', SUD AFRICA), aggiunge isValidCap"
```

---

### Task 2: `App.tsx` — usa `isValidCap` condiviso invece della copia locale

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6` (import)
- Modify: `apps/frontend-admin/src/App.tsx:802-804` (rimozione funzione locale)

**Interfaces:**
- Consuma: `isValidCap` da `@comunicapa/shared-types` (Task 1).
- Nessuna nuova interfaccia prodotta — stesso nome/firma, tutti i call site esistenti (righe 5394, 8400, 5265 già visti in esplorazione) restano invariati.

- [ ] **Step 1: Aggiornare l'import**

In `apps/frontend-admin/src/App.tsx`, sostituire la riga 6:
```ts
import { COUNTRIES, matchCountry } from '@comunicapa/shared-types';
```
con:
```ts
import { COUNTRIES, matchCountry, isValidCap } from '@comunicapa/shared-types';
```

- [ ] **Step 2: Rimuovere la funzione locale duplicata**

Rimuovere, alle righe 802-804:
```ts
function isValidCap(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}
```

(Nessun altro cambiamento: stessa firma, stesso comportamento, tutti i call site esistenti restano invariati.)

- [ ] **Step 3: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (nessun riferimento rotto a `isValidCap` locale, l'import copre tutti gli usi esistenti).

- [ ] **Step 4: Verifica manuale rapida (dev)**

Con lo stack dev già in esecuzione (`docker compose up -d`), aprire il wizard campagne POSTAL, Passo 3, e verificare che un CAP invalido (es. "LA") sia ancora segnalato come "CAP non valido (5 cifre)" — comportamento invariato rispetto a prima del refactor.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "refactor(frontend-admin): usa isValidCap condiviso da shared-types invece della copia locale"
```

---

### Task 3: Validazione Paese/Città/CAP in `EnrichmentProcessor`

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.processor.ts`
- Modify: `apps/backend/src/enrichment/enrichment.processor.spec.ts`

**Interfaces:**
- Consuma: `matchCountry(raw: string): string | null`, `isValidCap(value: string): boolean` da `@comunicapa/shared-types` (Task 1).
- Produce: nessuna nuova interfaccia pubblica — il comportamento osservabile è l'aggiunta di elementi a `warnings: EnrichmentWarning[]` (stesso tipo già esistente, `{ row: number; pdf: string; message: string }`).

- [ ] **Step 1: Scrivere i test falliti**

In `apps/backend/src/enrichment/enrichment.processor.spec.ts`, aggiungere un nuovo blocco `describe` in fondo al file (prima dell'ultima `});` di chiusura del `describe('EnrichmentProcessor', ...)` principale):

```ts

  describe('validazione Paese/Città/CAP (stesse regole del wizard campagne)', () => {
    it('Città mancante → warning, quando comune resta vuoto dopo estrazione/CSV', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: '', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Città mancante' })]),
      );
    });

    it('Paese non riconosciuto → warning, con il fix apostrofo/spazi ora "PERU\'" viene riconosciuto e NON genera warning', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: '', comune: 'LIMA', provincia: '', stato_estero: "PERU'" },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('non riconosciuto') })]),
      );
    });

    it('Paese realmente non riconosciuto (stringa non mappabile) → warning', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: '', comune: 'LIMA', provincia: '', stato_estero: 'PAESE INESISTENTE XYZ' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'Paese "PAESE INESISTENTE XYZ" non riconosciuto' })]),
      );
    });

    it('CAP non valido → warning solo per indirizzo domestico (Paese vuoto o Italia)', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: 'LA', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'CAP non valido (richieste 5 cifre)' })]),
      );
    });

    it('CAP non a 5 cifre NON genera warning se l\'indirizzo è estero', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'CALLE X', cap: 'LA', comune: 'LIMA', provincia: '', stato_estero: 'Perù' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      expect(finalUpdate.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('CAP non valido') })]),
      );
    });

    it('indirizzo domestico completo e valido → nessun nuovo warning di validazione', async () => {
      client.extract.mockResolvedValue({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: null,
        warnings: [],
      });

      await processor.process(fakeJob);

      const finalUpdate = repo.update.mock.calls.at(-1)![1];
      const validationMessages = finalUpdate.warnings
        .filter((w: any) => w.pdf === 'PROVV_1.pdf')
        .map((w: any) => w.message);
      expect(validationMessages).toEqual([]);
    });
  });
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2`
Expected: FAIL sui nuovi test (nessuna validazione ancora implementata — i warning attesi non compaiono).

- [ ] **Step 3: Implementare la validazione**

In `apps/backend/src/enrichment/enrichment.processor.ts`:

Aggiungere l'import in cima al file (dopo la riga 8, `import AdmZip from 'adm-zip';`):
```ts
import { matchCountry, isValidCap } from '@comunicapa/shared-types';
```

Sostituire la riga 224 (`rows.push(row);`) con:
```ts
        // Stesse 3 regole del wizard campagne (Paese/Città/CAP, vedi
        // docs/superpowers/specs/2026-07-29-arricchimento-validazione-design.md)
        // applicate qui: mai bloccanti, solo warning informativi come
        // "PDF non trovato"/"Estrazione fallita" — l'operatore corregge via
        // EnrichmentAddressOverrideService quando vuole. Applicate
        // incondizionatamente: row esiste sempre (baseRow), anche quando il
        // PDF è mancante o l'estrazione è fallita.
        const paeseRaw = (row.stato_estero || '').trim();
        const matchedCountry = paeseRaw ? matchCountry(paeseRaw) : null;
        const isForeignRow = !!matchedCountry && matchedCountry !== 'Italia';
        if (paeseRaw && !matchedCountry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Paese "${paeseRaw}" non riconosciuto` });
        }
        if (!(row.comune || '').trim()) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'Città mancante' });
        }
        if (!isForeignRow && (row.cap || '').trim() && !isValidCap(row.cap)) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'CAP non valido (richieste 5 cifre)' });
        }

        rows.push(row);
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2`
Expected: PASS, tutti i test (esistenti + nuovi) — incluso il test preesistente "elabora il ZIP: CSV scritto, riga con PDF mancante = warning, stato DONE" (riga 2 del fixture RUBRICA ha comune vuoto → ora genera anche un warning "Città mancante" in più, ma l'assert usa `arrayContaining`/`toBeGreaterThanOrEqual`, quindi resta verde).

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/enrichment/enrichment.processor.ts apps/backend/src/enrichment/enrichment.processor.spec.ts
git commit -m "feat(enrichment): valida Paese/Città/CAP durante l'arricchimento, stesse regole del wizard"
```

---

### Task 4: Verifica suite completa

**Files:** nessuna modifica — solo verifica.

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`), nessuna nuova regressione.

- [ ] **Step 2: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale end-to-end (dev)**

In ambiente dev (`LDAP_HOST=mock`), caricare uno ZIP di arricchimento con almeno una riga con Paese scritto come `"PERU'"` o `"SUD AFRICA"` (formato `rubrica.csv`/`pag_indice.csv` con colonna stato estero valorizzata) e una riga senza comune: verificare che il job risultante mostri i nuovi warning ("Città mancante" per la riga senza comune, nessun warning "Paese non riconosciuto" per PERU'/SUD AFRICA grazie al fix) nella UI "Log Job", e che "Scarica Righe Errate CSV"/"Crea bozza campagna" restino disponibili (warning non bloccanti).

- [ ] **Step 4: Nessun commit da questo task** — solo verifica, il codice è già committato nei Task 1-3.
