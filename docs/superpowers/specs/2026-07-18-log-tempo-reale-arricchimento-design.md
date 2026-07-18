# Log in tempo reale job arricchimento — Design

Data: 2026-07-18
Stato: approvato (brainstorming con Mirko)

## Contesto

Il tool sendcsv originale mostrava un log live (via SSE) durante la
conversione: l'operatore vedeva riconosciuto ogni documento man mano,
senza aspettare la fine del job. La dashboard "Arricchimento tracciati"
attuale (vedi `docs/superpowers/specs/2026-07-17-arricchimento-tracciati-design.md`)
mostra solo un contatore (`processedRecords/totalRecords`) aggiornato via
polling ogni 3s — nessuna visibilità su COSA è stato estratto finché il
job non è `DONE`. Serve poter controllare a occhio, già dal primo
documento, che l'estrazione stia funzionando come atteso — senza
aspettare l'esito finale su job potenzialmente lunghi (centinaia di PDF).

## Obiettivo

Log push in tempo reale (SSE) durante l'elaborazione di un job: prima riga
elaborata → dettaglio completo (funge da "template" di verifica manuale);
righe successive → riga sintetica.

## Vincolo di deployment (assunzione esplicita, verificata)

Il worker BullMQ (`EnrichmentProcessor`, `@Processor`) gira nello STESSO
processo Node del server HTTP (`docker-compose.yml`: un solo servizio
`backend`, nessun worker separato). Questo rende possibile un bridge
in-memory (`EventEmitter` per jobId) tra processor e endpoint SSE, senza
bisogno di pub/sub su Redis. **Limite esplicito**: se in futuro il backend
scala a più repliche, questo meccanismo smette di funzionare per chi si
connette a una replica diversa da quella che ha in carico il job — da
rivedere (Redis pub/sub) solo se/quando si introduce scaling orizzontale.
Non anticipato ora (YAGNI, coerente con lo stato attuale del deployment).

## Modifiche

### 1. Backend — bridge eventi in-memory

Nuovo `EnrichmentEventsService` (provider, non globale, vive in
`EnrichmentModule`): wrapper su `EventEmitter` con un canale per `jobId`.

```typescript
interface EnrichmentLogEvent {
  row: number;
  pdf: string;
  detail: 'full' | 'summary';
  // 'full' (solo riga 1): tutti i campi — indirizzo completo, totale,
  // ogni rata con numero_avviso/importo/scadenza, ogni warning singolo.
  // 'summary' (righe successive): un riassunto compatto.
  payload: Record<string, unknown>;
}
type EnrichmentTerminalEvent = { type: 'done' | 'error'; message?: string };

class EnrichmentEventsService {
  emitLog(jobId: string, event: EnrichmentLogEvent): void;
  emitTerminal(jobId: string, event: EnrichmentTerminalEvent): void;
  subscribe(jobId: string, onEvent: (e: EnrichmentLogEvent | EnrichmentTerminalEvent) => void): () => void; // ritorna unsubscribe
}
```

Nessuna persistenza: se nessuno è connesso quando un evento viene emesso,
va perso (comportamento identico al tool originale — è un log LIVE, non
uno storico). Lo storico dei warning per riga resta comunque disponibile
a fine job via `EnrichmentJob.warnings` (invariato, già esistente).

### 2. Processor — emette un evento per riga

`enrichment.processor.ts`, dentro il loop esistente su `records`:
- Riga 1 (`rowNum === 1`): dopo aver elaborato indirizzo/pagamento/warning
  di quella riga, `eventsService.emitLog(jobId, { row: 1, pdf, detail:
  'full', payload: { indirizzo, totale, rate: [...], warnings: [...] } })`.
- Righe successive: `detail: 'summary'`, payload compatto (es. `{
  indirizzoTrovato: bool, pagamentoTotale: bool, numeroRate: number,
  warningCount: number }`).
- A fine job (sia successo che fallimento): `eventsService.emitTerminal(jobId,
  { type: 'done' })` o `{ type: 'error', message }` — il frontend chiude
  la connessione SSE a questo punto.
- Se il job fallisce prima del loop (es. ZIP illeggibile): solo l'evento
  terminale `error`, nessun evento di riga.

