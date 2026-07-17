# Arricchimento tracciati — Design

Data: 2026-07-17
Stato: approvato (brainstorming con Mirko)

## Obiettivo

Dashboard admin dedicata ("Arricchimento tracciati") che prende in input un
tracciato di postalizzazione (v1: formato Maggioli — ZIP con
`rubrica.csv`/`pag_indice.csv` + `allegati/*.pdf`), estrae dai PDF i dati
mancanti (indirizzo fisico, dati pagamento PagoPA via QR code + regex testo)
e produce un CSV arricchito in formato pronto per il wizard ComunicaPA, più
lo ZIP degli allegati. Elaborazione **asincrona**: si avvia il job, si torna
sulla pagina per vedere lo stato.

Origine del codice: repo locale `sendcsv` (convertitore FastAPI verso
tracciato bloccato EasyNotification a 80 campi). Dall'audit: si riusa SOLO il
core di estrazione (`pdf_extractor.py`, `sanitizer.py`); tutto il resto
(transformer 80 campi, taxonomy, sender CF, writer, webapp) è specifico del
vecchio target e viene scartato — in ComunicaPA quelle decisioni vivono in UI.

**Nota GDPR**: dal repo sendcsv si copiano SOLO i file sorgente. I PDF reali
(`DOC_*.pdf`) e i CSV con dati personali presenti in quel repo NON vanno mai
copiati qui. Fixture di test = PDF sintetici generati ad hoc.

## Architettura (approccio scelto: B — microservizio Python)

Valutate tre opzioni:
- **A** Riscrittura TypeScript nel backend: estrazione testo fattibile
  (pdfjs-dist) ma decodifica QR da PDF in Node richiede canvas nativo
  (doloroso su Alpine/pnpm) — la parte più preziosa è la più rischiosa da
  portare. Scartata.
- **B** **Microservizio Python interno** — scelta. Riusa il codice provato
  sul campo con dipendenze mature (pdfplumber, PyMuPDF, pyzbar); isola crash
  e memoria del rendering PDF.
- **C** Python dentro il container backend (spawn): immagine ibrida
  Node+Python, viola il pattern un-processo-per-container. Scartata.

### 1. Servizio `pdf-extractor` (nuovo container)

- Percorso: `services/pdf-extractor/` (fuori dai workspace pnpm — è Python).
- Base: `pdf_extractor.py` e `sanitizer.py` (`strip_accents`,
  `parse_localita`) da sendcsv. `derive_protocollo` NON si porta (hardcoda
  prefisso `SIC/`).
- API FastAPI minimale:
  - `POST /extract` — body: PDF bytes (multipart o octet-stream) + query
    `mode=unica|multirata`. Risposta JSON:
    `{ "address": {indirizzo, cap, comune, provincia, stato_estero} | null,
       "payment": {numero_avviso, numero_avviso_alternativo, cf_ente,
                   importo, scadenza} | null,
       "warnings": ["..."] }`
  - `GET /health` — healthcheck compose.
- Fix rispetto all'originale: eliminare i `except Exception: pass` silenziosi
  — ogni fallimento di estrazione produce un warning esplicito nel JSON.
- Rete: SOLO rete interna compose, mai esposto dal proxy esterno. Il backend
  lo raggiunge via `PDF_EXTRACTOR_URL` (env bootstrap, default
  `http://pdf-extractor:8000`).
- Dockerfile.dev (dev, bind mount) + Dockerfile prod. CI `release.yml`:
  nuova immagine `ghcr.io/comune-di-montesilvano/comunicapa-pdf-extractor`
  (namespace lowercase come le altre).
- Capacità estrazione (ereditata da sendcsv, verificata sul campo):
  - Indirizzo: 3 template regex (`Residente in:` domestico, variante estero,
    `Residenza:` TARI).
  - Pagamento: QR primario (render pagina 3x/4x PyMuPDF + pyzbar, immagini
    embedded ordinate per bbox top-to-bottom/left-to-right, parse
    `PAGOPA|002|<numeroAvviso>|<cfEnte>|<centesimi>`), fallback regex testo
    (CBILL, importo formato italiano `4.222,00`→`4222,00`, scadenza).
    Selezione pagina totale/rata unica via dicitura `CBILL`.

### 2. Backend — nuovo modulo `enrichment/`

**Entity `EnrichmentJob`** (nuova tabella + migration):
- `id`, `sourceFilename`, `traceFormat` (enum, v1: `MAGGIOLI` — estensibile),
- `status` (`PENDING | RUNNING | COMPLETED | FAILED | CANCELLED`),
- contatori: `totalRecords`, `processedRecords`, `warningCount`,
- `warnings` (JSON, per riga: pdf, messaggio),
- path risultato (CSV arricchito + ZIP allegati),
- `campaignId` nullable (valorizzato se il job è diventato campagna),
- `createdBy`, timestamps.

**Upload input — VINCOLO OBBLIGATORIO: sempre chunked.** Lo ZIP Maggioli
supera facilmente il limite ~1MB del reverse proxy esterno: si riusa
`chunked-upload.util.ts` con endpoint `init/chunk/complete` dedicati
(chunk client-side 512KB), MAI un upload single-shot. Il `complete` crea
l'`EnrichmentJob` e accoda il job BullMQ.

**Motore BullMQ `ENRICHMENT`** (nuovo `EngineName` in
`notification-job.types.ts`):
- `opts.jobId = enrichmentJob.id` (pattern jobId = id record, lookup diretto).
- UI Motori esistente gratis: pausa/riprendi, job falliti, `job.log()`.
- Worker: legge ZIP da disco, parsa il tracciato, itera i record; per ogni
  PDF chiama `POST /extract` del servizio Python; logga progresso con
  `job.log()`; aggiorna contatori su `EnrichmentJob`; a fine corsa scrive
  CSV risultato + copia PDF e marca `COMPLETED`. Un fallimento fatale marca
  `FAILED` PRIMA di rilanciare l'errore (pattern stato terminale).
