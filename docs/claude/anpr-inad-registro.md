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

## ANPR elaborazioni massive (Verifica Domicili) — C030 e C007

`AnprMassivoService` (`channels/anpr/anpr-massivo.service.ts`): stessa spec
"Consultazione ANPR API C0XX massiva" per i due e-service, cambiano path e
caso d'uso — `E002AccertamentoIdAnprMassivo` (C030, presenza in ANPR) e
`E002VericaEsistenzaInVitaMassiva` ("Verica" sic, C007, esistenza in vita
S/N). Purpose ID distinti: `anpr.massivoId.purposeId`,
`anpr.massivoVita.purposeId` (vuoto = opzione nascosta nella UI).

- Input: `fileInput` = base64 di un gzip CSV con un CF per riga (senza
  intestazione), max 1.500.000 byte compressi → blocchi da 50.000 CF.
  `tipoRicerca: '1'` (CF), `datiRichiesta.casoUso` C030/C007.
- Output: JSON gzip `{risposteMassive:[{cf, RispostaE002OK:{listaSoggetti:…}}]}`.
  CF **assente** dall'output = mai in ANPR o cancellato per motivi diversi dal
  decesso (doc ufficiale, uguale per entrambi): per questo con C007 non serve
  anche C030 (una sola elaborazione).
- Fino a **3 giorni** di elaborazione: soglia di stallo del job 96h con ANPR
  pendente (48h altrimenti), download riprovato ogni 10 minuti.

**`aud` dei massivi = URL dei `servers` CON `-PDND`** (l'opposto di
C002/C019). Bug reale v1.25.0: con la regola di C002 la richiesta C007 in
produzione rispondeva 400 `InteroperabilityInvalidRequest`; il supporto ANPR
indica per lo stesso errore "Token contenente un claim 'aud' non valido" su
entrambi gli header (italia/anpr#4662), valore confermato in collaudo da un
altro ente (italia/anpr#5425). Mai ricavare l'`aud` di un nuovo e-service
ANPR per analogia: cercare prima nelle issue `italia/anpr`.

Stato elaborazione: non c'è un endpoint di stato, il download risponde 404
con `{"listaErrori":[{"testoErroreAnomalia":"Risorsa in attesa di
elaborazione con stato: N"}]}` finché non è pronto (italia/anpr#5425). Esiste
anche uno stato `5` non documentato. L'annullamento (`DELETE
…/anpr-massivo-e002-delete/resource/{id}`) è accettato solo nello stato
"inserita", che dura pochi istanti: l'annullamento di una Verifica Domicili
lo tenta comunque, best effort.

**Da verificare al primo uso reale** (dedotti, non provati):
1. GET download con `Agid-JWT-Signature` senza `signed_headers` di body
   (dichiarare `digest`/`content-type` senza inviarli → errore, #4888);
2. il file di esito può essere gzip binario o base64 di gzip
   (`format: byte`): `parseRispostaMassiva` accetta entrambi più JSON in chiaro.
