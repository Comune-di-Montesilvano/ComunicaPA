# Verifica Domicili Digitali unificata — design

Data: 2026-09-22

## Problema

Esistono oggi due pannelli separati per verificare massivamente i domicili
digitali di un elenco di codici fiscali/partite IVA:

- **"Verifica App IO massiva"** (`admin/io-services/verify-bulk/*`,
  `AppIoVerificationJob`) — un job BullMQ unico che processa l'intero CSV
  internamente (concorrenza 5), scrive risultato a fine job.
- **"Verifica INAD massiva"** (`admin/inad-verify/verify-bulk/*`,
  `InadVerificationJob`) — batch INAD (`/listDigitalAddress`, max 1000 CF)
  + verifica Registro Imprese ma **solo per le righe già in formato Partita
  IVA (11 cifre)** — un codice fiscale persona fisica (16 caratteri) che
  INAD non trova resta "non trovato" per sempre, anche se in realtà è una
  ditta individuale con CF=PIVA cercabile su Registro Imprese.

Problemi riportati:

1. Molti CF risultano "senza domicilio" su INAD, ma non viene mai tentato
   Registro Imprese come fallback per quei CF fisici.
2. Il `jobId` del job in corso vive solo in stato React del frontend — un
   refresh/abbandono pagina lo fa perdere, anche se il job lato server
   (DB) sopravvive e completa regolarmente. Nessuno storico per ritrovarlo.
3. Tre verifiche (App IO, INAD, Registro Imprese) vanno lanciate a mano
   separatamente, con tre CSV di input/output scollegati — nessuna vista
   aggregata "qual è il domicilio digitale reale, con quale priorità".

## Obiettivo

Un solo pannello **"Verifica Domicili Digitali"** che:

- Accetta un CSV, classifica ogni riga (CF fisico 16 char / PIVA-CF
  giuridico 11 cifre, `tax-id.util.ts`, nessun nuovo codice di
  classificazione)
- Verifica CF fisici su **INAD + App IO** (in parallelo)
- Verifica su **Registro Imprese**: tutte le PIVA/CF giuridici da subito,
  più — come fallback residuo — i CF fisici che INAD non ha trovato
- Resta in coda come un job persistente (stesso pattern di Arricchimento
  Tracciati), sopravvive al refresh/abbandono pagina, **eliminato
  automaticamente dopo 7 giorni** (retention configurabile)
- Mostra uno storico degli ultimi job nel pannello, per ritrovarne uno
  anche a distanza di giorni
- Produce 5 CSV scaricabili a fine job

Sostituisce del tutto i due pannelli esistenti (nessun altro modulo del
backend dipende da `AppIoVerificationJob`/`InadVerificationJob` — verificato
con grep, unico consumer è il proprio modulo).

## Impatto su Registro Imprese: SOLO fallback, mai su tutte le righe

Per i CF fisici, Registro Imprese viene interrogato **solo per quelli che
INAD non ha trovato** (non su ogni riga) — decisione esplicita
dell'operatore per limitare il carico su PDND. Le PIVA/CF giuridici vanno
sempre e comunque a Registro Imprese (comportamento già esistente, invariato).

## Entità: `DomicileVerificationJob`

Tabella `domicile_verification_jobs`, sostituisce `inad_verification_jobs`
e `app_io_verification_jobs` (entrambe droppate nella stessa migration).

