# Select ricercabili + ordinamento default-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire tutte le select native di mittenti PEC/EMAIL, servizi App IO e tassonomie SEND con un combobox ricercabile che mostra sempre il predefinito per primo e il resto in ordine alfabetico; introdurre doppio default (con/senza pagamento) per le tassonomie SEND abilitate, con nuovo formato label "Descrizione - CODICE".

**Architecture:** Un nuovo componente riusabile `SearchableSelect` (`apps/frontend-admin/src/components/SearchableSelect.tsx`, stesso pattern di `TemplateEditor.tsx` già presente in quella cartella) sostituisce 11 `<select>` native in `App.tsx`. Il componente ordina internamente le `options` (default primo, poi alfabetico) — nessuna logica di sort duplicata nei punti di chiamata. Per le tassonomie SEND, `settSendTaxonomies` guadagna un campo `isDefault?: boolean` gestito client-side (nessuna migration DB, resta un blob JSON in `app_settings`).

**Tech Stack:** React 19 + TypeScript, Bootstrap (classi esistenti, nessuna nuova dipendenza).

## Global Constraints

- Nessuna nuova dipendenza npm (niente `react-select`/`downshift`) — evita il workaround pnpm v11 per nuovi pacchetti (vedi CLAUDE.md).
- Type-check frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Nessuna modifica backend/migration: `send.enabledTaxonomyCodes` resta `type:'string'` in `settings.registry.ts`, il nuovo campo `isDefault` è solo un attributo in più nel JSON già persistito.
- L'attributo HTML `required` sulle select native sostituite è decorativo: il pulsante "Avanti" del wizard è già disabilitato via condizione JS esplicita su `!wizMailConfigId`/`!wizAppIoServiceId`/`!wizTaxonomyCode` (verificato: `App.tsx` righe con pattern `((wizChannel === 'EMAIL' || wizChannel === 'PEC') && !wizMailConfigId) || ...`, tre occorrenze duplicate per i tre step del wizard). Rimuoverlo passando a `SearchableSelect` è sicuro, nessuna regressione di validazione.
- I numeri di riga in questo piano sono indicativi al momento della stesura: ogni edit precedente sposta le righe successive. Localizzare ogni blocco per il testo esatto riportato (univoco), non per numero di riga.
- Verifica manuale in browser richiesta per ogni gruppo di select sostituite (nessun test automatico frontend nel repo oltre a `tsc`).

---

### Task 1: Componente `SearchableSelect`

**Files:**
- Create: `apps/frontend-admin/src/components/SearchableSelect.tsx`

**Interfaces:**
- Produces: `export interface SearchableSelectOption { value: string; label: string; isDefault?: boolean }`, `export function SearchableSelect(props: SearchableSelectProps): React.JSX.Element` — consumato da Task 3, 4, 5, 6.

- [ ] **Step 1: Crea il componente**

```tsx
// apps/frontend-admin/src/components/SearchableSelect.tsx
import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  isDefault?: boolean;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = '-- Seleziona --',
  disabled = false,
  className = 'form-select',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    return [...options].sort((a, b) => {
      if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label, 'it');
    });
  }, [options]);

  const filtered = useMemo(() => {
    if (!query) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(o => o.label.toLowerCase().includes(q));
  }, [sorted, query]);

  const selected = options.find(o => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  const commit = (opt: SearchableSelectOption) => {
    onChange(opt.value);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIndex]) commit(filtered[highlightIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="position-relative" ref={containerRef}>
      <input
        type="text"
        className={className}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {value && !open && (
        <button
          type="button"
          className="btn btn-sm btn-link position-absolute top-0 end-0 text-secondary p-1"
          style={{ textDecoration: 'none' }}
          tabIndex={-1}
          onClick={() => onChange('')}
          title="Pulisci selezione"
        >
          ×
        </button>
      )}
      {open && (
        <div
          className="position-absolute w-100 bg-white border rounded shadow-sm mt-1"
          style={{ zIndex: 1050, maxHeight: 260, overflowY: 'auto' }}
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-muted small">Nessun risultato</div>
          ) : (
            filtered.map((opt, idx) => (
              <div
                key={opt.value}
                className={`px-3 py-2 small ${idx === highlightIndex ? 'bg-primary text-white' : ''}`}
                style={{ cursor: 'pointer' }}
                onMouseDown={(e) => { e.preventDefault(); commit(opt); }}
                onMouseEnter={() => setHighlightIndex(idx)}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore (componente non ancora importato da nessuno, ma deve compilare isolatamente).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/components/SearchableSelect.tsx
git commit -m "feat(frontend-admin): componente SearchableSelect (combobox ricercabile default-first)"
```

