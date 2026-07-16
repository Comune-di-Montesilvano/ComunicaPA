# Verifica CAP/Stradario POSTAL — GlobalCom GBCCap

## Contesto

Il wizard campagne, step3 canale POSTAL, non convalida che via/città/CAP dichiarati
nel CSV corrispondano a un indirizzo reale — un CAP o una via errati vengono
scoperti solo dopo la spedizione cartacea reale (ritorno al mittente, costo
sprecato). GlobalCom espone un secondo web service SOAP, `GBCCap.asmx` (WSDL
verificato raw: `https://montesilvano.corrispondenzadigitale.it/gbcweb/GBCCap.asmx?wsdl`),
dedicato a informazioni geografiche (CAP, città, vie, province, regioni).

**Verificato sul WSDL/manuale tecnico raw (non un riassunto)**: il servizio è
un'API di lookup/typeahead (parametri `prefixText`/`contextKey`, pensati per
autocomplete UI), non un servizio di validazione/normalizzazione di un
indirizzo completo. Non esiste un metodo "verifica indirizzo" o "correggi
indirizzo" — l'unico modo per ottenere una verifica è comporre più chiamate di
lookup e confrontare il risultato con quanto dichiarato nel CSV. Metodi
rilevanti: `CittaDaCap` (CAP → città), `ListaCAPDaCitta` (città → CAP validi,
`tipoRicerca=ctExact`), `ListaVieDaCAP`/`TabellaVieDaCAP` (CAP → vie note).

## Obiettivo

Nuovo step nel wizard, solo per canale POSTAL, che verifica città+CAP+via di
ogni riga CSV contro il cappario/stradario GlobalCom, segnala le righe con
mismatch, propone correzioni quando disponibili, e blocca l'avanzamento finché
l'operatore non decide esplicitamente cosa fare di ogni riga segnalata.

## Backend

### `GlobalComClient` — nuovo metodo `verificaIndirizzo`

File: `apps/backend/src/channels/postal/globalcom-client.service.ts`.
Riusa il pattern esistente (`createSession`, cookie ASP.NET_SessionId,
convenzione `<nomeMetodo>Result`, mai loggare il body del Login) ma punta a
`capBaseUrl` invece di `baseUrl`.

Per una tupla `(via, città, cap)` unica, esegue in sequenza:

1. `CittaDaCap(contextKey=cap)` → lista città valide per quel CAP.
   - Se la città dichiarata (case-insensitive) è nella lista → città OK.
   - Se non c'è ma la lista ha esattamente 1 elemento → suggerisci quella città.
   - Se la lista è vuota → CAP stesso non esiste nel cappario, marca `unresolved`.
2. `ListaCAPDaCitta(contextKey=città-risolta, tipoRicerca=ctExact)` → CAP validi
   per quella città.
   - Se il CAP dichiarato è nella lista → CAP OK.
   - Se non c'è → suggerisci i CAP della lista (può essere più di uno, città
     grandi hanno più CAP per zona).
3. `ListaVieDaCAP(contextKey=cap-risolto)` → vie note per quel CAP.
   - Match case-insensitive, tollerante al prefisso DUG (VIA/VIALE/CORSO/...)
     tramite normalizzazione con `DUG` (lista tipologie) prima del confronto.
   - Match esatto → via OK. Nessun match ma lista non vuota → nessun
     suggerimento affidabile (troppe vie candidate), marca `unresolved` con
     nota "via non trovata nello stradario del CAP".

Esito per riga: `{ status: 'ok' | 'suggested' | 'unresolved', suggestedVia?, suggestedCitta?, suggestedCap?[], note? }`.

**Deduplica**: le chiamate si fanno per tupla `(via, città, cap)` unica nel
CSV, non per riga — un CSV di migliaia di righe con poche decine di comuni
diversi non deve generare migliaia di chiamate SOAP identiche. Cache in
memoria per la durata della richiesta.

### Endpoint

`POST /admin/campaigns/:id/postal/verify-addresses`

Input: mapping colonne già scelto in step3 (`addressColumn`,
`municipalityColumn`, `zipColumn`) + righe valide correnti (o rilette dalla
bozza CSV salvata). Output: array per riga con l'esito sopra.

Segue il pattern 200-with-flag per errori previsti (CLAUDE.md, proxy esterno):
se il provider POSTAL configurato non ha `capServiceAvailable` (vedi sotto),
risponde `{ available: false }` con HTTP 200 — il frontend salta lo step,
nessuna eccezione non-2xx.

### Config — `PostalProviderConfig`

Nuovo campo nullable `capBaseUrl` (default derivato lato UI/service sostituendo
il filename in `baseUrl`: `.../gbcweb/GBCWebservice.asmx` →
`.../gbcweb/GBCCap.asmx`, verificato essere il pattern reale in uso). Campo
editabile per override manuale se un'installazione GlobalCom non segue la
convenzione (il manuale tecnico GBCCap nota esplicitamente che il servizio
"non è sempre disponibile... viene distribuito come estensione al sistema").

Nuovo flag audit-only `capServiceAvailable` (boolean), scoperto dal tasto
"Test" esistente (`PostalProvidersService`) con una chiamata `SessionCheck` o
`Login` verso `capBaseUrl` — stesso pattern di `enabledServiceTypes`/
`ContrattiH2H` già presente per il servizio principale. Migration additiva
(`ALTER TABLE postal_provider_configs ADD COLUMN cap_base_url ...`, `ADD COLUMN
cap_service_available boolean DEFAULT false`).

## Frontend — nuovo step wizard "Verifica Indirizzi"

Si inserisce tra step3 (Mappatura) e l'attuale step4 (Template), solo quando
`wizChannel === 'POSTAL'` **e** il provider configurato ha
`capServiceAvailable === true` — altrimenti lo step non compare affatto (stesso
principio di skip già usato per App IO quando non configurato), e la
numerazione step visibile si adatta di conseguenza.

Contenuto:

- Al primo ingresso nello step, chiama l'endpoint di verifica su tutte le
  righe valide, mostra spinner (può richiedere secondi su CSV con molti comuni
  diversi).
- Tabella righe con `status !== 'ok'`: colonna riga, valori dichiarati,
  suggerimento (se presente), tre azioni per riga — **Accetta suggerimento**
  (solo se disponibile), **Tieni originale**, **Escludi riga dall'invio**.
  Bottone bulk "Accetta tutti i suggerimenti disponibili".
- Righe `unresolved` (nessun suggerimento) mostrano comunque le tre azioni
  meno "Accetta suggerimento" — l'operatore deve scegliere esplicitamente tra
  tieni originale o escludi, non c'è un default silenzioso.
- **Avanti bloccato** finché ogni riga segnalata non ha una decisione esplicita
  (stato tracciato lato wizard, non serve persistere nulla finché non si lancia
  la campagna).
- Le correzioni accettate sovrascrivono i valori usati per
  `physicalAddressConfig` all'invio (non il CSV originale — restano applicate
  solo ai dati della campagna corrente, coerente con come il wizard già
  trasforma i dati di mappatura in `channelConfig` senza toccare il file
  sorgente).

## Fuori scope

- Non tocca province/regioni (via CAP+città è sufficiente per GlobalCom, la
  provincia resta il campo opzionale già esistente).
- Non introduce un servizio di validazione indirizzi generico per altri
  canali — è specifico a POSTAL/GlobalCom.
- Non implementa retry automatico su indirizzi `unresolved` dopo la modifica
  manuale in step3 (l'operatore corregge il CSV e ricarica da capo se vuole
  ripartire da zero).
