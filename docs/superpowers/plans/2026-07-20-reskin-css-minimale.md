# Reskin CSS Minimale/Flat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire i colori Bootstrap generici hardcoded in
`no-bootstrap-compat.css`/`backoffice-shell.css` con i token civici già
pronti in `tokens.css` (navy istituzionale `--bi-navy` al posto del blu
generico `#0066CC`), e appiattire le ombre decorative (bordi netti invece
di ombre pesanti) per la direzione "minimale/flat" scelta.

**Architecture:** Solo CSS — 4 file toccati
(`tokens.css`, `no-bootstrap-compat.css`, `backoffice-shell.css`,
`app.css`) più un piccolo numero di punti isolati in `App.tsx` dove uno
style inline o una costante hardcoded referenzia colori. Nessun nuovo
componente, nessuna dipendenza.

**Tech Stack:** CSS custom properties, React 19 (solo per i punti
isolati in App.tsx). Nessun framework di test frontend nel repo —
verifica: `tsc --noEmit` + walkthrough browser.

## Global Constraints

- Colore primario finale: `--brand-primary` deve risolvere a
  `var(--bi-navy)` (`#003366`), non più `var(--bi-primary)`
  (`#0066CC`, valore hardcoded oggi in giro — il cambio a
  `--brand-primary` da solo sarebbe stato un no-op).
- Direzione "quasi flat": le ombre puramente decorative (card statiche,
  bottoni a riposo) vanno ridotte/rimosse in favore di bordi sottili;
  le ombre funzionali (elementi flottanti — dropdown, toast, popover
  datepicker — e focus-ring accessibilità) restano, al massimo ridotte
  di intensità, mai rimosse.
- Type-check: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`.
- Nessuna modifica a `frontend-citizen`.

---

### Task 1: `tokens.css` — hover navy + repoint brand-primary

**Files:**
- Modify: `apps/frontend-admin/src/assets/css/tokens.css:58` (dopo
  `--bi-navy: #003366;`)
- Modify: `apps/frontend-admin/src/assets/css/tokens.css:104`
  (`--brand-primary`)

**Interfaces:**
- Produces: `--bi-navy-h` (nuova variabile), `--brand-primary` ripuntata
  — consumate da Task 2 e Task 3.

- [ ] **Step 1: Aggiungi `--bi-navy-h`**

Dopo la riga `--bi-navy: #003366;` (riga 58), aggiungi:

```css
  --bi-navy-h: #002448;   /* hover, piu' scuro di --bi-navy */
```

- [ ] **Step 2: Ripunta `--brand-primary`**

Riga 104, cambia:

```css
  /* prima */
  --brand-primary:   var(--bi-primary);   /* institutional blue — CTAs, links, headers */
```
in
```css
  /* dopo */
  --brand-primary:   var(--bi-navy);      /* navy istituzionale — CTAs, links, headers */
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (modifica CSS, non tocca TS).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/assets/css/tokens.css
git commit -m "feat(frontend-admin): brand-primary punta a navy invece di blu istituzionale"
```

---

### Task 2: `no-bootstrap-compat.css` — variabili + ombre

**Files:**
- Modify: `apps/frontend-admin/src/assets/css/no-bootstrap-compat.css:3-33` (blocco `:root`)
- Modify: `apps/frontend-admin/src/assets/css/no-bootstrap-compat.css:455` (`.shadow-sm`)
- Modify: `apps/frontend-admin/src/assets/css/no-bootstrap-compat.css:605` (`.toast`)

**Interfaces:**
- Consumes: `--brand-primary`, `--ms-danger`, `--ms-success`,
  `--ms-warning`, `--ms-info`, `--border-1`, `--fg-3`, `--r-sm`,
  `--shadow-1`, `--shadow-2` (tutti già definiti in `tokens.css`, Task 1
  non li tocca oltre a `--brand-primary`).

- [ ] **Step 1: Ripunta le variabili del blocco `:root`**

