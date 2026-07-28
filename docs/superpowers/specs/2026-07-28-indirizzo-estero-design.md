# Supporto indirizzo estero — POSTAL (GlobalCom) + SEND (PN)

Data: 2026-07-28

## Contesto

Il modello indirizzo attuale (`Recipient.extraData`, `physicalAddressConfig`
in `channelConfig`, wizard mapping CSV) assume implicitamente indirizzo
italiano: nessun campo "paese/nazione", nessuna gestione CAP/provincia
esteri. Serve estendere POSTAL e SEND per destinatari con indirizzo estero,
propagare il dato da arricchimento tracciati e verifica anagrafica (ANPR
AIRE), e correggere due bug reali trovati durante l'analisi (estrazione PDF
indirizzo estero, lunghezza denominazione destinatario).

Verificato contro fonti primarie, non riassunti:
- WSDL GlobalCom reale (`tinn/globalcom/GBCWebservice.xml`) e manuale tecnico
  v5.26 (`tinn/globalcom/Globalcom WebService - Manuale tecnico.pdf`).
- Spec OpenAPI PN raw (`pagopa/pn-delivery`,
  `docs/openapi/api-external-b2b-pa-bundle.yaml`).
- 10 PDF reali di indirizzo estero (`tinn/DOC_GEN_1592_131922.pdf` +
  `tinn/esempi_estero/*.pdf`), estratti e testati contro l'algoritmo di
  parsing proposto.

## Sezione 1 — Modello dato Paese

- Nuova costante `COUNTRIES` (elenco fisso paesi, denominazione italiana,
  usata sia per il dropdown singolo che per il matching bulk). "Italia" è il
  valore di default/domestico: se il paese risolto per un destinatario è
  "Italia" (o assente), nessun campo estero viene inviato ai provider.
- `physicalAddressConfig` guadagna `countryColumn?: string` — quinto select
  nel wizard, stesso pattern di `addressColumn/municipalityColumn/
  zipColumn/provinceColumn` (mapping manuale, nessun autodetect — coerente
  con gli altri 4 campi già esistenti).
- Nessuna migration su `Recipient`: l'indirizzo resta interamente dentro
  `extraData` (jsonb), come oggi.

### Bulk (wizard CSV)

- `countryColumn` non mappata → tutti i destinatari trattati come
  domestici, comportamento identico a oggi (retrocompatibile).
- `countryColumn` mappata:
  - cella vuota o valore "Italia" → domestico.
  - valore non vuoto → cercato in `COUNTRIES` (match case/accento
    insensitive).
    - trovato → riga estera, valore normalizzato sulla denominazione
      canonica.
    - non trovato → **warning + skip riga** in fase di mapping (stesso
      punto/stessa UI dove oggi vengono segnalate/escluse righe con altri
      dati non validi), non bloccante per le altre righe.

### Singolo (wizard invio singolo)

- Nuovo campo `singleCountry` (dropdown `COUNTRIES`, default "Italia")
  accanto a `singleAddress/singleMunicipality/singleZip/singleProvince`.

## Sezione 2 — POSTAL (GlobalCom)

### Scoperta capability "Estero" per contratto

`DatiContrattoCOLMOLExt` (WSDL righe 207-227, ritornato da
`InformazioniUtenza.ContrattiH2H` — stessa chiamata già usata dal tasto
"Test" in Impostazioni → Postale) espone un booleano `Estero` per ogni
`CodiceContratto`, oggi scartato da
`globalcom-client.service.ts` (righe 348-360 leggono solo
`CodiceContratto/Descrizione/Tipologia`).

- Estendere quel parsing per leggere anche `Estero` e persisterlo su
  `postal_provider_configs` insieme al resto dei dati contratto.
- Nessuna chiamata SOAP aggiuntiva: il dato arriva già nella risposta
  esistente del Test.

### Gate in UI

- Wizard, step scelta canale/servizio POSTAL: se il `CodiceContratto`
  configurato ha `Estero:false`, mostrare evidenza (badge/alert) nella
  scelta canale.