---

### Task 2: `settSendTaxonomies` — campo `isDefault` + bottone "Imposta come predefinita"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: `settSendTaxonomies: Array<{ code: string; label: string; isDefault?: boolean }>` — consumato da Task 5.

- [ ] **Step 1: Estendi il tipo dello stato**

Cerca (dichiarazione stato, circa riga 1426):

```tsx
  const [settSendTaxonomies, setSettSendTaxonomies] = useState<Array<{ code: string; label: string }>>([]);
```

Sostituisci con:

```tsx
  const [settSendTaxonomies, setSettSendTaxonomies] = useState<Array<{ code: string; label: string; isDefault?: boolean }>>([]);
```

- [ ] **Step 2: Aggiungi bottone "Imposta come predefinita" per riga**

Cerca il blocco (lista tassonomie abilitate editabile, circa righe 10817-10846):

```tsx
                              {settSendTaxonomies.map((t, idx) => (
                                <div key={idx} className="d-flex gap-2 mb-2">
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    style={{ maxWidth: 120 }}
                                    placeholder="Codice"
                                    value={t.code}
                                    maxLength={7}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, code: e.target.value.toUpperCase() } : row))}
                                  />
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Etichetta descrittiva"
                                    value={t.label}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, label: e.target.value } : row))}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-outline-danger btn-sm"
                                    onClick={() => setSettSendTaxonomies(prev => prev.filter((_, i) => i !== idx))}
                                  >
                                    Rimuovi
                                  </button>
                                </div>
                              ))}
```