```ts
export enum DomicileVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export interface InadBatchRef { id: string; size: number; done: boolean }

@Entity('domicile_verification_jobs')
export class DomicileVerificationJob {
  id: string; // uuid
  status: DomicileVerificationJobStatus;
  totalRows: number;

  sourceCsv: string;       // text
  csvHeaders: string[];    // jsonb
  cfColumn: string;
  hasHeaders: boolean;

  ioServiceId: string;     // servizio App IO scelto dall'operatore, sempre richiesto

  cfFisicoTotal: number;   // righe 16 char
  pivaTotal: number;       // righe 11 cifre

  // --- INAD (solo CF fisici) ---
  inadBatches: InadBatchRef[];        // jsonb, un elemento per chiamata /listDigitalAddress (max 1000 CF)
  inadFoundMap: Record<string, string>; // jsonb {cf: domicilio_digitale}, scritto UNA VOLTA a batch tutti pronti

  // --- App IO (solo CF fisici) ---
  // Scritto da un SOLO job BullMQ (l'intero CSV in un job, come oggi) —
  // niente race, niente UPDATE-concat necessario, un update finale basta.
  appIoProcessedRows: number;   // per la progress bar, aggiornato ogni 25 righe come oggi
  appIoPresentCount: number;
  appIoAbsentCount: number;
  appIoResults: Record<string, boolean>; // jsonb {cf: presente}, scritto in un colpo solo a fine job App IO

  // --- Registro Imprese (PIVA subito + CF fisici non-trovati-INAD dopo fase INAD) ---
  registroImpreseTotal: number;
  registroImpreseDone: number;
  registroImpreseFoundCount: number;
  // jsonb {identificativo: pec|null}, scritto con UPDATE ... jsonb concat
  // (mai read-modify-write) — stesso pattern già in uso oggi per piva_results,
  // necessario perché più job PIVA paralleli scrivono sulla stessa riga.
  registroImpreseResults: Record<string, string | null>;
  residualEnqueued: boolean; // true dopo che il fallback CF-fisici-non-trovati è stato accodato (una sola volta)

  resultAssentiCsv: string | null;
  resultAppIoCsv: string | null;
  resultInadCsv: string | null;
  resultRegistroImpreseCsv: string | null;
  resultAggregatoCsv: string | null;

  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
```

## Orchestrazione

### Creazione job — `DomicileVerificationService.createJob()`

1. Parse CSV (`parseCsvContent`, riuso), blocca (200 + `{blocked:true}`,
   pattern proxy esterno) se zero righe o colonna CF non trovata.
2. Classifica ogni riga: CF fisico (16 char) / PIVA (11 cifre) — righe che
   non combaciano nessuno dei due formati vengono ignorate su tutte e tre
   le verifiche e finiscono comunque nel tracciato "assenti" e
   "aggregato" (nessun controllo applicabile).
3. Se ci sono CF fisici:
   - Accoda **un solo job App IO** sulla coda esistente `app-io-verify-bulk`
     (stesso `AppIoVerifyBulkProcessor`, ripuntato su `DomicileVerificationJob`
     invece di `AppIoVerificationJob` — vedi sotto). Il job itera **tutto**
     il CSV sorgente come già fa oggi (`parsed.rows`, non filtrato ai soli
     CF fisici — righe PIVA/non valide restano semplicemente "assenti"),
     quindi `appIoProcessedRows` arriva a `totalRows`, non a `cfFisicoTotal`.
   - Accoda batch INAD da 1000 CF (`InadService.startBulkExtraction`, riuso
     identico alla logica attuale di `InadVerifyBulkService.createJob`,
     stesso try/catch per-batch — un fallimento isolato non annulla il job)
4. Se ci sono PIVA: accoda subito Registro Imprese per ciascuna
   (`RegistroImpreseVerifyQueueService.enqueueVerify`, invariato)
5. Salva `PROCESSING`. Se **tutti** i tentativi di enqueue sono falliti
   (stesso controllo `totalAttempts>0 && succeededAttempts===0` di oggi) →
   `FAILED` immediato con l'errore.

### Sync — `DomicileVerificationSyncService` (cron `*/5 * * * *`)

Per ogni job `PROCESSING`:

1. **INAD**: polla i batch non ancora `done` (`InadService.getBulkState`).
   Quando tutti `DISPONIBILE`: fetch (`getBulkResult`) una volta sola,
   popola `inadFoundMap` (found = `digitalAddress` non vuoto — nessun'altra
   condizione, "found" vuol dire indirizzo non nullo/non vuoto).
