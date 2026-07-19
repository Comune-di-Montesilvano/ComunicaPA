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

**Allegato inline anche su questi canali.** Se la campagna ha allegati
configurati (`resolveAttachmentsConfig(channelConfig).length > 0` —
per EMAIL/PEC/APP_IO l'allegato è opzionale, non obbligatorio come per
SEND/POSTAL, ma se presente va comunque mostrato), il pannello include
sotto il corpo renderizzato lo stesso blocco `<embed>` PDF inline
descritto per SEND/POSTAL sotto — stesso endpoint, stessa logica di
risoluzione filename dal record corrente. Se la campagna non ha
allegati configurati, il blocco semplicemente non compare (nessun
placeholder vuoto).

## Componente condiviso — anteprima allegato inline

Terzo componente, `WizAttachmentInlinePreview`, usato sia dal pannello
EMAIL/PEC/APP_IO sia da quello SEND/POSTAL (sotto): riceve il record
corrente (`wizValidRows[wizPreviewIndex]`) e la config allegati della
campagna, calcola il filename atteso.

- Se la campagna non ha allegati configurati: non renderizza nulla
  (nessun placeholder).
- Se il filename atteso termina in `.pdf` (case-insensitive): fa
  `fetch()` autenticato standard (stesso `Authorization: Bearer`
  pattern già usato ovunque nel wizard — nessun meccanismo nuovo)
  verso l'endpoint sotto, ottiene il `Blob`, crea un Object URL
  (`URL.createObjectURL(blob)`) e lo monta come
  `<embed type="application/pdf" src={objectUrl}>`. L'Object URL va
  revocato (`URL.revokeObjectURL`) al cambio di record/smontaggio per
  non accumulare memoria durante una sfoglia lunga.
- Se il filename atteso ha un'altra estensione (es. allegati non-PDF
  estratti da uno ZIP): mostra solo un link "Scarica" che innesca lo
  stesso fetch-poi-blob e lo salva via `<a href={objectUrl} download>`
  sintetico — nessun `<embed>`, un browser non garantisce un
  visualizzatore inline affidabile per tipi arbitrari.
- Errore fetch (404 "allegato non trovato" o altro): messaggio inline
  nel pannello, nessun crash.

**Niente token in query string.** L'endpoint sotto resta protetto dal
normale guard JWT (`@Roles`, header `Authorization`) come tutti gli
altri endpoint di `admin/campaigns` — il fetch autenticato standard
(stesso `apiFetch`/`fetch`+header già usato ovunque nel wizard) prende
i byte e li trasforma in Object URL locale al browser, quindi
`<embed src>` non deve mai autenticarsi da solo. Nessun meccanismo di
firma nuovo, nessun riuso del sistema `DOWNLOAD_LINK_SECRET` (quello è
per link pubblici cittadino via `PublicDownloadController`, dominio
diverso — verificato che il frontend admin non lo usa mai, sempre
Bearer header).

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
- Anteprima PDF inline: monta `<WizAttachmentInlinePreview .../>`
  (componente condiviso, vedi sopra) per il record corrente — per
  SEND/POSTAL l'allegato è sempre presente (obbligatorio), quindi il
  componente renderizza sempre qualcosa qui (mai il caso "nessun
  allegato configurato").

## Backend — nuovo endpoint download allegato bozza

`GET /admin/campaigns/:id/attachments/preview-file?filename=<nome>`
in `campaigns.controller.ts`, stesso guard di classe
(`@Roles('user','admin')`, header `Authorization` standard — nessuna
eccezione). Nessun `Recipient` richiesto — la bozza wizard non ha
ancora `Recipient` reali in DB (si creano solo al lancio effettivo
tramite upload CSV). Validazione:

1. Campagna `:id` esiste (altrimenti 404).
2. `filename` deve comparire esattamente in
   `fs.readdirSync(getUploadsDir(id))` — whitelist stretta, nessun
   `path.join()` diretto su input utente (previene path traversal:
   niente `../`, niente path assoluti, il confronto è per uguaglianza
   di stringa contro l'elenco reale dei file presenti, non per
   costruzione di percorso).
3. Se non presente: 404 con messaggio `"Allegato non trovato — verifica
   il Passo 5"` (frontend lo mostra così, non un errore generico).
4. Se presente: risposta binaria (`Content-Type: application/pdf` o
   `application/octet-stream` per non-PDF, `Content-Disposition: inline`)
   — il frontend la consuma come `Blob` via `fetch()` autenticato
   standard, non come URL diretto in un tag HTML (vedi sopra).

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
(nessuna esclusione per canale sull'anteprima allegato inline — vedi
sopra, si applica a tutti e cinque i canali quando l'allegato è
configurato).