Sostituisci con (bottone stella tra i due input e "Rimuovi"; il default è relativo al gruppo P/N del `code` della riga cliccata — azzera `isDefault` solo sulle righe con lo stesso suffisso, mai su quelle dell'altro gruppo):

```tsx
                              {settSendTaxonomies.map((t, idx) => (
                                <div key={idx} className="d-flex gap-2 mb-2 align-items-center">
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    style={{ maxWidth: 120 }}
                                    placeholder="Codice"
                                    value={t.code}
                                    maxLength={7}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, code: e.target.value.toUpperCase() } : row))}
                                  />
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Etichetta descrittiva"
                                    value={t.label}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, label: e.target.value } : row))}
                                  />
                                  {!t.isDefault && (
                                    <button
                                      type="button"
                                      className="btn btn-outline-primary btn-sm text-nowrap"
                                      title="Imposta come predefinita (per il proprio gruppo con/senza pagamento)"
                                      onClick={() => {
                                        const suffix = t.code.slice(-1);
                                        setSettSendTaxonomies(prev => prev.map((row, i) => {
                                          if (i === idx) return { ...row, isDefault: true };
                                          if (row.code.slice(-1) === suffix) return { ...row, isDefault: false };
                                          return row;
                                        }));
                                      }}
                                    >
                                      <Star size={14} />
                                    </button>
                                  )}
                                  {t.isDefault && (
                                    <span className="badge bg-primary text-nowrap">Predefinita</span>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn-outline-danger btn-sm"
                                    onClick={() => setSettSendTaxonomies(prev => prev.filter((_, i) => i !== idx))}
                                  >
                                    Rimuovi
                                  </button>
                                </div>
                              ))}
```

`Star` è già importato da `lucide-react` in cima al file (usato per mail-configs/io-services in una feature precedente) — verifica con `grep -n "  Minus, Star," apps/frontend-admin/src/App.tsx`, nessuna azione se già presente.

- [ ] **Step 3: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Impostazioni → SEND → aggiungi almeno 2 tassonomie con `code` finali `P` e 2 con finale `N`. Clicca "Imposta come predefinita" su una riga `P`: verifica che il badge "Predefinita" appaia solo lì tra le righe `P`, le righe `N` non cambiano. Ripeti su una riga `N`: verifica indipendenza. Salva impostazioni, ricarica pagina, verifica che i default persistano (letti da `send.enabledTaxonomyCodes`).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): doppio default (con/senza pagamento) per tassonomie SEND abilitate"
```

---

### Task 3: Sostituzione select mittenti PEC/EMAIL (3 punti)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `SearchableSelect`/`SearchableSelectOption` (Task 1).

- [ ] **Step 1: Import del componente**

In cima ad `App.tsx`, dopo l'import di `TemplateEditor`:

```tsx
import { TemplateEditor } from './components/TemplateEditor';
import { SearchableSelect } from './components/SearchableSelect';
```

- [ ] **Step 2: Sostituisci il blocco "Server di Invio / Mittente" (wizard step avanzato)**

Cerca:

```tsx
                        {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                          <div className="mb-3">
                            <label className="form-label small fw-bold text-dark mb-1">Server di Invio / Mittente *</label>
                            <select
                              className="form-select"
                              value={wizMailConfigId}
                              onChange={e => setWizMailConfigId(e.target.value)}
                              required
                            >
                              <option value="">-- Seleziona Configurazione Mittente --</option>
                              {mailConfigs
                                .filter(c => c.type === wizChannel && c.active)
                                .map(c => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} ({c.fromAddress}){c.isDefault ? ' (Predefinito)' : ''}
                                  </option>
                                ))}
                            </select>
                            {mailConfigs.filter(c => c.type === wizChannel && c.active).length === 0 && (
                              <div className="form-text text-danger small mt-1">
                                Attenzione: non ci sono configurazioni attive per il canale {wizChannel}. Creane una nelle impostazioni.
                              </div>
                            )}
                          </div>
                        )}
```

Sostituisci con:

```tsx
                        {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                          <div className="mb-3">
                            <label className="form-label small fw-bold text-dark mb-1">Server di Invio / Mittente *</label>
                            <SearchableSelect
                              className="form-select"
                              value={wizMailConfigId}
                              onChange={setWizMailConfigId}
                              placeholder="-- Seleziona Configurazione Mittente --"
                              options={mailConfigs
                                .filter(c => c.type === wizChannel && c.active)
                                .map(c => ({ value: c.id, label: `${c.name} (${c.fromAddress})`, isDefault: c.isDefault }))}
                            />
                            {mailConfigs.filter(c => c.type === wizChannel && c.active).length === 0 && (
                              <div className="form-text text-danger small mt-1">
                                Attenzione: non ci sono configurazioni attive per il canale {wizChannel}. Creane una nelle impostazioni.
                              </div>
                            )}
                          </div>
                        )}
```

- [ ] **Step 3: Sostituisci il blocco "Server di Invio / Mittente" (wizard step compatto)**

Cerca:

```tsx
                  {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Server di Invio / Mittente *</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMailConfigId}
                        onChange={e => setWizMailConfigId(e.target.value)}
                        required
                      >
                        <option value="">-- Seleziona Configurazione Mittente --</option>
                        {mailConfigs
                          .filter(c => c.type === wizChannel && c.active)
                          .map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.fromAddress}){c.isDefault ? ' (Predefinito)' : ''}
                            </option>
                          ))}
                      </select>
                      {mailConfigs.filter(c => c.type === wizChannel && c.active).length === 0 && (
                        <div className="form-text text-danger small">
                          Attenzione: non ci sono configurazioni attive per il canale {wizChannel}. Creane una nelle impostazioni.
                        </div>
                      )}
                    </div>
                  )}