### 3. Controller — endpoint SSE

`GET admin/enrichment/jobs/:id/stream` (ruoli `user`+`admin`, stesso
accesso delle altre route job):
- Se il job è già in stato terminale (`DONE`/`FAILED`) al momento della
  connessione: invia subito l'evento terminale corrispondente e chiude
  (niente storico di riga da ripetere — chi si connette dopo la fine vede
  solo il warning riassuntivo già esistente via `GET jobs/:id`).
- Altrimenti: si iscrive via `EnrichmentEventsService.subscribe(jobId,
  ...)`, scrive ogni evento come `data: <json>\n\n`, chiude lo stream
  (`res.end()`) alla ricezione dell'evento terminale o alla disconnessione
  del client (cleanup della subscription in entrambi i casi — mai una
  subscription orfana).
- Header standard SSE: `Content-Type: text/event-stream`, `Cache-Control:
  no-cache`, `Connection: keep-alive` (stesso pattern header già presente
  altrove in questo backend per endpoint di streaming, se esistente —
  altrimenti pattern Express/Nest standard per SSE).

### 4. Frontend — pannello log live

**Auth — niente `EventSource` nativo.** Verificato: questo backend non ha
alcun precedente SSE/streaming, l'auth è ovunque JWT via header
`Authorization: Bearer` con un `JwtAuthGuard` globale
(`app.module.ts`) — `EventSource` nativo non supporta header custom, e
mettere il token in query string (alternativa comune) lo espone in log
di accesso/history del browser, non coerente con come questo repo tratta
il token altrove. Si usa quindi `fetch()` con `Authorization` header
normale + lettura manuale dello stream via
`response.body.getReader()`/`TextDecoder`, parsing delle righe `data:
...\n\n` a mano (nessuna libreria nuova — meccanismo semplice, poche
righe). Nessuna modifica al `JwtAuthGuard` globale: l'endpoint `/stream`
si comporta come qualunque altra route autenticata.

Nella vista job (lista o dettaglio job): mentre `status` è `queued` o
`processing`, apre la connessione verso
`${ADMIN_API_BASE}/enrichment/jobs/:id/stream` col meccanismo sopra.

- Riga 1 (`detail: 'full'`): pannello espanso fisso in cima al log,
  mostra tutti i campi — resta visibile come "template" di riferimento
  per tutta la durata del job (non scrolla via con le righe successive).
- Righe successive (`detail: 'summary'`): elenco compatto che cresce,
  una riga per documento, ordine di arrivo.
- Evento terminale: chiude la `EventSource`, il pannello resta con lo
  storico della sessione (non persiste al refresh pagina — è un log live,
  coerente con la scelta di non persistere lato backend).
- Se l'operatore naviga via dalla vista job e poi torna mentre il job è
  ancora in corso: nuova connessione SSE, log locale riparte vuoto (le
  righe già passate non si recuperano — limite noto, accettato, coerente
  con "nessuna persistenza" del punto 1).

## Test

- Backend: `EnrichmentEventsService` — subscribe/emit/unsubscribe,
  nessun evento consegnato dopo unsubscribe, multi-subscriber sullo
  stesso jobId ricevono entrambi lo stesso evento.
- Processor: riga 1 emette evento `detail:'full'` con payload completo,
  righe successive `detail:'summary'`; evento terminale sempre emesso
  (successo e fallimento), anche se zero eventi di riga (ZIP illeggibile).
- Controller: connessione su job già terminale → evento terminale
  immediato, nessuna subscription residua; connessione su job in corso →
  riceve gli eventi emessi dopo la connessione (verificabile con un
  processor fittizio che emette dopo un delay controllato nel test).
- Frontend: verifica manuale (nessun test automatico per `EventSource` in
  questo repo — stesso pattern già accettato per altre view admin non
  coperte da suite automatica).

## Fuori scope

- Nessuna persistenza del log live lato backend (solo warning finali,
  già esistenti, restano nello storico).
- Nessun replay dello storico log per chi si connette a job già in corso
  ma dopo l'inizio (vede solo gli eventi da quel momento in poi).
- Nessun supporto multi-replica (Redis pub/sub) — YAGNI finché il backend
  resta a istanza singola.
