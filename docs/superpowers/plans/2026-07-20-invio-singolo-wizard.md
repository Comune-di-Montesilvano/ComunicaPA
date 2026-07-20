# Invio Singolo su Wizard Riusato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire il form standalone "Invio Singolo" (`App.tsx:5530-5673`,
nessun allegato/validazione App IO, SEND/POSTAL inutilizzabili) con il
wizard campagne esistente (`view === 'invio-massivo-wizard'`) in una
modalità `wizSingleMode`, dove step 2+3 (upload CSV + mappatura) sono
sostituiti da un form diretto destinatario; step 1, 4, 5, 6, 7 restano
identici e già channel-agnostic.

**Architecture:** Un solo file toccato, `apps/frontend-admin/src/App.tsx`
(monolite esistente, pattern già in uso nel repo — non introdurre nuovi
file/componenti). Nuovo state booleano `wizSingleMode`; step2 in JSX
diventa condizionale su questo flag; nessun nuovo endpoint backend, nessuna
nuova dipendenza.

**Tech Stack:** React 19 + Vite 6 (nessun framework di test frontend nel
repo — verifica tramite `tsc --noEmit` + walkthrough manuale in browser,
stesso pattern usato per ogni altra modifica frontend in questo repo,
vedi CLAUDE.md sezione Test).

## Global Constraints

- Nessun form/importer di creazione campagne alternativo al di fuori del
  wizard (CLAUDE.md, "Creazione campagne — un solo percorso").
- Ogni bottone che avanza lo step deve chiamare
  `syncWizDraftAndRecipients(targetStep)` con `targetStep` esplicito, mai
  dedotto da `wizStep` corrente (CLAUDE.md, gotcha wizard sync).
- Ogni nuovo stato `wiz*` legato a `channelConfig` va azzerato in
  `resetWizard()` e ripristinato in `prefillWizardFrom()` (CLAUDE.md,
  "terzo punto di sync... lifecycle del wizard stesso").
- Type-check frontend-admin: `docker compose exec frontend-admin
  node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (NON `tsc -b`).
- Dev locale: `LDAP_HOST=mock` abilita login `admin/admin` senza AD reale.

---

### Task 1: State `wizSingleMode` — dichiarazione, reset, prefill, persistenza

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1038` (blocco dichiarazioni
  Wizard States, subito dopo `wizStep`)
- Modify: `apps/frontend-admin/src/App.tsx:4177-4235` (`resetWizard`)
- Modify: `apps/frontend-admin/src/App.tsx:4237-4347` (`prefillWizardFrom`)
- Modify: `apps/frontend-admin/src/App.tsx:4389-4451`
  (`buildWizChannelConfigDraft`)

**Interfaces:**
- Produces: state `wizSingleMode: boolean` + setter `setWizSingleMode`,
  letto da Task 2 e Task 3 per condizionare nav/JSX. Persistito nel
  `channelConfig` salvato come `channelConfig.wizSingleMode: boolean`
  (stesso contenitore dove oggi vive `wizStep`, vedi
  `buildWizChannelConfigDraft` riga 4395).

- [ ] **Step 1: Aggiungi lo state**

In `App.tsx`, subito dopo la riga `const [wizStep, setWizStep] =
useState(1);` (riga 1039), aggiungi:

```typescript
  const [wizSingleMode, setWizSingleMode] = useState(false);
```

- [ ] **Step 2: Azzera in `resetWizard()`**

In `resetWizard()` (riga 4177), subito dopo `setWizStep(1);` (riga 4179),
aggiungi:

```typescript
    setWizSingleMode(false);
```

- [ ] **Step 3: Ripristina in `prefillWizardFrom()`**

In `prefillWizardFrom()` (riga 4237), subito dopo `setWizCampaignId(...)`
(riga 4243), aggiungi:

```typescript
    setWizSingleMode(opts.isDuplicate ? false : Boolean(source.channelConfig?.wizSingleMode));
```

Nota: come per gli allegati (commento esistente riga 4290-4292), una
bozza duplicata NON eredita `wizSingleMode` — riparte come campagna
normale, coerente con `wizCampaignId` che viene azzerato per le
duplicazioni.

