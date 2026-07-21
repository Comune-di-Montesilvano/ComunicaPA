# Cerca Domicilio — verifica massiva unificata (DEFERITO — non pianificato)

## Stato

**Bozza di design, non ancora pianificata/implementabile.** Dipende dalla
spec `2026-07-21-cerca-domicilio-anpr-design.md` (verifica puntuale
unificata INAD+App IO+ANPR), che va implementata e verificata contro un
ambiente ANPR reale per prima. In particolare non abbiamo ancora osservato
una risposta reale di ANPR C020 (200 con `listaSoggetti` popolata) — la
forma esatta dei campi indirizzo (`TipoResidenza`/`TipoIndirizzo` nello
yaml è ricca di sotto-campi opzionali: civico, esponente, colore, scala,
interno...) potrebbe richiedere aggiustamenti alle colonne CSV proposte qui
una volta vista una risposta vera. Questo documento va rivisto quando quel
dato sarà disponibile, prima di scrivere il piano implementativo.

## Obiettivo

Estendere "Cerca Domicilio" (verifica puntuale già unificata) a una
verifica massiva da CSV: stesso principio, tutti i canali abilitati
interrogati insieme per ogni CF del file, un unico CSV di output con
colonne aggiuntive per canale.

Quando questa massiva unificata sarà implementata, sostituisce del tutto le
tab "Verifica massiva CSV" oggi presenti nelle pagine standalone "Verifica
INAD" e "Verifica App IO" (che a quel punto vengono rimosse, insieme al
codice dedicato — vedi sezione "Cleanup" più sotto). Fino ad allora quelle
due tab restano invariate e pienamente funzionanti.

## Vincolo principale

INAD `/extract` (singola per-CF) ha una quota giornaliera condivisa con il
resto del sistema (1000-2000 richieste/die, non documentata nello spec ma
nota da verifica diretta — vedi CLAUDE.md sezione INAD). Chiamarla in loop
per-riga su un CSV grande la esaurirebbe rapidamente. Va quindi riusata
l'API bulk nativa INAD (`/listDigitalAddress`, batch 1000, come fa già
`InadVerifyBulkService` oggi), mentre App IO e ANPR (chiamate sync per-CF,
nessuna quota nota) vanno in loop BullMQ per-riga come già fa
`AppIoVerifyBulkProcessor`. Il job risultante è quindi ibrido: due
sotto-processi asincroni indipendenti che convergono in un risultato
finale — più complesso di un singolo job lineare.

## Design proposto (da rivedere con dati ANPR reali)

Nuova entity `DomicilioVerificationJob`:

```ts
status: QUEUED | PROCESSING | DONE | FAILED
totalRows: number
processedRows: number          // avanzamento ramo App IO + ANPR
inadBatches: InadVerificationBatch[]   // riuso tipo esistente da inad-verification-job.entity.ts
inadDone: boolean
inadAddresses: Record<string, string>  // cf -> indirizzi digitali INAD, jsonb
appioAnprDone: boolean
partialResults: Record<string, {
  appIoAttivo: string;
  anprVia: string; anprCivico: string; anprCap: string;
  anprComune: string; anprProvincia: string;
}>  // jsonb — indirizzo ANPR spacchettato in campi, non stringa unica.
    // ATTENZIONE: set di campi da confermare contro una risposta ANPR
    // reale (vedi TipoIndirizzo nello yaml — numero civico, esponente,
    // scala, interno, ecc. potrebbero servire come colonne separate).
sourceCsv: string
csvHeaders: string[]
cfColumn: string
resultCsv: string | null      // CSV unico, non split found/notfound
errorMessage: string | null
completedAt: Date | null
```

Flusso:

1. `DomicilioVerifyBulkService.createJob` — parse CSV, CF univoci validi
   (16 caratteri), submit batch INAD nativo (`inadService.startBulkExtraction`,
   fino a 1000 CF a chiamata) → salva `inadBatches`, poi accoda un job
   BullMQ per il ramo App IO + ANPR.
