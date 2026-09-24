# Arricchimento tracciati

## Arricchimento tracciati

Feature `apps/backend/src/enrichment/` (+ vista admin "Arricchimento
Tracciati"): carica uno ZIP formato Maggioli (`rubrica.csv`/`pag_indice.csv`
+ `allegati/`), estrae indirizzo postale e dati PagoPA dai PDF via il
microservizio Python `services/pdf-extractor/` (FastAPI + PyMuPDF/pyzbar,
containerizzato, **raggiungibile solo sulla rete interna Docker**
`http://pdf-extractor:8000` — nessuna porta pubblicata verso l'host, non
esposto dal reverse proxy), produce un CSV arricchito scaricabile.

**Coda dedicata, non il meccanismo `EngineName`/`ENGINE_QUEUES`.** A
differenza dei motori di invio (PEC/Email/SEND/...), l'arricchimento usa una
propria coda BullMQ (`ENRICHMENT_QUEUE`, `enrichment-job.types.ts`) con
proprio processor (`enrichment.processor.ts`) — non è un canale di notifica
né un "motore" nel senso di `EnginesController`, quindi non compare nella UI
Motori e non partecipa a pausa/riprendi condivisi. Riusa comunque lo stesso
pattern verificato altrove: stato terminale (`DONE`/`FAILED`) scritto
PRIMA di uscire dal job, mai un job che finisce silenziosamente in stato
intermedio.

**"Retry righe fallite"/"resume" — quando SERVE serializzare con il job
originale, riusa la STESSA `ENRICHMENT_QUEUE`, mai una coda dedicata.**
Contro-esempio a "crea bozza campagna" (coda separata apposta per NON
aspettare un job pesante indipendente): qui la concurrency=1 della coda è
la garanzia voluta, non un limite — un job "retry" che patcha il checkpoint
deve aspettare che l'eventuale job 'enrich' originale finisca/venga
riconosciuto stalled da BullMQ prima di partire, altrimenti due writer
concorrenti sullo stesso checkpoint. Job name diverso ma jobId con prefisso
diverso dall'originale (mai lo stesso, dedup BullMQ per l'intera coda).

**Merge multi-ZIP — mai ricostruire un ZIP fisico coi PDF, solo il CSV.**
`adm-zip` è tutto in-RAM: `entry.getData()` decomprime, `addFile()`
accumula, `toBuffer()` ricomprime tutto insieme — per un batch multi-GB
questo tiene simultaneamente in memoria OGNI PDF decompresso + il nuovo ZIP
compresso (OOM reale, host compreso, non solo il container). Fix: i pezzi
ZIP originali restano file indipendenti su disco
(`getEnrichmentSourcesDir`, spostati con `fs.renameSync`/copy — I/O a
livello OS, mai un buffer in RAM), solo i CSV vengono fusi
(`mergeMaggioliCsv`, testo, mai un PDF toccato) — `processEnrich` apre i
pezzi al volo e decomprime un PDF alla volta, come già faceva per il caso a
singolo file.

**`deleteJob` NON blocca su stato `PROCESSING`** (deviazione deliberata dal
pattern altrove in questo repo, dove un blocco su stato intermedio è la
norma). Un job rimasto bloccato in `PROCESSING` (es. backend riavviato a
metà job) non ha altrimenti alcuna via d'uscita da UI: retention lo
esclude sempre, e non può essere riconvertito in bozza campagna. Endpoint
già `@Roles('admin')`-only — l'eliminazione forzata è la valvola di sfogo,
non un bug.

**Upload sempre chunked**, mai un multipart diretto — stesso vincolo del
proxy esterno ~1MB descritto sopra: `POST
/admin/enrichment/upload/{init,chunk,complete}`, chunk client-side,
riassemblati lato server prima di processare lo ZIP.

**Retention**: `enrichment.retentionDays` (default 30, chiave in
`settings.registry.ts`) — job e file (ZIP sorgente, CSV/ZIP risultato)
più vecchi vengono ripuliti da `EnrichmentRetentionService`, stesso
pattern di retention già usato per le campagne.

**"Crea bozza campagna" non è un importer parallelo.** Il pulsante sul job
completato scrive il CSV arricchito su disco come `draft_recipients.csv` e
imposta `wizCsvFilename` sulla campagna bozza creata — il wizard (`view
=== 'invio-massivo-wizard'`) lo rileva e precarica quel file allo Step 2
esattamente come una ripresa bozza normale (`handleResumeDraft`),
riusando le stesse validazioni CF/email/mappatura colonne del percorso
wizard standard. Nessun bypass di quelle validazioni, coerente con la
regola "creazione campagne — un solo percorso" sopra.