Righe 17-21 del blocco (subito prima di `--danger`), cambia:

```css
  /* prima */
  --border-color: #d9e2ec;
  --text-muted: #6c7a89;
  --primary: #0066cc;
  --danger: #b7283c;
  --success: #1f7a4d;
  --warning: #9e5a00;
  --info: #0259a8;
```
in
```css
  /* dopo */
  --border-color: var(--border-1);
  --text-muted: var(--fg-3);
  --primary: var(--brand-primary);
  --danger: var(--ms-danger);
  --success: var(--ms-success);
  --warning: var(--ms-warning);
  --info: var(--ms-info);
```

E righe 13-14 (radius), cambia:
```css
  /* prima */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
```
in
```css
  /* dopo */
  --radius-sm: var(--r-sm);
  --radius-md: var(--r-sm);   /* flat: stesso valore piccolo di sm, non il default arrotondato */
```

Non toccare le variabili `--bs-*` (righe 23-33, compatibilità TomSelect)
— restano invariate.

- [ ] **Step 2: `.shadow-sm` — riduci a `var(--shadow-1)`**

Riga 455, cambia:
```css
  /* prima */
.shadow-sm { box-shadow: 0 1px 5px rgba(30, 41, 59, 0.08); }
```
in
```css
  /* dopo */
.shadow-sm { box-shadow: var(--shadow-1); }
```

- [ ] **Step 3: `.toast` — riduci a `var(--shadow-2)`**

Riga 605, cambia:
```css
  /* prima */
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.15);
```
in
```css
  /* dopo */
  box-shadow: var(--shadow-2);
```

Il toast resta un elemento flottante (notifica sopra il contenuto) —
`--shadow-2` mantiene elevazione percepibile senza il blur pesante
originale.

**Non toccare** la riga 410 (`box-shadow: 0 0 0 3px rgba(0, 102, 204,
0.14);`, focus-ring su `.form-control:focus`) — è un indicatore di
accessibilità, non un'ombra decorativa, fuori scope per questo task.

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/assets/css/no-bootstrap-compat.css
git commit -m "feat(frontend-admin): no-bootstrap-compat usa token civici, ombre appiattite"
```

---

### Task 3: `backoffice-shell.css` — shell, sidebar, card, litepicker

**Files:**
- Modify: `apps/frontend-admin/src/assets/css/backoffice-shell.css:3-25` (blocco `:root`)
- Modify: `apps/frontend-admin/src/assets/css/backoffice-shell.css:979-982` (`.card-wizard`)
- Modify: `apps/frontend-admin/src/assets/css/backoffice-shell.css:1523-1532` (`.bo-hero-card:hover`)
- Modify: `apps/frontend-admin/src/assets/css/backoffice-shell.css:1755-1761` (variabili litepicker)
- Modify: `apps/frontend-admin/src/assets/css/backoffice-shell.css:1863` (glow data selezionata)

**Interfaces:**
- Consumes: `--bi-navy`, `--bi-navy-h`, `--bi-primary` (Task 1),
  `--border-1`, `--shadow-1` (`tokens.css`, invariati).

- [ ] **Step 1: Variabili shell — accent, radius, sidebar**

Righe 15-24, cambia:
```css
  /* prima */
  --bo-accent: #0066cc;
  --bo-accent-hover: #004c99;
  --bo-sidebar-bg: #0f1f36;
  --bo-sidebar-text: #d5dce5;
  --bo-sidebar-muted: #8ea0b8;
  --bo-sidebar-active: #16365f;
  --bo-sidebar-accent: #4fa3ff;
  --bo-radius-sm: 4px;
  --bo-radius: 6px;
  --bo-radius-lg: 10px;
```
in
```css
  /* dopo */
  --bo-accent: var(--bi-navy);
  --bo-accent-hover: var(--bi-navy-h);
  --bo-sidebar-bg: var(--bi-navy);
  --bo-sidebar-text: #d5dce5;
  --bo-sidebar-muted: #8ea0b8;
  --bo-sidebar-active: var(--bi-navy-h);
  --bo-sidebar-accent: var(--bi-primary);
  --bo-radius-sm: 4px;
  --bo-radius: 4px;    /* flat: stesso valore di sm, era 6px */
  --bo-radius-lg: 8px; /* ridotto da 10px */