- [ ] **Step 4: Persisti in `buildWizChannelConfigDraft()`**

In `buildWizChannelConfigDraft()` (riga 4389), nel blocco `cfg` iniziale
(righe 4390-4397), aggiungi il campo dopo `wizRowCount`:

```typescript
      wizRowCount: wizValidRows.length,
      wizSingleMode,
```

- [ ] **Step 5: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore rispetto al baseline pre-esistente (se il
comando falliva già prima per errori @types/node noti, verificare che il
set di errori sia invariato — non introdurne di nuovi).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): stato wizSingleMode nel wizard campagne"
```

---

### Task 2: Entry point nav + rimozione form standalone "Invio Singolo"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:763` (union type `view`)
- Modify: `apps/frontend-admin/src/App.tsx:5273-5280` (voce nav "Invio Singolo")
- Modify: `apps/frontend-admin/src/App.tsx:5281-5288` (voce nav "Invio Massivo", condizione is-active)
- Modify: `apps/frontend-admin/src/App.tsx:5382-5385` (titolo header pagina)
- Modify: `apps/frontend-admin/src/App.tsx:5530-5673` (rimuovi blocco JSX `view === 'invio-singolo'`)
- Modify: `apps/frontend-admin/src/App.tsx:1026-1036` (rimuovi state form vecchio, tranne i 4 riusati)
- Modify: `apps/frontend-admin/src/App.tsx:2194-2240+` (rimuovi `handleSingleSendSubmit`)

**Interfaces:**
- Consumes: `wizSingleMode`/`setWizSingleMode` da Task 1, `resetWizard()`
  esistente.
- Produces: nessuna nuova interfaccia — punto di ingresso nav che porta a
  `view === 'invio-massivo-wizard'` con `wizSingleMode === true`, che Task
  3 consuma per renderizzare lo step 2 fuso.

- [ ] **Step 1: Rimuovi `'invio-singolo'` dal tipo `view`**

Riga 763, rimuovi `'invio-singolo' | ` dall'union type:

```typescript
  const [view, setView] = useState<'dashboard' | 'invio-massivo' | 'invio-massivo-wizard' | 'statistiche' | 'notifiche-ricerca' | 'verifica-appio' | 'template-dashboard' | 'impostazioni' | 'campaign-detail' | 'audit-logs' | 'arricchimento'>('dashboard');
```

- [ ] **Step 2: Aggiorna la voce nav "Invio Singolo"**

Righe 5273-5280, sostituisci l'intero blocco `<a>` con:

```tsx
          <a
            className={`bo-nav-item ${view === 'invio-massivo-wizard' && wizSingleMode ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); resetWizard(); setWizSingleMode(true); setView('invio-massivo-wizard'); }}
          >
            <i className="fas fa-paper-plane"></i>
            <span>Invio Singolo</span>
          </a>
```

- [ ] **Step 3: Escludi `wizSingleMode` dall'evidenziazione "Invio Massivo"**

Riga 5282, la condizione is-active deve escludere il caso wizard-in-modalità-singola:

```tsx
            className={`bo-nav-item ${(view === 'invio-massivo' || view === 'campaign-detail' || (view === 'invio-massivo-wizard' && !wizSingleMode)) ? 'is-active' : ''}`}
```

- [ ] **Step 4: Titolo header pagina**

Rimuovi riga 5383 (`{view === 'invio-singolo' && 'Nuova Notifica Singola'}`).
Sostituisci riga 5385 (`{view === 'invio-massivo-wizard' && 'Wizard Nuova Campagna Massiva'}`) con:

```tsx
          {view === 'invio-massivo-wizard' && (wizSingleMode ? 'Wizard Invio Singolo' : 'Wizard Nuova Campagna Massiva')}
