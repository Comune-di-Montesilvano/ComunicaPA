# Terzo formato ZIP Maggioli — `pag_indice_service.txt`

## Contesto

`apps/backend/src/enrichment/maggioli-parser.ts` riconosce oggi due varianti
di ZIP Maggioli (feature Arricchimento Tracciati):

- `rubrica.csv` (`parseRubricaPec`) — ha PEC ma non indirizzo fisico
- `pag_indice.csv` (`parsePagIndice`) — ha indirizzo fisico (+ OCR notifica)
  ma non PEC/email

È stato trovato un terzo campione reale in `tinn/maggioli/Postalizzazione_134263.zip`:
entry `pag_indice_service.txt`, formato testo **pipe-delimited (`|`), senza
riga di header**, che contiene TUTTO insieme: indirizzo fisico, email/PEC e
OCR nello stesso record. Nessuna spec ufficiale disponibile per questo
formato specifico (a differenza dei due PDF Maggioli in `tinn/maggioli/`,
che documentano invece il formato di **export** esiti verso Sicr@Web — fuori
scope di questo spec, rimandato a un giro successivo).

Mappatura dedotta dal campione e confermata dall'utente (indici 1-based
sulla riga split per `|`):

| Colonna | Campo | Esempio dal campione |
|---|---|---|
| 3 | OCR (`ocrNotifica`) | `6802400000041384` (16 cifre) |
| 4 | numero provvedimento | `41384` |
| 7 | nome file PDF allegato | `PROVV_41384_124238.pdf` |
| 9 | nominativo | `IL MULINO S.A.S. DI DI BERARDINO FABIO & C.` |
| 10 | codice fiscale / P.IVA | `01790800682` |
| 11 | comune | `MONTESILVANO` |
| 12 | CAP | `65015` |
| 13 | provincia | `PE` |
| 14 | indirizzo | `VIA VESTINA 776/BIS` |
| 52 | email/PEC | `ilmulino.sas@pec.it` |

Tutti gli altri campi (oggetto, data emissione, numero avviso pagoPA...)
restano fuori mappatura in questo giro — stessa scelta minimale già fatta in
`parsePagIndice` per i campi non essenziali (es. `oggetto: ''`), col fallback
sull'estrazione PDF dove serve.

## Design

**Nuova funzione `parsePagIndiceService(text: string): MaggioliRecord[]`**
in `maggioli-parser.ts`, accanto a `parseRubricaPec`/`parsePagIndice`:

- split per riga (`\r?\n`), scarta righe vuote
- ogni riga: `line.split('|')`, accesso per indice fisso (0-based = colonna
  spec - 1), nessun parsing header (a differenza di `parsePagIndice` che
  legge i nomi colonna dalla prima riga)
- `tipo` dedotto da `tipoFromCf(codiceFiscale)` (util già esistente,
  riusato as-is — P.IVA 11 cifre → PG, CF 16 cifre → PF)
- `csvAddress` sempre popolato (indirizzo/cap/comune/provincia; `statoEstero`
  non presente in questo formato → stringa vuota)
- `ocrNotifica` = colonna 3 — è il campo che injecta in
  `external_id` lato `enrichment.processor.ts::baseRow()`
  (`rec.ocrNotifica || rec.numeroProvvedimento`), quindi diventa la chiave
  utilizzabile in futuro per l'export Maggioli (riferimento verbale)
- `oggetto`, `dataEmissione`, `csvNumeroAvviso`, `csvNumeroAvvisoAlt` → `''`
  (non mappati in questo giro)

**Detection in `parseMaggioliZip`**: nuovo ramo che controlla
`zip.getEntry('pag_indice_service.txt')` oltre ai due esistenti (ordine di
check non rilevante, nomi entry mutuamente esclusivi).

**Nessuna modifica a `enrichment.processor.ts`/`enrichment.service.ts`**:
consumano `MaggioliRecord` già uniforme tra i tre formati. In particolare il
fallback indirizzo (`if (!rec.csvAddress && result.address)`) resta
invariato — dato che il nuovo formato popola sempre `csvAddress`, il
tracciato è sempre la fonte, il PDF fa da fallback solo quando il tracciato
non lo fornisce (comportamento già esistente, confermato applicabile anche
qui).

## Testing

- `maggioli-parser.spec.ts`: nuovi casi per `parsePagIndiceService` (riga
  singola dal campione reale, verifica dei 7 campi mappati + verifica che
  `tipo` sia `PG` per P.IVA 11 cifre)
- `parseMaggioliZip`: caso con ZIP contenente solo `pag_indice_service.txt`
  → deve instradare correttamente alla nuova funzione

## Fuori scope (backlog)

Export esiti campagna nel formato Maggioli (le due spec PDF in
`tinn/maggioli/`: "Importazione Notifiche" e "Importazione Mancate
Notifiche", fixed-width TXT senza separatore, chiave `Riferimento verbale`
= OCR troncato) — rimandato a design separato quando il riconoscimento
input sarà stabile.
