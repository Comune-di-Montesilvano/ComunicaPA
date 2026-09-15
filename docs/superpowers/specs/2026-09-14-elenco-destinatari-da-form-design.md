# Elenco destinatari da form (invio manuale multi-riga, multicanale via campaign group) — design

Data: 2026-09-14 (revisionata 2026-09-15)

## Obiettivo

Oggi l'invio massivo richiede sempre un CSV. Per lotti piccoli (poche
decine di destinatari), caricare/preparare un CSV è più lento che
inserirli a mano. Serve un percorso alternativo: un form che replica,
riga per riga, il form dell'invio singolo — Verifica Anagrafica compresa
— per costruire l'elenco destinatari senza CSV, con un solo click di
conferma anche quando i destinatari finiscono su canali diversi.

## Mount point: estensione di "Invio Singolo", non toggle nel wizard massivo

Decisione presa in revisione (2026-09-15): non si tocca il wizard
massivo. Si estende invece il flusso "Invio Singolo" esistente
(`view === 'invio-massivo-wizard'`, `wizSingleMode`), che oggi già
costruisce un CSV virtuale da un form a singola riga
(`handleWizSingleSubmit`, `App.tsx`) e invia allo stesso endpoint
`uploadCsv()` del massivo — il meccanismo di fondo di questa spec è già
implementato per N=1. Il lavoro è trasformare lo stato da scalare
(`single*`) ad array di righe, non costruire un nuovo percorso.

Nav rinominato: "Invio Singolo" → "**Invio Manuale**" (voce unica, 1
riga è solo il caso degenere di N righe — niente doppia voce
Singolo/Manuale).

Vantaggio verificato: la Verifica Anagrafica è già cablata al momento
dell'inserimento nel form singolo (CF verificato mentre si scrive, non
al lancio) — il requisito "verifica anagrafica anticipa il
dirottamento" è già vero oggi per il caso a 1 riga, va solo esteso a N
righe indipendenti. Anche il pagoPA per-riga (`singlePaymentIuv/
Importo/Scadenza`) esiste già nel form singolo.

## Perimetro

- **Righe ripetibili**: bottone "Aggiungi destinatario" che salva la
  riga corrente nell'array e riapre il form vuoto per la prossima.
  Stessa validazione client-side già in uso nel wizard singolo
  (CF/email regex prima di interrogare Verifica Anagrafica).
- **Dedup**: CF già presente nell'array blocca "Aggiungi" con
  messaggio esplicito (stesso CF non può comparire due volte nello
  stesso lancio).
- **Edit in-place**: click su una riga già aggiunta nella tabella
  riapre il form precompilato con quei valori (Verifica Anagrafica
  ri-eseguibile se il CF cambia); non serve rimuovere e reinserire.
- **Limite 20 righe totali** — oltre, blocco soft: messaggio che
  indirizza al CSV, ma "Aggiungi" resta cliccabile (l'operatore può
  continuare se preferisce).
