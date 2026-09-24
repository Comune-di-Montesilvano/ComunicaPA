# ANPR, INAD, Registro Imprese

## Verifica Anagrafica — "Partita IVA" nella UI è in realtà ricerca per Codice Fiscale

`DomicilioService.cercaDomicilio()` classifica un input di 11 cifre numeriche
come "Partita IVA" (`isPartitaIva()`, `tax-id.util.ts` — solo classificazione
di FORMATO) e lo passa a `RegistroImpreseService.dettaglioImpresa()`, che
interroga **sempre** l'endpoint `/dettaglio/codicefiscale?codiceFiscale=...`
— non esiste un endpoint di ricerca per Partita IVA in questa integrazione
PDND. Per la maggior parte delle imprese Partita IVA e Codice Fiscale
persona giuridica coincidono (stesso numero), ma non sempre — enti
pubblici, cooperative sociali e altri soggetti possono avere un CF diverso
dalla PIVA. Se l'operatore inserisce la PIVA e per quel soggetto differisce
dal CF, la ricerca risponde "nessuna impresa trovata" — non un bug, va
ripetuta con il CF reale del soggetto. UI (`view === 'cerca-domicilio'` e
pannello test Impostazioni → Registro Imprese) avvisano di questo nel testo,
ma nessuna validazione automatica può distinguere i due casi (stesso formato
11 cifre) — l'unico modo è provare entrambi se il primo tentativo fallisce.

## Registro Imprese — stato impresa e campi alternativi per forma giuridica

`dettaglio/codicefiscale` (XML) espone lo stato impresa come attributo
`stato-impresa` su `dati-identificativi` — **assente per imprese attive**,
presente solo per cessate/cancellate (verificato dal vivo: Ferrari S.p.A.
attiva non ha l'attributo). Diverso dall'elemento `StatoImpresa` usato da
`ricerca/denominazione` — bug reale corretto: mai mappato prima, "Cerca
Domicilio" per CF non mostrava mai lo stato. `dt-iscrizione-ri` (società
di persone) vs `dt-iscrizione-rea` (SPA/SRL) — nomi attributo diversi per
la stessa data, un solo campo letto lasciava il dato assente per metà
delle forme giuridiche. `info-patrimoniali-finanziarie`: `capitale-sociale`
(SRL/SPA) vs `valore-nominale-conferimenti` (SAS/SNC) — strutture sorelle
diverse, mai entrambe presenti sulla stessa impresa. Script debug dedicato
(stesso pattern GlobalCom sopra): `apps/backend/src/debug/registro-imprese-dettaglio.cjs`.

## ANPR C002 — pattern di sicurezza reale (verificato con dati veri, funzionante)

Il servizio C002 "Servizio di comunicazione" (`AnprService`,
`channels/anpr/anpr.service.ts`) usa **bearer voucher standard** (non
DPoP — ipotesi provata dal vivo e scartata: cambiava l'esito del 400 ma
per un motivo diverso, vedi sotto). Sostituisce C020 "Servizio di
accertamento residenza" (stesso schema/pattern di sicurezza, path e
`casoUso` diversi) perché C002 è un superset: oltre a generalità e
residenza restituisce anche esistenza in vita ed eventuale domicilio
digitale, tramite `infoSoggettoEnte` (coppie chiave/valore generiche —
osservato dal vivo: `{chiave:"Verifica esistenza in vita", valore:"S"}`,
nessun'altra chiave documentata nello yaml, se un domicilio digitale è
presente compare come voce aggiuntiva nello stesso array). La
configurazione corretta, verificata byte-per-byte contro un client Java
ufficiale allegato dal supporto ANPR (github.com/italia/anpr/issues/3964
— **non fidarsi di un riassunto, solo di esempi reali con token
catturati**, un riassunto ha già portato su strade sbagliate — es.
certificato X.509 mancante, poi DPoP — in questa stessa integrazione):

1. **`aud` di `Agid-JWT-Signature`/`Agid-JWT-TrackingEvidence` è l'URL
   SENZA `-PDND` e SENZA il segmento operazione finale**
   (`ANPR_C002_AUD` = `.../MinInternoPortaANPR/C002-servizioComunicazione/v1`)
   — diverso dall'URL di invocazione reale (`ANPR_C002_ENDPOINT`, CON
   `-PDND` e CON `/anpr-service-e002` in coda). Un `aud` sbagliato (uno dei
   due dettagli scambiato) è la causa più comune di
   `InteroperabilityInvalidRequest` (HTTP 400) in tutto quel thread.
