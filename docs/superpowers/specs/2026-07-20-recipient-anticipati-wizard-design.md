# Recipient anticipati, autosave silenzioso, gating navigazione, upload allegati multipli, CF Ente opzionale

Data: 2026-07-20

## Problema

Quattro problemi/richieste distinti nel wizard campagne, risultati intrecciati sullo stesso meccanismo (persistenza destinatari/allegati):

1. **Bug: allegati scartati a step5.** `finalizeAttachments()` calcola i file
   "referenziati" leggendo i `Recipient` in DB per la campagna — ma a step5
   i `Recipient` non esistono ancora (creati oggi solo al lancio reale, dentro
   `handleWizLaunch`). Risultato: ogni allegato caricato a step5 viene
   scartato subito dopo, con popup fuorviante ("1 file scartato" quando in
   realtà lo sono tutti, perché la UI riporta solo l'ultimo risultato di un
   loop che chiama l'endpoint una volta per file).
2. **Feature: autosave silenzioso.** Dallo step 2 in poi, ogni click su
   "avanti" deve salvare la bozza senza alert (oggi solo step4→5 salva, con
   un `alert('Bozza salvata.')` visibile).
3. **Feature: navigazione step condizionata alla struttura.** Se una
   campagna ha già raggiunto lo step 6, tutti gli step restano
   click-navigabili direttamente (comportamento attuale, da mantenere) — ma
   se l'operatore torna a step 2/3 e cambia file CSV o mappatura, i tab
   successivi (5/6/7) devono ridiventare non raggiungibili direttamente
   finché la mappatura non viene riconfermata. Modifiche al template
   (step4: oggetto/corpo) NON sono distruttive verso gli step successivi
   (non toccano CSV/mappatura) — non devono invalidare nulla.
4. **Feature: upload allegati multipli a step5.** Oggi un solo bottone fa
   upload+avanzamento insieme, senza modo di verificare quanti allegati
   attesi sono realmente presenti. Serve poter caricare in più passate (più
   ZIP, più file singoli) con una barra di progresso "X di Y presenti" e
   "avanti" abilitato solo a copertura completa.
5. **Feature: CF Ente Creditore opzionale.** Campo obbligatorio nel form
   pagoPA (SEND/App IO), ma se l'Ente Creditore coincide con l'Ente che
   invia la comunicazione, l'operatore non deve doverlo compilare.

## Causa radice comune (1-4)

I `Recipient` vengono persistiti in DB solo al lancio reale della campagna.
Qualunque logica che ha bisogno di sapere "chi sono davvero i destinatari
di questa bozza" (allegati referenziati, validità struttura CSV) non ha
dati affidabili prima di quel momento. La soluzione architetturale scelta:
**anticipare la persistenza dei Recipient a ogni passaggio "avanti" dal
wizard**, riusando il meccanismo di import già esistente
(`CampaignsService.uploadCsv()`, che fa già delete-and-recreate dei
Recipient per campagna), invece di introdurre un secondo modo di risolvere
"chi sono i referenziati".

## 1. Sync anticipato Recipient + autosave silenzioso

**Backend:** nessuna modifica. `uploadCsv(campaignId, filePath)`
(`campaigns.service.ts:212-269`) già cancella e ricrea tutti i `Recipient`
di una campagna da un CSV normalizzato (colonne `codice_fiscale, full_name,
email, pec, ...extra`) — endpoint chunked `:id/recipients/upload` già
esposto e già usato da `handleWizLaunch`.

**Frontend — nuova funzione condivisa `buildNormalizedRecipientsCsvBlob()`:**
estrae la logica già scritta in `handleWizLaunch`
(`App.tsx:4567-4589`, oggi build inline del CSV normalizzato da
`wizValidRows`+`wizMapping`) in una funzione riusabile che ritorna un
`Blob`. `handleWizLaunch` la usa al posto del blocco inline (nessun cambio
di comportamento).

**Frontend — nuova funzione `syncWizDraftAndRecipients(): Promise<string | null>`:**
sostituisce/estende `handleSaveWizardDraft` — stessa logica di creazione/
patch campagna + salvataggio CSV grezzo bozza (`recipients/draft-csv`,
`App.tsx:4322-4379`), **più**, se `wizValidRows.length > 0` e la mappatura
CF è valorizzata, upload chunked del CSV normalizzato via
`buildNormalizedRecipientsCsvBlob()` verso `recipients/upload` (stesso
endpoint di `handleWizLaunch`). Nessun `alert()`: gli unici messaggi visibili
restano gli errori (stesso pattern attuale di `handleSaveWizardDraft`, che già
usa `alert(err.message)` solo nel catch).

**Punti di chiamata — ogni "avanti" da step2 in poi:**
- `setWizStep(3)` (righe 5938, 6007): diventa `onClick` async che chiama
  `syncWizDraftAndRecipients()` poi `setWizStep(3)` se non fallito.
- `handleWizAdvanceToStep5` (già async, righe 4387-4391): sostituisce la
  chiamata a `handleSaveWizardDraft()` con `syncWizDraftAndRecipients()`,
  rimuove l'alert (già non c'è in questa funzione, il salvataggio è
  silenzioso qui — solo `handleSaveWizardDraft` diretto, chiamato altrove,
  mostra l'alert).
- Step3→4 (riga 6502, "Procedi a Template"): stesso pattern, diventa async
  con `syncWizDraftAndRecipients()` prima di `setWizStep(4)`. **Questo è il
  momento in cui lo snapshot di gating (sezione 3 sotto) viene aggiornato.**
- Ogni altro bottone "avanti" nel wizard da step2 in su segue lo stesso
  pattern: `await syncWizDraftAndRecipients()` → se non-null, `setWizStep(N)`.

`handleSaveWizardDraft` ha un solo punto di chiamata in tutto il file
(dentro `handleWizAdvanceToStep5`, riga 4388) — nessun bottone "Salva
bozza" manuale distinto esiste altrove. Va quindi rimossa e sostituita
interamente da `syncWizDraftAndRecipients` (che ne assorbe la logica di
creazione/patch campagna + CSV grezzo, aggiungendo il sync dei Recipient):
nessun `alert('Bozza salvata.')` sopravvive nel wizard.

**Effetto collaterale che risolve il bug 1:** quando l'operatore arriva a
step5, i `Recipient` esistono già (creati al passaggio 3→4). Gli upload di
allegati a step5 (vedi sezione 4) trovano `finalizeAttachments()` capace di
risolvere correttamente i referenziati fin dal primo file caricato — nessun
cambiamento a `finalizeAttachments()` stessa necessario per questo.

## 2. Gating navigazione tab su cambio struttura

**Nuovo state:** `wizLastSyncedHeaders: string[] | null` e
`wizLastSyncedMapping: typeof wizMapping | null` — snapshot presi
esclusivamente al momento del sync 3→4 (quando la mappatura è confermata),
non ad ogni sync generico (il sync di step2→3, ad esempio, avviene prima
che la mappatura sia stata rivista dall'operatore, quindi non è un
checkpoint valido).

**Confronto:** i tab-step diretti per step ≥ 5 (il meccanismo di click
diretto sui tab già esistente, che oggi permette di saltare liberamente se
la campagna ha già raggiunto quello step) restano abilitati solo se, al
momento del render, `wizCsvHeaders` (array, confronto per uguaglianza
ordinata — stesso ordine di caricamento del CSV) e `wizMapping` (confronto
per uguaglianza dei 5 campi mappati: `codice_fiscale`, `full_name`,
`full_name_2`, `email`, `pec`) coincidono esattamente con lo snapshot.

**Se non coincidono:** tab 5/6/7 disabilitati (attributo `disabled`),
tooltip "Le colonne del file sono cambiate — ripassa dalla Mappatura per
confermare". Il tab 4 (Template) resta sempre navigabile liberamente (non
dipende dallo snapshot). Passando di nuovo da step 3→4 (che aggiorna lo
snapshot), i tab si riabilitano.

