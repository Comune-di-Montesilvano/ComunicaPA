# Registro Imprese via PDND — design

Data: 2026-08-11

## Contesto

ComunicaPA interroga oggi ANPR (persone fisiche, C002/C019) e INAD (domicilio
digitale persona fisica) per risolvere il canale di recapito di un
destinatario, sia in ricerca singola (`DomicilioService.cercaDomicilio`) sia
in verifica bulk su CSV campagna (`InadVerifyBulkService`). Nessuno dei due
gestisce una Partita IVA (impresa): ANPR non ha dati per soggetti non fisici,
INAD (bulk) oggi **droppa silenziosamente** le righe a 11 cifre
(`inad-verify-bulk.service.ts`, filtro `cf.length === 16`, nessun log/avviso)
— gap latente pre-esistente.

INIPEC (indice PEC imprese) era la pista precedente per il domicilio digitale
d'impresa — abbandonata: nuova API PDND "PCAD-PDND" (Unioncamere, spec
OpenAPI in `tinn/pdnd/registro imprese/Specifica API.json.json`) copre lo
stesso bisogno risolvendo direttamente dettaglio impresa (incluso presumibile
domicilio digitale) da Registro Imprese. `InipecService` resta scaffold morto,
mai stato un canale registrato — non toccato da questo design.

**Vincolo noto**: l'abilitazione PDND per questa finalità non è ancora attiva
per l'ente al momento di questo design. Nessun test reale eseguibile, nessun
esempio di risposta XML disponibile. Il design copre l'architettura e i punti
di innesto; i dettagli di parsing risposta si completano al primo test reale
(curl manuale) quando l'accesso sarà abilitato.

## API Registro Imprese (PCAD-PDND)

- Spec: `tinn/pdnd/registro imprese/Specifica API.json.json`, OpenAPI 3.0.1.
- Host: collaudo `https://pdndcl.registroimprese.it`, prod
  `https://pdnd.registroimprese.it`.
- Auth: `bearerAuth` (JWT) — voucher PDND **standard**, nessun claim `digest`
  extra (a differenza di ANPR C002/C019, pattern AUDIT_REST_02). Stesso
  `PdndAuthService.getVoucher(env, purposeId)` già usato da INAD/INIPEC.
- Endpoint scelto: `GET /rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=<cf>`
  — un solo round-trip, CF/PIVA 11-16 caratteri. Alternative nello spec
  (`ricerca/*`, `dettaglio/nrea`) richiedono provincia+REA, non pertinenti per
  ricerca-da-PIVA.
- Risposta 200: `application/xml`, schema dichiarato solo `{type: string}` —
  **struttura XML non documentata nello spec**, opaca finché non testata dal
  vivo.
- Errori: 400 richiesta non valida, 401 non abilitato, 429 rate limit
  (header `Retry-After` presente), 500/503 errore server — tutti
  `application/problem+xml`.

## Rilevamento PIVA vs CF persona fisica

Nuovo util condiviso `apps/backend/src/channels/tax-id.util.ts`:

```ts
export function isPartitaIva(value: string): boolean {
  return /^\d{11}$/.test(value.trim());
}
```

11 cifre numeriche = PIVA, 16 alfanumerici = CF persona fisica. Nessun caso
ambiguo noto. Un solo punto di verità, riusato da `DomicilioService` e da
`InadVerifyBulkService`.

## Componenti

### 1. `RegistroImpreseService` (nuovo modulo `channels/registro-imprese/`)

Mirror di `InadService`/`InipecService` (stesso pattern già in repo):

```ts
@Injectable()
export class RegistroImpreseService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`registroImprese.${env}.purposeId`);
    if (!purposeId) throw new Error(`Configurazione Registro Imprese (${env}) incompleta: purposeId non impostato`);
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async dettaglioImpresa(partitaIva: string): Promise<RegistroImpreseDettaglioResult> {
    // GET dettaglio/codicefiscale, Authorization: Bearer <voucher>
    // 429 → throw RegistroImpreseRateLimitError con retryAfterSeconds (da header)
    // altri !ok → throw Error generico (stesso pattern InadService)
    // parsing XML: fase 1 minimale, completato al primo test reale
  }
}
```

`RegistroImpreseDettaglioResult`: `{ found: boolean; raw: string; pec?: string;
denominazione?: string }` — `pec`/`denominazione` popolati solo dopo aver
verificato dal vivo dove vivono nell'XML reale. `raw` sempre presente
(fallback per debug/log, stesso spirito di non inventare struttura non
verificata).

Base URL fissa per env (costanti, non settings — stesso trattamento di
`INAD_BASE_URL`). Nessun claim digest nel voucher.

