# Redesign portale cittadino (post-login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire il markup Bootstrap-non-funzionante della dashboard cittadino post-login (lista notifiche, dettaglio, profilo) con il design system istituzionale già esistente in `fo-components.css`, aggiungendo un pannello di ricerca/filtro client-side e un comportamento responsive lista/dettaglio.

**Architecture:** Modifica diretta di `apps/frontend-citizen/src/App.tsx` (monolitico, come `frontend-admin`, nessuno split in componenti — segue il pattern esistente) e aggiunta di nuove classi CSS in `apps/frontend-citizen/src/assets/css/fo-components.css`, riusando classi/variabili già presenti (`.avviso-card`, `.avviso-row`, `.status`/`.dot`, `.btn`, `.field`/`.input`/`.select`, `.card`) invece di inventare un sistema nuovo.

**Tech Stack:** React 19, TypeScript, CSS custom (nessun Bootstrap in questa app), Docker (nessun comando Node/pnpm sull'host).

## Global Constraints

- Tutti i comandi girano in Docker (`docker compose exec frontend-citizen ...`), mai Node/pnpm sull'host — vedi CLAUDE.md.
- `frontend-citizen` NON carica Bootstrap: ogni classe deve esistere in `tokens.css`/`fo-components.css`/`app.css`, mai `row`/`col-*`/`list-group`/`badge` generico/`card` Bootstrap-style.
- Nessuna suite di test automatici per `apps/frontend-citizen` (come `frontend-admin`): verifica con `tsc --noEmit` (NON `tsc -b`, che nel container dev può fallire per motivi preesistenti non correlati — usare il binario diretto) + verifica visiva reale in browser prima di dichiarare un task concluso.
- Breakpoint mobile/desktop: `920px`, riusando lo stesso valore già impiegato da `.split`/`.svc-grid` in `fo-components.css` — non introdurre un nuovo valore arbitrario.
- Non toccare la lobby di login (già a posto) né aggiungere nuovi endpoint backend: il filtro è client-side sui dati già restituiti da `GET /citizen/notifications`.
- Non introdurre una timeline multi-step (non pertinente a una notifica single-shot) né altre feature non richieste nello spec.

---

### Task 1: Lista notifiche — markup reale e badge di stato

**Contesto:** oggi la lista (`apps/frontend-citizen/src/App.tsx`, righe 742-773) usa `list-group-item`, `badge bg-success`/`bg-primary` — classi Bootstrap inesistenti in questa app, quindi renderizzate come testo/bottoni non stilizzati. Questo task sostituisce SOLO il markup della lista (non ancora il filtro, che è Task 2) con classi reali, e introduce le pillole di stato colorate riusando la struttura `.status`/`.dot` già presente in `fo-components.css` (righe 177-181), con varianti di colore proprie (non le `.status-pay/paid/due` esistenti, che hanno semantica di pagamento).

**Files:**
- Modify: `apps/frontend-citizen/src/assets/css/fo-components.css`
- Modify: `apps/frontend-citizen/src/App.tsx:742-773` (blocco lista notifiche)

**Interfaces:**
- Produce: funzione helper `statusBadge(status: Notification['status']): { cls: string; label: string }` in `App.tsx`, usata anche da Task 3 (dettaglio) e Task 4 (profilo — badge provider).
- Consuma: interfaccia `Notification` esistente (righe 89-103 di `App.tsx`), invariata.

- [ ] **Step 1: Aggiungere le classi CSS per i badge di stato e la lista**

In `apps/frontend-citizen/src/assets/css/fo-components.css`, subito dopo il blocco `STATUS BADGES` esistente (dopo la riga `.status-cancel .dot { background: var(--fg-3); }`, circa riga 191), aggiungere:

```css
/* Varianti di stato per le notifiche cittadino (non riusare .status-pay/paid/due: semantica pagamento) */
.status-notif-received { background: var(--ms-success-bg); color: var(--ms-success); }
.status-notif-received .dot { background: var(--ms-success); }
.status-notif-pending   { background: var(--ms-info-bg);    color: var(--ms-info); }
.status-notif-pending .dot { background: var(--ms-info); }
.status-notif-failed    { background: var(--ms-danger-bg);  color: var(--ms-danger); }
.status-notif-failed .dot { background: var(--ms-danger); }
```

Poi, alla fine del file (dopo l'ultima regola esistente), aggiungere:

```css
/* ============================================================================
   NOTIFICHE CITTADINO — lista
   ============================================================================ */
.notif-list { display: flex; flex-direction: column; }
.notif-list-item {
  display: block; width: 100%; text-align: left; background: #fff; border: none;
  border-bottom: 1px solid var(--border-1); padding: var(--sp-4) var(--sp-5);
  cursor: pointer; font-family: inherit; transition: background var(--dur-fast) var(--ease-out);
}
.notif-list-item:last-child { border-bottom: none; }
.notif-list-item:hover { background: var(--bi-primary-a4); }
.notif-list-item.selected {
  background: var(--bi-primary-a8);
  border-left: 3px solid var(--bi-primary);
  padding-left: calc(var(--sp-5) - 3px);
}
.notif-list-item-top { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-2); }
.notif-date { font-size: 13px; color: var(--fg-3); }
.notif-list-item-title { font-size: 16px; font-weight: 700; color: var(--fg-1); margin: 0 0 4px; }
.notif-list-item-desc {
  font-size: 13px; color: var(--fg-3); margin: 0 0 var(--sp-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.notif-list-item-meta { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--fg-2); flex-wrap: wrap; gap: var(--sp-2); }

.notif-empty { text-align: center; padding: var(--sp-8) var(--sp-5); color: var(--fg-3); }
.notif-empty i { font-size: 40px; opacity: .3; margin-bottom: var(--sp-3); display: block; }
```

- [ ] **Step 2: Aggiungere l'helper `statusBadge` in App.tsx**

In `apps/frontend-citizen/src/App.tsx`, subito dopo la dichiarazione dell'interfaccia `Notification` (dopo la riga `}` che chiude l'interfaccia, circa riga 103, prima di `export function App()`), aggiungere:

```tsx
function statusBadge(status: Notification['status']): { cls: string; label: string } {
  if (status === 'sent') return { cls: 'status-notif-received', label: 'Ricevuta' };
  if (status === 'failed' || status === 'skipped') return { cls: 'status-notif-failed', label: 'Non recapitata' };
  return { cls: 'status-notif-pending', label: 'In corso' };
}
```

- [ ] **Step 3: Sostituire il markup della lista**

In `apps/frontend-citizen/src/App.tsx`, sostituire l'intero blocco da `{loadingNotifications && notifications.length === 0 ? (` a `)}` che chiude il rendering della lista (righe 732-773 circa, dentro `<div className="card-body p-0">`):

```tsx
                  {errorNotifications && (
                    <div className="alert alert-danger" style={{ margin: 'var(--sp-4)' }}>
                      <i className="fas fa-exclamation-triangle alert-icon" aria-hidden="true"></i>
                      <span>{errorNotifications}</span>
                    </div>
                  )}

                  {loadingNotifications && notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
                      <div>Caricamento comunicazioni...</div>
                    </div>
                  ) : notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="far fa-folder-open" aria-hidden="true"></i>
                      <p style={{ margin: 0 }}>Non ci sono comunicazioni per questo codice fiscale.</p>
                    </div>
                  ) : (
                    <div className="notif-list">
                      {notifications.map((n) => {
                        const isDownloaded = !!n.extraData?.['download_count'];
                        const badge = statusBadge(n.status);
                        return (
                          <button
                            key={n.id}
                            className={`notif-list-item ${selectedNotif?.id === n.id ? 'selected' : ''}`}
                            onClick={() => setSelectedNotif(n)}
                          >
                            <div className="notif-list-item-top">
                              <span className="notif-date">
                                <i className="far fa-calendar-alt" aria-hidden="true"></i> {new Date(n.createdAt).toLocaleDateString('it-IT')}
                              </span>
                              <span className={`status ${badge.cls}`}>
                                <span className="dot"></span>{badge.label}
                              </span>
                            </div>
                            <h4 className="notif-list-item-title">{n.campaign?.name || '—'}</h4>
                            <p className="notif-list-item-desc">{n.campaign?.description || ''}</p>
                            <div className="notif-list-item-meta">
                              <span>Canale: <strong>{n.campaign?.channelType || '—'}</strong></span>
                              {isDownloaded && (
                                <span className="status status-notif-received">
                                  <span className="dot"></span>Scaricato
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
```

Nota: `err` di TypeScript su `errorNotifications`/`loadingNotifications`/`notifications`/`selectedNotif` — nessuna modifica di stato richiesta in questo step, sono già dichiarati (righe 129-132 di `App.tsx`).

- [ ] **Step 4: Type-check**

```bash
docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit
```
Atteso: nessun errore nuovo. Se il progetto non ha un `tsconfig` root risolvibile da `tsc --noEmit` diretto, usare `docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (stesso pattern di `frontend-admin`, vedi CLAUDE.md).

- [ ] **Step 5: Verifica visiva in browser**

```bash
docker compose up -d --build frontend-citizen
```
Aprire http://localhost:3001, login (mock, se `LDAP_HOST=mock` in `.env`) con un codice fiscale che ha notifiche. Verificare: badge di stato colorati e leggibili, righe lista con hover e stato selezionato evidenziato da bordo blu a sinistra, nessuna classe Bootstrap "grezza" visibile (aprire DevTools, controllare che non ci siano più `list-group-item`/`badge bg-success` nel DOM).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/assets/css/fo-components.css
git commit -m "fix(frontend-citizen): lista notifiche con classi reali e badge di stato colorati"
```

---

### Task 2: Pannello ricerca/filtri (client-side)

**Contesto:** aggiunge un pannello di filtro sopra la lista notifiche, che opera su `notifications` già caricato (nessuna nuova chiamata di rete). Dipende da Task 1 (usa `statusBadge` e la struttura `.notif-list`/`.notif-empty`).

**Files:**
- Modify: `apps/frontend-citizen/src/assets/css/fo-components.css`
- Modify: `apps/frontend-citizen/src/App.tsx`

**Interfaces:**
- Consuma: `statusBadge` (Task 1), `notifications: Notification[]` (state esistente, riga 129).
- Produce: state `searchText`, `filterStatus`, `filterChannel`, `filterDateFrom`, `filterDateTo`; variabile derivata `filteredNotifications: Notification[]`; funzione `resetFilters(): void`. Task 3 non dipende da queste, ma il rendering della lista (Task 1) viene aggiornato per iterare su `filteredNotifications` invece di `notifications`.

- [ ] **Step 1: Aggiungere la classe CSS per la griglia dei filtri**

In `apps/frontend-citizen/src/assets/css/fo-components.css`, alla fine del file, aggiungere:

```css
/* ============================================================================
   NOTIFICHE CITTADINO — pannello filtri
   ============================================================================ */
.filters-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr auto; gap: var(--sp-4); align-items: end; }
@media (max-width: 920px) { .filters-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 480px) { .filters-grid { grid-template-columns: 1fr; } }
.filters-grid .field { margin-bottom: 0; }
```

- [ ] **Step 2: Aggiungere state e logica di filtro in App.tsx**

In `apps/frontend-citizen/src/App.tsx`, subito dopo la dichiarazione di `const [selectedNotif, setSelectedNotif] = useState<Notification | null>(null);` (riga 132), aggiungere:

```tsx
  // Filtri pannello ricerca (client-side, nessuna nuova chiamata di rete)
  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'sent' | 'pending' | 'failed'>('all');
  const [filterChannel, setFilterChannel] = useState('all');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const resetFilters = () => {
    setSearchText('');
    setFilterStatus('all');
    setFilterChannel('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const hasActiveFilters = !!(searchText || filterStatus !== 'all' || filterChannel !== 'all' || filterDateFrom || filterDateTo);

  const availableChannels = Array.from(
    new Set(notifications.map((n) => n.campaign?.channelType).filter((c): c is string => !!c)),
  );

  const filteredNotifications = notifications.filter((n) => {
    if (searchText) {
      const haystack = `${n.campaign?.name || ''} ${n.campaign?.description || ''}`.toLowerCase();
      if (!haystack.includes(searchText.toLowerCase())) return false;
    }
    if (filterStatus !== 'all') {
      const bucket = n.status === 'sent' ? 'sent' : (n.status === 'failed' || n.status === 'skipped') ? 'failed' : 'pending';
      if (bucket !== filterStatus) return false;
    }
    if (filterChannel !== 'all' && n.campaign?.channelType !== filterChannel) return false;
    if (filterDateFrom && new Date(n.createdAt) < new Date(filterDateFrom)) return false;
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(n.createdAt) > to) return false;
    }
    return true;
  });
```

- [ ] **Step 3: Aggiungere il pannello filtri sopra la lista**

In `apps/frontend-citizen/src/App.tsx`, individuare il blocco `<div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">` seguito dal titolo "Comunicazioni Ricevute" (Task 1 non lo tocca, resta con classi Bootstrap-non-funzionanti da correggere qui). Sostituire l'intero header della card con:

```tsx
                <div className="card-pad" style={{ borderBottom: '1px solid var(--border-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sp-3)' }}>
                  <h3 className="ms-h3" style={{ margin: 0 }}>
                    <i className="far fa-envelope" style={{ color: 'var(--bi-primary)', marginRight: 8 }} aria-hidden="true"></i>
                    Comunicazioni Ricevute
                  </h3>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={fetchNotifications} title="Aggiorna elenco">
                    <i className="fas fa-sync-alt" aria-hidden="true"></i>
                  </button>
                </div>
                <div className="card-pad" style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <div className="filters-grid">
                    <div className="field">
                      <label htmlFor="search-text">Cerca</label>
                      <input
                        id="search-text"
                        type="text"
                        className="input"
                        placeholder="Nome o descrizione comunicazione"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="search-status">Stato</label>
                      <select
                        id="search-status"
                        className="select"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value as 'all' | 'sent' | 'pending' | 'failed')}
                      >
                        <option value="all">Tutti</option>
                        <option value="sent">Ricevute</option>
                        <option value="pending">In corso</option>
                        <option value="failed">Non recapitate</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="search-channel">Canale</label>
                      <select
                        id="search-channel"
                        className="select"
                        value={filterChannel}
                        onChange={(e) => setFilterChannel(e.target.value)}
                      >
                        <option value="all">Tutti</option>
                        {availableChannels.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="search-date-from">Dal</label>
                      <input
                        id="search-date-from"
                        type="date"
                        className="input"
                        value={filterDateFrom}
                        onChange={(e) => setFilterDateFrom(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="search-date-to">Al</label>
                      <input
                        id="search-date-to"
                        type="date"
                        className="input"
                        value={filterDateTo}
                        onChange={(e) => setFilterDateTo(e.target.value)}
                      />
                    </div>
                    {hasActiveFilters && (
                      <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>
                        <i className="fas fa-times" aria-hidden="true"></i> Azzera
                      </button>
                    )}
                  </div>
                </div>
```

- [ ] **Step 4: Aggiornare la lista per usare `filteredNotifications` e distinguere "nessun risultato dai filtri" da "nessuna comunicazione"**

In `apps/frontend-citizen/src/App.tsx`, nel blocco lista introdotto al Task 1 Step 3, sostituire:

```tsx
                  ) : notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="far fa-folder-open" aria-hidden="true"></i>
                      <p style={{ margin: 0 }}>Non ci sono comunicazioni per questo codice fiscale.</p>
                    </div>
                  ) : (
                    <div className="notif-list">
                      {notifications.map((n) => {
```

con:

```tsx
                  ) : notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="far fa-folder-open" aria-hidden="true"></i>
                      <p style={{ margin: 0 }}>Non ci sono comunicazioni per questo codice fiscale.</p>
                    </div>
                  ) : filteredNotifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="fas fa-filter-circle-xmark" aria-hidden="true"></i>
                      <p style={{ margin: '0 0 var(--sp-3)' }}>Nessuna comunicazione corrisponde ai filtri.</p>
                      <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>Azzera filtri</button>
                    </div>
                  ) : (
                    <div className="notif-list">
                      {filteredNotifications.map((n) => {
```

- [ ] **Step 5: Type-check**

```bash
docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit
```
Atteso: nessun errore.

- [ ] **Step 6: Verifica visiva in browser**

Ricaricare http://localhost:3001, con lista popolata: digitare testo nel campo Cerca e verificare che la lista si restringa in tempo reale; selezionare uno stato/canale dai select; impostare un intervallo date che esclude tutti i risultati e verificare il messaggio "Nessuna comunicazione corrisponde ai filtri" con il tasto Azzera funzionante.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/assets/css/fo-components.css
git commit -m "feat(frontend-citizen): pannello ricerca/filtri client-side su lista notifiche"
```

---

### Task 3: Dettaglio notifica (pattern `.avviso-card`) e layout responsive lista/dettaglio

**Contesto:** sostituisce il markup Bootstrap-card del dettaglio (righe 778-848 circa di `App.tsx`) con il pattern `.avviso-card`/`.avviso-header`/`.avviso-row`/`.avviso-actions` già pronto in `fo-components.css` (mai usato finora), e introduce il layout a due colonne responsive: desktop lista+dettaglio affiancati, mobile il dettaglio sostituisce la lista con un tasto "Torna alle comunicazioni". Dipende da Task 1 (`statusBadge`, wrapper `.notif-list` col).

**Files:**
- Modify: `apps/frontend-citizen/src/assets/css/fo-components.css`
- Modify: `apps/frontend-citizen/src/App.tsx`

**Interfaces:**
- Consuma: `statusBadge` (Task 1), `selectedNotif`/`setSelectedNotif` (state esistente), `handleDownloadAttachment` (funzione esistente, righe 361-393), `entityName` (state esistente).
- Produce: classi CSS `.notif-layout`, `.notif-list-col`, `.notif-detail-col`, `.notif-detail-actions`, `.notif-back-btn`, `.notif-close-btn` — non consumate da altri task.

- [ ] **Step 1: Aggiungere le classi CSS per il layout responsive e i bottoni del dettaglio**

In `apps/frontend-citizen/src/assets/css/fo-components.css`, alla fine del file, aggiungere:

```css
/* ============================================================================
   NOTIFICHE CITTADINO — layout lista/dettaglio responsive
   ============================================================================ */
.notif-layout { display: grid; grid-template-columns: 1fr; gap: var(--sp-5); }
.notif-layout.has-detail { grid-template-columns: 1fr 1fr; }
@media (max-width: 920px) {
  .notif-layout.has-detail { grid-template-columns: 1fr; }
  .notif-layout.has-detail .notif-list-col { display: none; }
}

.notif-detail-actions { display: flex; gap: var(--sp-2); align-items: center; }
.notif-back-btn { display: none; }
.notif-close-btn { display: inline-flex; }
@media (max-width: 920px) {
  .notif-back-btn { display: inline-flex; }
  .notif-close-btn { display: none; }
}
```

- [ ] **Step 2: Sostituire il markup del layout (colonne lista/dettaglio)**

In `apps/frontend-citizen/src/App.tsx`, individuare il contenitore `<div className="row g-4">` (apertura della vista `notifications`, circa riga 716) e le due colonne `<div className={selectedNotif ? 'col-lg-6' : 'col-12'}>` / `<div className="col-lg-6">` (righe 719 e 780 circa). Sostituire l'apertura e le due `className` dei contenitori colonna, SENZA toccare il contenuto interno (già gestito da Task 1/2 per la lista, da Step 3 di questo task per il dettaglio):

```tsx
          <div className={`notif-layout ${selectedNotif ? 'has-detail' : ''}`}>

            {/* List of notifications (Left column) */}
            <div className="notif-list-col">
              <div className="card">
```

e, per la colonna dettaglio (era `<div className="col-lg-6">` subito prima del commento `{/* Notification Detail ... */}`):

```tsx
            {selectedNotif && (
              <div className="notif-detail-col">
```

- [ ] **Step 3: Sostituire il markup del dettaglio con `.avviso-card`**

Sostituire l'intero blocco della card dettaglio (da `<div className="card shadow-sm h-100 bg-white" ...>` dentro il commento "Notification Detail" fino alla chiusura del suo `</div>` finale, corrispondente in origine alle righe 781-846 circa) con:

```tsx
              <div className="avviso-card">
                <div className="avviso-header">
                  <div>
                    <span className="from">Mittente</span>
                    <strong>{entityName}</strong>
                  </div>
                  <div className="notif-detail-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm notif-back-btn"
                      onClick={() => setSelectedNotif(null)}
                    >
                      <i className="fas fa-arrow-left" aria-hidden="true"></i> Torna alle comunicazioni
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm notif-close-btn"
                      onClick={() => setSelectedNotif(null)}
                      title="Chiudi dettaglio"
                    >
                      <i className="fas fa-times" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
                <div className="avviso-body">
                  <h3 className="ms-h3" style={{ marginBottom: 'var(--sp-3)' }}>{selectedNotif.campaign?.name || '—'}</h3>
                  <p style={{ whiteSpace: 'pre-wrap', color: 'var(--fg-2)', marginBottom: 'var(--sp-4)' }}>
                    {selectedNotif.campaign?.description || ''}
                  </p>

                  <div className="avviso-row">
                    <span className="k">Canale di invio</span>
                    <span className="v">{selectedNotif.campaign?.channelType || '—'}</span>
                  </div>
                  <div className="avviso-row">
                    <span className="k">Stato spedizione</span>
                    <span className="v">
                      <span className={`status ${statusBadge(selectedNotif.status).cls}`}>
                        <span className="dot"></span>{statusBadge(selectedNotif.status).label}
                      </span>
                    </span>
                  </div>
                  <div className="avviso-row">
                    <span className="k">Data generazione</span>
                    <span className="v">{new Date(selectedNotif.createdAt).toLocaleString('it-IT')}</span>
                  </div>
                  {!!selectedNotif.extraData?.['download_count'] && (
                    <div className="avviso-row">
                      <span className="k">Download</span>
                      <span className="v">
                        {selectedNotif.extraData['download_count']} volte — ultimo il{' '}
                        {new Date(selectedNotif.extraData['downloaded_at']).toLocaleString('it-IT')}
                      </span>
                    </div>
                  )}
                </div>
                <div className="avviso-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleDownloadAttachment(selectedNotif.id)}
                  >
                    <i className="fas fa-file-pdf" aria-hidden="true"></i> Scarica documento PDF firmato
                  </button>
                </div>
              </div>
```

Chiudere correttamente i due `</div>` di `notif-detail-col` e del blocco condizionale `{selectedNotif && ( ... )}` (struttura invariata rispetto all'originale, solo il contenuto interno è cambiato).

- [ ] **Step 4: Type-check**

```bash
docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit
```
Atteso: nessun errore. Prestare attenzione a `selectedNotif.extraData['downloaded_at']` — se TypeScript segnala `any` implicito su `extraData` (tipizzato `Record<string, any>` nell'interfaccia esistente, riga 97), è atteso e preesistente, non introdotto da questo task.

- [ ] **Step 5: Verifica visiva in browser, inclusa la responsività**

Ricaricare http://localhost:3001, cliccare una notifica: verificare che il dettaglio appaia con lo stile `.avviso-card` (header con sfondo sfumato, righe chiave-valore con bordo tratteggiato, bottone PDF blu in fondo). Con DevTools, ridurre la larghezza della finestra sotto 920px: la lista deve sparire e il dettaglio deve occupare tutta la larghezza con il tasto "Torna alle comunicazioni" visibile in alto; sopra i 920px verificare invece che sia visibile solo la X di chiusura e che lista+dettaglio restino affiancati.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/assets/css/fo-components.css
git commit -m "feat(frontend-citizen): dettaglio notifica con pattern avviso-card, layout responsive lista/dettaglio"
```

---

### Task 4: Profilo cittadino — markup reale

**Contesto:** sostituisce il markup Bootstrap-card della vista profilo (righe 853-885 circa di `App.tsx`) con `.card`/`.card-pad` e righe chiave-valore in stile `.avviso-row` (riusabile fuori da `.avviso-card`, la regola CSS non è scoped al genitore). Introduce la classe `.user-initials-avatar`, oggi referenziata nel JSX ma mai definita in CSS.

**Files:**
- Modify: `apps/frontend-citizen/src/assets/css/fo-components.css`
- Modify: `apps/frontend-citizen/src/App.tsx:853-885`

**Interfaces:**
- Consuma: `name`/`cf`/`provider`/`authMode` (state esistente).
- Produce: classe CSS `.user-initials-avatar` — non consumata da altri task in questo piano, ma è lo stesso nome già usato (senza stile) nel codice attuale.

- [ ] **Step 1: Aggiungere la classe CSS per l'avatar**

In `apps/frontend-citizen/src/assets/css/fo-components.css`, alla fine del file, aggiungere:

```css
/* ============================================================================
   NOTIFICHE CITTADINO — profilo
   ============================================================================ */
.user-initials-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 64px; height: 64px; border-radius: 50%;
  background: var(--bi-primary-a8); color: var(--bi-primary);
  font-weight: 700; font-size: 24px; font-family: var(--font-sans);
}
```

- [ ] **Step 2: Sostituire il markup della vista profilo**

In `apps/frontend-citizen/src/App.tsx`, sostituire l'intero blocco `{activeTab === 'profile' && ( ... )}` (righe 853-885 circa) con:

```tsx
        {activeTab === 'profile' && (
          <div className="card card-pad" style={{ maxWidth: 600, margin: '0 auto' }}>
            <h3 className="ms-h3" style={{ marginBottom: 'var(--sp-5)' }}>
              <i className="far fa-user" style={{ color: 'var(--bi-primary)', marginRight: 8 }} aria-hidden="true"></i>
              Profilo Cittadino Certificato
            </h3>

            <div style={{ textAlign: 'center', marginBottom: 'var(--sp-5)' }}>
              <span className="user-initials-avatar">{name?.slice(0, 2).toUpperCase()}</span>
              <h4 className="ms-h3" style={{ marginTop: 'var(--sp-3)', marginBottom: 'var(--sp-2)' }}>{name}</h4>
              <span className="status status-notif-received">
                <span className="dot"></span>Identità Certificata via {provider}
              </span>
            </div>

            <div className="avviso-row">
              <span className="k">Codice Fiscale</span>
              <span className="v ms-mono">{cf}</span>
            </div>
            <div className="avviso-row">
              <span className="k">Metodo di accesso</span>
              <span className="v">{authMode === 'mock' ? 'Simulatore (sviluppo)' : `${provider} (OIDC)`}</span>
            </div>

            <p className="ms-small" style={{ textAlign: 'center', marginTop: 'var(--sp-5)' }}>
              Questa è un'area ad alto livello di sicurezza. Le sessioni scadono automaticamente dopo 8 ore.
            </p>
          </div>
        )}
```

- [ ] **Step 3: Type-check**

```bash
docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit
```
Atteso: nessun errore.

- [ ] **Step 4: Verifica visiva in browser**

Aprire il menu utente in alto a destra → "Il mio profilo": verificare avatar circolare con iniziali colorate, righe chiave-valore con separatore tratteggiato, badge "Identità Certificata" colorato.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/assets/css/fo-components.css
git commit -m "fix(frontend-citizen): vista profilo con classi reali, avatar iniziali stilizzato"
```

---

### Task 5: Verifica finale end-to-end

**Contesto:** passata di verifica complessiva su tutto il redesign (Task 1-4 insieme), su viewport desktop e mobile, prima di considerare il lavoro concluso. Nessun file nuovo da modificare a priori — solo fix mirati se la verifica scopre un problema di integrazione tra i task precedenti (es. una classe CSS mancante in un caso limite).

**Files:**
- Modify (solo se la verifica trova un problema): `apps/frontend-citizen/src/App.tsx` e/o `apps/frontend-citizen/src/assets/css/fo-components.css`

**Interfaces:** nessuna nuova — verifica di integrazione delle interfacce prodotte dai Task 1-4.

- [ ] **Step 1: Type-check completo**

```bash
docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit
```
Atteso: nessun errore.

- [ ] **Step 2: Percorso completo in browser, viewport desktop**

```bash
docker compose up -d --build frontend-citizen
```
Login (mock o SPID reale a seconda dell'ambiente) → verificare: lista notifiche stilizzata con badge colorati → digitare nel pannello filtri e verificare che la lista si aggiorni → cliccare una notifica → verificare dettaglio in stile avviso-card affiancato alla lista → scaricare il PDF (se presente un allegato di test) → aprire il profilo → tornare alla lista.

- [ ] **Step 3: Percorso completo in browser, viewport mobile**

Con DevTools in modalità responsive (o resize finestra) sotto 920px: ripetere l'apertura di una notifica e verificare che la lista sparisca e il dettaglio occupi tutta la larghezza con il tasto "Torna alle comunicazioni" funzionante; verificare che il pannello filtri resti utilizzabile (colonne impilate).

- [ ] **Step 4: Verifica assenza di classi Bootstrap residue**

```bash
docker compose exec frontend-citizen grep -n "list-group\|col-lg-\|col-sm-\|\"row \|className=\"card shadow-sm" src/App.tsx
```
Atteso: nessun risultato nella porzione di codice post-login (la lobby di login, fuori scope, può ancora contenere pattern simili solo se coincidenti per caso — verificare manualmente che i risultati, se presenti, siano nella lobby e non nella dashboard).

- [ ] **Step 5: Commit (solo se sono stati applicati fix di integrazione)**

```bash
git add apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/assets/css/fo-components.css
git commit -m "fix(frontend-citizen): fix di integrazione dalla verifica end-to-end del redesign"
```
Se nessun fix è stato necessario, non creare un commit vuoto: il lavoro è già tutto committato nei Task 1-4.