```

Sostituisci con:

```tsx
                  {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Server di Invio / Mittente *</label>
                      <SearchableSelect
                        className="form-select form-select-sm"
                        value={wizMailConfigId}
                        onChange={setWizMailConfigId}
                        placeholder="-- Seleziona Configurazione Mittente --"
                        options={mailConfigs
                          .filter(c => c.type === wizChannel && c.active)
                          .map(c => ({ value: c.id, label: `${c.name} (${c.fromAddress})`, isDefault: c.isDefault }))}
                      />
                      {mailConfigs.filter(c => c.type === wizChannel && c.active).length === 0 && (
                        <div className="form-text text-danger small">
                          Attenzione: non ci sono configurazioni attive per il canale {wizChannel}. Creane una nelle impostazioni.
                        </div>
                      )}
                    </div>
                  )}
```

- [ ] **Step 4: Sostituisci il blocco "Mittente PEC di riserva (verifica INAD)"**

Cerca:

```tsx
                  {(wizChannel === 'EMAIL' || wizChannel === 'POSTAL' || wizChannel === 'APP_IO') && (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Mittente PEC di riserva (verifica INAD)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizPecReserveMailConfigId}
                        onChange={e => setWizPecReserveMailConfigId(e.target.value)}
                      >
                        <option value="">-- Nessuno --</option>
                        {mailConfigs
                          .filter(c => c.type === 'PEC' && c.active)
                          .map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.fromAddress}){c.isDefault ? ' (Predefinito)' : ''}
                            </option>
                          ))}
                      </select>
                      <div className="form-text small text-muted">
                        Usato solo se un destinatario risulta avere un domicilio digitale INAD attivo: l'invio a quel destinatario passa automaticamente su PEC.
                      </div>
                    </div>
                  )}
```

Sostituisci con:

```tsx
                  {(wizChannel === 'EMAIL' || wizChannel === 'POSTAL' || wizChannel === 'APP_IO') && (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Mittente PEC di riserva (verifica INAD)</label>
                      <SearchableSelect
                        className="form-select form-select-sm"
                        value={wizPecReserveMailConfigId}
                        onChange={setWizPecReserveMailConfigId}
                        placeholder="-- Nessuno --"
                        options={mailConfigs
                          .filter(c => c.type === 'PEC' && c.active)
                          .map(c => ({ value: c.id, label: `${c.name} (${c.fromAddress})`, isDefault: c.isDefault }))}
                      />
                      <div className="form-text small text-muted">
                        Usato solo se un destinatario risulta avere un domicilio digitale INAD attivo: l'invio a quel destinatario passa automaticamente su PEC.
                      </div>
                    </div>
                  )}
```

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser**

Wizard invio singolo e massivo, canale PEC/EMAIL: verifica che il mittente predefinito appaia primo nell'elenco, digitando parte del nome la lista si filtra, la selezione funziona (click e Enter da tastiera). Verifica anche "Mittente PEC di riserva" nello step con canale EMAIL/POSTAL/APP_IO.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): select mittenti PEC/EMAIL ricercabili e ordinate (default primo)"
```

---

### Task 4: Sostituzione select servizi App IO (5 punti)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `SearchableSelect` (Task 1).

- [ ] **Step 1: Sostituisci "Servizio App IO Associato" (wizard step avanzato)**

Cerca:

```tsx
                        {wizChannel === 'APP_IO' && (
                          <div className="mb-3">
                            <label className="form-label small fw-bold text-dark mb-1">Servizio App IO Associato *</label>
                            <select
                              className="form-select"
                              value={wizAppIoServiceId}
                              onChange={e => setWizAppIoServiceId(e.target.value)}
                              required
                            >
                              <option value="">-- Seleziona Servizio App IO --</option>
                              {ioServices.map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
```

Sostituisci con:

