# Invio Singolo — form unificato (Dettagli+Canale+Destinatario), ANPR, pagamenti manuali, allegati inline

Estende `2026-07-20-invio-singolo-wizard-design.md` (riuso wizard multi-step,
`wizSingleMode`). Quello spec ha fuso step2+3 in un unico step "Destinatario"
con soli campi CF/nome/email/pec. Questo spec va oltre: fonde anche step1
in quello step, aggiunge lookup ANPR, indirizzo fisico per SEND/POSTAL,
pagamenti pagoPA manuali, allegati selezionati inline (upload differito al
lancio). Step3 (Mappatura CSV) e step5 (Upload Allegati) spariscono del
tutto dal percorso single-mode.

## Problema

Il form attuale di invio singolo (già fuso da step 2+3 nello spec
precedente) resta comunque diviso dallo step1 (Dettagli & Canale), obbliga
a scrivere nome/cognome a mano senza aiuto ANPR, non gestisce indirizzo
fisico per SEND/POSTAL, non ha pagamenti pagoPA manuali (solo mapping CSV,
inapplicabile a 1 riga), e obbliga comunque a passare per lo step 5 di
upload allegati con matching-per-filename pensato per CSV multi-riga.

## Soluzione — un solo step "Dettagli & Destinatario"

In `wizSingleMode`, step1 e l'attuale step2-single (destinatario) si fondono
in un unico step iniziale. Contiene, in ordine:

### Nome campagna