- **Canale libero per riga** (vedi sezione "Multicanale via campaign
  group" sotto) — non più fissato una volta per l'intero lotto.
- **Allegato**: campo "Allegato comune" (default per tutte le righe) +
  override per singola riga con un file diverso, disponibile da
  subito — stesso meccanismo ZIP+colonna-nome-file già usato dal CSV
  massivo, costruito qui dal frontend.
- **PagoPA**: per riga, colonne sempre presenti nel CSV virtuale
  generato; le Strategy che non supportano pagoPA (tutto tranne
  SEND/APP_IO) le ignorano — nessun cambio a quel meccanismo, già
  vero oggi.
- **Config specifica di canale (mailConfigId, taxonomyCode/
  physicalCommunicationType, postalServiceType/postalReturnReceipt/
  postalColorPrint/postalDuplex, ioServiceId)**: catturata nel form
  solo quando si aggiunge la **prima riga di un canale non ancora
  presente nel lotto** — i campi di config canale compaiono insieme ai
  campi destinatario in quel momento, salvati come default per quel
  canale (`wizManualChannelConfigs[canale]`). Righe successive dello
  stesso canale non li richiedono più (nascosti, riusano il default
  salvato) — evita di dover attraversare uno step "Template" separato
  per ogni canale coinvolto.
- **Protocollazione e valore legale**: non scelti manualmente una
  tantum — ricalcolati **reattivamente** in base ai canali
  effettivamente presenti nel lotto, stessa utility già esistente
  (`isChannelAlwaysLegalValue`) e stessa logica di protocollo
  obbligatorio per SEND già in vigore oggi (`assertSendProtocolConfigured`).
  Aggiungere una riga SEND attiva valore-legale/protocollo per l'intero
  gruppo; rimuovere l'ultima riga SEND li fa tornare allo stato
  riflesso dai canali rimanenti — nessun flag "sticky" separato da
  gestire, stesso comportamento reattivo già presente altrove nel
  wizard.

## Multicanale via campaign group

### Perché non vero multicanale-in-una-campagna

Analizzato e scartato in brainstorming (caso reale portato dall'utente:
collega ha inviato la stessa ordinanza a 10 persone, 6 via SEND e 4 via
PEC, come **due lanci separati** già oggi — non un lancio misto).

Un vero multicanale dentro una sola `Campaign` richiederebbe
ristrutturare `channelConfig` (oggi un oggetto singolo per campagna) in
una forma per-canale, e ogni `*Strategy` dovrebbe risolvere
subject/body/allegato/protocollo da `attempt.channelType` invece che da
`campaign.channelType` — le regole di contenuto sono incompatibili tra
canali (SEND/POSTAL rifiutano il body, EMAIL/PEC/APP_IO lo richiedono;
SEND ha `taxonomyCode` obbligatorio, POSTAL ha `servizio`/AR). Tocca
`campaigns.service.ts` (launch/retry/preview), tutte le Strategy, la
matrice comportamenti in CLAUDE.md andrebbe riverificata riga per riga.
Scope da spec propria, non da questa feature — **fuori perimetro,
definitivamente**.

### Soluzione scelta: campaign group

Un solo click di conferma nel form "Invio Manuale" crea e lancia **N
campagne single-channel esistenti**, invariate (`Campaign`,
`channelConfig`, `*Strategy`, `launch()` — zero modifiche), una per
ogni canale effettivo presente tra le righe del lotto (dopo eventuale
dirottamento INAD), usando per ciascuna il `channelConfig` costruito
dal default di canale catturato in fase di inserimento righe (vedi
sopra). Le N campagne condividono un nuovo campo di collegamento.

**Migration**: `campaigns.group_id uuid NULL` + indice. Nessun altro
cambio al data model. Non "campaign type" (un enum non basta a
rappresentare N campagne sorelle) — un id di raggruppamento condiviso.

**Flusso di conferma**:
1. Operatore ha accumulato righe con canale libero per riga (default =
   canale dell'ultima riga inserita, cambiabile per riga).
2. Operatore sceglie una volta sola, sul form (non per riga):
   protocollazione (sì/no) e valore legale — si applicano a tutte le
   sotto-campagne.
3. Alla conferma, il frontend raggruppa le righe per canale effettivo,
   genera un `group_id`, crea+lancia una `Campaign` per ciascun gruppo
   di canale (stesso meccanismo CSV-virtuale → `uploadCsv()` →
   `launch()` di oggi, ripetuto N volte), tutte taggate con lo stesso
   `group_id`.

**Fallimento parziale**: le N campagne sono indipendenti — se una
fallisce al lancio (es. errore SOAP GlobalCom), le altre già partite
non vengono annullate. Nessun rollback cross-campagna (coerente col
resto del sistema: POSTAL non ha nemmeno un'API di annullamento, vedi
CLAUDE.md). L'operatore vede quale canale è fallito e ritenta solo
quello.

**UI elenco/dettaglio campagne**: le campagne con lo stesso `group_id`
appaiono nell'elenco come una card raggruppata espandibile (nome
lotto, N canali coinvolti) invece che N righe sparse. Il dettaglio di
una singola campagna del gruppo mostra un link alle campagne sorelle
dello stesso lancio.

**Costo reale rispetto a "zero modifiche backend" della bozza
originale**: piccola migration + campo, più superficie UI (card
raggruppata in elenco, link sorelle in dettaglio). Ordini di grandezza
sotto al vero multicanale-in-una-campagna, ma non più "nessuna modifica
backend" — va detto esplicitamente, non è più vero come nella prima
stesura di questa spec.

## Componenti (livello alto — dettagli da approfondire in fase di sviluppo)

- **Frontend, `App.tsx`**: `single*` (scalari: `singleCf`,
  `singleSurname`, `singleEmail`, `singlePec`, indirizzo, pagoPA,
  `wizSingleAttachmentSlots`) diventano `wizManualRows: ManualRow[]`.
  Form attuale resta identico nei campi, scrive sulla "riga in editing"
  invece che su submit diretto. `handleWizSingleSubmit` →
  `handleWizManualSubmit`: raggruppa `wizManualRows` per canale
  effettivo, costruisce un CSV virtuale per gruppo (stesse colonne di
  oggi + `sd_allegato_N` solo per righe con override), invia N volte a
  `uploadCsv()` + `launch()`, imposta `group_id` condiviso.
- `wizSingleSubmitDisabled` diventa validazione per-riga (blocca
  "Aggiungi" se riga corrente invalida) + gate finale (array non vuoto,
  almeno una riga valida) per "Conferma e Invia".
- Vista tabellare compatta sopra la conferma: CF, nome, canale
  scelto/effettivo (con badge se dirottato da INAD), allegato, azioni
  edit/rimuovi.
- **Backend**: migration `AddCampaignGroupId` (`campaigns.group_id uuid
  NULL` + indice). Nessun altro cambio — `campaigns.service.ts`,
  Strategy, `launch()` invariati. Endpoint elenco campagne: aggiungere
  `group_id` alla select/risposta per permettere il raggruppamento
  client-side (o raggruppare lato server, da decidere in fase di
  piano).

## Decisioni tecniche (risolte in fase di brainstorming pre-piano)

- **Allegato comune**: nessun bisogno di ZIP per il caso "tutti
  uguali". L'endpoint `attachments/upload` già accetta upload di file
  singoli per nome; la risoluzione allegato per destinatario
  (`resolveCustomAttachmentFilename`/matching per colonna-nome-file,
  vedi CLAUDE.md "Allegati e co-consegna App IO") già permette a più
  righe CSV di referenziare lo **stesso filename** — l'allegato comune
  è quindi un solo file caricato una volta, referenziato dalla colonna
  `sd_allegato_1` di ogni riga senza override; una riga con override
  referenzia invece il proprio filename distinto, caricato a parte.
  Nessun cambio al meccanismo attachment esistente.
- **Raggruppamento `group_id` in elenco campagne**: lato client. Il
  campo si aggiunge automaticamente alla risposta di `GET
  admin/campaigns` (il controller fa spread dell'entity intera, vedi
  `campaigns.controller.ts:70`) — nessun endpoint dedicato, il
  frontend raggruppa in memoria dopo il fetch esistente.
- **Ordine di lancio delle N campagne del gruppo**: sequenziale (una
  `create → upload CSV → upload allegati → launch` alla volta,
  attendendo il completamento prima di passare al canale successivo).
  Evita N upload paralleli sullo stesso allegato comune e mantiene un
  solo progress indicator alla volta, coerente con l'UX esistente del
  wizard singolo (un solo `wizUploadProgress` globale).
- Struttura stato React `wizManualRows`/`wizManualChannelConfigs`:
  definita nel piano di implementazione (task dedicato), non più punto
  aperto di spec.
- Nudge INAD eterogeneo: banner non bloccante sopra la tabella righe,
  mostrato quando l'insieme delle righe accumulate include sia righe
  con `inadCheck.diverted === true` sia righe con canale diverso da
  quello dirottato — dettaglio implementativo nel piano.

## Fuori perimetro (non in questa feature)

- Vero multicanale-in-una-campagna (channelConfig per-canale dentro la
  stessa `Campaign`) — richiede spec propria, se emerge domanda reale
  oltre al caso risolto da campaign group.
- Incolla-multiplo (textarea) come alternativa alle righe ripetibili.
- Rimozione del limite di 20 righe.
- Rollback cross-campagna in caso di fallimento parziale del gruppo.
