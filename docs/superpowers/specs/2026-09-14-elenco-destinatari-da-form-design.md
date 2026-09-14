# Elenco destinatari da form (invio massivo senza CSV obbligatorio) — design

Data: 2026-09-14

## Obiettivo

Oggi l'invio massivo richiede sempre un CSV. Per lotti piccoli (poche
decine di destinatari), caricare/preparare un CSV è più lento che
inserirli a mano. Serve un percorso alternativo nel wizard massivo: un
form che replica, riga per riga, il form dell'invio singolo — Verifica
Anagrafica compresa — per costruire l'elenco destinatari senza CSV.

## Perimetro (deciso in brainstorming)

- **Righe ripetibili**, non incolla-multiplo: bottone "Aggiungi
  destinatario" che riapre il form (CF, nome, email/PEC, eventuali
  colonne extra come importo pagoPA) — stessa validazione client-side
  già in uso nel wizard singolo (CF/email regex prima di interrogare
  Verifica Anagrafica).
- **Limite 20 righe** da form — oltre, il wizard indirizza al CSV
  (messaggio esplicito, non un blocco duro: l'operatore può comunque
  continuare se preferisce, ma il form non è pensato per volumi più
  grandi).
- **Canale fissato una volta per il lotto** (Caso C, vedi analisi sotto)
  — non libero per destinatario.
- **Allegato**: campo "Allegato comune" (si applica a tutte le righe di
  default) + possibilità di override per singola riga con un file
  diverso — stesso meccanismo ZIP+colonna-nome-file già usato dal CSV
  massivo, costruito qui dal frontend invece che caricato dall'operatore.

## Analisi casistiche canale (fatta in brainstorming)

**Caso A — canale libero per destinatario** (replica letterale del
singolo): scartato. Il data model supporta già channelType diverso da
quello nominale della campagna (stesso meccanismo del dirottamento
INAD), ma `channelConfig` (oggetto/testo/allegato/protocollo) vive sulla
campagna, non per destinatario — canali diversi nello stesso lotto
richiederebbero configurazioni di contenuto incompatibili (SEND rifiuta
il body, EMAIL lo richiede) nella stessa campagna. L'unica
implementazione pulita sarebbe creare una campagna per ogni canale
realmente coinvolto — cambia il modello mentale dell'operatore ("un
invio" diventerebbe N campagne), complessità ingestibile per il
beneficio.

**Caso B — canale fissato, Verifica Anagrafica solo informativa**:
zero cambi architetturali (è il bulk di oggi, solo con inserimento via
form invece di CSV) ma la Verifica Anagrafica non cambierebbe nulla che
il sistema non faccia già da solo col dirottamento automatico — non dà
sostanza al requisito "verifica anagrafica fondamentale".

**Caso C — canale fissato, Verifica Anagrafica anticipa il
dirottamento** (scelto): come B, ma quando l'operatore verifica un CF
durante l'inserimento, se INAD trova un domicilio digitale diverso dal
canale scelto per il lotto, il form lo segnala **subito** ("questo
destinatario verrà dirottato su PEC") — stesso meccanismo
`inadCheck`/override già esistente (oggi valorizzato solo al lancio),
qui valorizzato in anticipo durante l'inserimento. Nessuna modifica al
data model, nessuna moltiplicazione di campagne; la Verifica Anagrafica
guadagna un ruolo reale (l'operatore è informato subito, non a sorpresa
dopo il lancio).

## Componenti (livello alto — dettagli da approfondire in fase di sviluppo, vedi sotto)

- **Frontend, wizard massivo, step 2**: toggle "Carica file" / "Inserisci
  a mano". Per il ramo "a mano": riusa la UI e la logica di Verifica
  Anagrafica già esistenti nel wizard singolo (stesso endpoint di
  verifica CF, stessa logica `singleInadForced`/`singleRegistroImpreseNoPec`)
  per mostrare l'anteprima dirottamento per riga.
- Righe accumulate in uno stato lista (array), con vista tabellare
  compatta (CF, nome, canale effettivo se dirottato, allegato) prima
  della conferma finale.
- **Backend**: nessuna modifica prevista. Alla conferma, il frontend
  costruisce un CSV virtuale in memoria (colonne `codice_fiscale`,
  `full_name`, `email`, `pec`, colonna nome-file allegato) e lo invia
  al **medesimo** endpoint di upload CSV già esistente (chunked-upload
  → `uploadCsv()`) — stesso percorso validato del CSV massivo
  tradizionale, coerente con "Creazione campagne — un solo percorso"
  (CLAUDE.md). Lo step 3 (mappatura colonne) viene saltato per questo
  percorso, i nomi colonna sono già quelli attesi dal sistema.

## Da approfondire in fase di sviluppo

Questi punti restano aperti, da decidere quando si comincia
l'implementazione (non bloccano la spec, ma vanno chiusi prima del piano
di implementazione):

- Struttura esatta dello stato React per la lista accumulata (array di
  oggetti vs riuso trasformato dei campi `wizSingle*` esistenti).
- Se e come mostrare/correggere una riga già aggiunta (edit in-place vs
  rimuovi-e-reinserisci).
- Comportamento esatto oltre le 20 righe: solo un avviso, o disabilitare
  "Aggiungi" oltre soglia forzando il passaggio a CSV.
- Se il campo "Allegato comune" va gestito come file unico nel CSV
  virtuale (stessa riga per tutti) o richiede comunque un piccolo ZIP
  anche nel caso "tutti uguali" (verificare il contratto esatto
  dell'endpoint upload allegati massivo).
- Interazione con pagoPA (colonne importo/numero avviso/scadenza) se
  attivo per il canale scelto — il form deve esporre questi campi riga
  per riga, stessa logica del wizard singolo con pagoPA attivo.

## Fuori perimetro (non in questa feature)

- Canale libero per destinatario nello stesso lotto (Caso A, scartato).
- Incolla-multiplo (textarea) come alternativa alle righe ripetibili.
- Rimozione del limite di 20 righe.
