# Swap Icone FontAwesome → Lucide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire tutte le 361 occorrenze `<i className="fas fa-...">`
in `App.tsx` (10982 righe) con componenti `lucide-react`, inclusi gli 8
punti dove l'icona è scelta a runtime (mappe status/canale, toggle,
condizioni), poi rimuovere il CDN FontAwesome.

**Architecture:** Un solo file applicativo toccato (`App.tsx`), spezzato
in 5 batch sequenziali per riga (ogni batch è un task revieware
indipendentemente via `tsc`), più un task di cleanup finale (rimozione
CDN) e uno di verifica browser. `package.json`/`index.html` toccati una
volta sola nel primo e nell'ultimo task.

**Tech Stack:** React 19, `lucide-react` (nuova dipendenza). Nessun
framework di test frontend — verifica: `tsc --noEmit` + grep di
copertura + walkthrough browser finale.

## Global Constraints

- **Fonte di verità per la mappatura nome-icona**: la tabella completa
  in `docs/superpowers/specs/2026-07-20-swap-icone-lucide-design.md`
  (sezione "Tabella di mappatura"). Ogni batch usa quella tabella, non
  ne inventa una propria.
- **Import nominali**, mai `import * as Icons` — ogni batch aggiunge le
  proprie icone all'unico blocco di import in cima al file (riga 1 di
  `App.tsx` circa, dopo gli import React esistenti), senza duplicare
  nomi già importati da un batch precedente.
- **Verifica nomi Lucide prima dell'uso**: per i nomi segnalati come "da
  verificare" nella tabella (`ShieldCheck`, `IdCard`, `Contact`,
  `BookUser`, `CircleUserRound`), controllare che il componente esista
  davvero (`grep "declare_const_default.*NomeIcona\|export declare const NomeIcona"
  node_modules/lucide-react/dist/lucide-react.d.ts` dentro il
  container, oppure equivalente) prima di importarlo. Se non esiste,
  scegliere la sostituzione visivamente più vicina disponibile e
  annotarla nel report come deviazione.
- **`size` esplicito**: `size={16}` di default; `size={24}` dove
  l'originale aveva `fa-2x`, `size={32}` dove aveva `fa-3x`. Le classi
  utility esistenti (`me-1`, `me-2`, `text-primary`, `text-danger`...)
  restano sull'elemento sostituito via `className`.
- **`.icon-spin`**: nuova classe CSS in `no-bootstrap-compat.css`
  (`animation: spin 1s linear infinite;`, riusa il `@keyframes spin`
  già esistente a riga 596) per ogni icona che sostituisce un
  `fa-spin`/`fa-spinner` con animazione attiva — aggiunta nel primo
  batch che la incontra, non ridefinita nei successivi.
- Type-check: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
  dopo ogni batch.
- **Non rimuovere il CDN FontAwesome (`index.html:7`) prima dell'ultimo
  task** — le icone non ancora convertite nei batch precedenti
  sparirebbero.

---

### Task 1: Dipendenza + `.icon-spin` + Batch 1 (righe 1-2200)

**Files:**
- Modify: `apps/frontend-admin/package.json` (aggiungi `lucide-react`)
- Modify: `apps/frontend-admin/src/assets/css/no-bootstrap-compat.css` (aggiungi `.icon-spin`)
- Modify: `apps/frontend-admin/src/App.tsx:1-2200`

**Interfaces:**
- Produces: import Lucide in cima al file (blocco unico, i batch
  successivi vi aggiungono altre righe), classe `.icon-spin`.
- Consumes: tabella di mappatura in
  `docs/superpowers/specs/2026-07-20-swap-icone-lucide-design.md`.

- [ ] **Step 1: Aggiungi la dipendenza**

Fuori dal container (`MSYS_NO_PATHCONV=1 docker run --rm -v
"${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack
prepare pnpm@latest --activate && pnpm install --lockfile-only
--ignore-scripts"` dopo aver aggiunto `"lucide-react": "^0.400.0"` — o
la versione più recente disponibile — alle `dependencies` di
`apps/frontend-admin/package.json`), poi `docker compose build
frontend-admin` e `docker compose up -d frontend-admin`. Verificare che
non compaia `ERR_PNPM_IGNORED_BUILDS`.