2. `DomicilioVerifyBulkProcessor` (BullMQ, concurrency 5, pattern identico
   ad `AppIoVerifyBulkProcessor`) — per ogni riga: `verifyProfile(cf)` +
   `anprService.getResidenza(cf, operatorUsername)` in parallelo, esito
   scritto in `partialResults[cf]`. A fine loop: `appioAnprDone = true`,
   poi chiama `tryComplete(jobId)`.
3. `DomicilioVerifyBulkSyncService` (Cron `*/5 * * * *`, pattern identico a
   `InadVerifyBulkSyncService`) — poll dei batch INAD; quando tutti
   `DISPONIBILE`: fetch risultati in `inadAddresses`, `inadDone = true`,
   chiama `tryComplete(jobId)`.
4. `tryComplete(jobId)` — metodo condiviso (chiamato sia dal processor sia
   dal cron): se `inadDone && appioAnprDone`, fa il merge — CSV con colonne
   originali + colonne aggiuntive per canale (vedi sotto) — e marca
   `status = DONE`. Se una delle due condizioni non è ancora vera, non fa
   nulla (l'altro ramo, quando finisce, richiamerà `tryComplete`).

Colonne aggiuntive nel CSV risultato (oltre a quelle originali del file
caricato): `domicilio_digitale_inad`, `app_io_attivo` (si/no/errore),
`anpr_via`, `anpr_civico`, `anpr_cap`, `anpr_comune`, `anpr_provincia`
(indirizzo ANPR spacchettato campo per campo, non una stringa unica
formattata — riusabile direttamente come sorgente per un futuro
import/mail-merge). Valori vuoti quando il canale non ha trovato nulla;
`errore: <msg>` nella colonna del canale se quella singola interrogazione è
fallita (non blocca le altre colonne della stessa riga).

UI: dentro "Cerca Domicilio" → tab "Verifica massiva CSV", stesso layout
upload/poll/download della tab INAD massiva odierna, un solo bottone
"Scarica CSV risultato" (nessuno split trovati/non trovati: ogni riga ha
sempre tutte le colonne di esito, qualunque sia il risultato).

## Cleanup — rimozione stack standalone INAD/App IO (da fare insieme a questa fase)

Quando questa massiva unificata viene implementata, lo stack dedicato
preesistente va eliminato, non lasciato dormiente:

**Backend — da rimuovere:**
- `InadVerifyController` (rotte `admin/inad-verify/*`, incluso
  `verify-single` già spostato sulla puntuale unificata)
- `InadVerifyBulkService`, `InadVerifyBulkSyncService`
- Entity `InadVerificationJob` (+ migration che droppa la tabella
  `inad_verification_job`)
- `IoServicesController`: rotte `verify-profile` e `verify-bulk/*` (il
  resto del controller — CRUD servizi App IO, `test`, `setDefault` —
  resta, serve ancora per la gestione da Impostazioni)
- `AppIoVerifyBulkService`, `AppIoVerifyBulkProcessor`, coda
  `APP_IO_VERIFY_BULK_QUEUE`
- Entity `AppIoVerificationJob` (+ migration che droppa la tabella
  `app_io_verification_job`)

**Frontend — da rimuovere:** le tab "Verifica massiva CSV" (e tutto lo
state associato) dalle view `verifica-inad`/`verifica-appio` — a quel punto
quelle due view non hanno più contenuto e vengono rimosse interamente dal
menu.

Nota: `InadService`/`IoServicesService` (le classi client, non i
controller/entity di bulk-verifica) restano invariate — già usate altrove
(es. `InadCheckSyncService` per il check automatico sulle campagne,
`IoServicesService` per l'invio App IO reale) e continuano a essere
richiamate anche da `DomicilioService`/`DomicilioVerifyBulkProcessor`.

## Testing (quando implementata)

- Unit test `DomicilioVerifyBulkService.tryComplete`: merge scatta solo a
  entrambi i flag true, non prima; CSV risultato ha le colonne attese.
- Unit test `DomicilioVerifyBulkProcessor`: un errore per singola riga
  (App IO o ANPR) non interrompe il loop né fa fallire l'intero job.
- Verifica manuale in collaudo con CSV reale prima del rilascio (stesso
  approccio già usato per SEND/INAD).
