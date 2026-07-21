# Invio Singolo — Form Unificato Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fondere step1 ("Dettagli & Canale") e l'attuale step2-single ("Destinatario") del wizard campagne in un unico step, aggiungendo lookup ANPR (con enforcement automatico PEC se INAD trovato), campi indirizzo/pagamenti manuali, e selezione allegati a slot con upload differito al momento dell'invio — eliminando gli step 3 (mappatura) e 5 (upload allegati dedicato) dal percorso `wizSingleMode`.

**Architecture:** Modifica esclusiva di `apps/frontend-admin/src/App.tsx` (nessun file nuovo, nessuna modifica backend — riuso totale degli endpoint e meccanismi esistenti: `/admin/domicilio/cerca`, `csvMapping`/`physicalAddressConfig`/`paymentConfig` a colonna, upload allegati per filename-matching). Il nuovo step fuso genera un CSV sintetico a 1 riga con colonne extra (`sd_indirizzo`, `sd_iuv`, `sd_allegato_N`, ...) esattamente come già avviene oggi per CF/nome/email/pec, poi punta gli state esistenti (`wizPostalAddressColumn`, `wizPaymentNoticeCol`, `wizAttachments`, ...) su quelle colonne — zero nuovi concetti lato dati, solo nuova UI e wiring.

**Tech Stack:** React 19 + TypeScript, Vite 6, Bootstrap (classi esistenti), nessun framework di test per componenti frontend in questo repo (solo `tsc --noEmit` come verifica statica + verifica manuale a runtime).

## Global Constraints

- Type-check obbligatorio dopo ogni task: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (NON `tsc -b`, fallisce per errori preesistenti non correlati).
- Nessuna modifica backend: tutto il flusso passa da endpoint/campi già esistenti (`/campaigns`, `/campaigns/:id/recipients/upload`, `/campaigns/:id/attachments/upload`, `/campaigns/:id/launch`, `/campaigns/:id/test-send`, `/admin/domicilio/cerca`).
- Percorso multi-riga CSV (`!wizSingleMode`) invariato: nessuna modifica a step2/3/5 quando `wizSingleMode === false`.
- Matrice comportamenti canale/INAD/App IO/protocollo/allegato (`docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`): ereditata, non toccata.
- Spec di riferimento: `docs/superpowers/specs/2026-07-21-invio-singolo-form-unificato-design.md` (e lo spec precedente `2026-07-20-invio-singolo-wizard-design.md` che estende).
- Ogni nuovo stato `wiz*`/`single*` legato al ciclo di vita del wizard va aggiunto sia a `resetWizard()` sia (se persistibile in bozza) a `prefillWizardFrom()` — CLAUDE.md "terzo punto di sync".
- Dopo modifica a `apps/backend` costruttori: N/A (nessuna modifica backend in questo piano).

---

## File Structure

Un solo file toccato: `apps/frontend-admin/src/App.tsx` (11970 righe, monolite esistente — non ristrutturato, coerente con la convenzione del repo).

Sezioni impattate (per riferimento, righe correnti prima delle modifiche):

- **Stato**: blocco `useState` righe 1127-1244 (nuove variabili aggiunte in coda a questo blocco).
- **`resetWizard()`**: righe 4333-4392.
- **`prefillWizardFrom()`**: righe 4394-4505.
- **`isValidCfOrPiva`**: riga 673-676 (riusata, non modificata).
- **`handleWizUploadAttachments()`**: righe 4750-4823 (refactor per estrarre core condiviso).
- **`handleWizLaunch()`**: righe 4825-4992 (aggiunta chiamata upload allegati differito).
- **`handleWizTestSend()`**: righe 5000-5057 (aggiunta chiamata upload allegati differito).
- **`wizTestAttachmentReady`**: riga 5437-5442 (short-circuit per `wizSingleMode`).
- **Steps Progress Header**: righe 6191-6262 (array single-mode aggiornato a 3 voci).
- **JSX `wizStep === 1`**: righe 6265-6585 (invariato per `!wizSingleMode`; nuovo blocco fuso `wizStep === 1 && wizSingleMode` sostituisce sia questo che il prossimo).
- **JSX `wizStep === 2 && wizSingleMode`**: righe 6588-6715 (rimosso interamente).
- **JSX `wizStep === 4`**: riga 7324 (`onClick={() => setWizStep(wizSingleMode ? 2 : 3)}` → `wizSingleMode ? 1 : 3`).

---

