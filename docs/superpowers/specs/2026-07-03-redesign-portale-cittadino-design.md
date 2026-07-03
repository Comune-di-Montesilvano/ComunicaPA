# Redesign portale cittadino (post-login) — Design

## Contesto

Il portale cittadino (`apps/frontend-citizen`) ha una lobby di login (SPID/CIE) già ben progettata con un design system istituzionale proprio (`tokens.css`, `fo-components.css`: tema PA/AGID, palette Comune di Montesilvano, componenti `slim-header`/`inst-header`/`hero`/`login-card`).

La parte POST-login (lista notifiche, dettaglio notifica, profilo) usa invece markup con classi Bootstrap (`row`, `col-lg-6`, `list-group`, `list-group-item`, `badge`, `card` generico Bootstrap-style) che **non esistono** in questa app: `frontend-citizen` non carica Bootstrap (vedi CLAUDE.md, sezione CSS frontend). Il risultato è HTML quasi non stilizzato — la causa del giudizio "grafica pessima" dell'utente.

`fo-components.css` contiene già componenti pronti e MAI usati nella dashboard, pensati esattamente per questo scopo:
- `.card` / `.card-pad` — contenitore generico
- `.avviso-card` / `.avviso-header` / `.avviso-row` (grid chiave-valore) / `.avviso-actions` — pattern completo per il dettaglio di una comunicazione singola
- `.status-pay/paid/due/check/cancel` — pillole di stato colorate (semantica pagamento, da NON riusare letteralmente per notifiche — servono nuove varianti con le stesse variabili colore)
- `.field` / `.input` / `.select` / `.field-row` (grid 2 colonne responsive) — form/filtri
- `.svc-tile` — tile cliccabili (ispirazione per empty-state/azioni, non strettamente necessario qui)

## Obiettivo

Riscrivere la porzione post-login di `apps/frontend-citizen/src/App.tsx` (vista `notifications` e vista `profile`) usando SOLO classi del design system esistente (nessuna classe Bootstrap), aggiungendo un pannello di ricerca/filtro client-side sulla lista notifiche, e un comportamento responsive lista/dettaglio.

**Fuori scope:** la lobby di login (già a posto), qualunque nuovo endpoint backend (il filtro è client-side sui dati già caricati da `GET /citizen/notifications`), timeline multi-step (non pertinente a una notifica single-shot).

## Componenti

### 1. Pannello ricerca/filtri (nuovo)

Sopra la lista notifiche, dentro la card `.card.card-pad`:
- Campo testo libero (filtra su `campaign.name` + `campaign.description`, case-insensitive, substring match)
- Select stato (Tutti / Ricevuta = `sent` / In coda = `queued|pending` / Fallita = `failed`) — nota: dal punto di vista del cittadino "fallita" non dovrebbe quasi mai comparire (è un dettaglio interno), ma il campo `status` esiste sul DTO quindi lo esponiamo per completezza senza nascondere dati
- Select canale (Tutti / Email / PEC / App IO / SEND / Postale) — valori popolati dinamicamente dai canali effettivamente presenti in `notifications` (niente valori hardcoded che potrebbero non esistere per quel cittadino)
- Intervallo date (da / a) su `createdAt`

Layout: `.field-row` (grid 2 colonne, 1 colonna sotto i 600px per via del breakpoint già definito in `fo-components.css`). Il filtro ricalcola una lista derivata in render (nessuno state duplicato, no nuova chiamata di rete) da `notifications` + i valori dei filtri.

Se il filtro non produce risultati ma `notifications` non è vuoto: messaggio "Nessuna comunicazione corrisponde ai filtri" con azione "Azzera filtri" — distinto dall'empty-state reale ("Non ci sono comunicazioni per questo codice fiscale").

### 2. Lista notifiche (riscritta)

Ogni riga: nuovo componente-classe `.notif-list-item` (bottone full-width, non un `<button>` Bootstrap-styled ma con le classi del design system: bordo `--border-1`, hover `--bi-primary-a4`, stato selezionato con bordo sinistro `--bi-primary` spesso 3px — stesso concetto UX di oggi, classi vere invece di Bootstrap).

Contenuto riga (invariato nei dati mostrati rispetto a oggi): data, badge di stato (nuove classi, vedi sotto), nome comunicazione (`campaign.name`), descrizione troncata, canale, contatto email/PEC se presente.