```

`--bo-sidebar-text`/`--bo-sidebar-muted` restano invariate (già testo
chiaro leggibile su fondo scuro, nessun problema di contrasto atteso dal
cambio `--bo-sidebar-bg`, che resta comunque un blu/navy scuro).

- [ ] **Step 2: `.card-wizard` — bordo invece di ombra**

Righe 979-982, cambia:
```css
  /* prima */
.card-wizard {
  border: 0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}
```
in
```css
  /* dopo */
.card-wizard {
  border: 1px solid var(--border-1);
  box-shadow: var(--shadow-1);
}
```

- [ ] **Step 3: `.bo-hero-card:hover` — riduci lift e glow**

Righe 1529-1532, cambia:
```css
  /* prima */
.bo-hero-card:hover {
  transform: translateY(-3px) !important;
  box-shadow: 0 8px 24px rgba(23, 50, 77, 0.12) !important;
}
```
in
```css
  /* dopo */
.bo-hero-card:hover {
  transform: translateY(-1px) !important;
  box-shadow: var(--shadow-2) !important;
}
```

- [ ] **Step 4: Litepicker — colore + ombra popover**

Righe 1755-1756, cambia:
```css
  /* prima */
  --lp-primary-color: #0066cc;
  --lp-primary-color-hover: #004c99;
```
in
```css
  /* dopo */
  --lp-primary-color: var(--bi-navy);
  --lp-primary-color-hover: var(--bi-navy-h);
```

Riga 1768 (ombra popover, resta elemento flottante — riduci ma non
rimuovere), cambia:
```css
  /* prima */
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 16px -6px rgba(0, 0, 0, 0.04) !important;
```
in
```css
  /* dopo */
  box-shadow: var(--shadow-2) !important;
```

- [ ] **Step 5: Glow data selezionata — allinea a navy**

Riga 1863, cambia:
```css
  /* prima */
  box-shadow: 0 4px 6px -1px rgba(0, 102, 204, 0.2) !important;
```
in
```css
  /* dopo */
  box-shadow: 0 4px 6px -1px rgba(0, 51, 102, 0.2) !important;
```

(rgba equivalente a `--bi-navy` — non esiste una variante alpha
pre-definita per navy in `tokens.css`, il letterale resta necessario qui
per lo stesso motivo per cui `--bi-primary-a16` esiste come letterale
per il blu.)

**Non toccare**: righe 202, 634, 1155 (focus-ring `0 0 0 3px`,
accessibilità, fuori scope), righe 399, 1161, 1458, 1488 (ombre di
elementi flottanti o già minime — dropdown utente, login card, stat
card, hero banner — lasciate come sono, non contribuiscono al look
"gestionale generico" quanto `.card-wizard`/`.bo-hero-card`).

- [ ] **Step 6: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/assets/css/backoffice-shell.css
git commit -m "feat(frontend-admin): shell/sidebar/card-wizard/litepicker su navy, ombre ridotte"
```

---