```tsx
                        {wizChannel === 'APP_IO' && (
                          <div className="mb-3">
                            <label className="form-label small fw-bold text-dark mb-1">Servizio App IO Associato *</label>
                            <SearchableSelect
                              className="form-select"
                              value={wizAppIoServiceId}
                              onChange={setWizAppIoServiceId}
                              placeholder="-- Seleziona Servizio App IO --"
                              options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                            />
                          </div>
                        )}
```

Nota: questo blocco (label "Servizio App IO Associato *", wrapper `mb-3`) è testualmente diverso dal blocco Step 2 sottostante (label "Servizio App IO *", wrapper `mt-3`) — la ricerca per testo esatto non è ambigua.

- [ ] **Step 2: Sostituisci il servizio App IO in co-consegna "parallel" (wizard step compatto)**

Cerca:

```tsx
                              {wizAppIoMode === 'parallel' && (
                                <div className="mt-3">
                                  <label className="form-label small fw-bold text-dark mb-1">Servizio App IO *</label>
                                  <select
                                    className="form-select"
                                    value={wizAppIoServiceId}
                                    onChange={e => setWizAppIoServiceId(e.target.value)}
                                    required
                                  >
                                    <option value="">-- Seleziona Servizio App IO --</option>
                                    {ioServices.map(s => (
                                      <option key={s.id} value={s.id}>
                                        {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}
```

Sostituisci con:

```tsx
                              {wizAppIoMode === 'parallel' && (
                                <div className="mt-3">
                                  <label className="form-label small fw-bold text-dark mb-1">Servizio App IO *</label>
                                  <SearchableSelect
                                    className="form-select"
                                    value={wizAppIoServiceId}
                                    onChange={setWizAppIoServiceId}
                                    placeholder="-- Seleziona Servizio App IO --"
                                    options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                                  />
                                </div>
                              )}
```

- [ ] **Step 3: Sostituisci il servizio App IO nella card "Co-consegna su App IO" (EMAIL/PEC/POSTAL)**

Cerca (blocco interno, dentro la card — NON toccare la select "Modalità Co-consegna" subito sopra, resta nativa):

```tsx
                        {wizAppIoMode !== 'none' && (
                          <div className="mb-0">
                            <label className="form-label small fw-bold">Servizio App IO *</label>
                            <select
                              className="form-select form-select-sm"
                              value={wizAppIoServiceId}
                              onChange={e => setWizAppIoServiceId(e.target.value)}
                              required
                            >
                              <option value="">-- Seleziona Servizio App IO --</option>
                              {ioServices.map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
```

Sostituisci con:

```tsx
                        {wizAppIoMode !== 'none' && (
                          <div className="mb-0">
                            <label className="form-label small fw-bold">Servizio App IO *</label>
                            <SearchableSelect
                              className="form-select form-select-sm"
                              value={wizAppIoServiceId}
                              onChange={setWizAppIoServiceId}
                              placeholder="-- Seleziona Servizio App IO --"
                              options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                            />
                          </div>
                        )}
```

- [ ] **Step 4: Sostituisci "Servizio App IO Associato" ramo `wizChannel==='APP_IO'` (step compatto)**

Cerca:

```tsx
                  {wizChannel === 'APP_IO' && (
                    <div className="mb-4">
                      <label className="form-label small fw-bold text-dark">Servizio App IO Associato *</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizAppIoServiceId}
                        onChange={e => setWizAppIoServiceId(e.target.value)}
                        required
                      >
                        <option value="">-- Seleziona Servizio App IO --</option>
                        {ioServices.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
```

Sostituisci con:

```tsx
                  {wizChannel === 'APP_IO' && (
                    <div className="mb-4">
                      <label className="form-label small fw-bold text-dark">Servizio App IO Associato *</label>
                      <SearchableSelect
                        className="form-select form-select-sm"
                        value={wizAppIoServiceId}
                        onChange={setWizAppIoServiceId}
                        placeholder="-- Seleziona Servizio App IO --"
                        options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                      />
                    </div>
                  )}
```

- [ ] **Step 5: Sostituisci il select in "Verifica massiva App IO" (fuori wizard)**