**Badge di stato — nuove classi** (in `fo-components.css`, accanto alle `.status-*` esistenti, stessa struttura pillola+dot ma nomi/etichette proprie per non confondersi con la semantica pagamento):
```css
.status-notif-received  { background: var(--ms-success-bg); color: var(--ms-success); }
.status-notif-received .dot { background: var(--ms-success); }
.status-notif-pending    { background: var(--ms-info-bg);    color: var(--ms-info); }
.status-notif-pending .dot { background: var(--ms-info); }
.status-notif-failed     { background: var(--ms-danger-bg);  color: var(--ms-danger); }
.status-notif-failed .dot { background: var(--ms-danger); }
```
Mappatura: `sent` → received ("Ricevuta"), `pending|queued` → pending ("In corso"), `failed|skipped` → failed ("Non recapitata"). Il badge "Scaricato" (oggi già presente, basato su `extraData.download_count`) resta ma con markup a pillola coerente invece di `badge bg-success`.

### 3. Dettaglio notifica (riscritto con `.avviso-card`)

Sostituisce interamente il markup Bootstrap-card attuale:
- `.avviso-card` come contenitore
- `.avviso-header`: mittente (nome ente) + data generazione — replica lo stile "from" già in CSS (`.avviso-header .from` / `.from strong`)
- `.avviso-body`: titolo comunicazione (`campaign.name`) + testo (`campaign.description`, preservando newline)
- `.avviso-row` (grid chiave-valore) per: Canale di invio, Stato spedizione (badge nuove classi), eventuale riga "Scaricato N volte, ultimo il ..." quando `extraData.download_count` esiste
- `.avviso-actions`: bottone download PDF (`.btn.btn-primary` — questi ESISTONO già in fo-components.css, sono i soli Bootstrap-shaped che funzionano perché ridefiniti localmente)

Bottone "chiudi dettaglio" (solo desktop, dove la lista resta visibile accanto): icona X in `.avviso-header`, stile `.btn-ghost` esistente.

### 4. Responsive lista/dettaglio

- Desktop (≥992px, breakpoint coerente con l'esistente `@media (max-width: 920px)` già usato in `fo-components.css` per `.svc-grid`): lista e dettaglio affiancati via CSS grid a 2 colonne (non `col-lg-6` Bootstrap — una nuova classe `.notif-layout` con `display:grid; grid-template-columns: 1fr 1fr` quando `selectedNotif` esiste, altrimenti `1fr` pieno).
- Mobile (<992px): quando `selectedNotif` è impostato, la lista si nasconde (`display:none` via classe condizionale) e il dettaglio occupa tutta la larghezza con un bottone "← Torna alle comunicazioni" ben visibile in testa (oltre alla X esistente, più prominente su mobile). Nessun nuovo state React: si sfrutta `selectedNotif !== null` già esistente, il comportamento cambia solo via CSS/classi condizionali sul contenitore.

### 5. Profilo cittadino (riscritto)

Stessa card `.card.card-pad`, righe key-value con lo stesso pattern di `.avviso-row` (etichetta a sinistra, valore a destra, bordo tratteggiato tra le righe) invece di `list-group-item` Bootstrap. Avatar iniziali: classe esistente `.user-initials-avatar` — verificare se già definita in CSS o se è anch'essa un residuo Bootstrap-style da sistemare (va controllato in fase di implementazione).

## Testing

Nessuna suite di test automatici per `apps/frontend-citizen` (coerente con `frontend-admin`). Verifica:
1. `docker compose exec frontend-citizen node_modules/.bin/tsc --noEmit` (o comando equivalente presente in `package.json` — da verificare, il progetto potrebbe non avere uno script `tsc` dedicato come `frontend-admin`)
2. Verifica visiva in browser reale (Playwright o chrome-devtools) prima di dichiarare il lavoro concluso: login mock, lista con filtri applicati, apertura dettaglio, resize a viewport mobile per il comportamento responsive, profilo.

## Rischi / decisioni aperte per la fase di piano

- Il breakpoint esatto per il layout mobile/desktop va confermato leggendo gli altri breakpoint già usati nel file (visti: 920px, 600px) — sceglieremo quello più coerente con la larghezza minima utile per una card dettaglio leggibile affiancata alla lista, non necessariamente un nuovo valore arbitrario a 992px.
- `.user-initials-avatar` (usata nel profilo attuale) va verificata: se non esiste in CSS va creata con lo stesso criterio (cerchio, iniziali, colore branded) invece di essere lasciata come classe Bootstrap-simile non definita.
