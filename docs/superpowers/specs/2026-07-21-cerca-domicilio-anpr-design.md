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

Centralizziamo le tre interrogazioni in un'unica funzione "**Cerca
Domicilio**": una pagina che, dato un CF, interroga sempre insieme tutti i
canali abilitati su quell'istanza (INAD + App IO + ANPR) e mostra una
scheda completa del cittadino (domicilio digitale eletto, stato App IO,
residenza anagrafica strutturata).

**Questo documento copre SOLO la verifica puntuale (singolo CF).** La
verifica massiva unificata è un'estensione più complessa (job ibrido
BullMQ+cron, merge di più fonti asincrone) e la forma esatta della risposta
ANPR reale non è ancora stata osservata con dati veri — il design dettagliato
è quindi scritto a parte, come spec separata, e non pianificato/implementato
in questa fase: `2026-07-21-cerca-domicilio-massiva-design.md`.

Conseguenza per questa fase: le pagine standalone "Verifica INAD" e
"Verifica App IO" perdono **solo** la tab "Verifica singola" (sostituita
dalla nuova pagina unificata) — la tab "Verifica massiva CSV" di entrambe
resta **invariata** per ora, verrà rimossa solo quando la massiva unificata
(spec separata) sarà implementata e prenderà il suo posto.

**Fuori scope per questa fase** (esplicitamente deferito):
- Verifica massiva unificata (spec separata, non pianificata ora).
- Invio massivo/singolo di comunicazioni usando i dati di residenza trovati
  su ANPR (fase successiva, da disegnare separatamente).
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

Endpoint esistenti `inad-verify/verify-single` e `io-services/verify-profile`:
restano per ora (non ancora rimossi — la loro rimozione è legata alla
massiva unificata, spec separata). Il frontend smette semplicemente di
chiamarli per la ricerca singola, usando solo il nuovo endpoint unificato.

### F. Frontend — pagina unificata (solo singola)

Nuova voce menu **"Cerca Domicilio"**, view `'cerca-domicilio'`: campo CF +
bottone "Cerca" → `POST admin/domicilio/cerca` → 3 card di esito (INAD /
App IO / ANPR), stesso stile border success/secondary/danger di
`verifica-inad` esistente. Nessuna tab (una sola modalità per ora).

Nelle view esistenti `view==='verifica-inad'` e `view==='verifica-appio'`
si rimuove **solo** la tab "Verifica singola" (e lo state dedicato:
`verificaInadCf`, `verificaInadResult`, `runVerificaInad`, equivalenti App
IO) — la tab "Verifica massiva CSV" di entrambe resta intatta, invariata,
finché non sarà sostituita dalla massiva unificata (spec separata).

## Testing

- Unit test `AnprService`: mapping risposta 200/404/RispostaKO, corretta
  costruzione digest + claim JWS (verificabile firmando e poi verificando
  la firma con la stessa chiave pubblica nel test, senza bisogno di rete).
- Unit test `PdndAuthService.signAgidJwt`: claim temporali coerenti, kid
  corretto nel JOSE header.
- Unit test `DomicilioService.cercaDomicilio`: un fallimento di una delle
  tre fonti (mock `Promise.allSettled` con un rejected) non deve impedire
  la risposta delle altre due.
- Nessun test E2E contro ANPR reale (richiede credenziali PDND vere,
  fuori dalla suite CI) — verifica manuale in collaudo prima del rilascio,
  stesso approccio già usato per SEND.

## Rischi noti — verificati dal vivo, risolti

- **DPoP obbligatorio, non bearer standard** (risolto): il primo test reale
  con credenziali PDND vere ha restituito `HTTP 400
  InteroperabilityInvalidRequest` dal gateway GovWay usando un bearer
  voucher standard. Causa reale: questa finalità richiede un voucher **DPoP**
  (RFC 9449) — scelta del fruitore in fase di richiesta voucher, non
  dichiarata né nello yaml/OpenAPI dell'erogatore né nel portale self-care
  PDND. Aggiunto `PdndAuthService.getVoucherDpop`/`buildResourceDpopProof`;
  `AnprService` ora invia `Authorization: DPoP <voucher>` + header `DPoP`
  (seconda proof con claim `ath`), oltre ai soliti
  `Digest`/`Agid-JWT-Signature`/`Agid-JWT-TrackingEvidence`. Verificato dal
  vivo: la risposta 400 `InteroperabilityInvalidRequest` sparisce con
  questo fix (nessun errore di validazione del protocollo). Vedi gotcha
  dedicato in CLAUDE.md.
- **`x5c`/certificato X.509**: non necessario. Una volta passati a DPoP, il
  solo `kid` nel JOSE header di `Agid-JWT-Signature`/`Agid-JWT-TrackingEvidence`
  è sufficiente — confermato dal vivo (nessun errore di certificato/firma
  dopo il fix DPoP).
- **Formato di `Agid-JWT-TrackingEvidence`** (claim `userID`/`userLocation`/
  `LoA`): i valori di default usati (vedi tab Impostazioni ANPR) sono stati
  accettati dal gateway nella chiamata reale — nessun errore di validazione
  su questi claim osservato dopo il fix DPoP.

## Rischio aperto — bloccante, NON di codice (infrastruttura esterna)

Dopo il fix DPoP, ogni chiamata (inclusa una `GET /status` non
autenticata, su entrambi i path `MinInternoPortaANPR`/
`MinInternoPortaANPR-PDND`) riceve HTTP 404
`{"detail":"Unknown API Request","Error Message":"Rejected by
policy.","Error Code":"0x00d30003"}` con header
`x-backside-transport: FAIL FAIL` — firma nota di IBM DataPower Gateway
che significa "gateway irraggiungibile verso il proprio backend", non un
rigetto applicativo. Stesso esito identico su operazione autenticata (POST
reale) e non (`/status`), su entrambe le varianti di path — esclude
firma/DPoP/body/path come causa: è un guasto o mancata attivazione
end-to-end del backend ANPR reale lato Ministero Interno/Sogei. Non
risolvibile lato codice. Verificare con Sogei/PDND lo stato del servizio
prima di ritentare in collaudo.