```

- [ ] **Step 5: Rimuovi il blocco JSX del form standalone**

Elimina interamente il blocco `{view === 'invio-singolo' && ( ... )}`
(righe 5530-5673 nel file pre-modifica — la riga esatta si sposta dopo
gli step precedenti, individuare col marcatore `{/* VIEW: INVIO MASSIVO */}`
che segue subito dopo e tagliare tutto ciò che sta sopra fino al blocco
`view === 'invio-singolo'` incluso).

- [ ] **Step 6: Rimuovi state del form vecchio non più referenziato**

Righe 1026-1036: elimina `singleSubject`, `singleBody`, `singleChannel`,
`singleAppIoServiceId`, `singleSending`, `singleSuccess` (il wizard usa
`wizSubject`/`wizBody`/`wizChannel`/`wizAppIoServiceId` propri). Mantieni
SOLO `singleCf`, `singleName`, `singleEmail`, `singlePec` — riusati come
state del form destinatario nello step fuso (Task 3):

```typescript
  // Form destinatario per invio singolo (step 2 fuso del wizard, wizSingleMode)
  const [singleCf, setSingleCf] = useState('');
  const [singleName, setSingleName] = useState('');
  const [singleEmail, setSingleEmail] = useState('');
  const [singlePec, setSinglePec] = useState('');
```

- [ ] **Step 7: Rimuovi `handleSingleSendSubmit`**

Elimina l'intera funzione `handleSingleSendSubmit` (a partire da riga
2194 nel file pre-modifica, fino alla sua chiusura — cercare il blocco
che costruisce `csvContent` a riga 2240 e proseguire fino alla `}` di
chiusura della funzione).

- [ ] **Step 8: Grep di conferma nessun riferimento residuo**

Run: `grep -n "invio-singolo\|singleSubject\|singleBody\|singleChannel\|singleAppIoServiceId\|singleSending\|singleSuccess\|handleSingleSendSubmit" apps/frontend-admin/src/App.tsx`
Expected: nessun match.

- [ ] **Step 9: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore rispetto al baseline.

- [ ] **Step 10: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): entry point Invio Singolo apre wizard, rimosso form standalone"
```

---

### Task 3: Step 2 fuso — form destinatario diretto in `wizSingleMode`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:5828-5890` (Steps Progress
  Header — array label)
- Modify: `apps/frontend-admin/src/App.tsx:6217-6312` (blocco
  `wizStep === 2`)

**Interfaces:**
- Consumes: `wizSingleMode` (Task 1), `singleCf`/`singleName`/
  `singleEmail`/`singlePec` (Task 2 Step 6), `isValidCfOrPiva()`
  (`App.tsx:623`, invariata), `parseCsvFile()` (`App.tsx:3859`,
  invariata — genera `wizCsvHeaders`/`wizCsvRows`/`wizMapping` da un
  `File` sintetico), `syncWizDraftAndRecipients()` (`App.tsx:4480`,
  invariata).
- Produces: nessuna nuova funzione esportata — solo JSX condizionale
  interno allo step 2.

**Nota tecnica sul flusso a due click (evita stale closure):**
`syncWizDraftAndRecipients()` legge `wizCsvRows`/`wizMapping` dalla
closure del render in cui è stato creato il suo handler. Generare il CSV
sintetico e chiamare `syncWizDraftAndRecipients()` nella STESSA closure
produrrebbe uno stato letto stantio (i `setState` di `parseCsvFile` non
sono ancora committati quando il codice successivo nella stessa funzione
gira). Per questo il flusso resta a due interazioni separate, esattamente
come il percorso CSV esistente: (1) bottone "Genera destinatario" popola
`wizCsvFile`/`wizCsvRows`/`wizMapping` e ritorna, causando un re-render;
(2) bottone "Avanti" — ricreato fresco in quel nuovo render, quindi con
closure aggiornata — chiama `syncWizDraftAndRecipients(4)`.

- [ ] **Step 1: Header step — label fusa e skip step 3 in `wizSingleMode`**

Righe 5830-5837, sostituisci l'array statico con uno calcolato:

```tsx
                {(wizSingleMode
                  ? [
                      { n: 1, label: '1. Dettagli & Canale' },
                      { n: 2, label: '2. Destinatario' },
                      { n: 4, label: '3. Template & Anteprima' },
                      { n: 5, label: '4. Upload Allegati' },
                      { n: 6, label: '5. Anteprima e Invio' },
                    ]
                  : [
                      { n: 1, label: '1. Dettagli & Canale' },
                      { n: 2, label: '2. Caricamento File' },
                      { n: 3, label: '3. Mappatura & Validazione' },
                      { n: 4, label: '4. Template & Anteprima' },
                      { n: 5, label: '5. Upload Allegati' },
                      { n: 6, label: '6. Anteprima e Invio' },
                    ]
                ).map(({ n, label }) => {
```

Il resto della funzione `.map` (righe 5838-5889) resta invariato — usa
già `n` genericamente, non assume che gli `n` siano consecutivi.

- [ ] **Step 2: Sostituisci il corpo di `wizStep === 2` con ramo condizionale**

Righe 6217-6312: avvolgi il contenuto esistente (CSV upload) in un ramo
`!wizSingleMode`, aggiungi un ramo `wizSingleMode` con form diretto:

```tsx
              {/* STEP 2: CARICAMENTO FILE (o DESTINATARIO in wizSingleMode) */}
              {wizStep === 2 && wizSingleMode && (
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3">Passo 2: Dati Destinatario</h4>

                  <div className="mb-4 pb-3 border-bottom d-flex justify-content-between">
                    <button className="btn btn-outline-secondary" onClick={() => setWizStep(1)}>
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        if (await syncWizDraftAndRecipients(4)) {
                          setWizStep(4);
                        }
                      }}
                      disabled={!wizCsvFile}
                    >
                      Avanti <i className="fas fa-arrow-right ms-1"></i>
                    </button>
                  </div>

                  {wizCsvFile ? (
                    <div className="p-4 border rounded bg-light text-center mb-4">
                      <div className="badge bg-success p-2 mb-2">
                        <i className="fas fa-check-circle me-1"></i> Destinatario pronto: {singleCf.toUpperCase()}
                      </div>
                      <div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary px-2"
                          onClick={() => {
                            setWizCsvFile(null);
                            setWizCsvHeaders([]);
                            setWizCsvRows([]);
                            setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', subject: '' });
                          }}
                        >
                          <i className="fas fa-pen me-1"></i> Modifica dati
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="row g-3 mb-4">
                      <div className="col-md-6">
                        <label className="form-label small fw-bold text-dark" htmlFor="s_cf">Codice Fiscale/P.IVA Destinatario <span className="text-danger">*</span></label>
                        <input
                          type="text"
                          id="s_cf"
                          className="form-control form-control-sm"
                          placeholder="16 caratteri alfanumerici o 11 cifre"
                          maxLength={16}
                          value={singleCf}
                          onChange={(e) => setSingleCf(e.target.value.toUpperCase())}
                        />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted" htmlFor="s_name">Nome Completo</label>
                        <input
                          type="text"
                          id="s_name"
                          className="form-control form-control-sm"
                          placeholder="Es: Mario Rossi"
                          value={singleName}
                          onChange={(e) => setSingleName(e.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted" htmlFor="s_email">Indirizzo Email</label>
                        <input
                          type="email"
                          id="s_email"
                          className="form-control form-control-sm"
                          placeholder="mario.rossi@example.com"
                          value={singleEmail}
                          onChange={(e) => setSingleEmail(e.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted" htmlFor="s_pec">Indirizzo PEC</label>
                        <input
                          type="email"
                          id="s_pec"
                          className="form-control form-control-sm"
                          placeholder="mario.rossi@pec.it"
                          value={singlePec}
                          onChange={(e) => setSinglePec(e.target.value)}
                        />
                      </div>
                      <div className="col-12">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!singleCf}
                          onClick={async () => {
                            if (!isValidCfOrPiva(singleCf)) {
                              alert('Codice Fiscale/P.IVA non valido: 16 caratteri alfanumerici o 11 cifre.');
                              return;
                            }
                            const csvContent = `codice_fiscale,full_name,email,pec\n"${singleCf.toUpperCase()}","${singleName.replace(/"/g, '""')}","${singleEmail.replace(/"/g, '""')}","${singlePec.replace(/"/g, '""')}"`;
                            const file = new File([csvContent], 'destinatario.csv', { type: 'text/csv' });
                            setWizCsvFile(file);
                            await parseCsvFile(file, true);
                          }}
                        >
                          <i className="fas fa-check me-1"></i> Genera destinatario
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                    <button className="btn btn-outline-secondary" onClick={() => setWizStep(1)}>
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        if (await syncWizDraftAndRecipients(4)) {
                          setWizStep(4);
                        }
                      }}
                      disabled={!wizCsvFile}
                    >
                      Avanti <i className="fas fa-arrow-right ms-1"></i>
                    </button>
                  </div>
                </div>
              )}

              {wizStep === 2 && !wizSingleMode && (
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                  {/* contenuto invariato di questo <div>, righe 6220-6311 pre-modifica */}
                </div>
              )}