Cerca:

```tsx
                        <label className="form-label small fw-bold">Servizio App IO da usare per la verifica</label>
                        <select className="form-select form-select-sm" value={verificaBulkServiceId} onChange={e => setVerificaBulkServiceId(e.target.value)}>
                          {ioServices.map(s => (
                            <option key={s.id} value={s.id}>{s.nome}{s.isDefault ? ' (predefinito)' : ''}</option>
                          ))}
                        </select>
```

Sostituisci con:

```tsx
                        <label className="form-label small fw-bold">Servizio App IO da usare per la verifica</label>
                        <SearchableSelect
                          className="form-select form-select-sm"
                          value={verificaBulkServiceId}
                          onChange={setVerificaBulkServiceId}
                          placeholder="-- Seleziona Servizio App IO --"
                          options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                        />
```

Nota: questo select originale non aveva un'opzione vuota selezionabile (nessun `<option value="">`), quindi `verificaBulkServiceId` partiva già valorizzato al primo servizio della lista. Con `SearchableSelect` senza value iniziale può mostrarsi vuoto: verificare al Step 6 se serve preselezionare `verificaBulkServiceId` col servizio default all'`useEffect`/mount della pagina (cercare `setVerificaBulkServiceId` per capire se già esiste un'inizializzazione; se non esiste, aggiungerla con lo stesso criterio "default attivo, altrimenti primo" usato altrove nel file, es. `ioServices.find(s => s.isDefault) || ioServices[0]`).

- [ ] **Step 6: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 7: Verifica manuale in browser**

Wizard canale APP_IO (diretto ed esclusiva/parallela da altri canali): verifica ordine e ricerca. Pagina "Verifica App IO" (menu Utility): verifica che il select servizio funzioni e che, se `verificaBulkServiceId` risultava vuoto dopo la sostituzione (Step 5), sia stato corretto.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): select servizi App IO ricercabili e ordinate (default primo)"
```

---

### Task 5: Sostituzione select tassonomie SEND nel wizard (2 punti) + nuovo formato label

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `SearchableSelect` (Task 1), `settSendTaxonomies[].isDefault` (Task 2).

- [ ] **Step 1: Sostituisci la select "Tassonomia SEND *" (wizard step avanzato)**

Cerca:

```tsx
                              <label className="form-label small fw-bold text-dark mb-1">Tassonomia SEND *</label>
                              <select
                                className="form-select"
                                value={wizTaxonomyCode}
                                onChange={e => setWizTaxonomyCode(e.target.value)}
                                required
                              >
                                <option value="">-- Seleziona tassonomia --</option>
                                {settSendTaxonomies
                                  .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                                  .map(t => (
                                    <option key={t.code} value={t.code}>{t.code} — {t.label}</option>
                                  ))}
                              </select>
```

Sostituisci con:

```tsx
                              <label className="form-label small fw-bold text-dark mb-1">Tassonomia SEND *</label>
                              <SearchableSelect
                                className="form-select"
                                value={wizTaxonomyCode}
                                onChange={setWizTaxonomyCode}
                                placeholder="-- Seleziona tassonomia --"
                                options={settSendTaxonomies
                                  .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                                  .map(t => ({ value: t.code, label: `${t.label} - ${t.code}`, isDefault: t.isDefault }))}
                              />
```

- [ ] **Step 2: Sostituisci la select "Tassonomia SEND *" (wizard step compatto)**

Cerca:

```tsx
                        <label className="form-label small fw-bold">Tassonomia SEND *</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizTaxonomyCode}
                          onChange={e => setWizTaxonomyCode(e.target.value)}
                          required
                        >
                          <option value="">-- Seleziona tassonomia --</option>
                          {settSendTaxonomies
                            .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                            .map(t => (
                              <option key={t.code} value={t.code}>{t.code} — {t.label}</option>
                            ))}
                        </select>