**Modifiche al template (step4) non invalidano nulla:** non toccano
`wizCsvHeaders`/`wizMapping`, quindi lo snapshot resta valido e i tab 5/6/7
restano navigabili come oggi.

## 3. Upload allegati multipli a step5, con barra progresso

**Backend — `finalizeAttachments()` (`campaigns.service.ts:1746-1802`):**
nessun cambiamento alla logica di scarto (già additiva/cumulativa sulla
directory intera, già scarta solo i non-referenziati, già sovrascrive per
stesso nome — comportamento corretto una volta risolto il bug 1 sopra).
Cambia solo il valore di ritorno: oltre a `{ uploaded, discarded }`,
aggiungere `attachmentsExpected` (= `referenced.size`, righe 1769-1778) e
`attachmentsPresent` (= conteggio dei file in `dir` il cui nome coincide
con un referenziato, dopo lo scarto — sottoinsieme di `uploaded`).
Propagare questi due campi nelle risposte di `uploadAttachments()`
(riga 294-298) e `completeAttachmentsChunkedUpload()` (riga 378) del
controller.

**Frontend — due bottoni separati** al posto dell'attuale "Carica allegati
e continua" (righe 6763-6776 e duplicato 6839-6852):
- **"Carica Allegati"**: esegue solo l'upload (loop chunked esistente su
  `wizPdfFiles`, invariato), NON chiama più `setWizStep(6)` alla fine.
  Dopo l'ultima risposta del loop, salva `attachmentsExpected`/
  `attachmentsPresent` in nuovo state `wizAttachmentProgress: { expected:
  number; present: number } | null`. Ripetibile: l'operatore può selezionare
  altri file (`wizPdfFiles` si aggiorna dal file input) e ricliccare
  "Carica Allegati" quante volte serve (più ZIP, più singoli).
