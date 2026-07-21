# Cerca Domicilio — integrazione ANPR C020 + unificazione INAD/App IO

## Contesto e obiettivo

Il backend interroga già, separatamente, due fonti sul domicilio digitale/App IO
di un cittadino: INAD (`InadService`, `/extract/{cf}`) e App IO
(`IoServicesService.verifyProfile`). Ogni fonte ha una propria pagina di
"verifica singola" nel frontend admin, con logica e UI duplicate.

Aggiungiamo una terza fonte — **ANPR C020 "Servizio di accertamento
residenza"**, esposto su PDND dal Ministero dell'Interno — che restituisce la
residenza anagrafica reale (indirizzo completo) di un cittadino dato il
codice fiscale.

Contestualmente, centralizziamo le tre interrogazioni in un'unica funzione
"**Cerca Domicilio**": una pagina che, dato un CF, interroga in parallelo
INAD + App IO + ANPR e mostra una scheda completa del cittadino (domicilio
digitale eletto, stato App IO, residenza anagrafica). Le vecchie pagine
"Verifica INAD" e "Verifica App IO" perdono la tab "Verifica singola"
(sostituita da questa pagina) ma mantengono la tab "Verifica massiva CSV"
per-canale, che resta invariata: la nuova pagina "Cerca Domicilio" aggiunge
la propria verifica massiva combinata, non tocca quelle esistenti.

**Fuori scope per questa fase** (esplicitamente deferito):
- Invio massivo/singolo di comunicazioni usando i dati di residenza trovati
  su ANPR (fase successiva, da disegnare separatamente).
- Un'API bulk nativa per ANPR C020 (non esiste — C020 è solo interrogazione
  puntuale per CF; la "massiva" qui è un loop per-riga, non una vera bulk API
  come INAD `/listDigitalAddress`).
- Persistenza dei risultati di "Cerca Domicilio" — è una query live ogni
  volta, nessuna tabella storica (come INAD singola oggi).

## Architettura

### A. Firma JWS PDND (estensione di `PdndAuthService`)

ANPR C020 richiede, oltre al bearer voucher PDND (già gestito da
`PdndAuthService.getVoucher`), due header aggiuntivi sulla singola chiamata
REST, pattern PDND `INTEGRITY_REST_02` e `AUDIT_REST_02`:

- **`Agid-JWT-Signature`**: JWS Compact Serialization. JOSE header
  `{alg:'RS256', typ:'JWT', kid}` (stesso kid del client PDND — verificato
  come sufficiente da un'integrazione reale chiusa con successo, issue
  `italia/anpr#4706`). Payload: `{iss, sub, aud: <url endpoint completo>,
  iat, exp (~60s), nbf, jti, signed_headers: [{digest: "SHA-256=<base64
  sha256(body)>"}, {"content-type": "application/json"}]}`. Il body della
  richiesta va anche accompagnato da un header HTTP separato `Digest:
  SHA-256=<stesso valore>` (RFC 3230).
- **`Agid-JWT-TrackingEvidence`**: stesso schema di firma (RS256, stesso
  kid), payload `{iss, sub, aud, iat, exp, jti, userID, userLocation, LoA}`.
  `userID` = username dell'operatore che ha effettuato la ricerca (da JWT di
  sessione); `userLocation`/`LoA` = valori fissi da settings (default
  plausibili, **non verificati contro un ambiente PDND reale** — primo test
  in collaudo può richiedere aggiustamento, come già successo per altre
  integrazioni PDND di questo repo — vedi gotcha SEND/PDND in CLAUDE.md).

Nuovo metodo su `PdndAuthService`:

```ts
signAgidJwt(env: PdndEnvironment, aud: string, extraClaims: Record<string, unknown>): string
```

Riusa `kid`/`privateKey` già letti da `pdnd.{env}.*` — nessuna nuova chiave di
firma da configurare.

### B. Settings

Nuova tab `anpr` in `SETTINGS_NAV` (frontend-admin), affiancata a
`inad`/`inipec`. Registry (`settings.registry.ts`):

```
anpr.test.purposeId          — solo per test voucher PDND (come INAD)
anpr.prod.purposeId          — query reale (sempre e solo prod, come INAD)
anpr.trackingUserLocation    — default: 'comunicapa-backend'
anpr.trackingLoA             — default: 'https://www.spid.gov.it/SpidL2'
```

Nessun `baseUrl` in settings: i due URL (val/esercizio) sono noti dallo
yaml ufficiale e vanno hardcoded in `AnprService` come `ANPR_C020_BASE_URL`
(pattern identico a `INAD_BASE_URL`) — la query reale usa sempre
l'endpoint di esercizio (`modipa.anpr.interno.it`), mai quello di test.

UI tab: stesso identico pattern della tab INAD — fieldset "Produzione" con
Purpose ID + bottone "Test connessione (voucher PDND)". Nessuna query di
prova qui: quella si fa dalla pagina "Cerca Domicilio".