- [ ] **Step 2: Aggiungi `.icon-spin`**

In `no-bootstrap-compat.css`, subito dopo il blocco `@keyframes spin { to
{ transform: rotate(360deg); } }` (righe 596-598), aggiungi:

```css
.icon-spin {
  animation: spin 1s linear infinite;
}
```

- [ ] **Step 3: Import Lucide + sostituzioni riga 1-2200**

Nelle prime 2200 righe di `App.tsx` (che includono i 4 blocchi
dati-driven `CHANNEL_META`/`SEND_STATUS_META`/`POSTAL_STATUS_META`/
`ChannelStatusBar` a righe ~17-162 — vedi punto 1 della sezione "Icone
con nome dinamico" nella spec), applica:

1. Grep `fa-` limitato a queste righe per enumerare le occorrenze reali.
2. Per ognuna, applica la tabella di mappatura dello spec (find
   l'icona statica `<i className="fas fa-X ...">` → `<X .../>`).
3. Per il blocco dati-driven (righe ~17-162): cambia il tipo `StatusMeta`
   (riga 101) da `icon: string` a `icon: React.ComponentType<{
   className?: string; size?: number }>`; ogni entry di `CHANNEL_META`
   (17-23), `SEND_STATUS_META` (77-88), `POSTAL_STATUS_META` (143-157)
   passa da stringa a componente importato (es. `icon: Mail` invece di
   `icon: 'fa-envelope'`); i fallback (righe 31, 93, 162) passano da
   `icon: 'fa-paper-plane'`/`'fa-circle-question'` ai componenti `Send`/
   `HelpCircle`. Il consumo in `ChannelStatusBar` (riga 130) diventa:
   ```tsx
   {(() => { const Icon = m ? m.icon : Hourglass; return <Icon className="me-1" size={14} />; })()}
   ```
4. Aggiungi in cima al file un blocco import con tutte le icone Lucide
   usate in questo batch (nomi esatti dedotti dalla tabella per ogni
   occorrenza trovata al punto 1, più `Mail`, `MailOpen`,
   `MailCheck`, `Mails`, `Globe`, `HelpCircle`, `Send`, `Hourglass`,
   `Truck`, `Inbox`, `Ban`, `Eye`, `CalendarCheck`, `Banknote`, `UserX`,
   `X`, `RotateCcw` per i `_STATUS_META`).

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (import mancanti o nomi Lucide inesistenti
falliscono qui — risolvere prima di procedere).

- [ ] **Step 5: Grep di copertura sul range**

Run: `sed -n '1,2200p' apps/frontend-admin/src/App.tsx | grep -c 'fa-'`
Expected: 0 (a parte eventuali falsi positivi non-icona, es. nomi
variabile — verificare manualmente se il conteggio non è zero).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/package.json pnpm-lock.yaml apps/frontend-admin/src/assets/css/no-bootstrap-compat.css apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): lucide-react, icon-spin, swap icone righe 1-2200"
```

---

### Task 2: Batch 2 (righe 2201-4400)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:2201-4400`

**Interfaces:**
- Consumes: import Lucide esistente (Task 1) — aggiungi solo le icone
  nuove di questo range, non ridichiarare quelle già importate.

Questo range include 5 dei punti "icona dinamica" della spec — gestirli
con il codice esatto indicato, non con find-replace:

- **Riga ~3105, ~3399** (messaggi provider Postal/Mail): `` `fas
  ${x.error ? 'fa-triangle-exclamation' : 'fa-check-circle'}` `` diventa
  `{x.error ? <AlertTriangle /> : <CheckCircle2 />}` (stesso pattern
  ripetuto identico nei due punti).
- **Riga ~3204, ~3471**: `` `fas fa-toggle-${p.active ? 'on' :
  'off'}` `` (rispettivamente `p.active` e `c.active`) diventa
  `{p.active ? <ToggleRight /> : <ToggleLeft />}`.
- **Riga ~3433**: `` `fas ${type === 'EMAIL' ? 'fa-envelope' :
  'fa-envelope-open-text'}` `` diventa `{type === 'EMAIL' ? <Mail /> :
  <MailOpen />}`.

Le righe esatte possono essere leggermente spostate dai batch precedenti
— localizzare per contenuto (`postalProviderMsg.error`,
`mailConfigMsg.error`, `p.active`/`c.active` in un contesto di toggle
provider, `type === 'EMAIL'`), non per numero di riga cieco.

- [ ] **Step 1: Sostituzioni statiche + i 5 punti dinamici sopra**

Grep `fa-` sul range, applica la tabella di mappatura per ogni
occorrenza statica, applica il codice esatto sopra per i 5 punti
dinamici.

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Grep di copertura**

Run: `sed -n '2201,4400p' apps/frontend-admin/src/App.tsx | grep -c 'fa-'`
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): swap icone righe 2201-4400"
```

---

### Task 3: Batch 3 (righe 4401-6600)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:4401-6600`