```

Non riscrivere il contenuto esistente. Applica la modifica come un
taglia-incolla puramente meccanico: il `<div style={{ maxWidth: '600px',
margin: '0 auto' }}>` di apertura riga 6219 e la sua `</div>` di chiusura
riga 6311 (pre-modifica) restano gli stessi tag, cambia solo la
condizione JSX che li racchiude — da `{wizStep === 2 && (` a `{wizStep
=== 2 && !wizSingleMode && (`. Nessuna riga tra 6220 e 6310 va toccata:
copiarle carattere per carattere così come sono oggi nel file.

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore rispetto al baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): step destinatario diretto per wizSingleMode"
```

---

### Task 4: Verifica end-to-end in browser (manuale — nessun test automatico frontend nel repo)

**Files:** nessuno (solo verifica).

**Interfaces:** nessuna.

- [ ] **Step 1: Avvia stack dev**

Run: `docker compose up -d`
Verifica: `docker compose logs -f frontend-admin` mostra Vite pronto
senza errori di compilazione.

- [ ] **Step 2: Login mock**

Apri `http://localhost:3000`, login `admin`/`admin` (richiede
`LDAP_HOST=mock` in `.env`).

- [ ] **Step 3: Percorso EMAIL — nessun allegato**

Click "Invio Singolo" in nav → verifica evidenziazione nav corretta e
titolo header "Wizard Invio Singolo" → Step1: nome campagna + canale
EMAIL → Avanti → Step2 (label "2. Destinatario"): compila CF valido +
email, click "Genera destinatario" → badge conferma → Avanti → verifica
atterraggio diretto su Step "3. Template & Anteprima" (skip mappatura) →
compila oggetto/corpo → Avanti fino a Step Anteprima e Invio → lancia →
verifica campagna creata in "Invio Massivo" con 1 destinatario EMAIL.

- [ ] **Step 4: Percorso APP_IO — validazione lunghezza oggetto/body**

Ripeti con canale APP_IO, inserisci oggetto sotto i 10 caratteri: verifica
che il blocco `wizAppIoSubjectLenInvalid` esistente impedisca l'avanzamento
(stessa validazione già presente nel wizard, ora raggiungibile da invio
singolo — prima non lo era).

- [ ] **Step 5: Percorso SEND o POSTAL — allegato obbligatorio**

Ripeti con canale POSTAL, prova ad avanzare oltre lo step Upload Allegati
senza allegato: verifica blocco (prima impossibile testare, canale
inutilizzabile da invio singolo).

- [ ] **Step 6: Riprendi bozza in modalità singola**

Salva una bozza a metà flusso "Invio Singolo" (bottone "Salva bozza"),
torna alla dashboard, riprendi la bozza da "Invio Massivo" → elenco
bozze: verifica che riapra il wizard con `wizSingleMode` ripristinato
correttamente (step "Destinatario" mostrato, non "Caricamento File").

- [ ] **Step 7: Nessuna regressione sul percorso CSV multi-riga**

Click "Invio Massivo" → "Nuova Campagna" → verifica che il percorso CSV
classico (upload file, mappatura colonne, step "3. Mappatura &
Validazione" visibile) sia identico a prima, invariato.