- Regola generale valida per **tutti** i Servizio, incluso Atto Giudiziario
  (Agol): nessuna esclusione a priori, permesso se il contratto usato ha
  `Estero:true` (confermato con l'utente).
- Bulk: se ci sono destinatari esteri ma il contratto configurato non
  supporta Estero → **skip riga con evidenza** in fase di mapping (stesso
  pattern di sopra), non bloccante per gli altri destinatari.

### Nota sul campo "Stato" (attenzione, verificata dal vivo)

Il manuale tecnico (§3.3.1, pag. 120) descrive `InfoIndirizzoExt.Stato`
come *"predefinito: ITALIA. Va indicato qui lo stato per le spedizioni
all'estero, attualmente solo per i telegrammi"* — prosa generica che
sembrerebbe escludere Raccomandata/Lettera. Il flag `Estero` per
`CodiceContratto` (sopra) è però un segnale più specifico e autoritativo
per i contratti COLMOL Market/Contest effettivamente usati da questo
Comune: si assume che, quando il contratto dichiara `Estero:true`, il
campo `Stato` sia supportato anche per quei Servizio. **Da confermare con
un invio reale di test in fase di implementazione** (stesso principio già
applicato più volte in questa integrazione: non fidarsi della sola prosa
del manuale).

### Mapping WSDL

`postal.strategy.ts` / `toInfoIndirizzoExt` (`globalcom-client.service.ts`):
quando la riga è estera, valorizzare `Stato` (mai mappato oggi) con la
denominazione paese; `Provincia` resta vuota/non significativa per un
indirizzo estero (già stringa libera, nessuna validazione formato oggi).

### Backend

**Revisione post-implementazione (fix-wave finale, verificata dal vivo):**
`uploadCsv()`/`launch()`/`createAttemptsAndEnqueue()` in
`campaigns.service.ts` non hanno mai avuto un meccanismo di skip-riga per
nessun campo (CF, email, allegato...) — ogni validazione per-destinatario
in questo backend vive nella strategy del canale, al momento dell'invio
(`send()`), non a monte in `campaigns.service.ts`. Costruire uno skip-riga
nuovo solo per l'estero avrebbe introdotto un pattern mai esistito in
questo codebase, rischio sproporzionato rispetto al beneficio.

Scelta finale: validazione server-side (match paese in `COUNTRIES` +
contratto `Estero:true`) dentro `postal.strategy.ts.send()`, subito prima
della chiamata SOAP — riusa il meccanismo di fallimento già esistente e
collaudato per ogni altra validazione per-destinatario (indirizzo non
risolvibile, allegato mancante...): l'errore lanciato marca quel singolo
`NotificationAttempt` come `FAILED` (visibile in UI, retriable via
"Rimetti in coda"), senza bloccare né gli altri destinatari né l'intero
lancio campagna. Stessa protezione pratica del design originale (il
server non è bypassabile passando dal wizard), cambio molto più piccolo e
coerente con l'architettura esistente. SEND non necessita di un gate
equivalente: PN accetta `foreignState` incondizionatamente (nessun
concetto di "contratto abilitato estero" per quel canale).

## Sezione 3 — SEND (PN)

Verificato su spec OpenAPI raw (`api-external-b2b-pa-bundle.yaml`,
schema `NotificationPhysicalAddress`/`PhysicalAddress`):

- Campo `foreignState` (string, max 256, "Denominazione paese estero") già
  esistente nello schema PN.
- `zip` diventa esplicitamente facoltativo per invio estero (documentato
  nello spec stesso: *"Codice di avviamento postale. In caso di invio
  estero diventa facoltativo"*).
- Nessun altro campo nuovo richiesto lato SEND.

Implementazione:

- `ResolvedPhysicalAddress` (`payment-config.util.ts`) guadagna
  `foreignState?: string`.
- `resolvePhysicalAddress()`: quando la riga è estera, valorizza
  `foreignState`, non richiede più `zip`.
- Wizard SEND (singolo e bulk): stesso `countryColumn`/dropdown della
  Sezione 1. Nessun gate di capability come per POSTAL — PN accetta sempre
  `foreignState`, non esiste un concetto di "contratto abilitato estero"
  per SEND.

## Sezione 4 — Wizard singolo + precompilazione da ANPR (AIRE)

`AnprResidenza.localitaEstera.indirizzoEstero`
(`anpr.types.ts:26-33`) già arriva dalla verifica anagrafica ANPR C002 ma
oggi è solo mostrato in sola lettura nel wizard, mai collegato al form.

Nuovo comportamento: se la verifica ANPR per il CF trova
`residenza[0].localitaEstera.indirizzoEstero`, precompilare
automaticamente (stesso pattern già usato per l'override PEC da INAD,
badge "Compilato da AIRE", editabile manualmente dall'operatore):

| Campo wizard | Fonte ANPR |
|---|---|
| `singleAddress` | `toponimo.denominazione` + spazio + `toponimo.numeroCivico` |
| `singleMunicipality` | `localita.descrizioneLocalita` |
| `singleZip` | `cap` |
| `singleProvince` | vuoto (non esiste per indirizzo estero) |
| `singleCountry` | match di `localita.descrizioneStato` su `COUNTRIES`; se non matcha, valore raw + badge "verifica manuale" |

## Sezione 5 — Fix estrazione indirizzo estero (`pdf_extractor.py`)

**Bug reale confermato** testando `_RE_FOREIGN` esistente contro
`tinn/DOC_GEN_1592_131922.pdf` (indirizzo svizzero reale):

```
Residente in: BAHNHOFPLATZ 2 CAP 8802 - 86078 KILCHBERG - SVIZZERA
```

Estrazione attuale: `indirizzo="BAHNHOFPLATZ 2 CAP 8802"` (CAP svizzero
vero incorporato nella via), `cap="86078"` (pseudo-codice interno
ANPR/Maggioli per la località estera, non un CAP reale), `comune=
"KILCHBERG"` (corretto), `stato_estero="SVIZZERA"` (corretto). La regex
assumeva un formato fisso `via - CAP comune - stato` che non regge sulle
varianti reali (CAP embedded nella via, CAP mancante, CAP alfanumerico
tipo Canada, parentetiche `(STATO)` ripetute nella via).

### Nuovo algoritmo (testato 10/10 su tutti gli esempi reali disponibili)

Sostituisce interamente `_RE_FOREIGN`. Dopo aver isolato il contenuto dopo
`Residente in:` (stessa regex di cattura generica di oggi):

1. Split su `" - "` (normalizzando en-dash `–` a `-`).
2. Ultimo segmento → `stato_estero` (raw).
3. Penultimo segmento → `[CAP] comune`: se il primo token è numerico
   (3-6 cifre) → CAP guess, resto → comune; altrimenti l'intero segmento è
   comune, CAP vuoto (limite noto/accettato: CAP alfanumerici come quelli
   canadesi restano dentro il comune, non vengono separati).
4. Segmenti restanti (indice `0..-3`), joinati con `" - "` → indirizzo
   grezzo. Ripulito da:
   - keyword esplicita `CAP\.?\s*(\w+)` nell'indirizzo → se presente, è il
     CAP **autoritativo** (sovrascrive il guess del punto 3), rimossa dal
     testo indirizzo insieme a eventuale parentetica `(STATO)` adiacente.
   - parentetica finale residua tipo `(SVIZZERA)`, `(BELGIO)`.

Verificato contro tutti i 10 PDF reali disponibili (`tinn/
DOC_GEN_1592_131922.pdf` + `tinn/esempi_estero/*.pdf`, Belgio/Svizzera/
Germania/Canada) — risultati corretti su tutti, incluso il caso
Kilchberg (CAP vero `8802` riconosciuto, pseudo-codice `86078` scartato).

`_RE_DOMESTIC` resta invariato (chiamato per primo, come oggi); questo fix
tocca solo il ramo `_RE_FOREIGN`.

`AddressData.stato_estero` già esiste ed è già propagato fino al CSV
arricchito (`enriched-csv.util.ts`, `maggioli-parser.ts`,
`enrichment.processor.ts`) — nessuna modifica necessaria lì, l'operatore
mappa la colonna `stato_estero` su `countryColumn` nel wizard come
qualunque altra colonna (Sezione 1).

## Sezione 6 — Denominazione destinatario troppo lunga (POSTAL + SEND)

**Bug reale confermato**: `postal.strategy.ts:85` usa
`denominazione1: recipient.fullName || recipient.codiceFiscale` come
riga unica, nessun limite/troncamento. WSDL impone `Denominazione1` max 44
char. Esempio reale (`tinn/esempi_estero/PROVV_41953_125502.pdf`):
destinatario `"IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO
ALESSANDRO"` (65 char) — la sola dicitura boilerplate *"IMPERSONALMENTE E
COLLETTIVAMENTE AGLI EREDI DI"* è già 47 char, oltre il limite di
Denominazione1 da sola, prima ancora del nome erede.

### Fix

Nuova utility `splitDenominazione(fullName, maxPerLine = 44)`:

1. Applica una tabella di abbreviazioni configurabile — nuova chiave
   settings `postal.denominazioneAbbreviations` (JSON
   `[{pattern, replacement}]`, editabile da Impostazioni → Postale).
   Seed di default: `[{"pattern": "IMPERSONALMENTE E COLLETTIVAMENTE AGLI
   EREDI DI", "replacement": "EREDI DI"}]`.
2. Word-wrap del risultato su due righe ≤44 char ciascuna
   (`Denominazione1`/`Denominazione2`, quest'ultimo oggi mai usato per il
   destinatario).
3. Se il risultato eccede ancora 88 char totali, troncamento secco su
   `Denominazione2` come ultima rete di sicurezza.

- `postal.strategy.ts:85`: sostituire la riga singola con
  `{ denominazione1, denominazione2 } = splitDenominazione(recipient.fullName
  || recipient.codiceFiscale)`.
- SEND: `denomination` (PN) verificato max 88 char su spec raw (schema
  `Denomination`) — un solo campo, nessuno split multi-riga necessario.
  Stessa tabella di abbreviazioni applicata prima, poi troncamento secco a
  88 char come rete di sicurezza.

## Fuori scope

- Verifica toponomastica/CAP-stradario (`postal-verifica-cap-stradario`)
  resta solo per indirizzi domestici — nessuna estensione a indirizzi
  esteri in questo lavoro.
- Nessuna gestione estero per App IO (canale digitale, non ha concetto di
  indirizzo fisico).
- INAD: nessuna modifica — il dirottamento a PEC resta invariato,
  indipendente da indirizzo fisico estero/domestico.