### Task 1: Nuovo stato per destinatario/ANPR/pagamenti/allegati single-mode

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1244` (subito dopo l'ultima dichiarazione `useState` del blocco esistente, prima di eventuale codice che segue)

**Interfaces:**
- Consumes: nessuno (stato nuovo, indipendente)
- Produces: `singleAddress, singleMunicipality, singleZip, singleProvince` (string), `singlePaymentIuv, singlePaymentImporto, singlePaymentScadenza` (string), `wizSingleAttachmentSlots: Array<{ id: string; label: string; file: File | null }>`, `singleAnprLoading: boolean`, `singleAnprCheckedCf: string | null`, `singleInadForced: boolean`, `singleInadAddress: string`, `singleAppIoActive: boolean` — usati da Task 2/3/4/6.

- [ ] **Step 1: Aggiungi le nuove dichiarazioni di stato**

Inserisci subito dopo la riga `const [singlePec, setSinglePec] = useState('');` (riga 1130):

```ts
  const [singleAddress, setSingleAddress] = useState('');
  const [singleMunicipality, setSingleMunicipality] = useState('');
  const [singleZip, setSingleZip] = useState('');
  const [singleProvince, setSingleProvince] = useState('');
  const [singlePaymentIuv, setSinglePaymentIuv] = useState('');
  const [singlePaymentImporto, setSinglePaymentImporto] = useState('');
  const [singlePaymentScadenza, setSinglePaymentScadenza] = useState('');
  const [wizSingleAttachmentSlots, setWizSingleAttachmentSlots] = useState<
    Array<{ id: string; label: string; file: File | null }>
  >([]);
  const [singleAnprLoading, setSingleAnprLoading] = useState(false);
  const [singleAnprCheckedCf, setSingleAnprCheckedCf] = useState<string | null>(null);
  const [singleInadForced, setSingleInadForced] = useState(false);
  const [singleInadAddress, setSingleInadAddress] = useState('');
  const [singleAppIoActive, setSingleAppIoActive] = useState(false);
```

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun nuovo errore (variabili dichiarate ma non ancora usate produrrebbero `noUnusedLocals` se attivo — verifica `tsconfig.app.json`; se attivo, aggiungi un uso placeholder non è ammesso dalle regole del progetto, quindi procedi comunque al Task 2 prima di rilanciare tsc se il primo run segnala "unused").

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): stato per destinatario/ANPR/pagamenti/allegati invio singolo"
```

---

### Task 2: Handler ANPR — lookup, precompilazione, enforcement PEC su INAD trovato

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuova funzione subito dopo `isValidCfOrPiva`-adjacent handlers, es. accanto a `runCercaDomicilio` riga 1967-1991, oppure nel corpo del componente vicino agli altri `handleWiz*` — inserire dopo `handleWizMappingChange` riga ~4147 per restare vicino alla logica wizard)

**Interfaces:**
- Consumes: `singleCf` (Task 1), `apiFetch` (helper esistente usato da `runCercaDomicilio`, riga 1972), `ApiAuthError` (classe esistente), `setWizChannel`, `setSingleName`, `setSingleAddress/Municipality/Zip/Province`, `setSingleAnprLoading/CheckedCf/InadForced/InadAddress/AppIoActive` (Task 1)
- Produces: `runWizAnprCheck(): Promise<void>` — usata da Task 4 (bottone "Carica dati ANPR")

- [ ] **Step 1: Scrivi `runWizAnprCheck`**