```

Sostituisci con:

```tsx
                        <label className="form-label small fw-bold">Tassonomia SEND *</label>
                        <SearchableSelect
                          className="form-select form-select-sm"
                          value={wizTaxonomyCode}
                          onChange={setWizTaxonomyCode}
                          placeholder="-- Seleziona tassonomia --"
                          options={settSendTaxonomies
                            .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                            .map(t => ({ value: t.code, label: `${t.label} - ${t.code}`, isDefault: t.isDefault }))}
                        />
```

- [ ] **Step 3: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Wizard canale SEND: con almeno una tassonomia P e una N marcate predefinite (Task 2), verifica che togglando "Integrazione pagamenti pagoPA" cambi il sottoinsieme mostrato e che la predefinita del sottoinsieme corrente sia sempre la prima opzione. Verifica label nel formato "Descrizione - CODICE".

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): select tassonomia SEND nel wizard ricercabile, ordinata, nuovo formato label"
```

---

### Task 6: Sostituzione select "Scegli tassonomia da elenco ufficiale" (Impostazioni)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `SearchableSelect` (Task 1).

- [ ] **Step 1: Sostituisci la select**

Cerca:

```tsx
                                <select
                                  className="form-select form-select-sm"
                                  value={wizAddTaxonomyCode}
                                  onChange={(e) => setWizAddTaxonomyCode(e.target.value)}
                                >
                                  <option value="">-- Scegli tassonomia da elenco ufficiale --</option>
                                  {SEND_TAXONOMY_CATALOG
                                    .filter(t => !settSendEntityType || t.entityType === settSendEntityType)
                                    .map(t => (
                                      <option key={t.code} value={t.code}>{t.code} — {t.title}</option>
                                    ))}
                                </select>
```

Sostituisci con:

```tsx
                                <SearchableSelect
                                  className="form-select form-select-sm"
                                  value={wizAddTaxonomyCode}
                                  onChange={setWizAddTaxonomyCode}
                                  placeholder="-- Scegli tassonomia da elenco ufficiale --"
                                  options={SEND_TAXONOMY_CATALOG
                                    .filter(t => !settSendEntityType || t.entityType === settSendEntityType)
                                    .map(t => ({ value: t.code, label: `${t.title} - ${t.code}` }))}
                                />
```

Nessun `isDefault` qui: è il catalogo statico completo da cui aggiungere, non il sottoinsieme abilitato — ordinamento risultante puramente alfabetico su `title`.

- [ ] **Step 2: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 3: Verifica manuale in browser**

Impostazioni → SEND: verifica che il select "Scegli tassonomia da elenco ufficiale" sia ricercabile, ordinato alfabeticamente su descrizione, label nel formato "Descrizione - CODICE", e che "+ Aggiungi da elenco" continui a funzionare (aggiunge la riga in `settSendTaxonomies`).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): select catalogo tassonomie SEND ricercabile e ordinata alfabeticamente"
```

---

### Task 7: Verifica finale

**Files:** nessuna modifica, solo verifica.

- [ ] **Step 1: Type-check completo**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 2: Suite backend (nessuna modifica backend attesa, verifica assenza regressioni)**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: failure set identico alla baseline nota (solo `app.controller.spec.ts`/`isLdapMock`).

- [ ] **Step 3: Rebuild e verifica E2E completa in browser**

```bash
docker compose up -d --build frontend-admin
```

Percorri, per ciascuno degli 11 punti sostituiti: apertura dropdown, digitazione filtro, navigazione tastiera (frecce+Enter), click su opzione, bottone "×" per pulire, click esterno per chiudere senza selezionare. Verifica in particolare:
- Predefinito sempre primo in ogni lista (mittenti PEC/EMAIL, servizi App IO, tassonomie SEND P e N separatamente, catalogo tassonomie).
- Nessuna regressione sulle select rimaste native (Modalità Co-consegna, Tipo comunicazione fisica, Tipologia Ente) — non toccate da questo piano.

- [ ] **Step 4: Nessun commit aggiuntivo (task di sola verifica)**
