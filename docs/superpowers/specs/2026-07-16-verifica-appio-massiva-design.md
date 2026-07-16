# Verifica App IO massiva da CSV

## Contesto

Esiste già la pagina "Verifica App IO" (frontend-admin, `view === 'verifica-appio'`)
che verifica un singolo codice fiscale via `POST admin/io-services/verify-profile`
(`IoServicesService.verifyProfile`), chiamando `GET /api/v1/profiles/{cf}` su App IO
(PagoPA) con l'API key del servizio App IO predefinito.

Serve estenderla per verificare in massa un elenco di CF caricato via CSV, producendo
due CSV in output (stesse colonne dell'originale): destinatari con App IO attivo e
messaggi abilitati da questo servizio ("presenti"), e tutti gli altri ("assenti").

Scala attesa: migliaia+ di righe per upload. Una richiesta HTTP sincrona che processi
tutte le righe non è percorribile (proxy esterno di produzione ha limite ~1MB body e
sostituisce il body delle risposte non-2xx, e comunque una richiesta bulk che itera
migliaia di chiamate esterne sequenziali rischia timeout indipendentemente dal body
size — vedi gotcha "Reverse proxy esterno in produzione" in CLAUDE.md). Serve quindi
un job asincrono con polling, non una singola richiesta bloccante.

## Scope

- Un unico servizio App IO va selezionato esplicitamente per la verifica massiva
  (non necessariamente il predefinito): `sender_allowed` è per-servizio, quindi
  verificare col servizio sbagliato invaliderebbe il risultato rispetto a una
  campagna reale che userà un servizio specifico.
- Split presenti/assenti: **presente** solo se `active === true` **e**
  `sender_allowed === true` (il cittadino può davvero ricevere un invio da quel
  servizio). Tutto il resto — non iscritto, non attivo sul canale, iscritto ma con
  messaggi disabilitati per questo servizio, CF vuoto/malformato — va in
  **assenti**. Motivazione: lo scopo è distinguere chi è raggiungibile per un
  successivo invio reale sull'app, non la sola iscrizione ad App IO.
- I due CSV di output mantengono esattamente le stesse colonne del CSV originale
  caricato (nessuna colonna aggiuntiva tipo "esito"/"messaggio").
- Errore di sistema durante il job (es. nessun servizio App IO configurato,
  errore di connessione persistente) marca l'intero job FAILED con un messaggio,
  non produce CSV parziali scaricabili.
- Fuori scope: retry automatico di righe singole fallite, notifica email a fine
  job, storicizzazione/list a più jobs (la UI mostra solo il job corrente della
  sessione), rate-limiting configurabile (concorrenza fissa in codice).

## Architettura

### Backend

**Nuova entity `AppIoVerificationJob`** (`apps/backend/src/entities/`):

| campo | tipo | note |
|---|---|---|
| id | uuid | PK |
| status | enum | `QUEUED`, `PROCESSING`, `DONE`, `FAILED` |
| totalRows | int | righe dati (esclusa eventuale intestazione) |
| processedRows | int | aggiornato periodicamente durante il job |
| presentCount | int | valorizzato a fine job |
| absentCount | int | valorizzato a fine job |
| sourceCsv | text | contenuto raw del CSV caricato |
| csvHeaders | jsonb | intestazioni rilevate (o generate se `hasHeaders=false`) |
| cfColumn | text | nome colonna scelta per il CF |
| hasHeaders | boolean | |
| ioServiceId | uuid | FK verso `IoServiceConfig`, servizio usato per la verifica |
| resultPresentCsv | text | CSV risultato "presenti", valorizzato a DONE |
| resultAbsentCsv | text | CSV risultato "assenti", valorizzato a DONE |
| errorMessage | text nullable | valorizzato solo su FAILED |
| createdAt | timestamptz | |
| completedAt | timestamptz nullable | |

Migration generata con la procedura standard del progetto (DB temporaneo).

**Nuova coda BullMQ `APP_IO_VERIFY_BULK`** (pattern coerente con
`queue.module.ts`/`channel-processors.ts`), **un solo job BullMQ per upload**
(non un job per riga — a differenza del pattern jobId=attemptId delle campagne,
qui non c'è un `NotificationAttempt` per riga da tracciare singolarmente, è una
verifica non un invio). `jobId` BullMQ = `AppIoVerificationJob.id`, stesso
pattern di lookup diretto usato altrove.

Processor:
1. Carica `AppIoVerificationJob`, status → `PROCESSING`.
2. Parsa `sourceCsv` con parser CSV riscritto lato backend (stessa logica del
   parser custom frontend: separatore `,`/`;`, gestione quoting) — non introdurre
   una libreria nuova per non duplicare due implementazioni CSV diverse nel repo.
3. Itera le righe con concorrenza limitata (5 richieste parallele fisse in codice)
   chiamando `IoServicesService.verifyProfile(cf, ioServiceId)`.
4. Riga con CF vuoto/formato non plausibile (lunghezza ≠ 16) → assente diretto,
   nessuna chiamata a PagoPA sprecata.
5. Aggiorna `processedRows` sul DB ogni 25 righe processate (non ad ogni riga,
   per non martellare il DB su CSV da migliaia di righe).
6. A fine iterazione costruisce i due CSV output (stessa intestazione/ordine
   colonne del CSV sorgente) e li scrive su `resultPresentCsv`/`resultAbsentCsv`,
   status → `DONE`, `completedAt` valorizzato.
7. Errore non recuperabile (es. `resolveApiKey` restituisce null per il servizio
   scelto) → status `FAILED`, `errorMessage` valorizzato, job BullMQ NON rilanciato
   in retry (nessun senso ritentare un'intera verifica bulk automaticamente).

**`IoServicesService.verifyProfile`** estesa con secondo parametro opzionale
`ioServiceId?: string`, passato a `resolveApiKey(ioServiceId)` (già supporta un id
esplicito). Comportamento invariato per il chiamante esistente (verifica singola)
che continua a non passarlo (usa il servizio predefinito).

**Endpoint REST** (`admin/io-services/verify-bulk`, stesso controller
`IoServicesController`, `@Roles('user','admin')` come `verify-profile`):

- `POST admin/io-services/verify-bulk`
  body: `{ csvContent: string, hasHeaders: boolean, cfColumn: string, ioServiceId: string }`
  → valida `ioServiceId` esiste, valida `cfColumn` presente tra le colonne rilevate
  dal CSV lato server (riparsing header), crea `AppIoVerificationJob` (QUEUED),
  enqueue, risposta 200 `{ jobId }`. Nessuna eccezione non-2xx per errori di
  validazione previsti (CF column mancante, csv vuoto) — pattern
  `{ blocked: true, message }` coerente col gotcha proxy.

- `GET admin/io-services/verify-bulk/:id`
  → `{ status, totalRows, processedRows, presentCount, absentCount, errorMessage }`.

- `GET admin/io-services/verify-bulk/:id/present.csv`
  `GET admin/io-services/verify-bulk/:id/absent.csv`
  → solo se `status === 'DONE'`, altrimenti 404/blocked. Header
  `Content-Type: text/csv`, `Content-Disposition: attachment`.

### Frontend

Pagina esistente `verifica-appio` diventa a due tab: **Singola** (contenuto
attuale, invariato) e **Massiva CSV** (nuovo). Stato UI nuovo, isolato con
prefisso `verificaBulk*` per non toccare stato esistente (`verificaCf`,
`verificaResult`, ecc. restano come sono).

Tab "Massiva CSV":
1. Dropdown selezione servizio App IO (riusa `ioServices` già caricato in
   `App.tsx`, stesso elenco usato altrove — es. wizard invio massivo).
2. Upload file CSV → parsing locale (nuova funzione minimale ispirata a
   `parseCsvLine`/`parseCsvFile` esistenti, MA senza gli side-effect del wizard
   — solo per popolare header/preview, non tocca `wizCsvHeaders`/`wizCsvRows`)
   → dropdown "Colonna Codice Fiscale" con le intestazioni rilevate, toggle
   "Il file ha intestazione" come nel wizard.
3. Bottone "Avvia verifica" → `POST verify-bulk` con l'intero `csvContent`
   (letto via `FileReader.readAsText`, stesso pattern già usato altrove nel
   file) → salva `jobId`, passa a stato "in corso".
4. Poll `GET verify-bulk/:id` ogni 2s (interval, ripulito su unmount/nuovo job)
   → progress bar `processedRows/totalRows`.
5. Su `DONE`: mostra contatori presenti/assenti, due bottoni download che
   fanno `fetch` + blob + `<a download>` (stesso pattern già usato per
   `export-postal-report-*.csv` in `App.tsx` riga ~2829).
6. Su `FAILED`: box errore con `errorMessage`, bottone "Riprova" che resetta lo
   stato per un nuovo upload.

## Errori / edge case

- CSV senza righe dati (solo intestazione o vuoto) → blocked lato server prima
  di creare il job.
- Colonna CF selezionata non trovata tra le intestazioni (mismatch se l'utente
  ricarica un file diverso dopo aver scelto la colonna) → blocked.
- CF con lunghezza ≠ 16 caratteri dopo trim/uppercase → assente diretto, non
  chiamata a PagoPA (evita spreco quota API e falsi errori di rete in log).
- Servizio App IO eliminato tra l'avvio del job e la sua esecuzione (race rara,
  operatore admin) → `resolveApiKey` torna null → job FAILED con messaggio
  esplicito.
- Chiusura/refresh pagina durante polling → il job continua lato server
  (BullMQ), ma la UI perde il riferimento al `jobId` (fuori scope conservarlo
  oltre la sessione corrente, coerente con "no storicizzazione job").

## Testing

- Backend: unit test `IoServicesService` per split presente/assente (i 4 casi:
  attivo+consentito, attivo+non consentito, non attivo, CF malformato) e per
  `resolveApiKey` con `ioServiceId` esplicito passato correttamente.
- Backend: unit test parser CSV backend (separatore `,`/`;`, quoting, mismatch
  colonne) — stessi casi coperti dal parser frontend esistente.
- Backend: test controller per i path `blocked` (colonna CF mancante, CSV
  vuoto, job non DONE su download).
- Manuale (via `run`/browser): upload CSV reale con mix di CF validi/invalidi/
  malformati, verifica progress bar avanza, verifica contenuto dei due CSV
  scaricati (stesse colonne, split corretto).
