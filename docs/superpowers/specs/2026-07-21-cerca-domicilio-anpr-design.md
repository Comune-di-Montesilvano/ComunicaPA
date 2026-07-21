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

### A. Firma JWS PDND (estensione di `PdndAuthService`) — verificato dal vivo, funzionante

ANPR C020 richiede, oltre al bearer voucher PDND, due header aggiuntivi
sulla singola chiamata REST, pattern PDND `INTEGRITY_REST_02` e
`AUDIT_REST_02`. Pattern finale confermato con una chiamata reale riuscita
(HTTP 200, dati di residenza corretti) — vedi CLAUDE.md sezione "ANPR C020"
per il percorso di debug completo (alcune ipotesi intermedie, incluso DPoP,
si sono rivelate sbagliate prima di arrivare qui):

- **`Agid-JWT-Signature`**: JOSE header `{alg:'RS256', typ:'JWT', kid}`
  (nessun `x5c`/certificato necessario, il kid da solo basta). Payload:
  `{iss, sub, aud: <ANPR_C020_AUD>, iat, exp (~60s), nbf, jti,
  signed_headers: [{digest: "SHA-256=<base64 sha256(body)>"}, {"Content-Type":
  "application/json"}]}`. **`aud` è l'URL SENZA `-PDND` e SENZA il segmento
  operazione finale** — diverso dall'URL di invocazione reale. Il body va
  anche accompagnato da un header HTTP separato `Digest:
  SHA-256=<stesso valore>` (RFC 3230).
- **`Agid-JWT-TrackingEvidence`**: stesso schema di firma, payload `{iss,
  sub, aud: <ANPR_C020_AUD>, iat, exp, nbf, jti, purposeId, dnonce,
  userID, userLocation, LoA}`. `userID` = username dell'operatore (da JWT
  di sessione); `userLocation`/`LoA` da settings — **`LoA` ha un vincolo di
  lunghezza massima 20 caratteri** (scoperto da un errore applicativo
  reale, non documentato nello yaml — default corretto a `SpidL2`, non un
  URL completo). `dnonce` = timestamp in millisecondi (stringa).
- **Voucher con claim `digest`** (pattern AUDIT_REST_02): la richiesta
  voucher a PDND (client assertion) deve includere un claim extra
  `digest: {alg:"SHA256", value:<hex>}`, dove `value` è lo SHA-256
  **esadecimale** (non base64) del JWT `Agid-JWT-TrackingEvidence` — va
  quindi costruito PRIMA il TrackingEvidence, poi hashato, poi richiesto
  il voucher che lo referenzia. Senza questo claim, PDND non lo incorpora
  nel voucher e l'erogatore rigetta la chiamata con
  `InteroperabilityInvalidRequest`.

Metodi su `PdndAuthService`:

```ts
signAgidJwt(env: PdndEnvironment, aud: string, extraClaims: Record<string, unknown>): Promise<string>
getVoucherWithDigest(env: PdndEnvironment, purposeId: string, digestHex: string): Promise<string>
```

Riusano `kid`/`privateKey`/`clientId` già letti da `pdnd.{env}.*` — nessuna
nuova chiave di firma da configurare. `getVoucherWithDigest` non usa cache
(il digest cambia a ogni chiamata, a differenza del voucher standard di
`getVoucher` usato da SEND/INAD).

### B. Settings

Nuova tab `anpr` in `SETTINGS_NAV` (frontend-admin), affiancata a
`inad`/`inipec`. Registry (`settings.registry.ts`):