### C. `AnprService`

Nuovo modulo `apps/backend/src/channels/anpr/` (pattern 1:1 con
`channels/inad/`):

```ts
async getResidenza(codiceFiscale: string, operatorUsername: string): Promise<AnprResidenzaResult>
```

- Voucher: `pdndAuth.getVoucher('prod', purposeId)`.
- Body `RichiestaE002` (schema yaml): `idOperazioneClient: randomUUID()`,
  `criteriRicerca: { codiceFiscale }` (query diretta per CF, niente step
  preventivo per idANPR — lo schema lo permette), `datiRichiesta: {
  dataRiferimentoRichiesta: <oggi, YYYY-MM-DD>, motivoRichiesta:
  'comunicapa-cerca-domicilio', casoUso: 'C020' }`.
- Calcola Digest SHA-256 del body, firma i due header JWS via
  `pdndAuth.signAgidJwt(...)`, POST a
  `${ANPR_C020_BASE_URL}/anpr-service-e002` con header `Authorization`,
  `Digest`, `Agid-JWT-Signature`, `Agid-JWT-TrackingEvidence`,
  `Content-Type: application/json`.
- 404 o `RispostaKO` (posizione non presente in ANPR) → `{ found: false }`.
- 200 → estrae `listaSoggetti.datiSoggetto[0]` (`generalita`, `residenza[]`,
  `identificativi.idANPR`) dalla `RispostaE002OK` — tipi TS ricalcati 1:1
  dallo yaml (`TipoGeneralita`, `TipoResidenza`, ecc.), niente wrapper
  custom.
- Altri errori HTTP → `throw`, stesso stile di `InadService`.

### D. `DomicilioService` — orchestratore

Nuovo modulo `apps/backend/src/channels/domicilio/`, nessuna persistenza:

```ts
async cercaDomicilio(codiceFiscale: string, operatorUsername: string) {
  const [inad, appIo, anpr] = await Promise.allSettled([
    this.inadService.extractDigitalAddress(cf),
    this.ioServicesService.verifyProfile(cf), // servizio App IO default
    this.anprService.getResidenza(cf, operatorUsername),
  ]);
  // ogni sezione della risposta riporta esito proprio — un fallimento
  // (es. ANPR down) non deve azzerare gli altri due già arrivati.
}
```

### E. Endpoint API

Nuovo controller `admin/domicilio`:

```
POST admin/domicilio/cerca   { codiceFiscale }
```

`@Roles('user','admin')`, `@HttpCode(200)` sempre (pattern proxy esterno:
mai eccezione non-2xx per un errore "previsto", vedi CLAUDE.md). Risposta:

```json
{
  "codiceFiscale": "...",
  "inad": { "success": true, "found": true, "digitalAddress": [...] },
  "appIo": { "success": true, "active": true, "message": "..." },
  "anpr": { "success": true, "found": true, "generalita": {...}, "residenza": [...] }
}
```

Gli endpoint esistenti (`inad-verify/verify-single`,
`io-services/verify-profile`) restano — non li tocchiamo lato backend,
servono ancora ai rispettivi flussi di verifica massiva. Cambia solo cosa
chiama il frontend per la ricerca singola.

### F. Frontend — pagina unificata

Nuova voce menu **"Cerca Domicilio"**, view `'cerca-domicilio'`, due tab
(stesso layout di "Verifica INAD" oggi: `nav nav-tabs`):

- **Verifica singola**: campo CF + bottone "Cerca" → `POST
  admin/domicilio/cerca` → 3 card di esito (INAD / App IO / ANPR), stesso
  stile border success/secondary/danger di `verifica-inad` esistente.
- **Verifica massiva CSV**: vedi sezione G.

Le pagine `view==='verifica-inad'` e `view==='verifica-appio'` perdono la
tab "Verifica singola" (resta solo "Verifica massiva CSV" — se resta un
solo tab, si rimuove anche la tab-nav, mostrando il contenuto direttamente).
Lo state legato alla verifica singola INAD (`verificaInadCf`,
`verificaInadResult`, `runVerificaInad`) viene rimosso da lì e ricreato
pulito, con nomi propri, nella nuova pagina — nessuna duplicazione tra le
due.

### G. Verifica massiva "Cerca Domicilio"

**Vincolo che guida il design**: INAD `/extract` (singola per-CF) ha una
quota giornaliera condivisa con il resto del sistema (1000-2000
richieste/die, non documentata nello spec ma nota da verifica diretta —
vedi CLAUDE.md sezione INAD). Chiamarla in loop per-riga su un CSV grande
la esaurirebbe rapidamente. Va quindi riusata l'API bulk nativa INAD
(`/listDigitalAddress`, batch 1000, come fa già `InadVerifyBulkService`),
mentre App IO e ANPR (chiamate sync per-CF senza quota nota) vanno in loop
BullMQ per-riga come già fa `AppIoVerifyBulkProcessor`. Il job risultante è
quindi ibrido: due sotto-processi che convergono in un risultato finale.