**Interfaces:**
- Consumes: import Lucide esistente — aggiungi solo le icone nuove.

- [ ] **Step 1: Sostituzioni statiche**

Grep `fa-` sul range, applica la tabella di mappatura per ogni
occorrenza. Nessun punto dinamico noto in questo range (verificare
comunque con `grep -n "className={\`" apps/frontend-admin/src/App.tsx`
limitato a queste righe — se emerge un pattern dinamico non
documentato nello spec, trattarlo con lo stesso criterio dei punti
elencati nel Task 2: due componenti Lucide scelti da una condizione,
mai una stringa di classe dinamica).

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Grep di copertura**

Run: `sed -n '4401,6600p' apps/frontend-admin/src/App.tsx | grep -c 'fa-'`
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): swap icone righe 4401-6600"
```

---

### Task 4: Batch 4 (righe 6601-8800)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:6601-8800`

**Interfaces:**
- Consumes: import Lucide esistente — aggiungi solo le icone nuove.

Include 1 punto dinamico:

- **Riga ~8722** (messaggio salvataggio impostazioni,
  `settingsSavedMessage.error`): stesso pattern di riga ~3105/~3399,
  `{settingsSavedMessage.error ? <AlertTriangle /> : <CheckCircle2 />}`.

- [ ] **Step 1: Sostituzioni statiche + punto dinamico sopra**

Grep `fa-` sul range, applica la tabella per le occorrenze statiche,
applica il pattern sopra per il punto dinamico.

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Grep di copertura**

Run: `sed -n '6601,8800p' apps/frontend-admin/src/App.tsx | grep -c 'fa-'`
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): swap icone righe 6601-8800"
```

---

### Task 5: Batch 5 (righe 8801-fine file) + `channelIcon`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:8801-10982`

**Interfaces:**
- Consumes: import Lucide esistente — aggiungi solo le icone nuove.

Include 2 punti dinamici:

- **Riga ~9681** (toggle form nuovo servizio App IO,
  `showNewSvcForm`): `` `fas ${showNewSvcForm ? 'fa-minus' :
  'fa-plus'} me-1` `` diventa `{showNewSvcForm ? <Minus
  className="me-1" /> : <Plus className="me-1" />}`.
- **Riga ~9945** (refresh motori, `loadingEngines`): `` `fas fa-sync-alt
  ${loadingEngines ? 'fa-spin' : ''}` `` diventa `<RefreshCw
  className={loadingEngines ? 'icon-spin' : ''} />`.
- **Righe ~9973-9991** (`channelIcon`, mappa locale canale→icona): il
  tipo `const channelIcon: Record<string, string>` diventa
  `Record<string, React.ComponentType<{ className?: string; size?:
  number }>>`; i valori passano da stringa a componente:
  ```typescript
  const channelIcon: Record<string, React.ComponentType<{ className?: string; size?: number }>> = {
    EMAIL: Mail,
    PEC: MailOpen,
    APP_IO: Smartphone,
    SEND: Send,
    POSTAL: Mails,
    PROTOCOLLAZIONE: Stamp,
  };
  ```
  Il consumo (riga ~9991, `<i className={`fas
  ${channelIcon[eng.channel] ?? 'fa-cog'}`}></i>`) diventa:
  ```tsx
  {(() => { const Icon = channelIcon[eng.channel] ?? Settings; return <Icon />; })()}
  ```

