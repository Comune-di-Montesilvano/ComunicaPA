# Verifica Domicili: errore "impresa cessata" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nella Verifica Domicili massiva segnalare in `errori` le partite IVA di imprese cessate nel Registro Imprese, e contarle nel riepilogo.

**Architecture:** `registro_imprese_found_map` (jsonb, nessuna migration) passa da `Record<string, boolean>` a `Record<string, RegistroImpreseOutcome>`; il worker scrive stato/data/causale già presenti in `dettaglioImpresa().data.sede`; il CSV aggregato e `getStatus` li leggono.

**Tech Stack:** NestJS 12 ESM, TypeORM, BullMQ, Vitest; React 19 (frontend-admin).

**Spec:** `docs/superpowers/specs/2026-11-21-registro-imprese-cessata-verifica-domicili-design.md`

## Global Constraints

- Solo partite IVA (`checkTaxId(...).kind === 'piva'`); CF fisici: nessun cambiamento di output.
- `isPecStillUsable` e `registroImpreseResults` invariati: cessata < 1 anno ⇒ PEC in `domicilio_digitale` **e** errore.
- Testo errore: `impresa cessata nel Registro Imprese (stato: <stato>, dal <dtCancellazione>, causale: <causale>)`, parti `dal …`/`causale: …` omesse se assenti.
- Chiave assente in mappa = verifica non riuscita (semantica invariata). Nessuna compatibilità con valori booleani dei job vecchi.
- Lavoro su branch `feat/registro-imprese-cessata` (mai commit su main). Fixture solo con dati fittizi.
- Guida operatori aggiornata nella stessa PR, data in testa.

## Review Focus

- Causale/testo con virgola e CSV separato da virgola → cella tra virgolette, colonne allineate (Task 2, test `cella quotata`).
- Cessata con PEC ancora valida → PEC in `domicilio_digitale` e errore insieme (Task 2).
- CF fisico con ditta individuale cessata → nessun errore (Task 2) e non contato (Task 2, `getStatus`).
- Errore generico/tentativi esauriti → chiave assente, "verifica Registro Imprese non riuscita" invariato (Task 1 test esistente, Task 2 test esistente).
- Impresa trovata attiva → oggetto `{ found: true }` senza campi di cessazione, nessun errore (Task 1, Task 2).

---

### Task 1: tipo `RegistroImpreseOutcome` + worker

**Files:**
- Modify: `apps/backend/src/entities/domicile-verification-job.entity.ts:130-141`
- Modify: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts` (`processAdHocVerify`)
- Test: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts`

