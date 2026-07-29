# Validazione Paese/Città/CAP in Arricchimento Tracciati — design

Data: 2026-07-29

## Problema

Il wizard campagne valida Paese/Città/CAP solo al momento della creazione
campagna (Passo 3), su un CSV che nella pratica arriva quasi sempre dal CSV
arricchito prodotto da "Arricchimento Tracciati" (estrazione indirizzo da
PDF). Un errore reale su un tracciato arricchito ha mostrato 40 righe con
problemi (`Città mancante`, `Paese non riconosciuto`, `CAP non valido`)
scoperti solo nel wizard — troppo tardi per una correzione comoda, l'
operatore deve tornare all'arricchimento (dove ha PDF/CSV originali) per
sistemare i dati.

Analisi di due casi reali di "Paese non riconosciuto" (`PERU'`, `SUD
AFRICA`) ha rivelato un bug nella funzione di matching condivisa
`matchCountry` (`packages/shared-types/src/index.ts`): `normalizeCountryName`
rimuove diacritici ma non spazi né apostrofi finali — un vezzo comune nei
dati PA dove la vocale accentata viene sostituita con lettera base +
apostrofo (`PERU'` per `Perù`, `CITTA'` per `Città`). "SUD AFRICA" (due
parole) non combacia con "Sudafrica" (una parola in `COUNTRIES`) per lo
stesso motivo (spazio non rimosso). Corretto qui, il fix beneficia subito
anche il wizard esistente, oltre al nuovo controllo in arricchimento.

## Regole in scope

Le stesse 3 regole "dato oggettivamente incompleto/errato" già presenti nel
wizard (`App.tsx` righe 5375-5398), applicabili indipendentemente da quale
campagna/canale verrà creato a valle:

1. **Paese non riconosciuto** — `matchCountry(raw)` ritorna `null` quando
   `raw` non è vuoto.
2. **Città mancante** — campo comune vuoto (sempre richiesto, non solo per
   indirizzi esteri).
3. **CAP non valido** — 5 cifre, controllato solo se il Paese non risulta
   estero (`matchedCountry` non nullo e diverso da `'Italia'`), stessa
   condizione `isForeignRow` già in uso nel wizard.

**Fuori scope**: il controllo "contratto POSTAL supporta spedizioni estero"
(righe 5401-5410 di `App.tsx`) — dipende dal canale/contratto configurato
sulla campagna che verrà creata, un concetto che l'arricchimento non conosce
ancora in questa fase. Resta solo nel wizard.

## Fix `matchCountry` (root cause)

`normalizeCountryName` (`packages/shared-types/src/index.ts:106-113`),
dopo la rimozione dei diacritici, aggiunge due passaggi: rimozione di ogni
apostrofo (dritto o tipografico) e di ogni spazio. Applicato simmetricamente
sia nella costruzione dell'indice (`COUNTRY_NORMALIZED_INDEX`) sia nel
matching (`matchCountry`), quindi nessun rischio di asimmetria. Nessuna
collisione attesa tra le ~190 voci di `COUNTRIES` (nomi sufficientemente
distinti anche senza spazi/apostrofi — verificato a mente sui casi limite:
Congo/Congo Democratica restano distinti, "Stati Uniti d'America" resta
unico).

## `isValidCap` — spostato in shared-types

Oggi definita localmente in `App.tsx` (`/^\d{5}$/`). Spostata in
`packages/shared-types/src/index.ts` come export pubblico accanto a
`COUNTRIES`/`matchCountry` — stessa richiesta del problema originale
("mapping e arricchimento devono seguire le stesse regole"): un'unica
definizione, usata sia dal wizard sia dal nuovo controllo in arricchimento.
`App.tsx` importa quella condivisa al posto della funzione locale (nessun
cambio di comportamento, stessa regex).

## Dove applicare il controllo in arricchimento

`EnrichmentProcessor.processEnrich` (`apps/backend/src/enrichment/
enrichment.processor.ts`) — **non** il microservizio Python
`pdf_extractor.py`: la validazione va sul valore finale di riga (`row`),
già frutto del merge CSV-vince/PDF-fallback esistente (`comune`, `cap`,
`stato_estero` su `EnrichedRow`), indipendentemente da quale delle due fonti
lo abbia popolato. Il backend Node ha già accesso a `@comunicapa/shared-types`
(usato in 31 file), nessuna duplicazione verso Python necessaria.

Punto di inserimento: subito prima di `rows.push(row)` (riga 224 attuale),
per ogni riga, incondizionatamente (PDF trovato/non trovato/estrazione
fallita — il `row` esiste comunque, popolato da `baseRow()` col CSV anche
quando l'estrazione PDF non è avvenuta):

```
paeseRaw = row.stato_estero.trim()
matchedCountry = paeseRaw ? matchCountry(paeseRaw) : null
isForeignRow = matchedCountry non-null && matchedCountry !== 'Italia'

se paeseRaw non vuoto e matchedCountry nullo:
  warning: `Paese "${paeseRaw}" non riconosciuto`
se row.comune vuoto:
  warning: 'Città mancante'
se non isForeignRow e row.cap non vuoto e !isValidCap(row.cap):
  warning: 'CAP non valido (richieste 5 cifre)'
```

Stesso formato `EnrichmentWarning` già esistente: `{ row: rowNum, pdf:
rec.pdfFilename, message: string }` — appare nella stessa lista warning
del job (UI "Log Job", conteggio `warningCount`), stessa severità di "PDF
non trovato nel ZIP"/"Estrazione fallita" (**solo informativo**: non
blocca "Scarica Righe Errate CSV" né "Crea bozza campagna" — l'operatore
corregge quando vuole tramite l'override indirizzo già esistente,
`EnrichmentAddressOverrideService`).

## Fuori scope / non modificato

- Nessuna modifica al microservizio Python `pdf_extractor.py`.
- Nessuna modifica al meccanismo di override esistente (`comune`/`cap`/
  `statoEstero` già correggibili per PDF).
- Nessun nuovo stato bloccante sul job — i warning restano informativi,
  stessa severità di quelli già esistenti.
- Il controllo "Codice Fiscale mancante" (visto nell'esempio reale, riga
  2791) resta invariato — non in scope per questo lavoro (non richiesto).
