# Validazione + correzione CF/Partita IVA in Arricchimento Tracciati — design

Data: 2026-09-16

## Problema

"Arricchimento Tracciati" non valida il formato di `codice_fiscale` durante
l'elaborazione: un CF/PIVA malformato nel CSV Maggioli passa indenne fino
alla creazione campagna, dove il wizard lo scopre solo al lancio (troppo
tardi — l'operatore deve tornare all'arricchimento per capire quale riga).

Caso reale verificato (`Postalizzazione Saldo PEC.zip`, riga 1): CSV
`codice_fiscale="2333900682"` (10 cifre), PDF riporta `C.F.: P.Iva:
02333900682` (11 cifre) — zero iniziale perso, quasi certamente in un
passaggio per campo numerico a monte (stesso meccanismo già noto per il CAP,
vedi `_pad_cap` in `pdf_extractor.py`). Sullo stesso tracciato: ~700 righe
con lo stesso difetto — un flusso "un warning, una correzione manuale a
riga" non è praticabile a quel volume.

Inoltre, il form "Correggi dati" (avviso per riga) non permette di
modificare `codice_fiscale` — solo indirizzo e altri campi — e il bottone
"Verifica ANPR"/"Carica da Registro Imprese" nello stesso form usa un CF
letto una sola volta all'apertura riga, mai aggiornato se l'operatore lo
modifica nel form: interrogare Registro Imprese per una persona giuridica
dopo aver corretto il CF a mano non funziona oggi (bug di stato stantio,
non un limite del backend — `DomicilioService.cercaDomicilio` instrada già
correttamente su Registro Imprese per un valore a 11 cifre).

## Fuori scope

- Verifica formale (checksum) del CF/PIVA — solo controllo di formato,
  stesso principio già in uso in `isPartitaIva`/`isValidCfOrPiva` esistenti
  (CLAUDE.md, sezione "tax-id.util.ts").
- Blocco del lancio campagna per CF/PIVA invalido — resta un warning
  informativo in arricchimento, mai uno stato bloccante nuovo (stesso
  principio di `2026-07-29-arricchimento-validazione-design.md`).
- Verifica checksum PIVA (modulo 11) — fuori scope, non richiesto.

## 1. Zero-pad automatico PIVA a 10 cifre (fix di massa, silenzioso)

Una PIVA italiana valida è **sempre** 11 cifre numeriche; un CF persona
fisica è **sempre** 16 alfanumerici — non esiste un identificativo valido di
esattamente 10 cifre numeriche in questo dominio. Un valore CSV a 10 cifre
numeriche è quindi un caso non ambiguo di zero iniziale perso a monte
(stesso ragionamento già validato e documentato per `_pad_cap`/CAP).

Fix in `apps/backend/src/enrichment/maggioli-parser.ts` (parsing CSV, non
PDF — il difetto è nel tracciato Maggioli, non nella lettura del PDF):
nuova funzione

```ts
function normalizeCodiceFiscale(value: string): string {
  const v = value.trim();
  return /^\d{10}$/.test(v) ? v.padStart(11, '0') : v;
}
```

applicata ai 4 punti che leggono `codiceFiscale` da CSV (`parseRubricaPec`,
3 varianti di formato; `parsePagIndice`, 1 variante), **prima** di
assegnarlo a `codiceFiscale` e di passarlo a `tipoFromCf` (così `tipo`
resta coerente col valore finale, anche se nel caso 10→11 cifre l'esito di
`tipoFromCf` — sempre `'PG'` per un valore non a 16 caratteri — non cambia).

Nessun warning generato per questo caso: stesso trattamento silenzioso già
in uso per il CAP, il pattern è altrettanto non ambiguo. Risolve l'intero
caso reale (700 righe) senza alcuna azione dell'operatore.

## 2. Validazione formato post-normalizzazione (righe non recuperabili dal solo zero-pad)

