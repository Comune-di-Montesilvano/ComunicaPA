# INAD — domicilio digitale come canale unico (fase 2, behaviour)

## Contesto

Fase 1 (completata, vedi `docs/superpowers/specs/2026-07-16-inad-singola-interrogazione-design.md`)
ha implementato la sola interrogazione singola `/extract/{cf}`, verificabile
a mano da Impostazioni. Questa fase implementa il comportamento reale: INAD
è fonte di verità assoluta sul domicilio digitale del cittadino. Se un
destinatario ha eletto un domicilio digitale, quel domicilio diventa
l'**unico** canale di invio — **tranne per SEND**, che risolve il domicilio
digitale legale per conto proprio tramite PN e non fa mai il check INAD
descritto qui.

INIPEC (registro PEC professionisti/imprese) resta esplicitamente fuori
scope — verrà aggiunto in una fase successiva con lo stesso pattern.

## Dati raccolti dal vivo (credenziali INAD prod reali, 2026-07-17)

- `GET /extract/{cf}` (query singola, già in produzione da fase 1): **~0.5s**
  di latenza, risposta sincrona.
- `POST /listDigitalAddress` + polling `state` (bulk, fino a 1000 CF per
  richiesta): **~5m50s** per un batch di 3 CF, stato `IN_ELABORAZIONE` per
  tutto il periodo, poi `303` con risultato disponibile. L'elaborazione è
  quasi certamente a batch periodici lato INAD, non realtime — il costo è
  presumibilmente fisso indipendentemente dal numero di CF nel batch (fino
  al limite di 1000), non lineare.
- `/extract` ha un limite di quota **giornaliero condiviso** (1000-2000
  richieste/giorno secondo indicazione dell'utente, non nello spec OpenAPI)
  — va usato con parsimonia sulle campagne grandi.
- Nessun filtro sul formato del CF: l'interrogazione INAD accetta sia CF
  persona fisica (16 caratteri alfanumerici) sia P.IVA (11 cifre) — costo
  identico, quindi si interroga ogni destinatario con un CF valorizzato,
  senza distinguere persona fisica da P.IVA/professionista.

## Meccanismo di interrogazione (ibrido per dimensione campagna)

- **Campagna con meno di 100 destinatari**: loop `/extract` (query singola
  già esistente da fase 1), con concorrenza limitata (5-10 richieste
  parallele) per non essere eccessivamente lento né sovraccaricare PDND.
  Scelto per campagne piccole perché il costo fisso del bulk (~5-6 minuti)
  non conviene quando il loop sincrono comunque completa in pochi secondi.
- **Campagna con 100 o più destinatari**: sempre `POST /listDigitalAddress`
  bulk, batch da max 1000 CF (più batch concatenati se la campagna supera
  1000 destinatari). Preferito sopra soglia perché il costo è fisso (non
  cresce sensibilmente con la dimensione del batch, sui dati osservati) e
  non consuma la quota giornaliera condivisa di `/extract`.
- **SEND è sempre escluso** da entrambi i meccanismi: nessun check INAD per
  campagne SEND.
- **Toggle globale** in Impostazioni (`inad.checkEnabled` o simile) per
  disattivare l'intera integrazione comportamentale (es. quota INAD
  esaurita, manutenzione) senza rimuovere codice — se disattivato, tutte le
  campagne procedono con canale/indirizzo configurati normalmente, nessun
  check.

## Stato campagna e flusso di lancio

- Nuovo `CampaignStatus.CHECKING_INAD`, inserito subito dopo il lancio
  (`launch()`), prima di `QUEUED`/`RUNNING`, **solo per campagne non-SEND**
  con il toggle INAD attivo. Le campagne SEND o con toggle disattivato
  saltano questo stato e procedono come oggi.
- **Sotto soglia (loop `/extract`)**: un job esegue il loop con concorrenza
  limitata, scrive i risultati per ogni destinatario, poi transizione
  automatica a `QUEUED` a loop completato (nessuna attesa umana prevista,
  ordine di pochi secondi anche per 99 destinatari).
- **Sopra soglia (bulk)**: la richiesta bulk viene inviata al lancio: un
  demone `@Cron` (stesso pattern di `send-status-sync.service.ts` /
  `postal-status-sync.service.ts`) fa polling dello stato ogni N minuti. A
  `DISPONIBILE` recupera i risultati e transiziona a `QUEUED`. Con più
  batch da 1000 (campagne molto grandi), ogni batch che diventa disponibile
  fa avanzare subito i destinatari di quel batch (non si aspetta che tutti
  i batch siano pronti prima di iniziare a inviare).