2. **Il voucher va richiesto con un claim `digest` extra nella client
   assertion** (pattern AUDIT_REST_02): `{alg:"SHA256", value:<hex>}` dove
   `value` è lo SHA-256 **esadecimale** (non base64) del JWT
   `Agid-JWT-TrackingEvidence` — va quindi costruito PRIMA il
   TrackingEvidence, poi hashato, poi richiesto il voucher
   (`PdndAuthService.getVoucherWithDigest`, mai cache: il digest cambia a
   ogni chiamata). Senza questo claim PDND non lo incorpora nel voucher e
   l'erogatore rigetta con lo stesso 400 generico.
3. **`signed_headers` in `Agid-JWT-Signature` è un array**, con chiavi che
   devono combaciare ESATTAMENTE (nome e valore) con gli header HTTP
   realmente inviati — `Content-Type` con la maiuscola, mai
   `content-encoding` se quell'header non viene effettivamente mandato.
4. **Vincoli di lunghezza sui claim di `Agid-JWT-TrackingEvidence`**,
   scoperti solo dall'errore applicativo reale restituito da ANPR (non
   documentati nello yaml): `LoA` max 20 caratteri (es. `SpidL2`, mai un
   URL completo tipo `https://www.spid.gov.it/SpidL2`) — vedi
   `anpr.trackingLoA` in `settings.registry.ts`. `userLocation`/`userID`
   probabilmente hanno vincoli simili, non ancora tutti mappati.
5. **`idOperazioneClient` (corpo della richiesta) max 30 caratteri** — un
   `randomUUID()` (36 con trattini) viene rifiutato con "Lunghezza del
   campo idOperazioneClient maggiore del massimo consentito 30".

**`x5c`/certificato X.509 non necessario**: il kid da solo basta (verifica
lato erogatore risolve la chiave pubblica dal kid già noto a PDND per
quel client) — l'esempio Java ufficiale mette (erroneamente, per quanto
osservabile) la chiave privata dentro `x5c`, un bug del sample mai
segnalato come problema dal supporto ANPR nello stesso thread; nella
nostra implementazione `x5c` è omesso del tutto, funziona.

**Warning non bloccante da tenere presente**: la risposta 200 include
spesso `listaAnomalie` con un warning (`tipoErroreAnomalia:"W"`) che
raccomanda l'uso di `idANPR` invece di `codiceFiscale` in
`criteriRicerca` per conformità al D.M. Interno 3 marzo 2023 — non blocca
la query attuale (funziona comunque per CF), ma se ANPR in futuro rende
`idANPR` obbligatorio, serve una fase di risoluzione CF→idANPR a monte.

## API esterne con XML — verificare l'encoding, mai fidarsi di `response.text()`

`response.text()` di `fetch` decodifica sempre come UTF-8 di default, ignorando l'encoding dichiarato nel
prologo XML (`<?xml ... encoding="windows-1252"?>`) — bug reale su Registro Imprese: ogni carattere accentato
storpiato (`unit�` invece di `unità`), nessun errore, scoperto solo controllando l'output a video. Fix: leggere
`response.arrayBuffer()` e decodificare esplicitamente con `new TextDecoder(encodingDichiarato).decode(buffer)`.
Verificare sempre l'encoding reale di una nuova API esterna (header `Content-Type` o prologo XML) prima di
fidarsi di `response.text()`.

## INAD — Indice Nazionale Domicili Digitali, dati verificati dal vivo

`GET /extract/{cf}` (query singola): **~0.5s**, sincrona. `POST
/listDigitalAddress` (bulk, fino a 1000 CF): **5-10 minuti**, elaborazione a
batch periodici lato INAD non realtime — costo prevalentemente fisso, non
lineare (3 CF: 5m53s; 50 CF: 6m09s-10m04s su due run separate). Non
verificato oltre 50 CF: se emerge crescita marcata su batch da centinaia,
va rivista qualunque soglia extract/bulk basata su questi numeri.
`/extract` ha limite **giornaliero condiviso** (1000-2000 richieste/die,
non nello spec OpenAPI) — non usare in loop su campagne grandi.



**Spec INAD** (verificata su raw YAML AgID, `AgID/INAD_API_Extraction`):
autenticazione **solo** bearer voucher PDND (nessun `x-api-key`, a
differenza di SEND); `GET /extract/{cf}` richiede il query param
`practicalReference` (riferimento del procedimento); **404 = nessun domicilio
digitale**, esito legittimo e non un errore.

**INIPEC abbandonato**: il domicilio digitale d'impresa passa da Registro
Imprese (PDND). Rimossi modulo, chiavi settings `inipec.*` (migration
`RemoveInipecSettings`), tab Impostazioni e test connessione.