**Interfaces:**
- Produces (esportato dall'entity file):
  ```ts
  export interface RegistroImpreseOutcome {
    found: boolean;
    stato?: string;          // sede.statoImpresa, solo se valorizzato
    dtCancellazione?: string; // "DD/MM/YYYY" così come arriva
    causale?: string;         // sede.causaleCessazione
  }
  ```
  `registroImpreseFoundMap!: Record<string, RegistroImpreseOutcome>` (commento JSDoc aggiornato).

- [ ] **Step 0:** `git switch -c feat/registro-imprese-cessata`; committare lo spec e questo piano (`docs: spec e piano errore impresa cessata`).
- [ ] **Step 1: test che falliscono** nello spec del processor:
  - aggiornare `scrive found:false …`: quarto parametro `JSON.stringify({ '12345678901': { found: false } })`.
  - aggiornare il test "trovata" esistente: `{ found: true }` (nessuna chiave `stato`).
  - nuovo `scrive stato, data e causale per un'impresa cessata`: mock `{ found: true, raw: '', pec: undefined, data: { sede: { denominazione: 'ACME SRL', statoImpresa: 'CANCELLATA', dtCancellazione: '12/03/2019', causaleCessazione: 'CESSAZIONE ATTIVITA' } } }` → quarto parametro `JSON.stringify({ '12345678901': { found: true, stato: 'CANCELLATA', dtCancellazione: '12/03/2019', causale: 'CESSAZIONE ATTIVITA' } })`, secondo parametro `1`.
- [ ] **Step 2:** `docker compose exec backend node_modules/.bin/vitest run registro-imprese-verify.processor` → FAIL sui 3 test.
- [ ] **Step 3:** in `processAdHocVerify` costruire l'outcome da `result.found` e `result.data?.sede`; campi di cessazione solo se `statoImpresa` presente, chiavi `undefined` non serializzate (spread condizionale). `onFailed` invariato (non scrive nella mappa).
- [ ] **Step 4:** `docker compose restart backend`, rilanciare il test → PASS; `docker compose exec backend node_modules/.bin/tsc --noEmit` → errori solo in `domicile-verification-csv.util.ts`/sync (risolti nel Task 2), annotarli.
- [ ] **Step 5:** commit `feat(verifica-domicili): salva stato cessazione Registro Imprese`.

### Task 2: errore nel CSV aggregato + contatore in `getStatus`

**Files:**
- Modify: `apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.ts:12,43,69-73`
- Modify: `apps/backend/src/channels/domicile-verification/domicile-verification.service.ts` (`DomicileVerificationStatus`, `getStatus`)
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.spec.ts`, `apps/backend/src/channels/domicile-verification/domicile-verification.service.spec.ts`

**Interfaces:**
- Consumes: `RegistroImpreseOutcome` (Task 1, `import type`).
- Produces: `registroImpreseFoundMap?: Record<string, RegistroImpreseOutcome>` in `DomicileVerificationCsvInput`; `registroImpreseCeasedCount: number` in `DomicileVerificationStatus` (subito dopo `registroImpreseFoundCount`).

- [ ] **Step 1: test che falliscono** (CSV util):
  - aggiornare i 3 test esistenti con mappa: `true` → `{ found: true }`, `false` → `{ found: false }`.
  - `impresa cessata con PEC: domicilio e errore` — sorgente `cf;nome\n12345678903;ACME SRL\n` (separatore `;`), `registroImpreseResults: { '12345678903': 'acme@pec.it' }`, mappa `{ found: true, stato: 'CANCELLATA', dtCancellazione: '12/03/2019', causale: 'FALLIMENTO' }` → riga `12345678903;ACME SRL;acme@pec.it;;impresa cessata nel Registro Imprese (stato: CANCELLATA, dal 12/03/2019, causale: FALLIMENTO)`.
  - `impresa cessata senza data né causale` — mappa `{ found: true, stato: 'CANCELLATA' }` → errore `impresa cessata nel Registro Imprese (stato: CANCELLATA)`.
  - `cella quotata` — separatore `,`, stesso caso del primo → ultima cella `"impresa cessata nel Registro Imprese (stato: CANCELLATA, dal 12/03/2019, causale: FALLIMENTO)"`.
  - `CF fisico con ditta cessata: nessun errore` — `RSSMRA80A01H501U` con mappa cessata → riga `RSSMRA80A01H501U,,,`.
- [ ] **Step 2: test che fallisce** (service spec, `getStatus`): mappa `{ '12345678903': { found: true, stato: 'CANCELLATA' }, '98765432103': { found: true }, RSSMRA80A01H501U: { found: true, stato: 'CANCELLATA' } }` → `registroImpreseCeasedCount === 1`.
- [ ] **Step 3:** `vitest run domicile-verification` → FAIL sui nuovi test.
- [ ] **Step 4:** ramo `piva` del CSV: `foundMap[key]?.found === false` → errore attuale; `foundMap[key]?.stato` → errore cessata (helper locale `ceasedError(o: RegistroImpreseOutcome): string`); ramo "non riuscita" invariato. In `getStatus`: conteggio chiavi con `stato` e `checkTaxId(k).kind === 'piva'`. Sync service: nessuna modifica oltre al tipo.
- [ ] **Step 5:** `docker compose restart backend`; `vitest run domicile-verification registro-imprese` con `-e TZ=UTC` e `-e TZ=Europe/Rome` → PASS; `tsc --noEmit` e `tsc -p tsconfig.spec.json --noEmit` → puliti; suite completa → solo il fallimento baseline noto di `app.controller.spec.ts`.
- [ ] **Step 6:** commit `feat(verifica-domicili): errore impresa cessata nell'aggregato`.

### Task 3: riepilogo admin + guida

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1759` (tipo stato), `:3736` (stato iniziale), `:14623` (testo "Verifica completata")
- Modify: `apps/frontend-admin/public/guida/guida.md` (data in testa; sezione Verifica Domicili, elenco `errori` riga ~198)

**Interfaces:**
- Consumes: `registroImpreseCeasedCount: number` dalla risposta di stato (Task 2).

- [ ] **Step 1:** tipo + stato iniziale `registroImpreseCeasedCount: 0`; dopo `trovati su Registro Imprese` aggiungere `, di cui <strong>{N}</strong> cessate` solo se `N > 0` (prima del punto finale).
- [ ] **Step 2:** guida: data aggiornata; nell'elenco di `errori` aggiungere "impresa cessata nel Registro Imprese (con stato, data e causale)"; una frase: la PEC di un'impresa cessata da meno di un anno resta in `domicilio_digitale`, decide l'operatore. Nessun titolo rinominato.
- [ ] **Step 3:** `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` → pulito; `cd apps/frontend-admin && node scripts/check-guida.mjs` → OK.
- [ ] **Step 4:** commit `feat(verifica-domicili): imprese cessate nel riepilogo e guida`.