2. Quando INAD è completo (tutti i batch `done`, o zero batch se non
   c'erano CF fisici) **e** `!residualEnqueued`: calcola i CF fisici assenti
   da `inadFoundMap`, li accoda su Registro Imprese
   (`enqueueVerify`, stesso identificativo CF come chiave in
   `registroImpreseResults`), imposta `registroImpreseTotal += residuo.length`,
   `residualEnqueued = true`. Se zero CF fisici mai controllabili (job solo
   PIVA), questo passo è no-op ma il flag va comunque a `true` per non
   ribloccare il gate finale.
3. Gate di completamento: `INAD completo && appIoDone (appIoProcessedRows
   >= totalRows, oppure vero a priori se zero CF fisici e nessun job App IO
   accodato) && residualEnqueued && registroImpreseDone >=
   registroImpreseTotal` → costruzione dei 5 CSV (vedi sotto), `DONE`.
4. Stale >24h in `PROCESSING` → `FAILED` esplicito (stesso fallback già in
   uso su `InadVerifyBulkSyncService`, messaggio con lo stato di ogni fase).

### App IO — riuso del processor esistente, ripuntato

`AppIoVerifyBulkProcessor` resta quasi identico: stesso loop a
concorrenza 5 sull'intero CSV del job, stesso `isPresentResult()`. Unica
differenza — invece di scrivere `status: DONE` sull'intera riga (che oggi
rappresenta l'intero job), scrive solo i campi App IO-specifici
(`appIoProcessedRows`, `appIoPresentCount`, `appIoAbsentCount`,
`appIoResults`) su `DomicileVerificationJob` — lo stato complessivo del job
lo decide solo `DomicileVerificationSyncService` (gate sopra). Repository
iniettato cambia da `AppIoVerificationJob` a `DomicileVerificationJob`,
logica di verifica (`ioServices.verifyProfile`) invariata.

### Registro Imprese — processor generalizzato

`RegistroImpreseVerifyProcessor.processAdHocVerify()` cambia solo la query
raw: da

```sql
UPDATE inad_verification_jobs SET piva_results = ..., piva_done = piva_done + 1, piva_found_count = ...
```

a

```sql
UPDATE domicile_verification_jobs SET registro_imprese_results = ..., registro_imprese_done = registro_imprese_done + 1, registro_imprese_found_count = ...
```

Nessun'altra modifica: stesso rate limiter 5/sec, stesso retry/backoff,
stesso `onFailed` per l'esaurimento tentativi. Il branch
`processCampaignVerify` (usato dal flusso separato di lancio campagna,
`VERIFY_PIVA_CAMPAIGN_JOB_NAME`) resta **invariato**, non tocca questa
tabella.

## Costruzione dei 5 CSV (a completamento)

Ogni riga del CSV sorgente viene riclassificata:

- **CF fisico**: `inadDomicilio = inadFoundMap[cf]` (o assente),
  `appIoAttivo = appIoResults[cf]` (o assente/non verificato se il CF non
  era valido), `registroImpresePec = registroImpreseResults[cf]` (solo se
  era tra i residui accodati)
- **PIVA**: `registroImpresePec = registroImpreseResults[piva]`. INAD e
  App IO non si applicano (colonne vuote/"n.d." nell'aggregato).

CSV prodotti:

| File | Condizione emissione | Contenuto |
|---|---|---|
| `assenti.csv` | sempre (anche vuoto) | CF fisico: nessun domicilio INAD **e** App IO non attivo **e** nessuna PEC Registro Imprese. PIVA: nessuna PEC Registro Imprese. |
| `app_io.csv` | solo se `appIoPresentCount > 0` | Righe CF fisico con App IO attivo |
| `inad.csv` | solo se `inadFoundMap` non vuota | Righe CF fisico con domicilio INAD, colonna aggiuntiva `domicilio_digitale_inad` (stesso nome colonna già usato oggi, continuità) |
| `registro_imprese.csv` | solo se almeno una PEC trovata (PIVA dirette + residuo CF fisico) | Righe con PEC trovata, colonna aggiuntiva `pec_registro_imprese` |
| `aggregato.csv` | sempre | **Tutte** le righe originali + 2 colonne: `domicilio_digitale` (priorità 1 Registro Imprese, 2 INAD, vuoto se nessuno) e `app_io` (`attivo`/`non attivo`/`n.d.` per le PIVA) |

`buildCsvContent`/`parseCsvContent` riusati senza modifiche.

## Retention

`DomicileVerificationRetentionService`, stesso pattern di
`EnrichmentRetentionService`: cron giornaliero (`0 4 * * *` — orario
diverso da enrichment 3:30 e da postal-sync per non sovrapporre carico),
elimina job `QUEUED`/`DONE`/`FAILED` più vecchi di
`domicileVerification.retentionDays` (nuova chiave in
`settings.registry.ts`, default **7**, come richiesto). `PROCESSING` mai
toccato. Nessun file su disco da ripulire (tutti i CSV sono colonne
`text`, non file — a differenza di Arricchimento Tracciati).

## Endpoint (`admin/domicile-verification`)

Stesso schema chunked-upload già in uso su `admin/inad-verify` e
`admin/io-services` (`chunked-upload.util.ts`, riuso 1:1):

- `POST verify/upload/init`
- `POST verify/upload/chunk/:uploadId/:index`
- `POST verify/upload/complete/:uploadId` → `{jobId}` o `{blocked, message}`
- `GET jobs` → storico ultimi 50 job (id, status, createdAt, totalRows,
  contatori) per il pannello "storico"
- `GET jobs/:id` → stato/progresso dettagliato (per il polling mentre `PROCESSING`)
- `GET jobs/:id/assenti.csv`
- `GET jobs/:id/app-io.csv`
- `GET jobs/:id/inad.csv`
- `GET jobs/:id/registro-imprese.csv`
- `GET jobs/:id/aggregato.csv`

Ogni download-CSV torna `404` (`NotFoundException`, come oggi) se il job
non è `DONE` o il CSV specifico è `null` (nessun risultato per quella
categoria) — il frontend nasconde il bottone corrispondente controllando i
contatori dello stato, stesso pattern già in uso.

## Frontend (`App.tsx`)

Nuovo pannello **"Verifica Domicili Digitali"** sostituisce le viste
esistenti "Verifica App IO massiva" e "Verifica INAD massiva" (bottoni di
navigazione, stato React, handler — rimossi):

- Upload CSV con selezione colonna CF + checkbox intestazioni (stesso
  componente di upload chunked riusato)
- Selezione servizio App IO (stesso dropdown già presente oggi)
- **Storico job**: tabella con gli ultimi job (`GET jobs`), click su una
  riga per caricarne lo stato/risultati — risolve la perdita del jobId al
  refresh
- Job attivo: polling 5s su `GET jobs/:id` mentre `PROCESSING` (stesso
  pattern polling già in uso altrove), 3 indicatori di progresso (INAD
  batch pronti, App IO righe processate, Registro Imprese done/totale)
- 5 bottoni download, visibili solo quando il rispettivo CSV è disponibile
  (stessa logica "se almeno un risultato" già in uso per i pannelli
  attuali: bottone disabilitato/nascosto se il contatore è zero)

## Rimozioni

- `apps/backend/src/entities/app-io-verification-job.entity.ts`
- `apps/backend/src/entities/inad-verification-job.entity.ts`
- `AppIoVerifyBulkService`, `.controller` (route `admin/io-services/verify-bulk/*`), `.processor` (sostituito, non rimosso — vedi sopra), `app-io-verify-bulk-job.types.ts` (riusato, non rimosso)
- `InadVerifyBulkService`, `InadVerifyBulkSyncService`, route `admin/inad-verify/verify-bulk/*` su `InadVerifyController` (resta `verify-single`, invariato)
- Migration che droppa `inad_verification_jobs` e `app_io_verification_jobs`, crea `domicile_verification_jobs` — registrata in `database.module.ts` (`entities:` + `migrations:`, controllo esplicito richiesto, vedi CLAUDE.md)

## Cosa NON cambia

- Verifica singola INAD/App IO (`verify-single`, un CF alla volta) — invariata
- Flusso INAD/Registro Imprese al **lancio di una campagna massiva**
  (`campaigns.service.ts`, `VERIFY_PIVA_CAMPAIGN_JOB_NAME`,
  `InadCheckSyncService`) — completamente separato, non tocca
  `DomicileVerificationJob`
- Classificazione formato CF/PIVA (`tax-id.util.ts`) — nessuna modifica

## Testing

- Unit: `DomicileVerificationService.createJob` (classificazione righe,
  enqueue per-fonte, blocco su CSV vuoto/colonna assente)
- Unit: `DomicileVerificationSyncService` (gate di completamento con le
  combinazioni: solo CF fisici, solo PIVA, misto, zero righe valide per
  una fonte, stallo >24h)
- Unit: `RegistroImpreseVerifyProcessor` — query raw ripuntata (mock repo,
  verificare il testo SQL/nome tabella)
- Unit: costruzione dei 5 CSV — casi limite (nessun trovato per una fonte
  → file non emesso, riga PIVA con priorità Registro Imprese su INAD non
  applicabile, riga senza CF/PIVA valido finisce in assenti+aggregato)
- E2E manuale (Docker dev): CSV misto CF fisici + PIVA reali contro
  INAD/App IO/Registro Imprese reali (DB dev ha già voucher/credenziali
  funzionanti per questi servizi, verificato in sessioni precedenti)