**Un job di arricchimento può generare più bozze nel tempo, non solo una.**
Prima di PR #132 era one-shot (cartella job cancellata subito dopo la
prima conversione, seconda richiesta bloccata) — bug reale: campagna da
18000 record lanciata con impostazione sbagliata, nessun modo di
rilanciarla senza rifare l'intero arricchimento. Ora la cartella resta
fino a retention scaduta e il bottone "Crea bozza campagna" (rinominato
"Crea nuova bozza campagna" se già usato) resta sempre cliccabile — ogni
click crea una campagna bozza NUOVA e indipendente dagli stessi dati.

**Rate multiple PagoPA — classificazione via etichetta, mai ordine pagina.**
`pdf_extractor.py` scansiona TUTTE le pagine con QR pagamento (non solo la
prima) e classifica ciascuna leggendo il testo: `RATA UNICA` → totale,
`N° RATA` → rata N (il numero nell'etichetta determina l'ORDINAMENTO delle
rate, non la posizione pagina — alcuni documenti non hanno la pagina "rata
unica", altri hanno solo quella). **Attenzione**: le rate ordinate vengono
poi compattate per POSIZIONE nelle colonne CSV `rataN_*`, non per numero-
etichetta-esatto — un piano con un buco nella numerazione (solo "2° RATA"
e "3° RATA", manca "1°") produce `rata1_*`=2°rata/`rata2_*`=3°rata, non
`rata2_*`/`rata3_*` con `rata1_*` vuota. Deviazione nota e accettata (caso
raro, piani rateali quasi sempre contigui da 1). Il CSV di output ha
quindi un header dinamico per job: colonne
`rataN_numero_avviso/importo/scadenza` quante ne servono (max trovato tra
i record del job), calcolate da `buildEnrichedCsvHeaders()`
(`enriched-csv.util.ts`) — non più una costante fissa. Controlli di
coerenza (somma rate vs totale, scadenze consecutive, unica≈prima rata)
producono warning, mai bloccanti.

**`pdf_extractor.py` — indirizzo (regex testo) e pagamento (QR code) sono
estrazioni indipendenti sullo stesso PDF, un fallimento non blocca l'altra.**
L'indirizzo usa un pattern testuale (`"Residente in:"`) via testo pagina;
il pagamento decodifica il QR embeddato (`_extract_payment_from_page_qr`,
payload `PAGOPA|002|<numero_avviso>|<cf_ente>|<centesimi>`). Una riga con
warning "Indirizzo non estratto" può avere comunque numero_avviso/importo
già corretti — verificare quale delle due estrazioni è fallita prima di
assumere che l'intera riga vada corretta a mano.

**`numero_avviso`/`numero_avviso_alternativo`: il PDF (QR) vince sempre sul
CSV del tracciato** (`enrichment.processor.ts`, `row.numero_avviso =
result.payment.totale.numero_avviso || rec.csvNumeroAvviso`) — il CSV Maggioli
può avere un valore disallineato dal vero IUV stampato (verificato dal vivo:
QR scansionato manualmente ≠ colonna CSV), il CSV resta solo fallback per
righe senza dati pagamento estratti dal PDF. L'indirizzo fa l'opposto (CSV
vince, PDF solo se `csvAddress` assente) — non generalizzare una priorità
all'altra, sono decisioni indipendenti per campo.

**"Senza PagoPa" — condizione OR su numero_avviso/importo, mai AND, mai
scadenza.** Conseguenza diretta del fallback sopra: `numero_avviso` può
restare valorizzato dal CSV Maggioli anche quando il PDF non ha PagoPa
reale, mentre `importo` non ha mai un fallback CSV. Il criterio "riga senza
PagoPa" dev'essere `!numero_avviso || !importo` (OR, dati obbligatori sono
questi due, `scadenza` esclusa perché non vincolante) — un AND su tutte e
tre le colonne (bug reale corretto 2 volte nella stessa sessione, in 3
punti diversi: `missingPaymentCount`, split bozza in due campagne,
ricalcolo in "Rigenera CSV") dà falsi negativi su ogni riga con solo il
`numero_avviso` residuo dal tracciato.

**Formato riga `rubrica.csv` (tracciato Maggioli) per costruire ZIP di test:**
`id;pec@pec.it;;NOME;COGNOME;CODICE_FISCALE;;NOMINATIVO;numeroProvvedimento;
dataEmissione;Oggetto;;;nomeFile.pdf` (14 campi `;`-separati, vedi
`parseRubricaPec` in `maggioli-parser.ts`) — un file `allegati/nomeFile.pdf`
mancante per una riga produce deliberatamente il warning "PDF non trovato nel
ZIP", utile per riprodurre scenari di correzione manuale senza dati reali.