- **Blocco manuale su timeout**: se un check bulk resta `IN_ELABORAZIONE`
  oltre una soglia configurabile (default 2 ore), la campagna resta ferma
  in `CHECKING_INAD` — **nessun fail-open automatico**. L'operatore deve
  intervenire dalla UI (bottone "Riprova verifica INAD" / "Salta verifica e
  procedi con canale configurato") per sbloccarla esplicitamente.
- Ogni nuovo stato terminale/intermedio introdotto qui va verificato contro
  tutti i metodi che mutano `Campaign`/`Recipient` esistenti (`cancel()`,
  `retryRecipient()`, ecc.) — pattern già noto in questo repo (vedi
  CLAUDE.md, sezione "Job BullMQ e stato campagna/destinatario"): un nuovo
  stato terminale richiede audit di TUTTI i metodi che mutano quel record,
  non solo quello che lo introduce.

## Override canale/indirizzo e persistenza

- Per ogni destinatario con domicilio INAD trovato (`found: true`):
  - **Campagna PEC**: se l'indirizzo INAD trovato è diverso da
    `recipient.pec` configurato, sovrascrive `recipient.pec` con
    l'indirizzo INAD (stesso canale, indirizzo aggiornato).
  - **Campagna EMAIL / POSTAL / APP_IO**: il destinatario viene forzato a
    canale **PEC** per l'invio effettivo. Questo è già rappresentabile
    senza modifiche di schema: `NotificationAttempt.channelType` è già
    per-attempt e indipendente da `campaign.channelType` — al momento della
    produzione dell'attempt (`launch()` in `campaigns.service.ts`), si
    sceglie `channelType = 'PEC'` per quel destinatario invece del canale
    di campagna. `recipient.pec` viene valorizzato con l'indirizzo INAD
    trovato (per questi canali il campo era tipicamente vuoto).
  - Se INAD non trova nulla per un destinatario (`found: false`), nessun
    override: procede con il canale/indirizzo configurato in campagna,
    come oggi.
- **Nuova colonna di audit su `Recipient`**: `inad_check` (jsonb, nullable)
  — `{ found: boolean, originalChannel: string | null, originalAddress:
  string | null, checkedAt: string }`. Scritta per ogni destinatario
  controllato (anche se `found: false`, per distinguere "controllato, non
  trovato" da "mai controllato" — stesso pattern già usato in questo repo
  per lo stato business null vs fallito, vedi CLAUDE.md). Preserva il dato
  originale prima di un eventuale overwrite di `recipient.pec`.
- **Nessuna modifica alle Strategy esistenti**: `PecStrategy`/`EmailStrategy`
  continuano a leggere `recipient.pec`/`recipient.email` direttamente,
  invariate — l'override avviene scrivendo sul recipient prima che la
  strategy venga invocata, non nella strategy stessa.

## Wizard — step PEC sempre presente per campagne non-SEND

Per ogni campagna non-SEND con canale diverso da PEC, il wizard mostra
sempre uno step aggiuntivo obbligatorio: mittente PEC da usare + template
email/PEC da applicare agli eventuali destinatari con override INAD attivo.
Mostrato incondizionatamente (anche se poi nessun destinatario di quella
campagna avrà un domicilio INAD attivo) per non introdurre un'ulteriore
toggle di attivazione per-campagna — coerente con la decisione già presa in
fase 1 di preferire "template a volte inutilizzati" a "complessità
aggiuntiva nel software".

## Fuori scope (questa fase)

- INIPEC (PEC professionisti/imprese) — stesso pattern, fase successiva.
- Tracking/dashboard di quanti destinatari sono stati overridden per
  campagna (nessuna UI di reportistica specifica, solo la colonna di audit
  `inad_check` per destinatario).
- Retry automatico del check INAT dopo un fallimento bulk — solo intervento
  manuale operatore (vedi sopra).
- Rate limiting/gestione esplicita della quota giornaliera `/extract` a
  livello applicativo (es. contatore, blocco preventivo) — si osserva il
  comportamento reale in produzione prima di aggiungere questa complessità.