```ts
  const runWizAnprCheck = async () => {
    if (!isValidCfOrPiva(singleCf)) {
      alert('Codice Fiscale/P.IVA non valido: 16 caratteri alfanumerici o 11 cifre.');
      return;
    }
    setSingleAnprLoading(true);
    try {
      const res = await apiFetch('/domicilio/cerca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: singleCf }),
      });
      const data = await res.json();
      setSingleAnprCheckedCf(singleCf);

      const g = data?.anpr?.generalita;
      if (data?.anpr?.success && data?.anpr?.found && g) {
        const nomeCompleto = [g.cognome, g.nome].filter(Boolean).join(' ');
        if (nomeCompleto) setSingleName(nomeCompleto);
      }

      const residenza = data?.anpr?.residenza?.[0];
      if (data?.anpr?.success && data?.anpr?.found && residenza?.indirizzo) {
        const ind = residenza.indirizzo;
        const via = [ind.toponimo?.specie, ind.toponimo?.denominazioneToponimo].filter(Boolean).join(' ');
        const civico = [ind.numeroCivico?.numero, ind.numeroCivico?.lettera].filter(Boolean).join('');
        setSingleAddress([via, civico].filter(Boolean).join(', '));
        setSingleMunicipality(ind.comune?.nomeComune || '');
        setSingleZip(ind.cap || '');
        setSingleProvince(ind.comune?.siglaProvinciaIstat || '');
      }

      const inadFound = Boolean(data?.inad?.success && data?.inad?.found && (data?.inad?.digitalAddress?.length ?? 0) > 0);
      setSingleInadForced(inadFound);
      setSingleInadAddress(inadFound ? data.inad.digitalAddress[0].digitalAddress : '');
      if (inadFound) {
        setWizChannel('PEC');
        setSinglePec(data.inad.digitalAddress[0].digitalAddress);
      }

      setSingleAppIoActive(Boolean(data?.appIo?.success && data?.appIo?.active));
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message || 'Errore di connessione durante la verifica ANPR.');
    } finally {
      setSingleAnprLoading(false);
    }
  };
```

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (funzione non ancora richiamata da JSX è consentito, non genera `noUnusedLocals` per funzioni dichiarate nel corpo componente se già usate altrove nel file — verifica comunque l'output).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): handler verifica ANPR con enforcement PEC su INAD trovato"
```

---

### Task 3: Helper allegati — slot management e upload core condiviso

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuove funzioni vicino a `handleWizUploadAttachments`, righe 4750-4823)

**Interfaces:**
- Consumes: `wizSingleAttachmentSlots` (Task 1), `uploadFileInChunks` (helper esistente, già usato riga 4775), `ADMIN_API_BASE`, `token`
- Produces: `addWizSingleAttachmentSlot()`, `removeWizSingleAttachmentSlot(id: string)`, `updateWizSingleAttachmentSlot(id: string, patch: Partial<{label: string; file: File | null}>)` — usate da Task 4. `uploadAttachmentFilesCore(campaignId: string, files: File[]): Promise<{filenames?: string[]; attachmentsExpected?: number; attachmentsPresent?: number; discarded?: number; blocked?: boolean; message?: string} | null>` — usata da Task 6 e dal refactor di `handleWizUploadAttachments`.

- [ ] **Step 1: Estrai `uploadAttachmentFilesCore` da `handleWizUploadAttachments`**

Sostituisci il blocco `if (wizPdfFiles && wizPdfFiles.length > 0) { ... }` (righe 4767-4816) di `handleWizUploadAttachments` con una funzione condivisa dichiarata subito PRIMA di `handleWizUploadAttachments`:

```ts
  const uploadAttachmentFilesCore = async (
    campaignId: string,
    files: File[],
  ): Promise<{ uploaded: number; discarded?: number; attachmentsExpected?: number; attachmentsPresent?: number; filenames?: string[]; blocked?: boolean; message?: string } | null> => {
    if (files.length === 0) return null;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    setWizUploadProgress({ label: 'Caricamento allegati', loaded: 0, total: totalBytes });
    let cumulativeBefore = 0;
    let lastAttachData: { uploaded: number; discarded?: number; attachmentsExpected?: number; attachmentsPresent?: number; filenames?: string[]; blocked?: boolean; message?: string } | null = null;
    for (const file of files) {
      const base = cumulativeBefore;
      const isZip = file.name.toLowerCase().endsWith('.zip');
      lastAttachData = await uploadFileInChunks(
        `${ADMIN_API_BASE}/campaigns/${campaignId}/attachments/upload`,
        token!,
        file,
        file.name,
        (loaded) => setWizUploadProgress(p => (p ? { ...p, loaded: base + loaded } : p)),
        () => setWizUploadProgress({
          label: isZip ? 'Estrazione allegati in corso' : 'Salvataggio allegato in corso',
          loaded: base + file.size,
          total: totalBytes,
        }),
      );
      cumulativeBefore += file.size;
    }
    setWizUploadProgress(null);
    if (lastAttachData?.blocked) {
      throw new Error(lastAttachData.message || 'Errore durante la finalizzazione degli allegati.');
    }
    if (lastAttachData) {
      setWizAttachmentProgress({
        expected: lastAttachData.attachmentsExpected ?? 0,
        present: lastAttachData.attachmentsPresent ?? 0,
      });
      if (lastAttachData.filenames) {
        setWizUploadedAttachmentFiles(lastAttachData.filenames);
      }
    }
    return lastAttachData;
  };
```

Poi riscrivi `handleWizUploadAttachments` (righe 4750-4823) perché usi questo core, mantenendo invariato il suo comportamento pubblico (alert, reset `wizPdfFiles`, gestione `wizSending`):

```ts
  const handleWizUploadAttachments = async (): Promise<void> => {
    setWizSending(true);
    try {
      const campaignId = wizCampaignId;
      if (!campaignId) {
        alert('Campagna non ancora salvata. Torna indietro e riprova.');
        return;
      }
      if (wizPdfFiles && wizPdfFiles.length > 0) {
        const lastAttachData = await uploadAttachmentFilesCore(campaignId, wizPdfFiles);
        const discardCount = lastAttachData?.discarded || 0;
        if (discardCount > 0) {
          alert(`Allegati caricati con successo.\nNota: ${discardCount} file non referenziati da alcun cittadino sono stati scartati.`);
        } else {
          alert('Allegati caricati con successo.');
        }
        setWizPdfFiles([]);
        const input = document.getElementById('wiz_pdf_input') as HTMLInputElement;
        if (input) {
          input.value = '';
        }
      }
    } catch (err: any) {
      alert(err.message || 'Errore durante il caricamento degli allegati.');
    } finally {
      setWizSending(false);
      setWizUploadProgress(null);
    }
  };
```

- [ ] **Step 2: Aggiungi gli helper di gestione slot**

Subito dopo `uploadAttachmentFilesCore`:

```ts
  const addWizSingleAttachmentSlot = () => {
    setWizSingleAttachmentSlots(prev => [
      ...prev,
      { id: `slot-${Date.now()}-${prev.length}`, label: `Allegato ${prev.length + 1}`, file: null },
    ]);
  };

  const removeWizSingleAttachmentSlot = (id: string) => {
    setWizSingleAttachmentSlots(prev => prev.filter(s => s.id !== id));
  };

  const updateWizSingleAttachmentSlot = (id: string, patch: Partial<{ label: string; file: File | null }>) => {
    setWizSingleAttachmentSlots(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  };
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore. Verifica in particolare che `uploadFileInChunks` accetti gli stessi argomenti già usati altrove (stessa firma, nessuna modifica alla funzione stessa).

- [ ] **Step 4: Verifica manuale rapida — percorso multi-riga invariato**

Con `docker compose up -d`, apri l'admin (`http://localhost:3000`), avvia "Invio Massivo" (non singolo), arriva allo step5 "Upload Allegati" con un CSV di test, verifica che il bottone "Carica Allegati" funzioni come prima (comportamento pubblico di `handleWizUploadAttachments` non cambiato).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "refactor(frontend-admin): estrai core upload allegati, aggiungi helper slot invio singolo"
```

---

### Task 4: JSX fuso — Step "Dettagli & Destinatario" (sostituisce step1 + step2-single)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6265-6715` (il blocco `wizStep === 1` esistente resta per `!wizSingleMode`; il blocco `wizStep === 2 && wizSingleMode`, righe 6588-6715, viene rimosso; nuovo blocco `wizStep === 1 && wizSingleMode` inserito prima del blocco `wizStep === 1 && !wizSingleMode`)

**Interfaces:**
- Consumes: tutto lo stato dei Task 1-3, più stato preesistente: `wizName, wizDesc, wizChannel, wizMailConfigId, wizAppIoServiceId, wizAppIoMode, wizPostalServiceType, wizProtocolla, wizPaymentEnabled, singleCf, singleName, singleEmail, singlePec, mailConfigs, ioServices, getChannelMeta, parseCsvFile, syncWizDraftAndRecipients`
- Produces: la funzione `handleWizSingleSubmit` (submit del form fuso) — non consumata da altri task, chiude il flusso verso `wizStep === 4`.

- [ ] **Step 1: Dividi il rendering di step1 in base a `wizSingleMode`**

Trova la riga di apertura esistente (6265):
```tsx
{wizStep === 1 && (
```
Sostituiscila con:
```tsx
{wizStep === 1 && !wizSingleMode && (
```
(la chiusura a riga 6585 resta invariata — questo blocco ora si applica solo al percorso multi-riga).

- [ ] **Step 2: Rimuovi il blocco `wizStep === 2 && wizSingleMode`**

Elimina interamente le righe 6588-6715 (l'intero blocco `{wizStep === 2 && wizSingleMode && ( ... )}`, incluso il commento `{/* STEP 2 */}` a riga 6587 se presente solo per quel blocco — verificane il contenuto esatto prima di cancellare, mantieni eventuali commenti condivisi con il blocco `!wizSingleMode` successivo).

- [ ] **Step 3: Scrivi `handleWizSingleSubmit`**

Inserisci questa funzione nel corpo del componente, vicino a `runWizAnprCheck` (Task 2):

```ts
  const needsWizSinglePhysicalAddress = wizChannel === 'SEND' || wizChannel === 'POSTAL';

  const handleWizSingleSubmit = async () => {
    if (!isValidCfOrPiva(singleCf)) {
      alert('Codice Fiscale/P.IVA non valido: 16 caratteri alfanumerici o 11 cifre.');
      return;
    }
    if (!singleName.trim()) {
      alert('Nome/Cognome (o Ragione Sociale) obbligatorio.');
      return;
    }

    const cols: string[] = ['codice_fiscale', 'full_name', 'email', 'pec'];
    const vals: string[] = [singleCf.toUpperCase(), singleName, singleEmail, singlePec];

    if (needsWizSinglePhysicalAddress) {
      cols.push('sd_indirizzo', 'sd_comune', 'sd_cap', 'sd_provincia');
      vals.push(singleAddress, singleMunicipality, singleZip, singleProvince);
    }
    if (wizPaymentEnabled) {
      cols.push('sd_iuv', 'sd_importo', 'sd_scadenza');
      vals.push(singlePaymentIuv, singlePaymentImporto, singlePaymentScadenza);
    }
    const attachmentSlotsWithFile = wizSingleAttachmentSlots.filter(s => s.file);
    attachmentSlotsWithFile.forEach((s, i) => {
      cols.push(`sd_allegato_${i + 1}`);
      vals.push(s.file!.name);
    });

    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csvContent = `${cols.join(',')}\n${vals.map(esc).join(',')}`;
    const file = new File([csvContent], 'destinatario.csv', { type: 'text/csv' });
    setWizCsvFile(file);
    await parseCsvFile(file, true);

    if (needsWizSinglePhysicalAddress) {
      setWizPostalAddressColumn('sd_indirizzo');
      setWizPostalMunicipalityColumn('sd_comune');
      setWizPostalZipColumn('sd_cap');
      setWizPostalProvinceColumn('sd_provincia');
    }
    if (wizPaymentEnabled) {
      setWizPaymentNoticeCol('sd_iuv');
      setWizPaymentAmountCol('sd_importo');
      setWizPaymentAmountType('euro');
      setWizPaymentDueDateCol('sd_scadenza');
    }
    setWizAttachments(
      attachmentSlotsWithFile.map((s, i) => ({ key: `sd_allegato_${i + 1}`, label: s.label || `Allegato ${i + 1}` })),
    );
    setWizPdfFiles(attachmentSlotsWithFile.map(s => s.file!));

    if (await syncWizDraftAndRecipients(4)) {
      setWizStep(4);
    }
  };

  const wizSingleSubmitDisabled =
    !singleCf.trim() ||
    !singleName.trim() ||
    (wizChannel === 'EMAIL' && !singleEmail.trim()) ||
    (wizChannel === 'PEC' && !singlePec.trim()) ||
    (needsWizSinglePhysicalAddress && (!singleAddress.trim() || !singleMunicipality.trim() || !singleZip.trim() || !singleProvince.trim())) ||
    ((wizChannel === 'SEND' || wizChannel === 'POSTAL') && wizSingleAttachmentSlots.filter(s => s.file).length === 0) ||
    ((wizChannel === 'EMAIL' || wizChannel === 'PEC') && !wizMailConfigId) ||
    (wizChannel === 'APP_IO' && !wizAppIoServiceId) ||
    (wizChannel === 'POSTAL' && !wizPostalServiceType);
```

- [ ] **Step 4: Inserisci il nuovo blocco JSX fuso, prima del blocco `wizStep === 1 && !wizSingleMode`**

```tsx
              {wizStep === 1 && wizSingleMode && (
                <div style={{ maxWidth: '700px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3">Passo 1: Dettagli & Destinatario</h4>

                  <div className="mb-4 pb-3 border-bottom d-flex justify-content-end">
                    <button
                      className="btn btn-primary"
                      onClick={handleWizSingleSubmit}
                      disabled={wizSingleSubmitDisabled}
                    >
                      Avanti <ArrowRight className="ms-1" />
                    </button>
                  </div>

                  <div className="mb-3">
                    <label className="form-label small fw-bold">Nome Campagna</label>
                    <input
                      type="text"
                      className="form-control form-control-sm"
                      value={wizName}
                      onChange={e => setWizName(e.target.value)}
                    />
                    <div className="form-text small text-muted">
                      Precompilato da CF/Nome, modificabile in ogni momento.
                    </div>
                  </div>

                  <div className="row g-3 mb-3">
                    <div className="col-md-6">
                      <label className="form-label small fw-bold text-dark" htmlFor="s_cf">
                        Codice Fiscale/P.IVA Destinatario <span className="text-danger">*</span>
                      </label>
                      <div className="input-group input-group-sm">
                        <input
                          type="text"
                          id="s_cf"
                          className="form-control form-control-sm"
                          maxLength={16}
                          value={singleCf}
                          onChange={(e) => {
                            const v = e.target.value.toUpperCase();
                            setSingleCf(v);
                            if (v !== singleAnprCheckedCf) {
                              setSingleInadForced(false);
                              setSingleInadAddress('');
                              setSingleAppIoActive(false);
                            }
                          }}
                        />
                        <button
                          className="btn btn-outline-primary"
                          type="button"
                          disabled={!isValidCfOrPiva(singleCf) || singleAnprLoading}
                          onClick={runWizAnprCheck}
                        >
                          {singleAnprLoading ? <Loader2 className="icon-spin me-1" size={16} /> : null}
                          Carica dati ANPR
                        </button>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small fw-bold" htmlFor="s_name">
                        Nome/Cognome (o Ragione Sociale) <span className="text-danger">*</span>
                      </label>
                      <input
                        type="text"
                        id="s_name"
                        className="form-control form-control-sm"
                        value={singleName}
                        onChange={(e) => setSingleName(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="mb-3">
                    <label className="form-label small fw-bold">Canale di Invio Principale *</label>
                    <select
                      className="form-select form-select-sm"
                      value={wizChannel}
                      disabled={singleInadForced}
                      onChange={(e: any) => {
                        const newChan = e.target.value as any;
                        setWizChannel(newChan);
                        const activeCfg = mailConfigs.find(c => c.type === newChan && c.active);
                        setWizMailConfigId(activeCfg?.id || '');
                        if (newChan === 'SEND') setWizProtocolla(true);
                      }}
                    >
                      {(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'] as const).map(key => (
                        <option key={key} value={key}>{getChannelMeta(key).label}</option>
                      ))}
                    </select>
                    {singleInadForced && (
                      <div className="form-text small text-success">
                        Domicilio digitale INAD trovato ({singleInadAddress}): canale forzato a PEC.
                      </div>
                    )}
                    {!singleInadForced && singleAppIoActive && (
                      <div className="form-text small text-success">
                        Servizio App IO attivo per questo destinatario: disponibile come co-consegna.
                      </div>
                    )}
                  </div>

                  {wizChannel === 'EMAIL' && (
                    <div className="mb-3">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_email">
                        Indirizzo Email <span className="text-danger">*</span>
                      </label>
                      <input
                        type="email"
                        id="s_email"
                        className="form-control form-control-sm"
                        value={singleEmail}
                        onChange={(e) => setSingleEmail(e.target.value)}
                      />
                    </div>
                  )}
                  {wizChannel === 'PEC' && (
                    <div className="mb-3">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_pec">
                        Indirizzo PEC <span className="text-danger">*</span>
                      </label>
                      <input
                        type="email"
                        id="s_pec"
                        className="form-control form-control-sm"
                        value={singlePec}
                        disabled={singleInadForced}
                        onChange={(e) => setSinglePec(e.target.value)}
                      />
                    </div>
                  )}

                  {needsWizSinglePhysicalAddress && (
                    <div className="row g-3 mb-3">
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted">Indirizzo (via e civico) *</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          placeholder="Es: Via Roma 12"
                          value={singleAddress}
                          onChange={(e) => setSingleAddress(e.target.value)}
                        />
                      </div>
                      <div className="col-md-3">
                        <label className="form-label small fw-semibold text-muted">Comune *</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          value={singleMunicipality}
                          onChange={(e) => setSingleMunicipality(e.target.value)}
                        />
                      </div>
                      <div className="col-md-1">
                        <label className="form-label small fw-semibold text-muted">CAP *</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          value={singleZip}
                          onChange={(e) => setSingleZip(e.target.value)}
                        />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small fw-semibold text-muted">Provincia *</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          maxLength={2}
                          value={singleProvince}
                          onChange={(e) => setSingleProvince(e.target.value.toUpperCase())}
                        />
                      </div>
                    </div>
                  )}

                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz_single_protocolla"
                      checked={wizProtocolla}
                      disabled={wizChannel === 'SEND'}
                      onChange={(e) => setWizProtocolla(e.target.checked)}
                    />
                    <label className="form-check-label small" htmlFor="wiz_single_protocolla">
                      Protocolla questo invio
                      {wizChannel === 'SEND' && (
                        <span className="text-muted"> (obbligatorio per SEND)</span>
                      )}
                    </label>
                  </div>

                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz_single_payment_enabled"
                      checked={wizPaymentEnabled}
                      onChange={e => setWizPaymentEnabled(e.target.checked)}
                    />
                    <label className="form-check-label small fw-bold" htmlFor="wiz_single_payment_enabled">
                      Integrazione pagamenti pagoPA
                    </label>
                  </div>

                  {wizPaymentEnabled && (
                    <div className="row g-3 mb-3 ps-3">
                      <div className="col-md-4">
                        <label className="form-label small fw-semibold text-muted">IUV / Codice Avviso</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          value={singlePaymentIuv}
                          onChange={(e) => setSinglePaymentIuv(e.target.value)}
                        />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-semibold text-muted">Importo (€)</label>
                        <input
                          type="text"
                          className="form-control form-control-sm"
                          value={singlePaymentImporto}
                          onChange={(e) => setSinglePaymentImporto(e.target.value)}
                        />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-semibold text-muted">Scadenza (opzionale)</label>
                        <input
                          type="date"
                          className="form-control form-control-sm"
                          value={singlePaymentScadenza}
                          onChange={(e) => setSinglePaymentScadenza(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  <div className="mb-3">
                    <label className="form-label small fw-bold d-block">
                      Allegati
                      {(wizChannel === 'SEND' || wizChannel === 'POSTAL') && <span className="text-danger"> *</span>}
                    </label>
                    {wizSingleAttachmentSlots.map((slot, idx) => (
                      <div className="row g-2 mb-2 align-items-center" key={slot.id}>
                        <div className="col-md-4">
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            placeholder={`Allegato ${idx + 1}`}
                            value={slot.label}
                            onChange={(e) => updateWizSingleAttachmentSlot(slot.id, { label: e.target.value })}
                          />
                        </div>
                        <div className="col-md-6">
                          <input
                            type="file"
                            accept=".pdf"
                            className="form-control form-control-sm"
                            onChange={(e) => updateWizSingleAttachmentSlot(slot.id, { file: e.target.files?.[0] || null })}
                          />
                        </div>
                        <div className="col-md-2">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => removeWizSingleAttachmentSlot(slot.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={addWizSingleAttachmentSlot}>
                      + Aggiungi allegato
                    </button>
                    <div className="form-text small text-muted">
                      Il caricamento effettivo avviene al momento dell'invio/test, non ora.
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-top d-flex justify-content-end">
                    <button
                      className="btn btn-primary"
                      onClick={handleWizSingleSubmit}
                      disabled={wizSingleSubmitDisabled}
                    >
                      Avanti <ArrowRight className="ms-1" />
                    </button>
                  </div>
                </div>
              )}

```

- [ ] **Step 5: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore. Se compare un errore su `Loader2`/`Trash2`/`ArrowRight` non importati, verifica che siano già importati altrove nel file (lo sono, usati da altri step — nessun nuovo import necessario).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): step fuso Dettagli+Destinatario per invio singolo"
```

---

### Task 5: Step bar, back-button step4, gating "Avvia Test"/"Lancia" per single-mode

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6191-6262` (step bar), `:7324` circa (back-button step4), `:5437-5442` (`wizTestAttachmentReady`)

**Interfaces:**
- Consumes: `wizSingleMode`, `wizStep`, `wizMaxReachedStep` (esistenti)
- Produces: nessuna nuova interfaccia — solo wiring di navigazione

- [ ] **Step 1: Aggiorna l'array single-mode della step bar**

Sostituisci righe 6194-6200:
```tsx
                  ? [
                      { n: 1, label: '1. Dettagli & Canale' },
                      { n: 2, label: '2. Destinatario' },
                      { n: 4, label: '3. Template & Anteprima' },
                      { n: 5, label: '4. Upload Allegati' },
                      { n: 6, label: '5. Anteprima e Invio' },
                    ]
```
con:
```tsx
                  ? [
                      { n: 1, label: '1. Dettagli & Destinatario' },
                      { n: 4, label: '2. Template & Anteprima' },
                      { n: 6, label: '3. Anteprima e Invio' },
                    ]
```

- [ ] **Step 2: Correggi il back-button dello step Template (riga 7324 circa)**

Trova (nel blocco `wizStep === 4`):
```tsx
onClick={() => setWizStep(wizSingleMode ? 2 : 3)}
```
Sostituisci con:
```tsx
onClick={() => setWizStep(wizSingleMode ? 1 : 3)}
```

- [ ] **Step 3: Short-circuit `wizTestAttachmentReady` per single-mode**

Sostituisci righe 5437-5442:
```ts
  const wizTestAttachmentReady = wizChannel !== 'SEND' && wizChannel !== 'POSTAL'
    ? true
    : wizAttachments.every((entry) => {
        const expectedFilename = wizValidRows[0]?.[entry.key];
        return expectedFilename && (wizUploadedAttachmentFiles?.includes(expectedFilename) ?? false);
      });
```
con:
```ts
  const wizTestAttachmentReady = wizSingleMode
    ? true
    : (wizChannel !== 'SEND' && wizChannel !== 'POSTAL'
      ? true
      : wizAttachments.every((entry) => {
          const expectedFilename = wizValidRows[0]?.[entry.key];
          return expectedFilename && (wizUploadedAttachmentFiles?.includes(expectedFilename) ?? false);
        }));
```

Nota: per `wizSingleMode`, la presenza di almeno un allegato per SEND/POSTAL è già stata imposta da `wizSingleSubmitDisabled` (Task 4) allo step1 — l'upload reale avviene dentro `handleWizLaunch`/`handleWizTestSend` (Task 6), non serve ri-validarlo qui.

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): step bar e gating invio singolo a 3 step (niente piu step 2/3/5)"
```

---

### Task 6: Upload allegati differito al momento dell'invio/test

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` — `handleWizLaunch()` (righe 4825-4992), `handleWizTestSend()` (righe 5000-5057)

**Interfaces:**
- Consumes: `uploadAttachmentFilesCore` (Task 3), `wizSingleMode`, `wizPdfFiles`, `wizCampaignId`
- Produces: nessuna nuova interfaccia — comportamento runtime

- [ ] **Step 1: Aggiungi helper di invocazione condizionale**

Vicino a `uploadAttachmentFilesCore` (Task 3), aggiungi:

```ts
  const ensureWizSingleAttachmentsUploaded = async (campaignId: string) => {
    if (!wizSingleMode || wizPdfFiles.length === 0) return;
    await uploadAttachmentFilesCore(campaignId, wizPdfFiles);
    setWizPdfFiles([]);
  };
```

- [ ] **Step 2: Richiama l'helper in `handleWizLaunch`, subito dopo aver ottenuto `campaignObj`**

Trova (riga 4938, subito dopo il blocco if/else che assegna `campaignObj`):
```ts
      const blob = buildNormalizedRecipientsCsvBlob();
```
Inserisci PRIMA di questa riga:
```ts
      await ensureWizSingleAttachmentsUploaded(campaignObj.id);

```

- [ ] **Step 3: Richiama l'helper in `handleWizTestSend`, subito dopo il guard su `wizCampaignId`**

Trova (riga 5004-5005):
```ts
      if (!wizCampaignId) throw new Error('Campagna non ancora salvata.');
      if (!wizTestForm.codiceFiscale.trim()) throw new Error('Codice Fiscale obbligatorio.');
```
Sostituisci con:
```ts
      if (!wizCampaignId) throw new Error('Campagna non ancora salvata.');
      if (!wizTestForm.codiceFiscale.trim()) throw new Error('Codice Fiscale obbligatorio.');
      await ensureWizSingleAttachmentsUploaded(wizCampaignId);
```

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): upload allegati invio singolo differito al lancio/test"
```

---

### Task 7: `resetWizard`/`prefillWizardFrom` — ciclo di vita del nuovo stato

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:4333-4392` (`resetWizard`), `:4394-4505` (`prefillWizardFrom`)

