# Frontend UI — registro canali, CSS, formattazione, polling

## Label/loghi/badge canali — sempre dal registro centralizzato

Label, colore, badge, logo (Data URI SVG) e icona di ogni canale/tipologia (EMAIL, PEC, APP_IO, SEND, POSTAL, PROTOCOLLAZIONE, INAD...) sono definiti **una sola volta per frontend**, mai duplicati in un punto isolato del JSX:

- `frontend-admin`: `apps/frontend-admin/src/data/channels.ts` (`CHANNELS_REGISTRY`, `EMBEDDED_LOGOS`, `getChannelMeta()`, `channelLabel()`, `ENGINE_LABELS`). Usare sempre `getChannelMeta(channel)` o `EMBEDDED_LOGOS.<CANALE>` — mai un'altra label/colore/logo hardcoded per un canale già presente lì (nav sidebar, badge, intestazioni pagina, select, tabelle). Stesso principio per gli stati condivisi (`STATUS_META`, `SEND_STATUS_META`, `POSTAL_STATUS_META` in `App.tsx`).
- `frontend-citizen`: `CHANNEL_META`/`EMBEDDED_LOGOS` in cima a `App.tsx` (copia indipendente, non condivisa con l'admin — due bundle separati, ognuno con la propria unica fonte di verità). Usare sempre `CHANNEL_META[canale]`/`ChannelBadge`, mai un'label/logo hardcoded altrove nel file.

Per aggiungere un canale o cambiarne label/colore/logo, modificare solo il registro di quel frontend: si propaga ovunque senza dover cercare copie sparse (vedi commit `e4dc41e` che ha eliminato 3 copie duplicate della stessa mappa in admin). Se un canale esiste in entrambi i frontend, aggiornare entrambi i registri — non sono sincronizzati automaticamente.

## CSS frontend — gotcha

`frontend-citizen` NON carica Bootstrap: le utility (`d-grid`, `w-100`, `text-center`...) sono no-op. Usare i css custom (`tokens.css`, `fo-components.css`, design system `--ms-*`/`--bi-*`) o stili espliciti. L'admin ha le sue utility custom in `app.css`/`backoffice-shell.css`.

`frontend-citizen` carica in ordine `tokens.css` → `fo-components.css` → `app.css` (vedi `main.tsx`): una classe con lo stesso nome definita in più file vince per ordine di caricamento a parità di specificity, non per "ultima modificata". Prima di aggiungere una classe già vista altrove, cercarla in tutti e tre i file (`grep -rn "nomeclasse" apps/frontend-citizen/src/assets/css/`).

## Formattazione importi — `Intl.NumberFormat`/`toLocaleString('it-IT')` richiede `useGrouping: true` esplicito

`(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`
senza `useGrouping` esplicito risolve internamente a `useGrouping: 'auto'`,
che in pratica NON applica il separatore delle migliaia — produce
`"2941,12"` invece di `"2.941,12"` (verificato dal vivo, sia Node che
browser). Ogni formattazione di importi in euro deve passare
`useGrouping: true` esplicito — vedi `formatEuroCents()` in
`apps/frontend-admin/src/App.tsx`, unico punto da riusare per nuovi importi.

## Frontend admin — `.card-header .d-flex` forza sempre `flex-direction: row`

`backoffice-shell.css` ha una regola `.card-header .d-flex { flex-direction:
row !important; ... }` che si applica a QUALSIASI discendente `.d-flex`
dentro un card-header, anche quando si vuole `flex-column` (es. badge stato
sopra una caption). Le classi utility non bastano in quel contesto — usare
uno `style` inline esplicito per bypassare la regola.

## Frontend admin — tabella in un pannello stretto senza `table-layout: fixed` → wrap carattere per carattere

Una `<td>` con solo `text-break`/`maxWidth` (nessuna larghezza minima) in
un pannello narrow (es. sidebar dettaglio campagna) si schiaccia sotto la
larghezza di una singola parola — Bootstrap `text-break` spezza a metà
parola pur di stare nello spazio, producendo wrap illeggibile lettera per
lettera (bug reale: colonna "Motivo errore" in "Destinatari con invio
fallito"). Fix: `table-layout: fixed` + `<colgroup>` con percentuali
esplicite + `minWidth` sulla tabella — il contenitore `table-responsive`
scrolla orizzontalmente se serve, invece di schiacciare il testo.

## Frontend admin — mai `<form>` annidate

La pagina Impostazioni avvolge tutte le tab in un'unica `<form
onSubmit={handleSaveSettings}>`. Un pannello di editing dentro una tab
(es. CRUD provider) non può usare un proprio `<form onSubmit={...}>`:
HTML non valido, il browser instrada il submit sulla form esterna
(bug reale: "Salva" su un pannello interno riportava alla home invece
di salvare). Usare `<div>` + bottone con `onClick` esplicito per
qualunque pannello di editing dentro una tab di Impostazioni.

**Un dato correttamente calcolato/salvato in state può restare invisibile per un gate di rendering indipendente
dal dato stesso** (es. una sezione mostrata solo per un certo canale, non per la presenza del dato) — prima di
sospettare un bug di parsing/backend quando "il dato non compare", verificare se la sezione UI che lo mostrerebbe
è condizionata da altro stato (bug reale: indirizzo Registro Imprese scritto giusto nello state, sezione
indirizzo nascosta perché il canale non era POSTAL/SEND — vedi "Verifica Anagrafica" sopra).

## Verifica Anagrafica (Cerca Domicilio) — validazione locale + errori leggibili

`isValidCfOrPiva()` (`App.tsx`, già usata dal wizard singolo) va sempre chiamata lato client PRIMA di interrogare
un endpoint di verifica esterna (ANPR/INAD/App IO/Registro Imprese) — bug reale corretto: un input malformato
(es. 10 cifre) veniva instradato su ANPR invece di essere rifiutato subito, sprecando una chiamata PDND reale.
`formatExternalErrorMessage()` (`App.tsx`) sanitizza il payload JSON/XML grezzo degli errori esterni prima di
mostrarli in UI (tiene solo contesto + HTTP code + suggerimento IT) — ogni nuovo pannello che mostra un
`message` di errore da un servizio esterno deve passarci attraverso, mai stampare `error.message` grezzo.

**Wizard singolo, PIVA senza PEC: l'indirizzo sede va comunque compilato, ma resta invisibile senza un avviso
esplicito.** Nessuna PEC trovata su Registro Imprese non forza alcun canale (correttamente — nessun domicilio
digitale) ma `needsWizSinglePhysicalAddress` mostra i campi indirizzo fisico solo per canale POSTAL/SEND: senza un
banner dedicato l'operatore non ha modo di sapere che l'indirizzo è già disponibile e serve solo cambiare canale.
Stesso principio generale sotto ("un dato può restare invisibile per un gate di rendering indipendente").

## Liste e pannelli con stato lato server — nessun refresh automatico globale

Non esiste un meccanismo generale (websocket/SSE) che push-aggiorna la UI
quando lo stato di una campagna cambia lato server (worker BullMQ) — l'unica
eccezione è il log live job di Arricchimento Tracciati (SSE dedicato, vedi
sopra). Qualunque lista/pannello che mostra stato potenzialmente in corso
deve avere il proprio `useEffect` con `setInterval` — bug reale corretto:
dashboard "Attività Recenti", elenco "Campagne Massive" e vista Statistiche
fetchavano una volta sola (al login o all'ingresso vista) e restavano fermi
su "In coda" anche a campagna completata, finché l'operatore non ricaricava
la pagina manualmente. Il dettaglio campagna aveva già un polling da 3s ma
solo per l'oggetto `campaign` principale, non per i pannelli di breakdown/
statistiche/destinatari (fetchati una sola volta al click) — un nuovo
pannello nel dettaglio campagna va aggiunto anche al polling esistente, non
solo al caricamento iniziale.

**Il commento sopra era più aspirazionale che vero.** Il `useEffect` di
polling 5s ha un commento che promette l'aggiornamento di "pannelli di
breakdown/statistiche", ma chiamava solo `fetchCampaignDetail` — quasi
NESSUNO degli altri fetch fatti da `handleCampaignClick` all'ingresso
(channelBreakdown, failureGroups, effectiveChannelBreakdown, sendStageCounts,
send/postal status breakdown, cost, paymentTotal, downloadCombinations) era
mai stato aggiunto al poll — tutti fermi allo snapshot iniziale finché
l'operatore non usciva e rientrava. Quando aggiungi/tocchi un pannello di
dettaglio campagna, diffa esplicitamente la lista dei fetch in
`handleCampaignClick` contro quelli nel/nei `useEffect` di polling — non
fidarti di un commento che dice già "lo fa".

Stessa istanza trovata anche fuori dal dettaglio campagna: il modale
"Dettaglio Notifica" (`openNotificationDetail`, apribile dalla ricerca
notifiche globale) fetchava una volta sola all'apertura — lo stato di un
singolo tentativo (es. "In corso" → "Consegnato") restava fermo finché non
si ricaricava tutto il sito. Fix: `useEffect` con `setInterval` (3s) che
rilegge silenziosamente (nessun reset a `null`/loading, per non far
sfarfallare/richiudere il modale già aperto) finché resta aperto.

**Il gate sullo `status` campagna può fermare il polling troppo presto per
canali con tracking di consegna asincrono (SEND/POSTAL).** Il polling del
dettaglio campagna si fermava non appena `campaign.status` passava a
`completed` — ma per SEND/POSTAL il completamento è deciso a livello di
submission (tutti gli attempt hanno un esito terminale), mentre
`sendStatus`/`postalStatus` (consegna a valle) continuano ad aggiornarsi
per giorni via demoni separati. Bug reale: l'elenco messaggi restava fermo
all'ultimo stato di consegna visto al completamento — fix: continuare il
polling anche a `status==='completed'` quando `channelType` è `SEND` o
`POSTAL`.

**Tabella destinatari (dettaglio campagna) — un solo trigger per fetch, mai
sia `useEffect` reattivo sia chiamata esplicita sullo stesso cambio
stato.** `fetchRecipientsPage()` ha parametri con default = stato React
corrente (`page = recipientsPageNum`, ecc.), per poter essere chiamata
senza argomenti sia dal timer di polling 3s sia da un handler. Serie di 3
bug reali consecutivi sistemando questo: (1) il timer di polling passava i
vecchi valori posizionali invece dei default, duplicando la fetch a ogni
tick; (2) rimuovendo quella duplicazione, cambio pagina/filtro/ordinamento
è stato spostato su un solo `useEffect` con tutte le dipendenze — corretto
in teoria ma la paginazione ha smesso di rispondere in modo affidabile al
click; (3) fix finale: `onClick`/`onChange` di paginazione, filtri e
intestazioni ordinabili chiamano `fetchRecipientsPage(...)` esplicitamente
con i nuovi valori, **oltre** allo `useEffect` che resta come rete di
sicurezza sulle stesse dipendenze — doppia fetch occasionale accettata come
compromesso, preferibile a un click che non aggiorna nulla. Debounce 300ms
mantenuto SOLO sul campo di ricerca testuale libera, mai su
pagina/filtri/ordinamento (0ms, l'operatore si aspetta risposta immediata
al click).

**Dettaglio campagna — navigazione SOLO via `handleCampaignClick`, mai
`setSelectedCampaignId`/`setView` inline.** Un secondo punto di ingresso al
dettaglio campagna (link "Visualizza Dettaglio" nell'Audit Log) chiamava
`setSelectedCampaignId`+`setView` direttamente, bypassando
`handleCampaignClick` — nessun filtro destinatari resettato. Bug reale
gemello: `handleCampaignClick` stesso non resettava
`recipientsTagsFilter`/`recipientsDownloadFilter` — un filtro "Tipo invio"
rimasto attivo dalla campagna precedente faceva mostrare "Nessun
destinatario associato" sulla campagna nuova, letto (erroneamente) come
dato perso. Ogni nuovo stato `recipients*Filter` va aggiunto al reset di
`handleCampaignClick`; ogni nuovo punto che apre il dettaglio campagna deve
chiamare `handleCampaignClick`, mai reimplementare un sottoinsieme della
navigazione a mano.

**"Download per Canale" e la tabella Destinatari/filtri — stessa istanza
ancora, trovata in sessione successiva.** `fetchDownloadCombinationStats`
era dentro il blocco di polling gated su `hasAsyncDeliveryTracking` (solo
SEND/POSTAL, pensato per lo stato di consegna) — restava fermo allo
snapshot iniziale su una campagna EMAIL/PEC già completata, ma un
cittadino può scaricare l'allegato in qualunque momento durante la
retention, su qualunque canale. `fetchRecipientsPage`/
`fetchRecipientsFilterOptions` non avevano MAI un intervallo, solo trigger
esplicito su cambio filtro/pagina/ordinamento. Fix: poll dedicati
indipendenti dallo status campagna — per la tabella destinatari,
l'intervallo va messo DENTRO lo stesso `useEffect` che già gestisce il
fetch su cambio filtro (mai un effect separato), così si resetta da solo
a ogni dipendenza cambiata senza chiusura stantia su filtri/pagina vecchi.

**Breakdown aggregato (`Array.from(map.entries())`) da un `Map` lato
backend non ha ordine garantito tra una query e l'altra** — un componente
che lo renderizza SENZA ordinare (es. `ChannelStatusBar`, la barra
"Andamento Invio") cambia visibilmente ordine ad ogni poll, percepito
come bug. I donut già ordinavano (valore desc, poi label) — replicare lo
stesso criterio in ogni nuovo componente che consuma lo stesso tipo di
dato.

