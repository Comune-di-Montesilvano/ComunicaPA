# Invio Manuale multi-riga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare "Invio Singolo" (form a 1 destinatario) in "Invio Manuale" (form a N destinatari ripetibili, canale fisso per lotto), riusando la pipeline CSV-virtuale già esistente per N=1.

**Architecture:** Frontend-only (`apps/frontend-admin/src/App.tsx`). Gli stati scalari `single*` (CF/nome/email/pec/indirizzo/pagoPA/allegati) restano il "form della riga in editing"; si aggiunge uno stato lista `wizManualRows` che accumula le righe confermate. Alla conferma finale, `handleWizManualSubmit` costruisce un CSV virtuale multi-riga (generalizzazione di `handleWizSingleSubmit`) e lo invia allo stesso endpoint `uploadCsv()` già usato da massivo e singolo — zero modifiche backend.

**Tech Stack:** React 19 + TypeScript (Vite), nessun test runner configurato per `frontend-admin` (`package.json: "test": "echo 'no tests'"`) — verifica per ogni task via `docker compose` + browser manuale, non TDD automatizzato (coerente con CLAUDE.md: "For UI or frontend changes, start dev server and test in browser").

**Spec:** `docs/superpowers/specs/2026-09-14-elenco-destinatari-da-form-design.md` (sezioni "Perimetro" e "Componenti" — questo piano copre SOLO Piano 1: canale fisso per lotto. Il campaign group multicanale è Piano 2, spec/piano separati).

## Global Constraints

- Canale fisso per l'intero lotto in questo piano (nessun campaign group, nessun `group_id`) — un solo `Campaign` creato per submit, come oggi.
- Limite 20 righe: blocco **soft** — oltre soglia, banner che indirizza al CSV, "Aggiungi destinatario" resta cliccabile.
- Dedup CF: bloccante, non soft — CF già presente nella lista impedisce "Aggiungi" con messaggio esplicito.
- Nessuna modifica backend: stesso endpoint `POST admin/campaigns/:id/recipients/upload` (chunked) già usato da `handleWizSingleSubmit`/`syncWizDraftAndRecipients`.
- Ogni file toccato è `apps/frontend-admin/src/App.tsx` — nessun nuovo file, coerente con la struttura esistente del wizard (già monolitico, non introdurre split non richiesto).

---

## Task 1: Rename nav + tipo `ManualRow` + stato lista

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:8488-8493` (nav item)
- Modify: `apps/frontend-admin/src/App.tsx:1884-1923` (blocco stati `single*`/wizard)

**Interfaces:**
- Produces: `type ManualRow`, stato `wizManualRows: ManualRow[]`, `setWizManualRows`, `wizManualEditingId: string | null`, `setWizManualEditingId` — usati da tutti i task successivi.

- [ ] **Step 1: Rinomina voce nav**

In `App.tsx:8493`, sostituisci il testo della voce nav:

```tsx
// PRIMA (riga 8493)
            <span>Invio Singolo</span>

// DOPO
            <span>Invio Manuale</span>
```

Nessun'altra label da cambiare in questo task: `view === 'invio-massivo-wizard' && wizSingleMode` resta il predicato di attivazione (`wizSingleMode` non viene rinominato — è uno state interno, la label utente è l'unica cosa che cambia).

- [ ] **Step 2: Aggiungi tipo `ManualRow` e stato lista**

Subito dopo la dichiarazione di `singleAppIoActive` (`App.tsx:1906`), aggiungi:

```tsx
interface ManualRow {
  id: string;
  cf: string;
  surname: string;
  firstName: string;
  email: string;
  pec: string;
  address: string;
  municipality: string;
  zip: string;
  province: string;
  country: string;
  paymentIuv: string;
  paymentImporto: string;
  paymentScadenza: string;
  // Snapshot del risultato Verifica Anagrafica al momento dell'Aggiungi,
  // per mostrare il badge dirottamento nella tabella senza dover rifare
  // la query quando si sfoglia la lista.
  inadForced: boolean;
  inadAddress: string;
  registroImpreseNoPec: boolean;
  appIoActive: boolean;
  // key = id dello slot in wizSingleAttachmentSlots, value = file diverso
  // dal default per questa riga (vedi Task 4).
  attachmentOverrides: Record<string, File>;
}
```

`interface ManualRow` va dichiarata a livello di modulo (fuori da qualunque componente), stesso punto dove sono dichiarate le altre `interface`/`type` di supporto del wizard in cima al file — cercare `interface` più vicina sopra la riga 1884 e aggiungerla subito dopo quel blocco, non dentro il componente (le `interface` non possono stare dentro una function component in questo file, verificare lo stile esistente con `grep -n "^interface\|^type " apps/frontend-admin/src/App.tsx` prima di scegliere il punto esatto).

Poi, nel blocco di stati (subito dopo `const [singleAppIoActive, setSingleAppIoActive] = useState(false);` alla riga 1906):

```tsx
const [wizManualRows, setWizManualRows] = useState<ManualRow[]>([]);
// null = form sta componendo una riga NUOVA; altrimenti id della riga in
// wizManualRows che si sta ri-editando (rimossa dalla lista finché non si
// preme di nuovo "Aggiungi destinatario", vedi Task 2).
const [wizManualEditingId, setWizManualEditingId] = useState<string | null>(null);
```

- [ ] **Step 3: Verifica manuale**

```bash
docker compose up -d --build frontend-admin
docker compose ps
```

Apri `http://localhost:3000`, login `admin`/`admin` (LDAP mock), sidebar → verifica che la voce mostri "Invio Manuale" e che cliccandola il wizard si apra come prima (nessun cambio funzionale ancora, solo label + stati non ancora usati).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: rinomina Invio Singolo in Invio Manuale, aggiunge tipo ManualRow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 2: Commit riga / dedup / edit-in-place

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuove funzioni, vicino a `handleWizSingleSubmit`, riga 6438)

