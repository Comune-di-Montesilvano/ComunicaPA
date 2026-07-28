# Arricchimento Tracciati — checkpoint/resume + correzione manuale indirizzo

Data: 2026-07-28

## Contesto

`EnrichmentProcessor` (`apps/backend/src/enrichment/enrichment.processor.ts`) elabora un job
in un unico `process()` sincrono, in memoria, dalla riga 0 alla fine. Se il backend viene
riavviato a metà job:

- il processo Node muore senza mai raggiungere il blocco `catch`;
- il record `EnrichmentJob` resta bloccato in `PROCESSING` per sempre (nessun demone lo
  marca `FAILED` dopo il fatto);
- BullMQ non ha `attempts` configurato (default `1`) — nessun retry automatico;
- anche in caso di retry, `process()` non ha modo di riprendere da dove si era fermato —
  rilancerebbe l'intero job da riga 0, ripetendo tutte le chiamate al microservizio
  `pdf-extractor` già fatte.

Inoltre, righe con warning tipo "Indirizzo non estratto: Pattern 'Residente in:' non
trovato" (fallimento parsing PDF) oggi non hanno alcuna via di correzione — l'unico
percorso è ricaricare l'intero ZIP con un PDF diverso/corretto.

Questo spec introduce due feature correlate:

1. **Checkpoint/resume**: salvataggio periodico dello stato di elaborazione su disco,
   ripresa automatica al riavvio invece di restare bloccati o ripartire da zero.
2. **Correzione manuale indirizzo**: form per sovrascrivere l'indirizzo di una riga
   quando l'estrazione PDF fallisce, con prefill opzionale da ANPR.

## Feature 1 — Checkpoint / Resume

### Storage

Nuovo file per job, stesso pattern di `enrichment-paths.ts` (dove vivono già ZIP
sorgente e CSV risultato): `getEnrichmentCheckpoint(jobId)` → `checkpoint.json`.

Contenuto:

```json
{
  "lastRow": 300,
  "rows": [ /* EnrichedRow[] già costruite, righe 1..300 */ ],
  "warnings": [ /* EnrichmentWarning[] accumulati fino a riga 300 */ ],
  "maxRate": 4
}
```

Scrittura **atomica**: `fs.writeFileSync` su `checkpoint.json.tmp` poi `fs.renameSync` a
`checkpoint.json` — mai scrittura diretta sul file finale (stesso rischio flush/troncamento
già noto per `assembleChunkedUpload`, un crash a metà `writeFileSync` non deve produrre un
JSON illeggibile).

### Cadenza

Ogni 100 righe elaborate (`CHECKPOINT_EVERY = 100`), separato dall'update DB esistente ogni
10 righe (`PROGRESS_UPDATE_EVERY`, resta invariato — serve solo per la barra di progresso
UI, non garantisce persistenza).

Ad ogni checkpoint:
1. Applica gli override indirizzo esistenti (Feature 2) alle righe fino a `lastRow`.
2. Scrive `checkpoint.json` (atomico, come sopra).
3. Aggiorna `EnrichmentJob.checkpointRow = lastRow` (nuova colonna, vedi migration sotto) —
   distinto da `processedRecords` (che avanza ogni 10 righe ma non implica persistenza su
   checkpoint.json).

### Resume

All'inizio di `process()`:
- se `checkpoint.json` esiste ed è parsabile: legge `lastRow`/`rows`/`warnings`/`maxRate`,
  il loop principale salta i record `0..lastRow-1` (nessuna chiamata `extractor.extract`
  per righe già elaborate), riparte accumulando da `lastRow`.
- se `checkpoint.json` esiste ma è illeggibile/corrotto (JSON parse fallisce): log warning,
  trattato come "nessun checkpoint" — vedi comportamento boot sotto.
- se non esiste: comportamento attuale, parte da riga 0.

A completamento (stato terminale `DONE` o `FAILED`): cancella `checkpoint.json` (cleanup,
niente accumulo su disco per job conclusi).

### Rilevamento a boot

`EnrichmentModule` (`onModuleInit`, o nuovo provider dedicato):
- query `EnrichmentJob` con `status = PROCESSING`;
- per ciascuno, se `checkpoint.json` esiste e parsa correttamente → re-enqueue BullMQ
  (`queue.add('enrich', { jobId }, { jobId })`, stesso pattern già usato in
  `enrichment.service.ts`) — il job riprende da checkpoint;
- se `checkpoint.json` assente o corrotto → marca il job `FAILED` con
  `errorMessage: 'Interrotto da riavvio, nessun checkpoint disponibile'`. Nessun retry
  automatico da riga 0: evita un retry-loop infinito se il crash è causato dal job stesso
  (stesso principio già in uso per gli altri motori — stato terminale esplicito, mai un
  record bloccato in stato intermedio).

### Migration

Nuova colonna `EnrichmentJob.checkpointRow` (integer, nullable, default `0`) — generata con
DB temporaneo come da procedura standard di questo repo (sezione "Migration DB" in
`CLAUDE.md`).

## Feature 2 — Correzione manuale indirizzo

### Chiave override

**Nome file PDF** (`allegato` in `EnrichedRow`, univoco per riga dentro il job) — non
numero riga (fragile a eventuali riordini futuri) né CF (un job può in teoria avere righe
con lo stesso CF, es. più provvedimenti per la stessa persona).

### Storage

Nuova entity `EnrichmentAddressOverride`:

