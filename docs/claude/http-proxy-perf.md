# Reverse proxy & performance — timeout, event loop, upload

## Reverse proxy esterno in produzione — gotcha critico

Davanti al backend in produzione c'è un reverse proxy esterno (fuori da questo
repo, gestito a livello infrastruttura) con **limite body ~1MB** e che
**sostituisce il body delle risposte non-2xx con una pagina HTML propria**,
rendendo illeggibile qualsiasi messaggio di errore lato frontend. Pattern
obbligatorio per endpoint che possono fallire in modo "previsto" (validazione,
allegati mancanti): rispondere sempre **HTTP 200** con un flag tipo
`{ blocked: true, message: '...' }`, mai lanciare eccezioni HTTP non-2xx per
errori che l'utente deve poter leggere (vedi `campaigns.service.ts`
`launch()`/`uploadCsv()`). Per upload di file grandi (CSV migliaia di righe,
ZIP allegati) usare l'upload a chunk (`chunked-upload.util.ts` +
`:id/recipients/upload/{init,chunk,complete}` e equivalente per attachments):
chunk client-side da 512KB (sotto il limite del proxy), riassemblati lato
server prima di riusare la logica di import esistente.

Anche stando sotto ~1MB, un endpoint bulk che itera N operazioni sequenziali
per-record dentro una singola richiesta HTTP (es. retry di massa su migliaia
di destinatari falliti) resta a rischio timeout dietro il proxy, indipendente
dal body size — 200-with-flag non basta se la richiesta stessa impiega troppo
a rispondere. Ogni nuovo endpoint bulk deve avere un tetto esplicito sul
numero di elementi per chiamata (validato sia server-side con
`BadRequestException` sia client-side prima di inviare la richiesta, per non
sprecare la chiamata) — vedi `retryRecipientsBulk`/`MAX_BULK_RETRY_SIZE` in
`campaigns.service.ts` (limite 500).

**`assembleChunkedUpload` — attendere sempre l'evento `finish` prima di
ritornare.** Bug reale trovato durante verifica E2E: la funzione chiamava
`out.end()` senza attenderne il completamento — `WriteStream.end()` non
garantisce che l'ultimo chunk sia stato effettivamente flushato su disco,
solo che è stato accodato al buffer interno. Il chiamante poteva quindi
leggere il file assemblato (es. `new AdmZip(path)`) prima del flush,
ottenendo un file troncato (`ADM-ZIP: Invalid filename` su central
directory incompleta) — race intermittente, più probabile su file grandi
(più tempo di flush). Fix: avvolgere `out.end()` in una Promise che
risolve su `finish`/rigetta su `error`, dentro il blocco `finally` prima
del `return`. Questa funzione è condivisa da 4 percorsi upload (campagne
CSV destinatari, campagne allegati, arricchimento tracciati, io-services
verify-bulk) — qualunque modifica a `chunked-upload.util.ts` va verificata
con lo stesso rigore su tutti e quattro, non solo sul percorso che si sta
toccando.

## Lavoro pesante sincrono in un handler HTTP — non solo timeout proxy, affama TUTTO

Oltre al noto rischio timeout proxy esterno (vedi sopra), un endpoint che fa
unzip/scrittura file pesante in modo sincrono dentro la richiesta HTTP
blocca l'event loop Node (single-thread) per l'intera durata — affamando
ANCHE richieste concorrenti scollegate (osservato in prod: 403 su
`/admin/settings` mentre "crea bozza campagna" da arricchimento (unzip
500MB + scrittura 3280 PDF sync) girava). Fix reale applicato:
`EnrichmentService.requestCampaignConversion()` fa solo validazioni rapide
e accoda un job BullMQ (`convert-campaign`, stesso processor
dell'arricchimento) — l'endpoint risponde subito, il frontend fa polling
sul job esistente. Ogni futuro endpoint che fa unzip/IO pesante va valutato
con lo stesso criterio, non solo "rischia il timeout proxy?" ma anche
"blocca l'app intera nel frattempo?".

**Un loop sincrono di chiamate HTTP esterne per riga (non solo unzip/scrittura
file) scatena lo stesso timeout.** Bug reale: endpoint "Riprova righe
fallite" su ~1142 righe, una chiamata pdf-extractor ciascuna dentro la
richiesta — 504 dal reverse proxy esterno. Stesso fix: l'endpoint fa solo
check economici e accoda un job BullMQ, la logica pesante gira nel processor
in background (riusa la STESSA coda/stesso processor del job originale se
serve serializzare — vedi "Arricchimento tracciati" sotto — non serve
sempre una coda dedicata).

**`bullmq` `Job.remove()` (questa versione, nessuna opzione `force`) lancia
se il job è `active`/lockato da un worker**, mai un no-op silenzioso — un
endpoint che rimuove un job per poi riaccodarlo deve avvolgerlo in
try/catch, altrimenti un click su un job realmente in corso produce un 500
non gestito (bug reale, visto dal vivo).

**worker_thread/BullMQ spostano SOLO il blocco dell'event loop, mai un
picco di memoria.** Bug reale: offload del merge multi-ZIP (adm-zip) su
worker_thread — l'event loop restava libero, ma adm-zip tiene comunque in
RAM OGNI PDF decompresso + il nuovo ZIP compresso simultaneamente, causando
OOM/swap thrashing dell'intero host (Docker Desktop/WSL2 incluso, non solo
il container). Fix vero: evitare di materializzare tutto in memoria insieme
(vedi "Arricchimento tracciati" sotto) — spostare il lavoro su un altro
thread/coda non basta se quel lavoro alloca comunque tutto insieme.

## multer diskStorage — esegue PRIMA di ValidationPipe/ParseUUIDPipe/guard Nest, mai un raw throw dentro

I callback `destination`/`filename` di `diskStorage` (multer) girano DURANTE
il parsing del body multipart, prima che NestJS risolva `@Body()`/`@Param()`
e prima che qualunque `ValidationPipe`/`ParseUUIDPipe` li validi — un
`@IsUUID()` sul DTO o un `ParseUUIDPipe` sul param NON protegge un valore
letto direttamente da `req.body`/`req.params` dentro quei callback. Bug
reale ritrovato **4 volte consecutive** nella stessa sessione (stessa classe,
endpoint diversi): `filename`/`uploadId`/`index`/route param `:id` letti
grezzi dentro `destination`/`filename` e joinati in un path — path traversal
verso scrittura file arbitraria, sempre scoperto solo con un E2E che boota
l'app reale (mai da unit test che chiamano il controller direttamente).
Fix: validare/sanitizzare (`basename()`, regex UUID) DENTRO il callback
stesso, PRIMA di ogni `path.join`/`mkdirSync`/`copyFileSync`.

**Un `throw` sincrono dentro quel callback NON va a un exception filter
Nest — diventa un `uncaughtException` e crash dell'intero processo Node**
(nessun `process.on('uncaughtException')` in questo repo). Mai lanciare:
usare la convenzione di errore di multer, `cb(new BadRequestException(...), '')`.
Pattern di riferimento: `safeChunkUploadDir()`/`isValidChunkIndex()` in
`chunked-upload.util.ts` (mai throw, ritornano `null`) — usare quelle o lo
stesso identico pattern per qualunque nuovo endpoint multer.