**Interfaces:**
- Consumes: `ManualRow`, `wizManualRows`, `wizManualEditingId` (Task 1); `singleCf`/`singleSurname`/... e relativi setter (esistenti); `isValidCfOrPiva`, `isValidEmailFormat` (esistenti, righe 1081/1109).
- Produces: `buildManualRowFromForm(): ManualRow`, `isManualRowFormInvalid: boolean`, `commitCurrentManualRow(): boolean` (ritorna `false` se dedup blocca), `startEditManualRow(row: ManualRow): void`, `removeManualRow(id: string): void`, `clearManualRowForm(): void` — usati da Task 3/5/6/7.

- [ ] **Step 1: `buildManualRowFromForm` e `clearManualRowForm`**

Subito prima di `handleWizSingleSubmit` (riga 6438), aggiungi:

```tsx
const buildManualRowFromForm = (id: string): ManualRow => ({
  id,
  cf: singleCf.toUpperCase(),
  surname: singleSurname.trim(),
  firstName: singleFirstName.trim(),
  email: singleEmail,
  pec: singlePec,
  address: singleAddress,
  municipality: singleMunicipality,
  zip: singleZip,
  province: singleProvince,
  country: singleCountry,
  paymentIuv: singlePaymentIuv,
  paymentImporto: singlePaymentImporto,
  paymentScadenza: singlePaymentScadenza,
  inadForced: singleInadForced,
  inadAddress: singleInadAddress,
  registroImpreseNoPec: singleRegistroImpreseNoPec,
  appIoActive: singleAppIoActive,
  attachmentOverrides: {},
});

const clearManualRowForm = () => {
  setSingleCf('');
  setSingleSurname('');
  setSingleFirstName('');
  setSingleEmail('');
  setSinglePec('');
  setSingleAddress('');
  setSingleMunicipality('');
  setSingleZip('');
  setSingleProvince('');
  setSingleCountry('Italia');
  setSinglePaymentIuv('');
  setSinglePaymentImporto('');
  setSinglePaymentScadenza('');
  setSingleAnprCheckedCf(null);
  setSingleInadForced(false);
  setSingleInadAddress('');
  setSingleRegistroImpreseNoPec(false);
  setSingleAppIoActive(false);
  setWizManualEditingId(null);
};
```

- [ ] **Step 2: `isManualRowFormInvalid` (rinomina/generalizza `wizSingleSubmitDisabled`)**

`wizSingleSubmitDisabled` (righe 6512-6527) valuta già esattamente le regole di validità di UNA riga (CF, email/pec per canale, indirizzo fisico, allegati obbligatori per SEND/POSTAL, mailConfigId, ecc.) — non serve riscriverla, va solo rinominata perché ora si applica alla riga-in-editing, non più a un submit diretto. Rinomina `wizSingleSubmitDisabled` in `isManualRowFormInvalid` in tutto il file:

```bash
grep -rn "wizSingleSubmitDisabled" apps/frontend-admin/src/App.tsx
```

Sostituisci ogni occorrenza (dichiarazione riga 6512 + ogni uso nei `disabled={...}` dei bottoni, verrà ricollegata ai nuovi bottoni nel Task 7) da `wizSingleSubmitDisabled` a `isManualRowFormInvalid`. Nessun cambio alla logica interna della costante.

- [ ] **Step 3: dedup CF**

Subito dopo `isManualRowFormInvalid`, aggiungi:

```tsx
const isManualCfDuplicate = (cf: string, excludeId: string | null): boolean =>
  wizManualRows.some(r => r.id !== excludeId && r.cf === cf.toUpperCase());
```

- [ ] **Step 4: `commitCurrentManualRow`**

```tsx
const commitCurrentManualRow = (): boolean => {
  if (isManualRowFormInvalid) return false;
  const cf = singleCf.toUpperCase();
  if (isManualCfDuplicate(cf, wizManualEditingId)) {
    alert(`Codice Fiscale/P.IVA ${cf} già presente nella lista.`);
    return false;
  }
  const id = wizManualEditingId ?? `row-${Date.now()}-${wizManualRows.length}`;
  const row = buildManualRowFromForm(id);
  setWizManualRows(prev => {
    const withoutEditing = prev.filter(r => r.id !== wizManualEditingId);
    return [...withoutEditing, row];
  });
  clearManualRowForm();
  return true;
};
```