| campo | tipo | note |
|---|---|---|
| `id` | uuid | PK |
| `jobId` | uuid | FK logico a `EnrichmentJob.id` |
| `pdfFilename` | varchar | chiave riga dentro il job |
| `indirizzo` / `cap` / `comune` / `provincia` / `statoEstero` | varchar nullable | come `EnrichedRow` |
| `correctedBy` | varchar | username operatore |
| `correctedAt` | timestamp | |

Upsert su `(jobId, pdfFilename)` — una correzione successiva sulla stessa riga sovrascrive
la precedente.

### Endpoint

- `GET admin/enrichment/jobs/:id/rows/:pdfFilename` — ritorna CF, dati indirizzo correnti
  della riga (dal checkpoint se job in corso, dal CSV risultato se `DONE`), warning
  associato, override esistente se presente.
- `PUT admin/enrichment/jobs/:id/rows/:pdfFilename/address` — salva override. Valida che
  `pdfFilename` esista tra i record del job (altrimenti `BadRequestException`).
- `POST admin/enrichment/jobs/:id/regenerate-csv` — solo per job `DONE`: rilegge il CSV
  risultato esistente, ripatcha le righe con override presente, riscrive il file.
  `BadRequestException` se il job non è `DONE`.

### "Carica da ANPR"

Il form richiama l'endpoint **già esistente** `POST admin/domicilio/cerca` (CF della riga)
— nessun nuovo endpoint ANPR. Estrae solo i campi indirizzo di residenza dalla risposta per
precompilare il form; l'operatore può editare prima di salvare (mai applicato
automaticamente — stesso principio "solo su azione operatore esplicita" già in uso per la
correzione indirizzo POSTAL). Audit log già gestito dall'endpoint esistente
(`DOMICILIO_SEARCH`), nessuna duplicazione necessaria.

### Applicazione dell'override

- **Durante l'elaborazione**: ad ogni checkpoint (100 righe) e alla scrittura finale del
  CSV, il processor rilegge `EnrichmentAddressOverride` per `jobId` e patcha
  `indirizzo/cap/comune/provincia/stato_estero` sulle righe con `allegato` corrispondente,
  prima di scrivere checkpoint/CSV.
- **Dopo `DONE`**: bottone "Rigenera CSV" (endpoint sopra) — azione esplicita, mai
  automatica.

### Gate UI — editabile solo su riga già committata

Un override su una riga elaborata ma non ancora scritta su `checkpoint.json` rischia di
essere perso: se il job crasha prima del checkpoint successivo, il resume rielabora quella
riga da PDF (il resume salta solo le righe *prima* dell'ultimo checkpoint), ignorando/
sovrascrivendo l'override appena salvato.

Fix: il bottone "Correggi indirizzo" nella lista warning è abilitato solo se
`warning.row <= job.checkpointRow` (nuovo campo esposto dall'API job detail). Sotto soglia:
bottone disabilitato, tooltip "In attesa di checkpoint (salvataggio ogni 100 righe)". Dopo
`DONE`, `checkpointRow` non è più rilevante — editor sempre abilitato (tutte le righe sono
nel CSV finale).

Nota: il gate è solo lato UI (UX, evita di far credere all'operatore che una correzione sia
al sicuro quando non lo è) — l'endpoint `PUT .../address` stesso non impone il vincolo
lato server, la correzione non è un'operazione distruttiva da bloccare a livello di
sicurezza.

## Error handling — riepilogo

- Scrittura checkpoint fallisce (disco pieno/permessi): log errore, job continua
  comunque — riprova al checkpoint successivo. Se non viene mai scritto nessun checkpoint e
  il job crasha: comportamento di boot standard (marcato `FAILED`, nessun retry automatico).
- Checkpoint corrotto: trattato come assente (vedi Resume/boot sopra).
- `PUT .../address` su `pdfFilename` inesistente nel job: `BadRequestException`.
- `POST .../regenerate-csv` su job non `DONE`: `BadRequestException`.
- Nessun lock tra scrittura override e lettura per checkpoint/CSV: un override salvato a
  metà scrittura si applica semplicemente al checkpoint/regenerate successivo, mai perso
  (persistito in tabella dedicata, non nel file checkpoint/CSV).

## Testing

- Unit `enrichment.processor.spec.ts`: resume da checkpoint salta le righe già fatte
  (`extractor.extract` mockato, verificare invocato solo per righe dopo `lastRow`);
  checkpoint corrotto → job marcato `FAILED` al boot, non crash silenzioso.
- Unit: applicazione override — riga con override presente in tabella viene patchata nel
  CSV/checkpoint, riga senza override resta con dato originale anche se warning presente.
- Unit: `checkpointRow` esposto correttamente via API job detail.
- E2E manuale (Docker): job reale con ZIP >100 record, `docker compose restart backend` a
  metà elaborazione — verificare che riprende da checkpoint, non da riga 0. Correggere un
  indirizzo su riga con warning (via form + "Carica da ANPR"), verificare che il CSV finale
  riflette la correzione.

## Fuori scope (YAGNI)

- Scaling multi-replica del backend (checkpoint/boot-scan assumono singola istanza, stesso
  vincolo già noto per l'SSE bridge dei log live — non affrontato qui).
- Retry automatico da riga 0 se il checkpoint è assente/corrotto al boot — scelta
  deliberata anti retry-loop, non un'omissione.
- Override bulk (correzione di più righe in un colpo) — un solo form per riga, come da
  richiesta.