`apps/backend/src/enrichment/enrichment.processor.ts`, `processEnrich`,
stesso punto di inserimento delle regole Paese/Città/CAP esistenti (subito
prima di `rows.push(row)`, incondizionato — `row.codice_fiscale` esiste
sempre, popolato da `baseRow()` anche quando l'estrazione PDF fallisce).

Nuova funzione condivisa `isValidCfOrPiva` in
`apps/backend/src/channels/tax-id.util.ts` (oggi contiene solo
`isPartitaIva`, usata da `DomicilioService`/`InadVerifyBulkService`/
`campaigns.service.ts`) — stesso regex già in uso lato frontend
(`App.tsx:1121`, mai condiviso fino ad ora perché nessun consumer backend
ne aveva bisogno):

```ts
export function isValidCfOrPiva(value: string): boolean {
  const v = value.trim();
  return /^[A-Z0-9]{16}$/i.test(v) || /^\d{11}$/.test(v);
}
```

Logica di validazione in `processEnrich`:

```
cf = row.codice_fiscale.trim()
se cf vuoto:
  warning: 'Codice Fiscale/Partita IVA mancante'
altrimenti se !isValidCfOrPiva(cf):
  se result?.fiscalCode e isValidCfOrPiva(result.fiscalCode):
    row.codice_fiscale = result.fiscalCode
    warning: `Codice Fiscale/Partita IVA CSV non valido ("${cf}") — sostituito con valore estratto dal PDF`
  altrimenti:
    warning: `Codice Fiscale/Partita IVA non valido ("${cf}")`
```

`result` (oggetto ritornato da `PdfExtractorClient.extract`) va dichiarato
fuori dal blocco `try` interno (oggi scoping locale) per restare leggibile
in questa sezione — stesso pattern già in uso per `warnings`/`rows` nello
stesso metodo. Se l'estrazione PDF è fallita o il PDF non è stato trovato,
`result` è `undefined`: si applica solo il ramo "non valido" senza
fallback.

Il "sostituito con valore estratto dal PDF" è **auto-applicato** (scrive
`row.codice_fiscale`), non solo proposto — coerente con la decisione presa
per questo design (stesso pattern già in uso per l'indirizzo mancante da
CSV: PDF come fallback automatico, mai silenzioso — resta comunque un
warning in lista, correggibile/ignorabile come gli altri).

## 3. Estrazione CF/PIVA dal PDF (fallback per casi non risolvibili da zero-pad)

`services/pdf-extractor/app/pdf_extractor.py` — nuovo metodo
`extract_fiscal_code() -> Optional[str]`, stesso approccio testuale già in
uso per l'indirizzo (regex su testo pagina 0, via `pdfplumber`). Verificato
sui due formati reali osservati nello stesso documento di test:

- persona fisica: `C.F.:DLLMCL65B24B180N`
- persona giuridica: `C.F.: P.Iva:02333900682`

```python
_RE_CF_LABEL = re.compile(
    r"C\.F\.\s*:\s*(?:P\.?\s*Iva\s*:\s*)?([A-Z0-9]{11,16})",
    re.IGNORECASE,
)

def extract_fiscal_code(self) -> Optional[str]:
    with self._open() as pdf:
        if not pdf.pages:
            return None
        text = pdf.pages[0].extract_text() or ""
    m = self._RE_CF_LABEL.search(text)
    return m.group(1).upper() if m else None
```

`app/main.py`, endpoint `/extract`: chiamata incondizionata (try/except
come address/payment, mai bloccante — un fallimento non deve impedire il
resto della risposta), nuovo campo `fiscalCode: str | None` nella risposta
JSON.

`apps/backend/src/enrichment/pdf-extractor.client.ts`: `ExtractResult`
guadagna `fiscalCode: string | null`.

## Form "Correggi dati" — CF/PIVA editabile + fix bottone Verifica ANPR

`apps/frontend-admin/src/App.tsx`, pannello warning per riga (Arricchimento
Tracciati):

1. **Campo editabile**: rimuovere `h !== 'codice_fiscale'` dal filtro
   `enrichAddressEditHeaders.filter(...)` (riga ~15052) — `codice_fiscale`
   è già un header standard (`enriched-csv.util.ts`), diventa modificabile
   come `indirizzo`/`cap`/ecc. senza alcun cambio di storage: `codice_fiscale`
   non è tra i campi tipizzati dell'override (`indirizzo`/`cap`/`comune`/
   `provincia`/`stato_estero`), passa già per `extraFields` generico in
   `saveRowOverride`/`applyOverrides` — nessuna modifica backend necessaria
   per la persistenza.