```
anpr.test.purposeId          — solo per test voucher PDND (come INAD)
anpr.prod.purposeId          — query reale (sempre e solo prod, come INAD)
anpr.trackingUserLocation    — default: 'comunicapa-backend'
anpr.trackingLoA             — default: 'SpidL2' (max 20 caratteri, vincolo ANPR)
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

- Costruisce prima `Agid-JWT-TrackingEvidence` (serve il suo digest per il
  voucher), poi chiede il voucher con `pdndAuth.getVoucherWithDigest('prod',
  purposeId, trackingDigestHex)`.
- Body `RichiestaE002` (schema yaml): `idOperazioneClient` (timestamp ms +
  6 char random, **max 30 caratteri** — un `randomUUID()` di 36 caratteri
  viene rifiutato da ANPR), `criteriRicerca: { codiceFiscale }` (query
  diretta per CF, niente step preventivo per idANPR — lo schema lo
  permette), `datiRichiesta: { dataRiferimentoRichiesta: <oggi,
  YYYY-MM-DD>, motivoRichiesta: 'comunicapa-cerca-domicilio', casoUso:
  'C020' }`.
- Calcola Digest SHA-256 del body, firma `Agid-JWT-Signature` via
  `pdndAuth.signAgidJwt(...)`, POST a `ANPR_C020_ENDPOINT` (CON `-PDND` e
  `/anpr-service-e002` — diverso da `ANPR_C020_AUD` usato per `aud`) con
  header `Authorization: Bearer <voucher>`, `Digest`, `Agid-JWT-Signature`,
  `Agid-JWT-TrackingEvidence`, `Content-Type: application/json`.
- 404 o `RispostaKO` (posizione non presente in ANPR) → `{ found: false }`.
- 200 con `listaAnomalie` (warning, non bloccante): ANPR raccomanda
  `idANPR` al posto di `codiceFiscale` per conformità normativa — non
  impedisce la risposta, ignorato per ora (vedi CLAUDE.md).
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

## Rischi noti — tutti verificati e risolti con una chiamata reale riuscita (HTTP 200, dati di residenza corretti)

Il percorso di debug reale ha attraversato diverse ipotesi sbagliate prima
di arrivare al pattern corretto (documentato in dettaglio, con motivazione
del perché ogni ipotesi intermedia sembrava plausibile, in CLAUDE.md
sezione "ANPR C020"). Riassunto della causa reale, verificata contro un
client Java ufficiale allegato dal supporto ANPR
(github.com/italia/anpr/issues/3964):

- **`aud` sbagliato** (con `-PDND` e/o con `/anpr-service-e002` in coda,
  invece dell'URL base senza questi due dettagli) — causa più comune di
  `InteroperabilityInvalidRequest` nel thread di supporto.
- **Voucher senza il claim `digest`** nella client assertion (pattern
  AUDIT_REST_02: hash esadecimale del JWT TrackingEvidence, non base64) —
  senza, PDND non lo incorpora nel voucher e l'erogatore rigetta.
- **`signed_headers` con case/contenuto non esattamente combacianti** con
  gli header HTTP realmente inviati.
- **Vincoli di lunghezza sui claim** (`LoA` max 20 caratteri — il default
  iniziale `https://www.spid.gov.it/SpidL2` era troppo lungo, corretto a
  `SpidL2`) e sul corpo (`idOperazioneClient` max 30 caratteri — un
  `randomUUID()` di 36 caratteri veniva rifiutato).
- **DPoP** (RFC 9449) è stata un'ipotesi intermedia rivelatasi sbagliata —
  provata dal vivo, cambiava l'esito del 400 ma non per il motivo giusto;
  scartata e rimossa dal codice quando il vero pattern (bearer standard +
  digest-bound voucher) è stato confermato dal thread di supporto ufficiale.
- **`x5c`/certificato X.509**: non necessario, il `kid` da solo basta.

Verifica finale dal vivo: risposta HTTP 200 con dati di residenza reali e
corretti (indirizzo completo, comune, CAP). Un warning non bloccante
(`listaAnomalie`, `tipoErroreAnomalia:"W"`) raccomanda l'uso di `idANPR`
al posto di `codiceFiscale` per conformità al D.M. Interno 3 marzo 2023 —
non blocca oggi, ma se ANPR renderà `idANPR` obbligatorio in futuro serve
una fase di risoluzione CF→idANPR a monte (fuori scope per ora).