- [ ] **Step 1: Sostituzioni statiche + 3 punti dinamici sopra**

Grep `fa-` sul range, applica la tabella per le occorrenze statiche,
applica il codice esatto sopra per i 3 punti dinamici.

- [ ] **Step 2: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Grep di copertura sull'intero file**

Run: `grep -n 'fa-' apps/frontend-admin/src/App.tsx`
Expected: nessun match reale (0 risultati, o solo falsi positivi da
verificare manualmente uno per uno — es. un nome variabile che contiene
"fa-" per coincidenza). Questo è il grep di copertura FINALE su tutto
il file, non solo sul range di questo batch — conferma che nessun
batch precedente ha lasciato residui.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): swap icone righe 8801-fine, channelIcon dinamico"
```

---

### Task 6: Rimozione CDN FontAwesome

**Files:**
- Modify: `apps/frontend-admin/index.html:7`

**Interfaces:** nessuna — task di sola pulizia, eseguito solo dopo che
il Task 5 ha confermato zero occorrenze `fa-` residue in `App.tsx`.

- [ ] **Step 1: Verifica preliminare**

Run: `grep -rn "fas fa-\|fa-solid\|className=\"fa " apps/frontend-admin/src/`
Expected: zero match in TUTTI i file sotto `src/`, non solo `App.tsx`
(controlla anche `TemplateEditor.tsx` e i CSS — se un file diverso da
`App.tsx` referenzia ancora classi `fa-*`, questo task si blocca:
riportarlo come `NEEDS_CONTEXT` invece di rimuovere il CDN, il file
extra va aggiunto come batch aggiuntivo prima di procedere qui).

- [ ] **Step 2: Rimuovi il link CDN**

Riga 7 di `apps/frontend-admin/index.html`, rimuovi interamente:
```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/index.html
git commit -m "chore(frontend-admin): rimuovi CDN FontAwesome, swap Lucide completo"
```

---

### Task 7: Verifica visiva browser (manuale — nessun test automatico frontend nel repo)

**Files:** nessuno (solo verifica).

**Interfaces:** nessuna.

- [ ] **Step 1: Avvia stack, verifica console browser pulita**

Login mock, apri devtools console: nessun errore React
("Element type is invalid" — sintomo classico di un import Lucide
sbagliato/named-export inesistente sfuggito al type-check se
qualche punto usa `any`).

- [ ] **Step 2: Viste rappresentative**

Dashboard, wizard "Invio Singolo" (tutti gli step, verifica icone
frecce/check/upload), "Invio Massivo" (tabella, badge canale — verifica
`CHANNEL_META`), "Motori" (verifica `channelIcon`), "Impostazioni" (tab
provider Postal/Mail, verifica toggle on/off e messaggi
errore/successo), "Statistiche". Confermare visivamente: nessuna icona
mancante (quadrato vuoto o icona di fallback), dimensioni coerenti con
il testo circostante (non icone giganti/minuscole rispetto a prima).

- [ ] **Step 3: Stati dinamici**

Attiva/disattiva un provider Mail/Postal (toggle on/off) — verifica
`ToggleRight`/`ToggleLeft` cambiano correttamente. Avvia un refresh
sulla vista "Motori" — verifica l'icona di sync ruota
(`.icon-spin`) durante il caricamento e si ferma al termine.

- [ ] **Step 4: Nessuna regressione dal reskin CSS**

Se il piano `2026-07-20-reskin-css-minimale.md` è già stato eseguito,
verificare che le nuove icone Lucide restino leggibili sui nuovi colori
(es. icone bianche su sidebar navy, icone su bottoni navy) — altrimenti
annotare l'ordine di esecuzione consigliato (questo piano prima del
reskin, o viceversa, in base a cosa si osserva).