**Interfaces:**
- Consumes: tutto lo stato Task 1
- Produces: nessuna nuova interfaccia — solo lifecycle corretto (CLAUDE.md "terzo punto di sync")

- [ ] **Step 1: Estendi `resetWizard()`**

Aggiungi, subito prima della riga di chiusura `};` (riga 4392):

```ts
    setSingleCf('');
    setSingleName('');
    setSingleEmail('');
    setSinglePec('');
    setSingleAddress('');
    setSingleMunicipality('');
    setSingleZip('');
    setSingleProvince('');
    setSinglePaymentIuv('');
    setSinglePaymentImporto('');
    setSinglePaymentScadenza('');
    setWizSingleAttachmentSlots([]);
    setSingleAnprLoading(false);
    setSingleAnprCheckedCf(null);
    setSingleInadForced(false);
    setSingleInadAddress('');
    setSingleAppIoActive(false);
```

Nota: `resetWizard()` non azzerava già `singleCf`/`singleName`/`singleEmail`/`singlePec` prima di questo piano (bug pre-esistente segnalato dall'agente di ricognizione) — questo step lo corregge insieme all'aggiunta del nuovo stato.

- [ ] **Step 2: Estendi `prefillWizardFrom()` per ripristinare i campi destinatario quando si riprende una bozza single-mode**

Trova il blocco che gestisce il fetch del CSV di bozza (righe 4467-4498, dentro l'`if (!opts.isDuplicate && opts.campaignId && source.channelConfig?.wizCsvFilename)`). Subito dopo la riga:
```ts
          setWizCsvFile(file);
```
e PRIMA della chiamata a `parseCsvFile`, non serve nulla — invece, aggiungi la ricostruzione dei campi `single*` dopo `parseCsvFile` ha popolato `wizCsvRows` (cioè dopo la riga `if (source.channelConfig?.csvMapping) { ... }`, prima del blocco `} else { ... }`). Inserisci questo blocco subito dopo la chiusura dell'`if (source.channelConfig?.csvMapping)` (dopo riga 4488, ancora dentro il blocco `try`):

```ts
          if (Boolean(source.channelConfig?.wizSingleMode)) {
            // wizCsvRows non è ancora aggiornato in questo punto della stessa closure
            // (setState non è visibile nel render corrente) — rileggiamo la singola riga
            // direttamente dal CSV appena fetchato via un secondo parse locale, sola lettura.
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
              const rowVals = parseLine(lines[1]);
              const row: Record<string, string> = {};
              headerCols.forEach((h, i) => { row[h] = rowVals[i] || ''; });
              setSingleCf(row['codice_fiscale'] || '');
              setSingleName(row['full_name'] || '');
              setSingleEmail(row['email'] || '');
              setSinglePec(row['pec'] || '');
              setSingleAddress(row['sd_indirizzo'] || '');
              setSingleMunicipality(row['sd_comune'] || '');
              setSingleZip(row['sd_cap'] || '');
              setSingleProvince(row['sd_provincia'] || '');
              setSinglePaymentIuv(row['sd_iuv'] || '');
              setSinglePaymentImporto(row['sd_importo'] || '');
              setSinglePaymentScadenza(row['sd_scadenza'] || '');
              const attachmentEntries = (source.channelConfig?.attachments || []) as Array<{ key: string; label: string }>;
              setWizSingleAttachmentSlots(
                attachmentEntries.map((a, i) => ({ id: `slot-resume-${i}`, label: a.label || `Allegato ${i + 1}`, file: null })),
              );
            }
          }
```

Nota: i file allegati non sono recuperabili lato client (sono già sul server se caricati in precedenza) — gli slot vengono ripristinati con `file: null`, coerente con `wizPdfFiles` che resta vuoto: `ensureWizSingleAttachmentsUploaded` (Task 6) farà `no-op` (nessun nuovo file da caricare) e i controlli si baseranno su quanto già presente sul server via `wizAttachmentProgress`/`wizUploadedAttachmentFiles`, esattamente come fa oggi il percorso multi-riga alla ripresa di una bozza.

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): reset e ripristino stato destinatario invio singolo (bozza/reset)"
```

---

### Task 8: Verifica manuale end-to-end (nessun framework di test frontend in questo repo)

**Files:** nessuno (solo verifica a runtime)

- [ ] **Step 1: Avvia lo stack di sviluppo**

```bash
docker compose up -d --build frontend-admin backend
```

- [ ] **Step 2: Percorso EMAIL semplice, senza ANPR**

Da UI: Invio Singolo → CF valido + Nome/Cognome + canale EMAIL + email → verifica che "Avanti" sia disabilitato finché email vuota, poi abilitato. Procedi fino a "Lancia campagna", verifica invio in coda su dashboard.

- [ ] **Step 3: Percorso POSTAL con ANPR che trova INAD → forzatura PEC**

Usa un CF di test con domicilio INAD noto (o simulato via mock ambiente dev se disponibile) → click "Carica dati ANPR" → verifica: select canale si blocca su PEC, campo PEC precompilato, badge verde visibile, "Avvia Test"/"Lancia" non richiedono più allegato (perché il canale non è più POSTAL).

- [ ] **Step 4: Percorso SEND con pagamenti + 2 allegati**

Seleziona SEND (protocollazione auto-forzata) → spunta pagamenti, compila IUV/importo/scadenza → aggiungi 2 slot allegato con file PDF reali → avanza a Template, poi Anteprima, poi "Avvia Test": verifica che gli allegati vengano effettivamente caricati sul server SOLO in questo momento (controllare `docker compose logs -f backend` per la chiamata `POST /campaigns/:id/attachments/upload` che compare dopo il click "Avvia Test", non prima).

- [ ] **Step 5: Ripresa bozza single-mode**

Salva una bozza a metà (es. dopo step1), torna alla dashboard, "Riprendi wizard" sulla bozza → verifica che CF/Nome/canale/indirizzo/pagamenti siano ripopolati nello step1 fuso.

- [ ] **Step 6: Percorso multi-riga invariato**

Ripeti un invio massivo CSV standard (non singolo) end-to-end per conferma di non-regressione su step 2/3/5 esistenti.

Nessun commit in questo task (solo verifica).

---

## Self-Review

**1. Copertura spec:** step fuso Dettagli+Canale+Destinatario (Task 4), ANPR + enforcement PEC su INAD (Task 2, Task 4 select disabled), campi canale-dipendenti (Task 4), pagamenti manuali (Task 4), allegati a slot con upload differito (Task 3, Task 4, Task 6), step bar/back-button/gating (Task 5), lifecycle reset/prefill (Task 7), verifica end-to-end (Task 8). Tutte le sezioni dello spec `2026-07-21-invio-singolo-form-unificato-design.md` sono coperte.

**2. Placeholder scan:** nessun "TBD"/"da definire" — ogni step ha codice completo.

**3. Coerenza tipi:** `wizSingleAttachmentSlots: Array<{id,label,file}>` (Task 1) usato identicamente in Task 3/4/7; `uploadAttachmentFilesCore(campaignId, files)` stessa firma in Task 3/6; `ensureWizSingleAttachmentsUploaded(campaignId)` stessa firma in Task 6; colonne sintetiche CSV (`sd_indirizzo`, `sd_comune`, `sd_cap`, `sd_provincia`, `sd_iuv`, `sd_importo`, `sd_scadenza`, `sd_allegato_N`) usate identicamente in Task 4 (scrittura) e Task 7 (lettura in ripristino bozza).