Nota: se si sta editando una riga esistente (`wizManualEditingId` non nullo), viene rimossa dalla posizione originale e riaggiunta in fondo alla lista — semplificazione deliberata (edit-in-place non preserva l'ordine originale), accettata in fase di brainstorming per evitare la complessità di uno splice posizionale.

- [ ] **Step 5: `startEditManualRow` e `removeManualRow`**

```tsx
const startEditManualRow = (row: ManualRow) => {
  setSingleCf(row.cf);
  setSingleSurname(row.surname);
  setSingleFirstName(row.firstName);
  setSingleEmail(row.email);
  setSinglePec(row.pec);
  setSingleAddress(row.address);
  setSingleMunicipality(row.municipality);
  setSingleZip(row.zip);
  setSingleProvince(row.province);
  setSingleCountry(row.country);
  setSinglePaymentIuv(row.paymentIuv);
  setSinglePaymentImporto(row.paymentImporto);
  setSinglePaymentScadenza(row.paymentScadenza);
  setSingleInadForced(row.inadForced);
  setSingleInadAddress(row.inadAddress);
  setSingleRegistroImpreseNoPec(row.registroImpreseNoPec);
  setSingleAppIoActive(row.appIoActive);
  setWizManualRows(prev => prev.filter(r => r.id !== row.id));
  setWizManualEditingId(row.id);
};

const removeManualRow = (id: string) => {
  setWizManualRows(prev => prev.filter(r => r.id !== id));
  if (wizManualEditingId === id) clearManualRowForm();
};
```

- [ ] **Step 6: Verifica manuale**

Queste funzioni non hanno ancora UI collegata (arriva nel Task 6/7) — verifica solo che il file compili:

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun nuovo errore rispetto alla baseline (le funzioni non sono ancora chiamate da nessuna parte, `tsc` non segnala funzioni inutilizzate come errore in questa config — se lo facesse, è atteso finché non arriva il Task 6/7).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: logica commit/dedup/edit-in-place per righe Invio Manuale

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 3: Nome campagna — auto-fill solo a 1 riga, manuale da 2 in su

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:9489,9524,9542` (i 3 punti nel form che fanno `setWizName` ad ogni keystroke)
- Modify: `apps/frontend-admin/src/App.tsx:6342,6376` (i 2 punti nel flusso ANPR/autofill che fanno `setWizName`)
- Modify: `apps/frontend-admin/src/App.tsx:9451-9465` circa (area titolo step, per mostrare il campo "Nome della Campagna" manuale quando serve)

**Interfaces:**
- Consumes: `wizManualRows.length` (Task 1).
- Produces: `manualNameIsAuto: boolean` (derivato, non stato) — usato anche dal Task 7 per il gate del bottone finale.

- [ ] **Step 1: Guardia sui 5 punti che fanno auto-fill**

I 5 `setWizName(...)` che oggi scrivono `Invio singolo a ${...}` ad ogni keystroke vanno tutti condizionati a "siamo ancora nel caso a 1 riga" — cioè `wizManualRows.length === 0` (nessuna riga ancora confermata: la riga in editing, se confermata, sarebbe la prima). Esempio per il punto più rappresentativo (`App.tsx:9485-9497`):

```tsx
// PRIMA
                          onChange={(e) => {
                            const v = e.target.value.toUpperCase();
                            setSingleCf(v);
                            const fullName = [singleSurname.trim(), singleFirstName.trim()].filter(Boolean).join(' ');
                            setWizName(fullName ? `Invio singolo a ${fullName}` : (v ? `Invio singolo a ${v}` : ''));

// DOPO
                          onChange={(e) => {
                            const v = e.target.value.toUpperCase();
                            setSingleCf(v);
                            if (wizManualRows.length === 0) {
                              const fullName = [singleSurname.trim(), singleFirstName.trim()].filter(Boolean).join(' ');
                              setWizName(fullName ? `Invio singolo a ${fullName}` : (v ? `Invio singolo a ${v}` : ''));
                            }
```

Applica lo stesso pattern (avvolgere la chiamata `setWizName(...)` esistente in `if (wizManualRows.length === 0) { ... }`, senza cambiare il testo generato) ai restanti 4 punti: righe 9524, 9542 (stesso file, stesso blocco form) e 6342, 6376 (flusso `runWizAnprCheck`/autofill ANPR — leggere il contesto locale di ciascuno prima di modificare, la struttura `if (...) setWizName(...)` è già un'espressione singola in quei due casi, basta avvolgerla allo stesso modo).

- [ ] **Step 2: Campo "Nome della Campagna" manuale quando N ≥ 2**

Nell'area titolo dello step 1 singolo (`App.tsx:9451-9465`), il nome campagna oggi non ha alcun campo visibile in modalità singola (si auto-scrive e basta, l'operatore lo vede/edita solo se torna allo step successivo). Da N=2 in su deve comportarsi come il campo del massivo (`App.tsx:10201-10211`, plain input, required). Aggiungi, subito sotto il blocco `<h4>`/`<p>` esistente (dopo la riga con `</p>` a 9457, prima del bottone "Avanti" a 9458):

```tsx
{wizManualRows.length >= 1 && (
  <div className="mb-3" style={{ maxWidth: '420px' }}>
    <label className="form-label small fw-bold">Nome della Campagna *</label>
    <input
      type="text"
      className="form-control form-control-sm"
      placeholder="Es: Ordinanza 123/2026 — lotto SEND"
      value={wizName}
      onChange={e => setWizName(e.target.value)}
      required
    />
    <div className="form-text small text-muted">
      Da quando aggiungi più di un destinatario, il nome campagna va scelto a mano (come per l'invio massivo).
    </div>
  </div>
)}
```

Condizione `wizManualRows.length >= 1` (non `>= 2`): il campo compare appena la PRIMA riga viene confermata con "Aggiungi destinatario" (quel momento segna il passaggio a "sto costruendo un lotto", anche se per ora contiene solo 1 riga + la riga in editing che diventerà la seconda) — coerente con la regola "l'auto-fill si disattiva definitivamente appena si aggiunge la seconda riga": mostrare il campo un istante prima (a 1 riga già confermata) evita che l'operatore veda il nome sparire/ricomparire nell'istante esatto del secondo "Aggiungi".

- [ ] **Step 3: Verifica manuale**

Nel browser (Invio Manuale): digita CF/cognome di un destinatario, verifica che il nome campagna si auto-scriva come oggi. Clicca "Aggiungi destinatario" (bottone arriva nel Task 7 — se non ancora presente in questo punto del piano, verificare invece chiamando `commitCurrentManualRow()` da devtools console per simulare, oppure posticipare questa verifica al Task 7). Dopo la prima riga aggiunta, verifica che compaia il campo "Nome della Campagna *" e che digitare CF/nome della riga successiva NON sovrascriva più il nome.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: nome campagna auto-fill solo a 1 destinatario, manuale da 2 in su

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 4: Allegato comune + override per riga

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:9937-9977` (rendering slot allegati)

**Interfaces:**
- Consumes: `wizSingleAttachmentSlots` (esistente, righe 1898-1900) — resta lo stato dei default/"Allegato comune" per l'intero lotto, invariato nel nome. `ManualRow.attachmentOverrides` (Task 1).
- Produces: `setManualRowOverride(rowId: string, slotId: string, file: File | null): void` — usata dalla tabella righe (Task 6).

- [ ] **Step 1: Etichetta "Allegato comune"**

Nel blocco allegati (`App.tsx:9922-9926`), aggiorna il titolo per chiarire che si applica a tutto il lotto quando ci sono più righe:

```tsx
// PRIMA (riga 9923)
                        <h5 className="h6 fw-bold text-secondary text-uppercase tracking-wider mb-2">
                          Allegati
                          {(wizChannel === 'SEND' || wizChannel === 'POSTAL') && <span className="text-danger"> *</span>}
                        </h5>

// DOPO
                        <h5 className="h6 fw-bold text-secondary text-uppercase tracking-wider mb-2">
                          {wizManualRows.length >= 1 ? 'Allegati (comune a tutte le righe)' : 'Allegati'}
                          {(wizChannel === 'SEND' || wizChannel === 'POSTAL') && <span className="text-danger"> *</span>}
                        </h5>
                        {wizManualRows.length >= 1 && (
                          <p className="small text-muted mb-2">
                            Questi file si applicano di default a ogni destinatario del lotto. Puoi caricare un file diverso per una singola riga già aggiunta dalla tabella sottostante (colonna "Allegato").
                          </p>
                        )}
```

Nessun altro cambio in questo blocco: `wizSingleAttachmentSlots`/`addWizSingleAttachmentSlot`/`updateWizSingleAttachmentSlot`/`removeWizSingleAttachmentSlot` restano invariati, sono già generici (un array di slot con label+file), riusati come default del lotto senza modifiche.

- [ ] **Step 2: Funzione override**

Vicino a `updateWizSingleAttachmentSlot` (`App.tsx:7490-7492`), aggiungi:

```tsx
const setManualRowOverride = (rowId: string, slotId: string, file: File | null) => {
  setWizManualRows(prev => prev.map(r => {
    if (r.id !== rowId) return r;
    const overrides = { ...r.attachmentOverrides };
    if (file) overrides[slotId] = file;
    else delete overrides[slotId];
    return { ...r, attachmentOverrides: overrides };
  }));
};
```

L'input file per l'override compare nella tabella righe (Task 6), non qui — questo task fornisce solo la funzione, il Task 6 la collega alla UI.

- [ ] **Step 3: Verifica manuale**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun nuovo errore (funzione non ancora chiamata da UI, verifica solo tipi).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: allegato comune per lotto + funzione override per riga

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 5: CSV virtuale multi-riga + submit (`handleWizManualSubmit`)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6438-6510` (sostituisce `handleWizSingleSubmit`)

**Interfaces:**
- Consumes: `wizManualRows`, `commitCurrentManualRow` (Task 2), `wizSingleAttachmentSlots` (default allegati), `ManualRow.attachmentOverrides` (Task 4), `syncWizDraftAndRecipients` (esistente, riga 7216), `ensureWizSingleAttachmentsUploaded`/`uploadAttachmentFilesCore` (esistenti, righe 7354/7462).
- Produces: `handleWizManualSubmit(targetStep: number): Promise<void>` — sostituisce ogni chiamata a `handleWizSingleSubmit` (righe 9427, 9460, 10170).

- [ ] **Step 1: Sostituisci `handleWizSingleSubmit` con `handleWizManualSubmit`**

Rimpiazza l'intera funzione (`App.tsx:6438-6510`) con:

```tsx
const handleWizManualSubmit = async (targetStep: number = 4) => {
  // Se il form corrente ha dati validi, committalo come ultima riga —
  // preserva l'esperienza "riempi una volta, clicca un bottone" per il
  // caso a 1 destinatario (nessun bisogno di premere "Aggiungi" a parte).
  if (singleCf.trim() && !isManualRowFormInvalid) {
    if (!commitCurrentManualRow()) return; // dedup bloccante, messaggio già mostrato
  } else if (singleCf.trim() && isManualRowFormInvalid) {
    alert('Completa correttamente i dati del destinatario corrente prima di procedere, oppure svuota il Codice Fiscale se vuoi inviare solo le righe già aggiunte.');
    return;
  }

  const rows = wizManualRows;
  if (rows.length === 0) {
    alert('Aggiungi almeno un destinatario prima di procedere.');
    return;
  }
  if (rows.length >= 2 && !wizName.trim()) {
    alert('Inserisci il nome della campagna prima di procedere.');
    return;
  }

  const cols: string[] = ['codice_fiscale', 'full_name', 'email', 'pec'];
  if (needsWizSinglePhysicalAddress) cols.push('sd_indirizzo', 'sd_comune', 'sd_cap', 'sd_provincia', 'sd_paese');
  if (wizPaymentEnabled) cols.push('sd_iuv', 'sd_importo', 'sd_scadenza');
  const defaultSlotsWithFile = wizSingleAttachmentSlots.filter(s => s.file);
  defaultSlotsWithFile.forEach((_s, i) => cols.push(`sd_allegato_${i + 1}`));

  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  // Nome file per (riga, slot): override della riga se presente, altrimenti
  // il default comune dello slot — stesso filename riusato su più righe è
  // già supportato dalla risoluzione allegato esistente lato backend (vedi
  // "Decisioni tecniche" nella spec).
  const filesToUpload = new Map<string, File>();
  defaultSlotsWithFile.forEach(s => filesToUpload.set(s.file!.name, s.file!));

  rows.forEach(row => {
    const fullName = [row.surname, row.firstName].filter(Boolean).join(' ');
    const vals: string[] = [row.cf, fullName, row.email, row.pec];
    if (needsWizSinglePhysicalAddress) vals.push(row.address, row.municipality, row.zip, row.province, row.country);
    if (wizPaymentEnabled) vals.push(row.paymentIuv, row.paymentImporto, row.paymentScadenza);
    defaultSlotsWithFile.forEach((s, i) => {
      const override = row.attachmentOverrides[s.id];
      const file = override || s.file!;
      if (override) filesToUpload.set(override.name, override);
      vals.push(file.name);
    });
    lines.push(vals.map(esc).join(','));
  });

  const csvContent = lines.join('\n');
  const file = new File([csvContent], 'destinatari.csv', { type: 'text/csv' });
  setWizCsvFile(file);
  await parseCsvFile(file, true);

  if (needsWizSinglePhysicalAddress) {
    setWizPostalAddressColumn('sd_indirizzo');
    setWizPostalMunicipalityColumn('sd_comune');
    setWizPostalZipColumn('sd_cap');
    setWizPostalProvinceColumn('sd_provincia');
    setWizPostalCountryColumn('sd_paese');
  }
  if (wizPaymentEnabled) {
    setWizPaymentNoticeCol('sd_iuv');
    setWizPaymentAmountCol('sd_importo');
    setWizPaymentAmountType('euro');
    setWizPaymentDueDateCol('sd_scadenza');
  }
  const newWizAttachments = defaultSlotsWithFile.map((s, i) => ({ key: `sd_allegato_${i + 1}`, label: s.label || `Allegato ${i + 1}` }));
  setWizAttachments(newWizAttachments);
  const uploadFiles = Array.from(filesToUpload.values());
  setWizPdfFiles(uploadFiles);

  const recipientsCsvBlobOverride = new Blob([csvContent], { type: 'text/csv' });
  const campaignId = await syncWizDraftAndRecipients(targetStep, newWizAttachments, recipientsCsvBlobOverride);
  if (!campaignId) return;

  try {
    if (!(await ensureWizSingleAttachmentsUploaded(campaignId, uploadFiles))) return;
  } catch (err: any) {
    alert(err.message || 'Errore durante il caricamento degli allegati.');
    return;
  }

  setWizStep(targetStep);
};
```

Differenze principali rispetto all'originale: loop su `rows` invece di un singolo destinatario; `filesToUpload` è una `Map` chiave-filename per deduplicare — se due righe condividono lo stesso file di default, viene caricato una volta sola (coerente con "Decisioni tecniche" della spec: stesso filename referenziato da più righe è già supportato lato risoluzione allegato).

- [ ] **Step 2: Aggiorna i 3 call site**

```bash
grep -n "handleWizSingleSubmit" apps/frontend-admin/src/App.tsx
```

Sostituisci `handleWizSingleSubmit` con `handleWizManualSubmit` alle righe 9427, 9460, 10170 (stessa firma, stessi argomenti — nessun altro cambio in quei punti, sono solo il nome della funzione chiamata).

- [ ] **Step 3: Verifica manuale end-to-end**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose restart frontend-admin
```

Nel browser: Invio Manuale, canale EMAIL, compila un destinatario, clicca "Avanti" (bottone esistente, non ancora rinominato — arriva Task 7) senza mai premere "Aggiungi": verifica che il comportamento sia IDENTICO a oggi (crea campagna, 1 destinatario, procede allo step Template). Poi via devtools console, verifica che `wizManualRows` sia popolato correttamente dopo il submit (dovrebbe essere vuoto di nuovo se il flusso resetta, o contenere la riga — verificare che non ci siano doppioni).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: generalizza handleWizSingleSubmit a N righe (handleWizManualSubmit)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 6: Tabella righe accumulate + banner limite 20

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:9451-9465` (area titolo step, sopra le sezioni Dati Destinatario/Allegati)

**Interfaces:**
- Consumes: `wizManualRows`, `startEditManualRow`, `removeManualRow` (Task 2), `setManualRowOverride` (Task 4), `wizSingleAttachmentSlots`.

- [ ] **Step 1: Banner limite 20**

Subito dopo il blocco titolo esistente (dopo la riga con `</div>` che chiude `d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom`, circa riga 9465), aggiungi:

```tsx
{wizManualRows.length >= 20 && (
  <div className="alert alert-warning d-flex align-items-start gap-2 mb-3">
    <AlertCircle size={16} className="mt-1 flex-shrink-0" />
    <div>
      Hai già {wizManualRows.length} destinatari in lista. Per lotti di queste dimensioni conviene il caricamento da CSV (più veloce da correggere/riverificare) — puoi comunque continuare ad aggiungere righe da qui se preferisci.
    </div>
  </div>
)}
```

- [ ] **Step 2: Tabella righe**

Subito dopo il banner (o al posto suo se sotto 20 righe), aggiungi:

```tsx
{wizManualRows.length > 0 && (
  <div className="card shadow-sm border-0 rounded-3 p-3 mb-3 bg-white">
    <h5 className="h6 fw-bold text-secondary text-uppercase tracking-wider mb-2">
      Destinatari aggiunti ({wizManualRows.length})
    </h5>
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th>CF/P.IVA</th>
            <th>Nominativo</th>
            <th>Canale effettivo</th>
            <th>Allegato</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {wizManualRows.map(row => (
            <tr key={row.id}>
              <td className="font-monospace small">{row.cf}</td>
              <td>{[row.surname, row.firstName].filter(Boolean).join(' ')}</td>
              <td>
                {row.inadForced ? (
                  <span className="badge bg-info-subtle text-info-emphasis">Dirottato su PEC (INAD)</span>
                ) : (
                  <span className="text-muted small">{wizChannel}</span>
                )}
              </td>
              <td>
                {wizSingleAttachmentSlots.length === 0 ? (
                  <span className="text-muted small">—</span>
                ) : (
                  wizSingleAttachmentSlots.map(slot => (
                    <div key={slot.id} className="d-flex align-items-center gap-1 mb-1">
                      <span className="small text-muted" style={{ minWidth: '90px' }}>{slot.label}:</span>
                      {row.attachmentOverrides[slot.id] ? (
                        <span className="small text-success">{row.attachmentOverrides[slot.id].name}</span>
                      ) : (
                        <span className="small text-muted">comune</span>
                      )}
                      <input
                        type="file"
                        accept=".pdf"
                        className="form-control form-control-sm"
                        style={{ maxWidth: '160px' }}
                        onChange={(e) => setManualRowOverride(row.id, slot.id, e.target.files?.[0] || null)}
                      />
                    </div>
                  ))
                )}
              </td>
              <td className="text-end">
                <button type="button" className="btn btn-sm btn-outline-secondary me-1" onClick={() => startEditManualRow(row)}>
                  <Pencil size={14} />
                </button>
                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeManualRow(row.id)}>
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
)}
```

Se `Pencil` non è già importato da `lucide-react` in cima al file (verificare con `grep -n "^import.*lucide-react" apps/frontend-admin/src/App.tsx`), aggiungilo all'elenco degli import esistenti.

- [ ] **Step 3: Verifica manuale**

Nel browser: aggiungi 2-3 destinatari (una volta collegato il bottone "Aggiungi" nel Task 7 — se questo task viene eseguito prima, verificare temporaneamente chiamando `commitCurrentManualRow()` da devtools console dopo aver compilato il form). Verifica che la tabella mostri le righe, che il bottone matita ricarichi i dati nel form (e la riga sparisca dalla tabella), che il cestino la rimuova, che il file override per uno slot compaia come "override" invece di "comune".

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: tabella destinatari accumulati + banner limite 20 righe

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 7: Bottoni "Aggiungi destinatario" / "Conferma e Invia" + gate

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:9458-9464` (bottone titolo step)
- Modify: `apps/frontend-admin/src/App.tsx:10170` circa (bottone in fondo allo step — stesso pattern duplicato "Avanti"/"Indietro" documentato in CLAUDE.md, verificare entrambe le copie)

**Interfaces:**
- Consumes: `commitCurrentManualRow`, `isManualRowFormInvalid` (Task 2), `handleWizManualSubmit` (Task 5), `wizManualRows`.

- [ ] **Step 1: Sostituisci il bottone titolo (App.tsx:9458-9464)**

```tsx
// PRIMA
                    <button
                      className="btn btn-primary px-4 fw-medium d-flex align-items-center gap-2"
                      onClick={() => handleWizSingleSubmit(wizSingleNeedsTemplateStep ? 4 : 6)}
                      disabled={wizSingleSubmitDisabled}
                    >
                      Avanti <ArrowRight size={16} />
                    </button>

// DOPO
                    <div className="d-flex align-items-center gap-2">
                      <button
                        className="btn btn-outline-primary px-3 fw-medium d-flex align-items-center gap-2"
                        onClick={() => commitCurrentManualRow()}
                        disabled={!singleCf.trim() || isManualRowFormInvalid}
                        title={isManualRowFormInvalid ? 'Completa correttamente i dati del destinatario' : undefined}
                      >
                        <Plus size={16} /> Aggiungi destinatario
                      </button>
                      <button
                        className="btn btn-primary px-4 fw-medium d-flex align-items-center gap-2"
                        onClick={() => handleWizManualSubmit(wizSingleNeedsTemplateStep ? 4 : 6)}
                        disabled={
                          (wizManualRows.length === 0 && (!singleCf.trim() || isManualRowFormInvalid)) ||
                          (wizManualRows.length >= 1 && !wizName.trim())
                        }
                      >
                        Conferma e Invia <ArrowRight size={16} />
                      </button>
                    </div>
```

`Plus` va importato da `lucide-react` se non già presente (`grep -n "^import.*lucide-react" apps/frontend-admin/src/App.tsx` — se manca, aggiungilo all'elenco).

- [ ] **Step 2: Sostituisci il bottone duplicato in fondo (App.tsx:10170 circa)**

```bash
grep -n "handleWizManualSubmit(wizSingleNeedsTemplateStep ? 4 : 6)" apps/frontend-admin/src/App.tsx
```

Applica la stessa sostituzione (bottone singolo "Avanti" → coppia "Aggiungi destinatario"/"Conferma e Invia" con lo stesso markup e le stesse condizioni `disabled` dello Step 1) alla seconda occorrenza — CLAUDE.md documenta esplicitamente che questi bottoni duplicati (uno in cima, uno in fondo allo step) sono due blocchi JSX separati da tenere sincronizzati a mano, causa di bug reali quando aggiornati solo in un punto.

- [ ] **Step 3: Verifica manuale completa (flusso multi-riga)**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose restart frontend-admin
```

Nel browser, canale EMAIL:
1. Compila destinatario 1, clicca "Aggiungi destinatario" — verifica che il form si svuoti, la tabella (Task 6) mostri 1 riga, il nome campagna resti auto-compilato.
2. Compila destinatario 2 (CF diverso) — verifica che digitare NON sovrascriva più il nome campagna, che compaia il campo manuale (Task 3), riempilo.
3. Prova ad aggiungere lo stesso CF del destinatario 1 — verifica l'alert di duplicato e che "Aggiungi" non lo inserisca.
4. Clicca "Conferma e Invia" col destinatario 2 ancora nel form (non ancora aggiunto) — verifica che venga auto-committato come riga 2 prima del submit (nessuna riga persa).
5. Procedi fino al lancio reale (test send) e verifica in `docker compose logs -f backend` che la campagna riceva 2 destinatari.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: bottoni Aggiungi destinatario / Conferma e Invia per Invio Manuale

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 8: Reset wizard + ripristino bozza (resume) multi-riga

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6838-6858` (`resetWizard`)
- Modify: `apps/frontend-admin/src/App.tsx:6975-7022` (`prefillWizardFrom`, blocco `wizSingleMode`)

**Interfaces:**
- Consumes: `wizManualRows`, `setWizManualRows`, `setWizManualEditingId` (Task 1).

- [ ] **Step 1: `resetWizard` azzera la lista**

Nel blocco commentato "Stato destinatario invio singolo" (`App.tsx:6838-6858`), aggiungi dopo `setSingleAppIoActive(false);`:

```tsx
setWizManualRows([]);
setWizManualEditingId(null);
```

- [ ] **Step 2: `prefillWizardFrom` ricostruisce TUTTE le righe, non solo `lines[1]`**

Il blocco esistente (`App.tsx:6975-7022`) ricostruisce oggi solo `lines[1]` (assunzione hardcoded "una sola riga dati") dentro `single*`. Con N righe, resuming un draft deve popolare `wizManualRows` con tutte le righe tranne l'ultima (che resta come form "in editing", pronto per essere completato/aggiunto), oppure — più semplice e senza ambiguità — TUTTE le righe finiscono in `wizManualRows` e il form resta vuoto pronto per la riga successiva. Scelta presa: tutte le righe in `wizManualRows`, form vuoto.

Sostituisci il blocco `if (source.channelConfig?.wizSingleMode) { ... }` (righe 6975-7022) con:

```tsx
if (source.channelConfig?.wizSingleMode) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length >= 2) {
    const parseLine = (line: string) => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else current += ch;
      }
      result.push(current);
      return result.map(v => v.replace(/^"(.*)"$/, '$1').replace(/""/g, '"'));
    };
    const headerCols = parseLine(lines[0]);
    const attachmentEntries = (source.channelConfig?.attachments || []) as Array<{ key: string; label: string }>;
    const restoredRows: ManualRow[] = lines.slice(1).map((line, idx) => {
      const rowVals = parseLine(line);
      const row: Record<string, string> = {};
      headerCols.forEach((h, i) => { row[h] = rowVals[i] || ''; });
      return {
        id: `row-resume-${idx}`,
        cf: row['codice_fiscale'] || '',
        // full_name è la sola colonna disponibile (handleWizManualSubmit unisce
        // cognome+nome con un solo spazio, nessuna colonna separata) — non è
        // possibile invertire lo split in modo affidabile. Ripristino
        // conservativo: l'intero valore va in surname, firstName resta vuoto.
        surname: row['full_name'] || '',
        firstName: '',
        email: row['email'] || '',
        pec: row['pec'] || '',
        address: row['sd_indirizzo'] || '',
        municipality: row['sd_comune'] || '',
        zip: row['sd_cap'] || '',
        province: row['sd_provincia'] || '',
        country: row['sd_paese'] || 'Italia',
        paymentIuv: row['sd_iuv'] || '',
        paymentImporto: row['sd_importo'] || '',
        paymentScadenza: row['sd_scadenza'] || '',
        inadForced: false,
        inadAddress: '',
        registroImpreseNoPec: false,
        appIoActive: false,
        // File non ricostruibili da un percorso server (limite già esistente
        // per il caso singolo pre-refactor): l'operatore ri-carica solo se
        // vuole SOSTITUIRE l'allegato già presente sul server per questa
        // campagna, altrimenti resta quello già caricato in precedenza.
        attachmentOverrides: {},
      };
    });
    setWizManualRows(restoredRows);
    setWizManualEditingId(null);
    setSingleCf('');
    setSingleSurname('');
    setSingleFirstName('');
    setSingleEmail('');
    setSinglePec('');
    setSingleAddress('');
    setSingleMunicipality('');
    setSingleZip('');
    setSingleProvince('');
    setSingleCountry('Italia');
    setSinglePaymentIuv('');
    setSinglePaymentImporto('');
    setSinglePaymentScadenza('');
    setWizSingleAttachmentSlots(
      attachmentEntries.map((a, i) => ({ id: `slot-resume-${i}`, label: a.label || `Allegato ${i + 1}`, file: null })),
    );
  }
}
```

- [ ] **Step 3: Verifica manuale**

Nel browser: crea un Invio Manuale con 2 destinatari, salva bozza (senza lanciare), torna alla dashboard, riprendi la bozza dall'elenco campagne. Verifica che la tabella righe mostri 2 destinatari con i dati corretti, form vuoto pronto per un terzo.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
fix: resetWizard/prefillWizardFrom ricostruiscono tutte le righe manuali

resetWizard azzerava solo gli stati single* scalari, non la nuova lista
wizManualRows — una bozza abbandonata a metà lasciava trapelare righe
sulla campagna successiva. prefillWizardFrom ricostruiva solo lines[1]
(assunzione a 1 riga pre-refactor) — riprendere una bozza multi-riga
mostrava solo il primo destinatario, gli altri sparivano dalla UI pur
restando salvati sul server.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 9: QA manuale end-to-end + tsc/lint finali

**Files:** nessuna modifica, solo verifica.

- [ ] **Step 1: Type-check completo**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: 0 errori.

- [ ] **Step 2: Lint**

```bash
docker compose exec frontend-admin node_modules/.bin/eslint src/App.tsx
```

(verificare il comando esatto in `apps/frontend-admin/package.json` script `lint` se diverso — usare quello, es. `pnpm lint` se il container lo espone senza il gotcha `pnpm --filter` per un singolo file di questa dimensione va bene invocare eslint diretto sul binario).

Expected: 0 errori (warning preesistenti, se presenti in baseline, non bloccanti — confrontare con lo stato pre-piano).

- [ ] **Step 3: Checklist manuale browser (canali diversi)**

Per ciascun canale EMAIL, PEC, APP_IO, SEND, POSTAL: apri Invio Manuale, aggiungi 3 destinatari (CF diversi), verifica:
- Dedup CF blocca un quarto destinatario con CF ripetuto.
- Edit-in-place (matita) ricarica correttamente i campi e la riga sparisce dalla tabella finché non si preme di nuovo "Aggiungi".
- Rimozione riga funziona.
- Per SEND/POSTAL: allegato obbligatorio bloccante come oggi (gate esistente, non toccato da questo piano).
- Anteprima allo step Template/Anteprima scorre correttamente tra i 3 destinatari (bottoni prev/next del pannello condiviso, `App.tsx:579-630` — nessuna modifica di questo piano, verifica che funzioni già "gratis" con N righe reali).
- Lancio test (se disponibile per il canale) e lancio reale completano senza errori nei log backend (`docker compose logs -f backend`).

- [ ] **Step 4: Verifica limite 20 righe**

Aggiungi 21 destinatari (o forza `wizManualRows` a 20 elementi via devtools per velocità), verifica che compaia il banner e che "Aggiungi destinatario" resti comunque cliccabile (soft, non hard block).

- [ ] **Step 5: Nessun commit in questo task** (solo verifica) — se emergono bug durante la QA, aprire un task correttivo ad-hoc seguendo lo stesso ciclo TDD/commit degli altri task, non accumulare fix non committati.