- **"Avanti"**: nuovo bottone separato, `onClick={() => setWizStep(6)}`,
  `disabled` finché `wizAttachmentProgress` è `null` oppure
  `wizAttachmentProgress.present !== wizAttachmentProgress.expected`.

**Barra di progresso:** stesso stile della barra upload byte-based già
presente (righe 6812-6829, `wizUploadProgress`), nuova barra separata
sotto: "Allegati: {present} di {expected} presenti", percentuale
`present/expected`. Visibile dopo il primo upload riuscito (quando
`wizAttachmentProgress !== null`); se `expected === 0` (canale con
allegato opzionale, nessun destinatario lo referenzia) la barra non
compare e "Avanti" è comunque abilitato.

## 4. CF Ente Creditore opzionale

**Frontend** (`App.tsx:6302-6310`): rimuovere `required` dall'input
`wizPaymentPayeeStatic`. Aggiungere sotto l'input un
`<div className="form-text small text-muted">` con testo: "Lascia vuoto se
l'Ente Creditore è lo stesso Ente che invia questa comunicazione." La label
resta "Codice Fiscale Ente Creditore" ma senza `*` (non più obbligatorio).

**Backend — App IO** (`app-io.strategy.ts:90-91`): nessun cambiamento,
già tollera `creditorTaxId` vuoto (omette `paymentData.payee` se falsy).

**Backend — SEND** (`send-dispatch.service.ts`, intorno alla riga 163-168):
oggi il payload pagoPa include sempre `creditorTaxId: resolvedPayment.creditorTaxId`
anche se stringa vuota. Modifica: se `resolvedPayment.creditorTaxId` è
vuoto/falsy, usare `senderTaxId` (già letto poco sotto nello stesso metodo,
riga 177, va spostata prima nell'ordine delle operazioni) come fallback —
esattamente il caso "stesso Ente che invia". Se anche `senderTaxId` non è
configurato, il campo resta stringa vuota come oggi (nessuna eccezione
nuova, comportamento invariato per chi non configura nulla).

## Fuori scope

- Nessuna modifica al meccanismo di retry/gestione di `Recipient` già
  esistenti per campagne già lanciate — questo design riguarda solo la fase
  bozza/wizard, prima del lancio.
- Nessuna modifica al gate esistente di "Avvia Test" (step7,
  `wizTestAttachmentReady`) — continua a verificare solo l'allegato del
  primo record valido, invariato.
- Nessuna modifica alla UI di step6 (anteprima ricca, già completata in
  sessione precedente) oltre a quanto già in produzione.