**Log live job (SSE) — bridge in-memory, valido a singola istanza.**
`GET admin/enrichment/jobs/:id/stream` inoltra in tempo reale gli eventi
che `EnrichmentProcessor` emette via `EnrichmentEventsService`
(`EventEmitter` per jobId) man mano che elabora ogni riga — funziona solo
perché worker BullMQ e HTTP server girano nello stesso processo Node
(un solo servizio `backend`, nessun worker separato). Se il backend scala
a più repliche in futuro, va sostituito con Redis pub/sub — non fatto ora
(YAGNI). Il frontend NON usa `EventSource` nativo (non supporta header
`Authorization`): legge lo stream via `fetch()` +
`response.body.getReader()`, parsing manuale delle righe `data: ...\n\n`.
Nessuna persistenza lato backend — è un log live, non uno storico (i
warning finali restano su `EnrichmentJob.warnings` come sempre).

**adm-zip — "Unknown descriptor format" non è (necessariamente) un file
corrotto.** Un'entry ZIP scritta con **data descriptor** (general purpose
bit 3, sizes nell'header locale assenti, valori dopo i dati compressi) può
far fallire `entry.getData()` di `adm-zip@0.5.18` con `"Unknown descriptor
format"` — limite noto della libreria nel riconoscere il descriptor
(verificato dal vivo: il PDF estratto standalone dallo stesso entry era un
`%PDF-1.4` perfettamente valido, `%%EOF` finale incluso). Non trattarlo
come sintomo di corruzione del file/PDF prima di aver verificato lo stream
isolato. **Ogni punto che itera entry di uno ZIP arricchimento deve avere
un try/catch PER-ENTRY** — bug reale: `EnrichmentProcessor.
processConvertCampaign` iterava tutti i PDF senza try/catch, un solo entry
illeggibile bloccava l'intera conversione di migliaia di destinatari,
mentre `processEnrich` già gestiva lo stesso caso con un warning per-riga.
Stesso fix applicato anche a `EnrichmentService.buildResultZip` (stesso
pattern, stesso rischio).

**PDF scompattati su disco una volta sola (mai più AdmZip su source.zip a
valle).** `EnrichmentProcessor.processEnrich` scompatta ogni PDF valido su
`allegati/` (cartella piatta, `getEnrichmentAttachmentsDir()`) nello stesso
passaggio in cui già legge l'entry per l'estrazione (`entry.getData()`
chiamato una sola volta, riusato sia per l'estrattore Python sia per la
scrittura su disco, con `basename()` sul filename da CSV prima di scrivere
— dato caricato dall'operatore, non fidato per costruire un path) — poi
cancella `source.zip` a fine job **riuscito** (mai su FAILED: un
resume/retry deve poterlo rileggere). `buildResultZip`/
`processConvertCampaign` leggono solo da `allegati/`, mai più `new
AdmZip(source.zip)` a valle — elimina il re-parsing ripetuto di uno ZIP
fino a 500MB in 3 punti diversi e la classe di bug sopra in due di quei tre
punti. **Gap noto**: nessun meccanismo di resume/recovery per
`campaignConversionStatus` bloccato in `processing` (es. backend
riavviato/redeploy a metà copia) — a differenza dello stato principale del
job (`EnrichmentResumeService`), un `campaignConversionStatus` stallato
oggi richiede intervento manuale in DB, nessuna valvola di sfogo da UI.

**Badge/stato "corretto" solo client-side ottimistico — verificare che il
fallback da server dichiarato nel commento esista davvero, non fidarsi.**
Bug reale: `enrichCorrectedPdfs` (badge "Corretto" su riga con override
indirizzo salvato) settato solo al salvataggio riuscito in sessione — un
commento nel codice dichiarava "al refresh torna a leggersi da row.override
via GET" ma nessun endpoint bulk lo faceva, solo GET per singola riga
on-demand al click "Correggi indirizzo". Dato restava sempre corretto in DB
(`enrichment_address_overrides`), solo il badge spariva a ogni
remount/refresh del pannello "Avvisi". Fix: `GET
admin/enrichment/jobs/:id/overrides`, letto all'apertura del pannello per
riconciliare stato locale con DB. Pattern generale: uno stato React
Set/flag "visivo" con commento che promette un fallback server-side va
grep-verificato sul setter effettivo, mai dato per buono dal commento.



**Backlog — terzo formato ZIP Maggioli, mai implementato.** Campione reale
con entry `pag_indice_service.txt`: testo **pipe-delimited (`|`) senza
header**, che contiene indirizzo, PEC/email e OCR nello stesso record.
Mappatura dedotta dal campione e confermata (indici 1-based dopo split su
`|`): 3 OCR (16 cifre), 4 numero provvedimento, 7 nome file PDF,
9 nominativo, 10 CF/PIVA, 11 comune, 12 CAP, 13 provincia, 14 indirizzo,
52 email/PEC. Anche l'export esiti nel formato Maggioli ("Importazione
Notifiche"/"Mancate Notifiche", TXT a larghezza fissa verso Sicr@Web) resta
da fare.