### Task 4: `App.tsx` — colori inline e costante rotta

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:757` (`PIE_COLORS`)
- Modify: `apps/frontend-admin/src/App.tsx:9656` (bottone con style inline)

**Interfaces:**
- Consumes: nessuna nuova — solo token CSS già esistenti/aggiornati
  (Task 1-3).

- [ ] **Step 1: Fix `PIE_COLORS` — token inesistente**

Riga 757 referenzia `var(--ms-blue-600)`, un token che NON esiste in
`tokens.css` (verificato via grep — bug pre-esistente, il colore
risolve a `unset`/trasparente nel grafico a torta). Cambia:

```typescript
// prima
const PIE_COLORS = ['var(--bi-primary)', 'var(--ms-purple-600)', 'var(--ms-gold-500)', 'var(--ms-green-600)', 'var(--ms-blue-600)'];
```
in
```typescript
// dopo
const PIE_COLORS = ['var(--bi-navy)', 'var(--ms-purple-600)', 'var(--ms-gold-500)', 'var(--ms-green-600)', 'var(--bi-primary)'];
```

(sostituisce sia il token rotto che allinea il primo colore al nuovo
navy — `--bi-primary`, blu istituzionale più chiaro, resta comunque
disponibile come quinto colore della sequenza, non sprecato).

- [ ] **Step 2: Bottone con style inline — allinea a navy**

Riga 9656 (`style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}`),
cambia:
```tsx
// prima
                            style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
```
in
```tsx
// dopo
                            style={{ backgroundColor: 'var(--bi-navy)', border: 'none' }}
```

Verificare col grep del brief (Step 3 sotto) se restano altri
`var(--bi-primary)` inline in `App.tsx` da valutare — non rimuoverli
automaticamente: `--bi-primary` (blu chiaro) resta un colore valido
disponibile nel sistema, non tutti i suoi usi vanno per forza spostati
a navy (solo dove lo scopo è "colore primario di brand", come i due
punti sopra).

- [ ] **Step 3: Grep di verifica**

Run: `grep -n "ms-blue-600\|var(--bi-primary)" apps/frontend-admin/src/App.tsx`
Expected: nessun `ms-blue-600` residuo. Eventuali altri
`var(--bi-primary)` trovati vanno valutati manualmente (non è un
errore se restano — solo se il contesto è chiaramente "colore
primario di brand" va cambiato a `var(--bi-navy)`).

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): PIE_COLORS token inesistente, bottone allineato a navy"
```

---

### Nota: `app.css` non ha un task dedicato

Audit fatto in fase di pianificazione (grep `box-shadow` su tutto il
file): le ombre pesanti presenti (`.login-card`, `.login-button`,
righe 138-291) appartengono alla pagina di login, che usa già un
gradiente viola/navy civico e un'estetica glassmorphism intenzionale —
non è "generica Bootstrap", è già un pezzo di identità propria distinto
dal resto dell'admin. L'unica ombra minore fuori da quel contesto
(`.user-initials-avatar`, righe 55-61, blur 2-10px) è di peso
trascurabile e non contribuisce percettibilmente al problema originale.
Nessuna modifica pianificata per questo file in questo piano.

---

### Task 5: Verifica visiva browser (manuale — nessun test automatico frontend nel repo)

**Files:** nessuno (solo verifica).

**Interfaces:** nessuna.

- [ ] **Step 1: Avvia stack e verifica hot-reload pulito**

`docker compose logs --tail=30 frontend-admin` — nessun errore di
compilazione dopo le modifiche CSS/TSX dei task precedenti.

- [ ] **Step 2: Login + contrasto**

Login mock (`admin`/`admin`). Verifica visiva: sidebar navy leggibile
(testo chiaro su `--bi-navy`), bottoni primari (es. "Avanti" nel wizard)
navy con testo bianco leggibile — nessun testo che sparisce per
contrasto insufficiente.

- [ ] **Step 3: Viste rappresentative**

Naviga Dashboard, wizard "Invio Singolo" (step1 e step6 anteprima),
"Invio Massivo" (tabella campagne), "Impostazioni", "Statistiche"
(grafico a torta — verificare che i 5 colori di `PIE_COLORS` siano
tutti visibili/distinti, non più un colore mancante/trasparente).
Confermare visivamente: bordi netti al posto di ombre pesanti su card
wizard e hero card, nessuna regressione di leggibilità.

- [ ] **Step 4: Elementi flottanti**

Apri un dropdown utente (badge in alto a destra) e, se presente in una
vista, un date-range-picker: verificare che restino leggibili come
elementi "sopra" il contenuto (ombra ridotta ma presente, non piatti sul
resto della pagina).
