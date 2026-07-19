# Estrazione rate multiple PagoPA — Design

Data: 2026-07-17 (rivisto 2026-07-18: classificazione via etichetta, non ordine pagina)
Stato: approvato (brainstorming con Mirko)

## Contesto

La dashboard "Arricchimento tracciati" (feature completa, vedi
`docs/superpowers/specs/2026-07-17-arricchimento-tracciati-design.md`)
estrae oggi UN solo pagamento PagoPA per PDF: `_find_payment_pages` in
`services/pdf-extractor/app/pdf_extractor.py` cerca dall'inizio del
documento la prima pagina con dicitura `CBILL` e si ferma lì. Il commento
nel codice lo dichiara esplicito: quella pagina è sempre il totale/rata
unica, "a prescindere da quante siano" le rate che seguono — le pagine
successive vengono ignorate. Il parametro `mode` (`unica`/`multirata`)
esiste nella firma ma non incide sulla ricerca: è morto.

Molti avvisi TARI/IMU hanno però più pagine di pagamento nello stesso PDF
(piano rateale): la dashboard oggi perde quel dato — l'operatore lo scopre
solo aprendo ogni PDF a mano.

## Obiettivo

Estrarre TUTTE le pagine di pagamento presenti nel PDF, non solo la prima,
distinguendo il totale (rata unica) dalle singole rate, con un controllo
di coerenza automatico.

## Struttura del PDF (corretta da Mirko dopo prima bozza — l'ordine pagina
## da solo NON è affidabile, va letta l'etichetta testuale)