2. **Fix stato stantio in `runEnrichAddressAnprCheck`**: oggi legge
   `enrichAddressEditCf` (impostato una sola volta da `openEnrichAddressEdit`
   al caricamento riga, mai risincronizzato se l'operatore modifica il
   campo nel form) sia per il body della richiesta `/domicilio/cerca` sia
   per decidere il ramo Registro-Imprese-vs-ANPR (`/^\d{11}$/.test(...)`).
   Sostituito con `enrichAddressEditFields['codice_fiscale']` (valore
   corrente in form) in entrambi i punti — questo è l'unico motivo per cui
   oggi "funzionare anche con persone giuridiche" non funziona nel form di
   correzione: il backend (`DomicilioService.cercaDomicilio`) instrada già
   correttamente su `RegistroImpreseService` per un valore a 11 cifre,
   nessuna modifica lì necessaria.

3. **Gate client-side**: bottone "Verifica ANPR"/"Carica da Registro
   Imprese" disabilitato se `!isValidCfOrPiva(enrichAddressEditFields['codice_fiscale'])`
   — stesso principio già in uso per "Verifica Anagrafica" (mai sprecare
   una chiamata PDND/Registro Imprese su un input malformato). Richiede
   portare `isValidCfOrPiva` (già definita localmente in `App.tsx:1121`)
   accessibile in questo punto — già nello stesso file, nessun import
   nuovo.

4. **`openEnrichAddressEdit`**: `enrichAddressEditCf` (usato solo per il
   testo "CF: ..." mostrato sopra il bottone) va inizializzato dal valore
   riconciliato (`fields['codice_fiscale']`, che già tiene conto di un
   eventuale override salvato) invece che dal CSV grezzo (`row.codiceFiscale`)
   — altrimenti riaprire una riga già corretta mostra il vecchio CF nel
   testo di stato pur avendo il campo form già aggiornato.

## Flusso completo per il caso reale (700 righe PIVA senza zero)

1. Zero-pad silenzioso (§1) risolve tutte le 700 righe durante il
   processing — nessun warning, nessuna azione operatore.
2. Le righe con CF/PIVA genuinamente corrotto (non recuperabile da
   zero-pad) restano in warning (§2), con fallback automatico dal PDF (§3)
   quando disponibile.
3. Le righe non risolte nemmeno dal fallback PDF restano correggibili a
   mano nel form (ora anche sul campo CF/PIVA), con "Verifica ANPR"/
   "Carica da Registro Imprese" funzionante per entrambi i tipi di
   soggetto dopo la correzione.

## Testing

- `tax-id.util.spec.ts`: nuovi casi per `isValidCfOrPiva` (CF 16 valido,
  PIVA 11 valido, valori troppo corti/lunghi/con caratteri non ammessi).
- `maggioli-parser.spec.ts`: nuovi casi `normalizeCodiceFiscale` (10 cifre
  → zero-pad, 11 cifre invariato, 16 alfanumerici invariato, valore vuoto
  invariato) su almeno una delle varianti di `parseRubricaPec` e su
  `parsePagIndice`.
- `enrichment.processor.spec.ts`: nuovi casi — CF mancante, CF invalido con
  fallback PDF riuscito (auto-sostituzione + warning corretto), CF invalido
  senza fallback disponibile (solo warning, `row.codice_fiscale` invariato).
- `services/pdf-extractor/tests/test_pdf_extractor.py`: nuovi casi
  `extract_fiscal_code` per i due formati (PF/PG), dati anonimizzati
  (pattern esistente nel file: `ROSSI MARIO`/`RSSMRA80A01H501U`).

## Fuori scope / non modificato

- Nessuna modifica a `EnrichmentAddressOverrideService`/schema DB — CF/PIVA
  passa già per `extraFields` generico.
- Nessuna modifica al meccanismo di warning "corretto"/"ignorato" esistente
  — riusato identico per i nuovi warning CF/PIVA.
- Nessuna modifica a `DomicilioService`/`RegistroImpreseService` — lo
  smistamento CF-vs-PIVA lato backend è già corretto, il bug era solo lo
  stato stantio lato frontend.
