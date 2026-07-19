# Anteprima ricca allo step "Anteprima e Invio" del wizard campagne

Data: 2026-07-19

## Problema

Lo step 6 del wizard ("Anteprima e Invio") mostra oggi solo un riepilogo
statico (nome campagna, canale, conteggio destinatari/allegati, un
render regex-based dell'oggetto sul solo primo record). Non riusa il
motore di anteprima reale già presente allo step 4 ("Template &
Anteprima": rendering server-side via `POST /campaigns/preview`, sfoglia
tra i destinatari validi). L'operatore arriva al lancio reale senza aver
mai visto un'anteprima renderizzata per verificare corpo/oggetto sugli
altri record, e per SEND/POSTAL non ha alcun modo di verificare
indirizzo risolto o allegato PDF effettivo prima dell'invio.

## Scope

- EMAIL/PEC/APP_IO: step6 mostra lo stesso pannello anteprima di step4
  (stesso rendering, stessa sfoglia destinatari).
- SEND/POSTAL: step6 mostra un pannello diverso — indirizzo risolto
  (sempre tutti e 4 i campi, obbligatori per entrambi i canali) +
  download del PDF allegato reale per il record corrente.
- Sfoglia condivisa tra i due pannelli (stesso indice, stesso
  meccanismo prec/succ già esistente in step4).
- Gate aggiuntivo su "Avvia Test" (step7): non accessibile se
  l'allegato atteso per il record di test non è presente in upload.

## Componente condiviso — pannello anteprima EMAIL/PEC/APP_IO

Estrarre il blocco JSX esistente in step4 (tab canale MAIN/APP_IO,
barra sfoglia prec/succ con `wizPreviewIndex`, box oggetto+corpo
renderizzato da `wizPreviewResult`) in un componente
`WizRecipientPreviewPanel`, parametrizzato sui dati già esistenti
(`wizValidRows`, `wizPreviewIndex`, `setWizPreviewIndex`,
`wizPreviewResult`, `wizPreviewLoading`, `wizPreviewChannelTab`,
`setWizPreviewChannelTab`, `wizChannel`, `wizAppIoMode`, `wizMapping`).
Nessuna nuova chiamata di rendering: l'effect che già popola
`wizPreviewResult` al cambio di `wizPreviewIndex` (esistente per step4)
continua a valere anche quando step6 è montato, dato che l'indice è
condiviso — nessuna duplicazione di fetch.

Step6 monta `<WizRecipientPreviewPanel .../>` al posto del riepilogo
statico attuale, quando `wizChannel` è `EMAIL`, `PEC` o `APP_IO`.

## Pannello SEND/POSTAL — indirizzo + download allegato

Nuovo componente `WizAddressAttachmentPreviewPanel`, montato in step6
quando `wizChannel` è `SEND` o `POSTAL`. Riusa la stessa barra sfoglia
(stesso `wizPreviewIndex`/`setWizPreviewIndex` di sopra — un solo
meccanismo di navigazione in tutto il wizard). Per il record corrente
mostra:

- Indirizzo: `wizValidRows[wizPreviewIndex][wizPostalAddressColumn]` +
  Municipality/Zip/Province — sempre tutti e 4 valorizzati (obbligatori
  sia per POSTAL sia per SEND, nessun fallback "risolto da PN": la
  validazione già esistente al passo 3 garantisce che siano sempre
  mappati e non vuoti per ogni riga valida).
- Anteprima PDF inline: calcola il filename atteso per il record
  corrente come già fa la config allegati esistente
  (`wizValidRows[wizPreviewIndex][attachmentEntry.key]`, stessa colonna
  usata per il mapping allegato configurato al passo 3), poi monta
  `<embed type="application/pdf" src=".../preview-file?filename=...">`
  puntato su `GET /admin/campaigns/:id/attachments/preview-file?filename=<nome>`
  (vedi sotto) — il PDF reale già presente in `uploads/<campaignId>/`
  (caricato al passo 5) si vede direttamente nel pannello, senza dover
  scaricare un file per aprirlo. Il token di auth va passato come query
  param (`?token=...`) dato che `<embed src>` non può impostare header
  `Authorization` — stesso pattern già usato altrove nel repo per
  risorse protette caricate da tag HTML nativi (verificare in fase di
  piano se esiste già un meccanismo equivalente, es. short-lived
  download token, da riusare invece di esporre il JWT operatore in
  chiaro nell'URL). Sotto l'embed resta comunque un link "Apri in nuova
  scheda / Scarica" (stessa URL, per chi preferisce il visualizzatore
  nativo del browser o vuole salvare il file).

## Backend — nuovo endpoint download allegato bozza

`GET /admin/campaigns/:id/attachments/preview-file?filename=<nome>`
in `campaigns.controller.ts`, stesso guard di classe
(`@Roles('user','admin')`) degli altri endpoint. Nessun `Recipient`
richiesto — la bozza wizard non ha ancora `Recipient` reali in DB
(si creano solo al lancio effettivo tramite upload CSV). Validazione:

1. Campagna `:id` esiste (altrimenti 404).
2. `filename` deve comparire esattamente in
   `fs.readdirSync(getUploadsDir(id))` — whitelist stretta, nessun
   `path.join()` diretto su input utente (previene path traversal:
   niente `../`, niente path assoluti, il confronto è per uguaglianza
   di stringa contro l'elenco reale dei file presenti, non per
   costruzione di percorso).
3. Se non presente: 404 con messaggio `"Allegato non trovato — verifica
   il Passo 5"` (frontend lo mostra così, non un errore generico).
4. Se presente: stream del file (`Content-Type: application/pdf`,
   `Content-Disposition: inline` — deve aprirsi nel browser dentro
   `<embed>`, non forzare download; il link "Scarica" esplicito in UI
   può comunque ottenere il salvataggio tramite l'attributo `download`
   sul tag `<a>`, che funziona indipendentemente dal `Content-Disposition`
   della risposta).

**Autenticazione per `<embed src>`:** il tag HTML nativo non può
impostare l'header `Authorization: Bearer <token>` usato da tutte le
altre chiamate autenticate del wizard (`apiFetch`). In fase di piano,
verificare se esiste già nel repo un meccanismo di download-link
autenticato via query param per risorse servite da tag HTML nativi
(es. `DOWNLOAD_LINK_SECRET` già citato in CLAUDE.md per link
email/PEC cittadino) da riusare — altrimenti l'endpoint accetta
`?token=<jwt operatore>` in query oltre che in header, stessa verifica
del guard esistente, scelta minima che non introduce un nuovo sistema
di firma.

## Gate aggiuntivo su step7 "Avvia Test"

Dopo il completamento dello step5 (upload allegati), il frontend
verifica una volta (non ad ogni render) l'elenco file effettivamente
presenti in `uploads/<campaignId>/` per il canale corrente (riusa la
stessa chiamata/elenco usato dal pannello SEND/POSTAL di step6 sopra,
o una chiamata equivalente lato client). Se il canale è SEND/POSTAL e
il file atteso per il primo record (quello usato dal test, vedi feature
"invio notifica di prova") non risulta presente, il bottone "Avvia
Test" resta disabilitato con tooltip che spiega il motivo — oltre alla
condizione già esistente `!wizCampaignId`.

## Fuori scope

- Nessuna modifica al motore di rendering server-side
  (`/campaigns/preview`) — riusato as-is.
- Nessuna modifica alla logica di risoluzione allegato esistente
  (`resolveCustomAttachmentFilename`) — il nuovo endpoint non la
  invoca, serve il file per nome esatto già noto lato client.
- EMAIL/PEC con allegato configurato ma canale primario testuale: la
  feature non aggiunge un pannello download separato per questi canali
  in questa iterazione — solo SEND/POSTAL (canali dove l'allegato È il
  contenuto notificato, non un corredo al body).