### 2. Settings

`settings.registry.ts`: nuove chiavi `registroImprese.test.purposeId`,
`registroImprese.prod.purposeId` (stesso pattern INAD/INIPEC — non
`bootstrapOnly`, editabili da UI Impostazioni → sezione PDND esistente).

### 3. `DomicilioService.cercaDomicilio()` — branch PIVA

```ts
if (isPartitaIva(codiceFiscale)) {
  // salta ANPR (C002/C019), INAD, App IO — nessuno dei tre ha dati per un'impresa
  const registroImprese = await this.registroImpreseService.dettaglioImpresa(codiceFiscale)
    .then(r => ({ success: true, ...r }))
    .catch(e => ({ success: false, found: false, message: e.message }));
  return { codiceFiscale, registroImprese, /* inad/appIo/anpr omessi o vuoti */ };
}
```

`DomicilioSearchResult` guadagna campo opzionale
`registroImprese?: DomicilioRegistroImpreseResult`. Per input PIVA i campi
`inad`/`appIo`/`anpr` non vengono interrogati (nessuna chiamata sprecata) —
il consumer (frontend admin, pannello "Cerca Domicilio") va esteso per
renderizzare questo branch quando valorizzato, invece dei pannelli
ANPR/INAD/AppIO esistenti. Fuori scope implementare qui il dettaglio UI —
menzionato per completezza, va nel piano.

### 4. Bulk verify (CSV campagne) — coda BullMQ dedicata

Nuova coda `registro-imprese-verify` (pattern "coda dedicata", non
`EngineName`/`ENGINE_QUEUES` — non è un canale di invio, stesso principio già
in uso per `ENRICHMENT_QUEUE`). Un job = una PIVA.

```ts
new Queue('registro-imprese-verify', {
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
// worker: limiter { max: <N>, duration: <ms> } — valore placeholder
// conservativo finché non nota la soglia PDND reale, da tarare a test avvenuto
```

`attempts`+`backoff` esponenziale assorbono i 429 senza intervento manuale —
"resta in coda, quando il limite si libera continua" (comportamento
confermato voluto).

**`InadVerifyBulkService.createJob()`**: split righe CSV valide per
`isPartitaIva`:
- righe 16 char → invariato, flusso `InadService.startBulkExtraction` esistente.
- righe PIVA (11 cifre) → un job per PIVA sulla nuova coda, invece di essere
  droppate (fix del gap silenzioso attuale).

**`InadVerificationJob` entity**: nuovi campi per tracciare il sub-job
Registro Imprese indipendente dal batch INAD:
`pivaTotal`, `pivaDone`, `pivaFoundCount` (stesso spirito di `batches` già
presente per INAD). Il job resta `PROCESSING` finché **entrambe** le fonti
(batch INAD + coda PIVA) non sono complete — poi merge dei risultati nei due
CSV output esistenti (`resultFoundCsv`/`resultNotFoundCsv`), stessa forma
riga per riga indipendentemente dalla fonte (CF persona fisica via INAD, PIVA
via Registro Imprese).

**Processor** `registro-imprese-verify.processor.ts`: 1 job = 1 PIVA →
`dettaglioImpresa()` → scrive esito (found/notfound + pec) → decrementa
contatore pendenti del job padre → se ultimo pending del job, triggera merge
+ eventuale transizione a `DONE` (simmetrico a come oggi
`InadVerifyBulkSyncService` chiude il job sul lato INAD).

### 5. Errori/edge case

- 401 (ente non abilitato alla finalità) → propagato come errore leggibile,
  stesso trattamento delle altre integrazioni PDND non ancora abilitate
  (messaggio chiaro invece di stack trace generico).
- 429 → in `DomicilioService` (ricerca singola, sincrona) propagato come
  errore all'operatore con messaggio "riprova tra qualche secondo" (nessuna
  coda per la ricerca singola — è già una singola chiamata interattiva). In
  bulk, assorbito da `attempts`+`backoff` della coda.
- XML non parsabile / campo atteso assente → `found: false` con `raw`
  comunque salvato, mai eccezione che blocca l'intero batch (stesso principio
  già in uso per try/catch per-entry ZIP in Arricchimento).

## Fuori scope (questo design)

- Dettaglio UI frontend-admin (pannello risultato PIVA in "Cerca Domicilio",
  colonna esito in bulk verify) — menzionato, dettagliato nel piano di
  implementazione.
- Parsing XML completo/tipizzato — bloccato su abilitazione API reale.
- Taratura rate limiter reale — placeholder conservativo fino a test.
- INIPEC — abbandonato, `InipecService` scaffold resta intonso.