Nuova entity `DomicilioVerificationJob`:

```ts
status: QUEUED | PROCESSING | DONE | FAILED
totalRows: number
processedRows: number          // avanzamento ramo App IO + ANPR
inadBatches: InadVerificationBatch[]   // riuso tipo esistente da inad-verification-job.entity.ts
inadDone: boolean
inadAddresses: Record<string, string>  // cf -> indirizzi digitali INAD, jsonb
appioAnprDone: boolean
partialResults: Record<string, { appIoAttivo: string; anprIndirizzo: string }>  // jsonb
sourceCsv: string
csvHeaders: string[]
cfColumn: string
resultCsv: string | null      // CSV unico, non split found/notfound
errorMessage: string | null
completedAt: Date | null
```

Flusso:

1. `DomicilioVerifyBulkService.createJob` — parse CSV, CF univoci validi
   (16 caratteri), submit batch INAD nativo (`inadService.startBulkExtraction`,
   fino a 1000 CF a chiamata) → salva `inadBatches`, poi accoda un job
   BullMQ per il ramo App IO + ANPR.
2. `DomicilioVerifyBulkProcessor` (BullMQ, concurrency 5, pattern identico
   ad `AppIoVerifyBulkProcessor`) — per ogni riga: `verifyProfile(cf)` +
   `anprService.getResidenza(cf, operatorUsername)` in parallelo, esito
   scritto in `partialResults[cf]`. A fine loop: `appioAnprDone = true`,
   poi chiama `tryComplete(jobId)`.
3. `DomicilioVerifyBulkSyncService` (Cron `*/5 * * * *`, pattern identico a
   `InadVerifyBulkSyncService`) — poll dei batch INAD; quando tutti
   `DISPONIBILE`: fetch risultati in `inadAddresses`, `inadDone = true`,
   chiama `tryComplete(jobId)`.
4. `tryComplete(jobId)` — metodo condiviso (in `DomicilioVerifyBulkService`,
   chiamato sia dal processor sia dal cron): se `inadDone && appioAnprDone`,
   fa il merge — CSV con colonne originali + 3 colonne aggiuntive:
   - `domicilio_digitale_inad` (indirizzi digitali o vuoto)
   - `app_io_attivo` (`si` / `no` / `errore: <msg>`)
   - `anpr_indirizzo_residenza` (indirizzo formattato o `non trovato` /
     `errore: <msg>`)

   e marca `status = DONE`. Se una delle due condizioni non è ancora vera,
   non fa nulla (l'altro ramo, quando finisce, richiamerà `tryComplete`).

UI: dentro "Cerca Domicilio" → tab "Verifica massiva CSV", stesso layout
upload/poll/download della tab INAD massiva odierna, un solo bottone
"Scarica CSV risultato" (nessuno split trovati/non trovati: ogni riga ha
sempre le 3 colonne di esito, qualunque sia il risultato).

## Testing

- Unit test `AnprService`: mapping risposta 200/404/RispostaKO, corretta
  costruzione digest + claim JWS (verificabile firmando e poi verificando
  la firma con la stessa chiave pubblica nel test, senza bisogno di rete).
- Unit test `PdndAuthService.signAgidJwt`: claim temporali coerenti, kid
  corretto nel JOSE header.
- Unit test `DomicilioService.cercaDomicilio`: un fallimento di una delle
  tre fonti (mock `Promise.allSettled` con un rejected) non deve impedire
  la risposta delle altre due.
- Unit test `DomicilioVerifyBulkService.tryComplete`: merge scatta solo a
  entrambi i flag true, non prima; CSV risultato ha le 3 colonne attese.
- Nessun test E2E contro ANPR reale (richiede credenziali PDND vere,
  fuori dalla suite CI) — verifica manuale in collaudo prima del rilascio,
  stesso approccio già usato per SEND.

## Rischi noti / verifiche da fare in collaudo (non bloccanti per il design)

- Formato esatto di `Agid-JWT-TrackingEvidence` (claim `userID`/
  `userLocation`/`LoA`) non è confermato da uno spec ufficiale con esempio
  completo — solo da issue GitHub parziali. Primo test reale in collaudo
  può richiedere aggiustamento dei nomi/valori claim.
- `x5c`/certificato X.509 nel JOSE header di `Agid-JWT-Signature`: lo spec
  ufficiale lo cita come opzione (alternativa a un kid già noto
  all'erogatore), l'integrazione reale osservata (issue `italia/anpr#4706`)
  ha usato solo `kid` — assumiamo che basti perché il kid è già registrato
  su PDND per lo stesso client, ma va confermato al primo test reale.