- PDF mancante nel ZIP o estrazione fallita = warning sulla riga, non
  fallimento del job (la riga esce nel CSV con i campi estratti vuoti).

**Parser tracciato Maggioli in TypeScript** (port di `reader.py` — parsing
CSV semplice, non serve Python):
- `rubrica.csv` (PEC): posizionale, `;`, no header — campi 1=PEC, 3=nome,
  4=cognome, 5=CF (16=PF/11=PG), 7=nome completo, 8=n. provvedimento,
  9=data, 10=oggetto, 13=nome PDF.
- `pag_indice.csv` (analogico): con header, valori prefissati da apostrofo,
  indirizzo/località/Ocr int/Ocr rid da colonne dedicate.
- Interfaccia parser per-formato (`TraceFormatParser`) così un formato
  futuro = nuova implementazione, senza toccare il worker.

**Storage e retention:**
- File in `/data/attachments/enrichment/<jobId>/` (volume `attachments_data`
  esistente).
- Nuova chiave settings `enrichment.retentionDays` (default 30) in
  `settings.registry.ts`, configurabile da UI Impostazioni.
- Cleanup: cron che elimina job (record + file) più vecchi della retention;
  eliminazione manuale dalla dashboard; eliminazione automatica dei file
  quando il job diventa campagna (il record resta con `campaignId` per
  storico).

**Endpoint (`admin/enrichment/*`):**
- `POST .../upload/init|chunk|complete` — upload chunked + creazione job.
- `GET .../jobs` / `GET .../jobs/:id` — lista e dettaglio (stato, progresso,
  warnings per riga).
- `GET .../jobs/:id/download/csv` e `.../download/zip` — risultati.
- `DELETE .../jobs/:id` — eliminazione manuale.
- `POST .../jobs/:id/create-campaign` — vedi sotto.
- Errori "previsti" (ZIP malformato, rubrica assente, formato non
  riconosciuto): SEMPRE `200 { blocked: true, message }` — mai eccezioni
  non-2xx leggibili solo come pagina HTML del proxy.

### 3. CSV output (formato wizard ComunicaPA)

Colonne v1 (fisse, definite in un **descrittore per-formato** così la
personalizzazione futura non richiede di rifare il core):
- `codice_fiscale`, `nominativo` (nome completo/ragione sociale), `tipo`
  (PF/PG), `pec`, `indirizzo`, `cap`, `comune`, `provincia`, `stato_estero`,
  `allegato` (nome file PDF),
- colonne extra placeholder-ready (usabili come `%%chiave%%` nei template):
  `numero_avviso`, `importo`, `scadenza`, `numero_provvedimento`,
  `data_emissione`, `oggetto`.
- Encoding UTF-8, delimitatore compatibile con l'import wizard esistente.
- Sanitizzazione accenti NON applicata di default (era requisito SEND del
  vecchio target, non del wizard) — i dati passano com'estratti.

### 4. Frontend admin — nuova view dashboard

- Nuova voce menu → view `enrichment` in `App.tsx`.
- Lista job: stato, barra progresso (`processedRecords/totalRecords`),
  conteggio warning, data, azioni (dettaglio, download, elimina).
- Upload: form ZIP + selezione formato tracciato (v1: solo Maggioli) →
  chunked upload → job avviato → si resta/riparte dalla lista con polling
  dello stato (pattern polling esistente).
- Dettaglio job: warnings riga per riga, download CSV/ZIP, "Crea bozza
  campagna", elimina.
- NIENTE `<form>` annidate se la view finisce dentro pagine con form esterna
  (gotcha noto) — la view è standalone, ma i pannelli interni usano
  `<div>` + `onClick`.

### 5. "Crea bozza campagna"

Vincolo CLAUDE.md: la creazione/import destinatari passa SOLO dal wizard
(unico punto con le validazioni corrette). Quindi il bottone NON crea un
importer parallelo: crea una bozza e instrada l'operatore nel wizard, dove
il CSV arricchito viene importato **attraverso lo stesso percorso di
validazione dell'upload wizard esistente** (riuso interno dell'endpoint di
import recipients, nessuna logica duplicata). Gli allegati del job vengono
resi disponibili al wizard senza re-upload manuale. Al completamento della
creazione campagna, i file del job di arricchimento vengono eliminati e il
record marcato con `campaignId`.

Dettaglio del riuso esatto (quale endpoint/flusso wizard invocare e come
pre-collegare gli allegati) da definire nel piano di implementazione,
leggendo il codice reale del wizard — non assumere dallo spec.

## Test

- Parser Maggioli TS: unit test con fixture sintetiche (entrambi i formati,
  righe corte, encoding latin-1, apostrofi).
- Worker: spec con HTTP extractor mockato (successo, PDF mancante, warning).
- Service/controller: spec per stati, retention, `200 {blocked:true}`.
- Servizio Python: test pytest su `/extract` con PDF sintetici (indirizzo
  nei 3 template, QR PagoPA generato ad hoc, PDF senza dati).
- Suite completa backend a fine lavoro (`jest --maxWorkers=2`) — baseline:
  solo il fallimento noto `app.controller.spec.ts`.

## Fuori scope v1

- Mapping dinamico colonne di un tracciato arbitrario (solo Maggioli).
- Personalizzazione colonne output da UI (il descrittore per-formato è il
  punto di estensione predisposto).
- Template PDF oltre ai 3 noti.
- Conversione verso il tracciato 80 campi EasyNotification (non serve:
  l'invio SEND lo fa già ComunicaPA nativamente).