Auto-generato: `Invio singolo a <COGNOME/RAGIONE SOCIALE> <NOME>` (aggiornato
live mentre l'utente digita Nome/Cognome o lo precompila via ANPR). Il campo
resta sempre editabile — l'utente può sovrascriverlo in ogni momento.

### Destinatario

- **Codice Fiscale/P.IVA** (obbligatorio, validato `isValidCfOrPiva`,
  invariato).
- **Nome/Cognome (o Ragione Sociale)**: campo di testo, **sempre
  obbligatorio** — nessun fallback su CF, bottone "Avanti" resta disabilitato
  finché vuoto. Niente caso degenere da gestire.
- **Bottone "Carica dati ANPR"**: abilitato appena il CF è sintatticamente
  valido (non serve altro). Click chiama lo stesso endpoint già esistente
  `/admin/domicilio/cerca` (riuso 1:1 di quanto usato dalla pagina "Verifica
  Anagrafica", nessun nuovo endpoint). Sulla risposta:
  - precompila Nome/Cognome da `anpr.generalita` (restano editabili)
  - precompila indirizzo fisico (via, comune, cap, provincia) da
    `anpr.residenza`/luogo di residenza, restano editabili (es. domicilio
    diverso da residenza)
  - **se `inad.found`: canale primario forzato a PEC.** A differenza del
    percorso bulk (dove l'esito INAD si scopre solo a lancio avvenuto),
    qui la verifica INAD è già sincrona nella stessa chiamata ANPR — quindi
    la UI applica subito la stessa regola che il backend applicherebbe
    comunque al lancio (CLAUDE.md "INAD — override canale per-recipient"),
    evitando un giro a vuoto. Effetto pratico: select canale si blocca su
    PEC (disabilitato, non editabile finché INAD resta `found` per questo
    destinatario), campo PEC precompilato con l'indirizzo trovato (anch'esso
    non editabile in questo stato). Se l'operatore aveva già scelto un altro
    canale (es. POSTAL) prima di cliccare "Carica dati ANPR", lo switch a
    PEC avviene automaticamente alla risposta, senza conferma. Riguarda solo
    il canale primario — App IO come co-consegna resta scelta separata e
    facoltativa (parallela/esclusiva), non toccata da questa forzatura.
  - se `appIo.active`: badge informativo verde vicino all'opzione App IO
    (co-consegna) — resta solo hint, nessuna forzatura.
  - se `inad.found` è `false` (o l'operatore non clicca il bottone / CF non
    trovato in ANPR): nessun blocco, select canale libero come oggi, form
    compilabile a mano su qualunque canale.

### Enforcement INAD reale — invariato, non toccato da questo spec

Il controllo INAD che forza davvero il canale a PEC quando trova un
domicilio digitale diverso è un meccanismo **backend, automatico, già
esistente**, indipendente dal bottone "Carica dati ANPR" descritto sopra:
`CampaignsService.launch()` (`campaigns.service.ts:407-416`) esegue
`runInadExtractLoop`/`startInadBulkCheck` per QUALSIASI campagna non-SEND
(bulk o a singolo destinatario, indifferente) se il flag globale
`inad.checkEnabled` è attivo — a prescindere da cosa l'operatore ha fatto in
step1. Se trovato domicilio digitale diverso, forza `diverted:true` +
canale PEC, nessun bypass (vedi CLAUDE.md "INAD — override canale
per-recipient"). Se le credenziali INAD non sono configurate
(`inad.prod.purposeId` mancante), `runInadExtractLoop` cattura l'errore
per-destinatario, logga un warning e tratta il caso come "non trovato" —
la campagna prosegue senza divert, silenziosamente (comportamento
pre-esistente, non modificato). Invio singolo eredita questo comportamento
automaticamente perché passa dallo stesso `launch()` di ogni altra
campagna — nessuna modifica di codice necessaria qui.

Nota: se l'operatore ha usato "Carica dati ANPR" e la UI ha già forzato PEC
(sezione precedente), l'enforcement backend a `launch()` ritrova lo stesso
esito (nessun secondo divert, il destinatario è già su PEC) — resta comunque
attivo come rete di sicurezza per il caso in cui l'operatore NON abbia
cliccato ANPR: anche partendo da EMAIL/PEC/POSTAL scelto a mano, il check
automatico di `launch()` può ancora forzare il divert a lancio avvenuto.

### Canale — campi destinatario richiesti in base alla scelta

Select canale invariato (EMAIL/PEC/APP_IO/SEND/POSTAL). In base al valore,
cambiano i campi obbligatori nello stesso step:

| Canale | Campi richiesti oltre CF+Nome |
|---|---|
| EMAIL | email obbligatoria |
| PEC | pec obbligatoria |
| APP_IO | nessun altro campo |
| SEND | indirizzo fisico obbligatorio (via, civico, cap, comune, provincia) |
| POSTAL | indirizzo fisico obbligatorio (via, civico, cap, comune, provincia) |

### Protocollazione

Checkbox esistente, invariata (auto-true e disabilitata per SEND, come
oggi in step1).

### Pagamenti pagoPA

Checkbox "Integrazione pagamenti pagoPA" esistente. Se spuntata, appaiono
subito sotto — nello stesso step, non in uno step3 dedicato — 3 campi
diretti: **IUV** (codice avviso), **Importo**, **Scadenza** (opzionale).
Nessun mapping-colonna-CSV: sostituito da input diretti, essendo 1 solo
destinatario.

### Allegati — selezione inline, upload differito al lancio

Niente più step5 dedicato. Lista a slot nello stesso step:

- Bottone "+ Aggiungi allegato" → ogni slot: campo **Label** (editabile,
  default "Allegato N") + file-input singolo (`.pdf`).
- File tenuti in memoria (`File[]`) attraverso gli step successivi
  (Template→Anteprima), **non ancora caricati sul server**.
- Obbligatorio almeno 1 slot con file per **SEND e POSTAL** (bottone
  "Avanti" di questo step bloccato altrimenti — stessa regola matrice
  canale già esistente, "Allegato obbligatorio per SEND e POSTAL").
- Meccanismo tecnico di collegamento (riuso 1:1 del matching-per-filename
  già usato per CSV multi-riga, **zero modifiche backend**): per ogni slot
  si genera una colonna sintetica nella riga-CSV a 1-riga
  (`allegato_1`, `allegato_2`, ...) il cui valore = `file.name` del file
  scelto in quello slot. Il `wizAttachments[i].key` punta a quella colonna.
  L'utente non digita mai un nome file — coerenza automatica.
- **Upload reale**: scatta in automatico, in modo trasparente (spinner
  "Caricamento allegati..." poi "Invio..."), nel momento in cui l'utente
  preme "Avvia Test" o "Lancia campagna" nello step finale — riusando
  `handleWizUploadAttachments` esistente, invariato, chiamato prima della
  vera azione di lancio/test invece che da un bottone dedicato in uno step
  intermedio.

### Navigazione

Bottone "Avanti" dello step fuso salta direttamente allo step "Template &
Anteprima" (ex step4). Step 2/3 (caricamento CSV / mappatura colonne) e
step5 (upload allegati dedicato) non esistono mai nel percorso
`wizSingleMode`.

Step bar aggiornata per `wizSingleMode`:
`1. Dettagli & Destinatario` → `2. Template & Anteprima` →
`3. Anteprima e Invio` (+ "Invia Test" invariato, non in step bar oggi).

## Cosa NON cambia

- Percorso multi-riga CSV (`!wizSingleMode`): tutti gli step 1-7 invariati,
  incluso upload allegati per filename-matching con step5 dedicato.
- Matrice comportamenti canale/INAD/App IO/protocollo/allegato
  (`2026-07-17-matrice-comportamenti-campagne-design.md`): ereditata,
  non toccata da questo spec.
- Backend `CampaignsService.launch()`/`uploadCsv()`/enforcement INAD:
  nessuna modifica. Il synthetic CSV a 1 riga con colonne extra
  (indirizzo, iuv, importo, scadenza, allegato_N) passa dagli stessi path
  già esistenti usati per CSV multi-riga.
- Regola "creazione campagne — un solo percorso" (CLAUDE.md): invariata,
  invio singolo resta dentro lo stesso wizard, nessun form parallelo.

## Fuori scope

- Riorganizzazione nav "Utility"/restyling generale admin (già rimandato
  dallo spec precedente).
- Qualunque modifica al meccanismo di enforcement INAD backend o alla sua
  configurazione (`inad.checkEnabled`, credenziali PDND) — comportamento
  pre-esistente, fuori scope.
- Verifica toponomastica indirizzo POSTAL (non implementata oggi, non
  introdotta qui).