Non tutti i documenti hanno una pagina "rata unica": alcuni hanno solo le
rate, altri solo la rata unica, altri entrambe le opzioni (pagamento in
un'unica soluzione O a rate, stesso importo totale). L'ordine delle pagine
non basta per distinguerle — va letta l'etichetta testuale su ciascuna
pagina con QR:

- **"RATA UNICA"** → pagina del totale.
- **"N° RATA"** / **"N RATA"** (numero + parola RATA, es. "1° RATA",
  "2 RATA") → pagina della rata numero N. Il numero nell'etichetta,
  NON la posizione della pagina nel documento, determina l'ORDINAMENTO
  delle rate riconosciute — pagine potrebbero non essere in ordine
  stretto, l'etichetta è la fonte di verità per l'ordine.
  **Nota**: le rate vengono poi compattate per POSIZIONE nell'array
  ordinato (non per numero-etichetta-esatto) quando scritte nelle
  colonne CSV `rataN_*` — un piano rateale con un buco nella
  numerazione (es. solo "2° RATA" e "3° RATA", manca "1°") produce
  comunque `rata1_*`/`rata2_*` compatte (la 2° rata nella colonna
  `rata1_*`, la 3° in `rata2_*`), non `rata2_*`/`rata3_*` con
  `rata1_*` vuota. Deviazione accettata deliberatamente (caso raro
  nella pratica, piani rateali quasi sempre contigui da 1) — vedi
  decisione in fase di whole-branch review del piano
  `2026-07-18-rate-multiple-e-log-tempo-reale`.
- Una pagina `CBILL` che non matcha nessuno dei due pattern: trattata come
  rata non classificabile, va comunque in `rate` con un indice progressivo
  interno e un warning "etichetta rata non riconosciuta" (dato comunque
  preservato, mai scartato silenziosamente).

### Controlli di coerenza (warning, mai bloccanti)

1. **Somma**: `somma(rata.importo)` vs `totale.importo` (se entrambi
   presenti). Diversi → warning.
2. **Scadenze consecutive**: le scadenze delle rate, ordinate per indice,
   dovrebbero essere temporalmente consecutive (crescenti, tipicamente a
   cadenza mensile/bimestrale — nessun vincolo rigido sull'intervallo
   esatto, solo che siano in ordine crescente senza N° rata fuori
   sequenza). Se non lo sono → warning.
3. **Scadenza unica ≈ prima rata**: se sia `totale` che `rate[1]` sono
   presenti, la scadenza del totale coincide di norma con quella della
   prima rata (stesso termine di pagamento, sono due modalità alternative
   dello stesso obbligo). Se diverse → warning (non necessariamente un
   errore, ma un'anomalia da segnalare).

## Modifiche

### 1. Servizio Python — scansione completa

`pdf_extractor.py`:
- `_find_payment_pages` (o suo sostituto) scansiona l'INTERO documento per
  tutte le pagine `CBILL`, non solo la prima. Ritorna la lista di indici
  pagina (ordine di apparizione, non usato per classificare).
- Nuova funzione di classificazione per pagina: regex case-insensitive
  `RATA\s+UNICA` → totale; `(\d+)\s*°?\s*RATA` → rata, cattura il numero
  come indice. Applicata al testo estratto della pagina (`page.get_text()`,
  stesso meccanismo già usato per gli altri pattern in questo file).
  Nessun match → rata non classificabile, indice progressivo interno
  (partendo da `max(indici_riconosciuti) + 1` o da 1 se nessuno
  riconosciuto), warning "etichetta rata non riconosciuta a pagina N".
- `extract_payment()` cambia firma: rimuove il parametro `mode` (morto,
  comportamento ora sempre "trova tutto e classifica"). Estrae il QR/testo
  da OGNI pagina `CBILL` trovata, la classifica, popola `totale:
  PaymentData | None` e `rate: list[PaymentData]` (ordinate per indice
  rata riconosciuto, non per posizione pagina).
- Controlli di coerenza (vedi sezione sopra) implementati come confronti
  post-estrazione, ognuno produce un warning indipendente se fallisce —
  mai bloccanti, i dati estratti vengono comunque restituiti.
- Riuso di `_parse_pagopa_qr`/regex import esistenti, applicati a ciascuna
  pagina invece che a una sola.

### 2. Contratto `/extract` (main.py) — cambia forma

Risposta payment da oggetto singolo a struttura con totale + lista:

```json
{
  "address": {...} | null,
  "payment": {
    "totale": {"numero_avviso": "...", "importo": "761,00", "scadenza": "...", ...} | null,
    "rate": [
      {"numero_avviso": "...", "importo": "380,50", "scadenza": "..."},
      {"numero_avviso": "...", "importo": "380,50", "scadenza": "..."}
    ]
  } | null,
  "warnings": ["..."]
}
```

`mode` query param rimosso da `/extract` (non più significativo).

### 3. Client TS (`pdf-extractor.client.ts`) — tipo aggiornato

`ExtractedPayment` diventa `{ totale: ExtractedPaymentDetail | null; rate: ExtractedPaymentDetail[] }`
(`ExtractedPaymentDetail` = i campi attuali di `ExtractedPayment`).
`extract()` non passa più `mode`.

### 4. CSV output — header dinamico per job

`ENRICHED_CSV_HEADERS` non è più una costante fissa: diventa una funzione
`buildEnrichedCsvHeaders(maxRate: number): string[]` che genera le colonne
base (invariate: `codice_fiscale`...`oggetto`, dove `numero_avviso`/
`importo`/`scadenza` restano il TOTALE) più, per ogni indice `1..maxRate`,
tre colonne `rataN_numero_avviso`, `rataN_importo`, `rataN_scadenza`.

`maxRate` = il numero massimo di rate trovate tra tutti i record del job
corrente (calcolato dal processor dopo aver processato tutti i PDF, prima
di scrivere il CSV). Record con meno rate lasciano le colonne eccedenti
vuote. Nessun tetto artificiale — quante ne servono per quel job.

`buildEnrichedCsv(headers, rows)` accetta l'header come parametro invece
di usare la costante globale.

### 5. Processor — raccolta rate + calcolo header dinamico

`enrichment.processor.ts`:
- Per ogni record, oltre ai campi attuali, accumula `row.rate: Array<{numero_avviso, importo, scadenza}>` (temporaneo, prima di serializzare).
- Warning di coerenza dal servizio Python (`somma rate ≠ totale`) confluisce
  nei warning di riga esistenti, stessa struttura `EnrichmentWarning`.
- Dopo il loop su tutti i record: `maxRate = Math.max(0, ...rows.map(r => r.rate.length))`.
- Costruisce l'header con `buildEnrichedCsvHeaders(maxRate)`, poi mappa
  ogni riga sulle colonne `rataN_*` (vuote oltre la lunghezza della
  propria lista rate).
- Precedenza CSV-su-PDF invariata per il totale (`rec.csvNumeroAvviso ||
  totale.numero_avviso`); le rate arrivano SOLO da PDF (pag_indice.csv non
  ha mai dati per singola rata, resta come oggi).

### 6. Retrocompatibilità

Nessuna: la struttura payment cambia forma (`totale`/`rate` invece di
oggetto piatto) — tutti i consumatori (client TS, processor, test) vanno
aggiornati insieme, non c'è un vecchio formato da preservare (feature
appena rilasciata, nessun job storico con lo schema vecchio da migrare:
i job vecchi restano leggibili così come sono, solo i NUOVI job usano il
nuovo schema).

## Test

- Python: fixture con 3 pagine CBILL etichettate ("RATA UNICA", "1° RATA",
  "2 RATA") via QR sintetici + testo pagina, verificare `totale`/`rate`
  popolati correttamente secondo l'etichetta (non l'ordine pagina — es.
  fixture con pagine in ordine "2° RATA" poi "1° RATA" deve comunque
  produrre `rate[0]` = prima rata); fixture con etichetta rata assente
  (solo dicitura CBILL generica) → rata non classificabile, warning
  specifico, dato comunque incluso; fixture con somma rate ≠ totale →
  warning; fixture con scadenze rata non consecutive → warning; fixture
  con scadenza unica ≠ scadenza prima rata → warning; fixture con 1 sola
  pagina "RATA UNICA" (nessuna rata) → `rate` vuoto, nessun warning di
  coerenza (niente da confrontare).
- Client TS: parsing della nuova forma di risposta.
- CSV util: header dinamico per `maxRate` diversi (0, 1, 3), colonne vuote
  per righe con meno rate del massimo del job.
- Processor: merge end-to-end con 2 record (uno con 2 rate, uno senza),
  verificare header CSV finale ha `rata1_*`/`rata2_*`, seconda riga con
  colonne rata vuote.

## Fuori scope

- Nessun tetto massimo colonne rata.
- Nessuna modifica alla UI di upload (nessun selettore modalità pagamento
  da riattivare — la scansione è sempre completa, automatica, guidata
  dalle etichette lette sulle pagine).
- Nessuna tolleranza configurabile sulla cadenza attesa tra rate (il
  controllo "consecutive" verifica solo l'ordine crescente delle
  scadenze, non un intervallo esatto in giorni).
