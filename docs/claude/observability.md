# Log, audit log, Sentry/GlitchTip

## Log debug/verbose — gotcha

Il logger NestJS di default (`NestFactory.create`) esclude i livelli
`debug`/`verbose`, a prescindere dall'ambiente. `main.ts` legge `LOG_LEVEL`
da env (default `info`) e lo mappa ai livelli Nest — impostare
`LOG_LEVEL=debug` in `.env` e riavviare il backend per vedere i log di
dettaglio dei motori di invio (payload/risposte PEC/Email/App IO/SEND/Postal).
I job BullMQ salvano inoltre i propri log (`job.log()`), consultabili dalla
UI admin → Motori → "Vedi log" per singolo job, senza bisogno di accesso SSH.

## E2E browser (Chrome DevTools MCP) — gotcha click sidebar

Click su voci di navigazione sidebar (`href="#"`, routing client-side via
`onClick` React, nessun cambio URL reale) spesso fallisce con "did not
become interactive within the configured timeout" anche se l'elemento è
visibile e cliccabile a mano. Workaround: `evaluate_script` che seleziona
il link per testo e chiama `.click()` sul DOM direttamente, es. `() => {
const link = [...document.querySelectorAll('a')].find(a =>
a.textContent.trim() === 'Arricchimento Tracciati'); link?.click(); }` —
bypassa il controllo di interattività del tool `click` che su questi
elementi non lo soddisfa mai.

**Verificare a schermo una lista vuota in dev** (es. "Campagne recenti"): in `evaluate_script` sostituire temporaneamente `window.fetch` per l'URL interessato con `new Response(JSON.stringify(rows))`, cliccare il bottone di refresh, ripristinare `fetch` — dati solo client, nessuna scrittura su DB, spariscono al poll successivo.

## Audit log — ogni endpoint che consulta un registro PA esterno deve loggare

`AuditLogsService.log()` non è solo per le azioni su Campaign — qualunque
controller che interroga un registro esterno con dati personali (ANPR,
INAD, App IO...) deve loggare operatore + CF cercato, altrimenti non c'è
modo di ricostruire dopo il fatto "chi ha cercato quale CF". Gap reale
trovato e corretto: `DomicilioController.cerca()` (orchestratore
ANPR+INAD+App IO) non aveva alcun logging fino a `06f943e` — verificare
per ogni nuovo endpoint di ricerca su registro esterno.

## Sentry/GlitchTip — error tracking, gotcha reali

`AllExceptionsFilter` (`src/common/all-exceptions.filter.ts`) DEVE estendere
`BaseExceptionFilter` di NestJS (`super.catch(exception, host)`), mai
reimplementare a mano status/body/logging — bug reale trovato solo dalla
review finale whole-branch (i task review singoli non l'hanno preso): una
reimplementazione manuale perdeva il branch `http-errors`
(`PayloadTooLargeError`/413 diventava 500 generico, stesso incidente già
documentato sopra per il body-parser) e il controllo `isHeadersSent`
(rischio crash su handler `@Res()`/SSE che lanciano dopo aver già inviato
risposta). `captureException` va chiamato solo per non-`HttpException` o
status >=500 — stessa filosofia di `ExternalApiExceptionFilter`
(INTERNAL_ERROR-only), altrimenti ogni 401/404 normale (bot scan su rotte
pubbliche incluso) finisce su GlitchTip.

`Sentry.init` con `@sentry/node` v8 installa di default
`onUnhandledRejectionIntegration` in modalità `'warn'` — cambia il
comportamento Node standard (crash → restart pulito via
`restart: unless-stopped`) in "logga e continua". Va sempre passato
esplicitamente `integrations: [Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })]`
per non alterare la semantica di crash solo perché l'observability è
abilitata.

Frontend: DSN va SOLO da `window.__COMUNICAPA_CONFIG__` runtime (mai
`VITE_*`/`import.meta.env`, stesso principio già in vigore per `apiBase`
— vedi sopra), iniettata dall'entrypoint nginx in prod. **In dev
(`docker-compose.override.yml`, Vite dev server) l'entrypoint nginx non
gira affatto** — `public/config.js` resta il placeholder statico committato
(`sentryDsn: ''`), quindi Sentry è sempre disattivato in dev locale anche
con una DSN valorizzata in `.env`; verificato solo buildando l'immagine
prod reale (stesso principio già noto per `@comunicapa/shared-types`).
`SENTRY_ENVIRONMENT` è un valore libero scelto dall'operatore (nome ente,
può contenere spazi) — la validazione charset nell'entrypoint nginx deve
ammettere lo spazio, altrimenti un valore plausibile blocca l'avvio del
container frontend con `exit 1` mentre il backend (non validato) parte
comunque. Il fallback del tag `environment` deve usare `||` non `??`:
`docker-compose.yml` passa sempre la var (`${SENTRY_ENVIRONMENT:-}`, mai
`undefined`), quindi `??` non scatta mai sulla stringa vuota — backend e
frontend finiscono per taggare `environment` diversamente sulla stessa
istanza.

**Verifica manuale rapida della reachability DSN→GlitchTip** senza passare
da un errore HTTP reale: `docker compose exec backend node -e "..."` che
fa `Sentry.init(...)` con la DSN reale e chiama
`Sentry.captureException(new Error(...))` poi `await Sentry.close(8000)` —
ritorna `true`/`false` a seconda che il trasporto sia riuscito entro il
timeout, utile per confermare auth/rete verso l'istanza GlitchTip prima di
aspettare un errore applicativo vero.

**Attenzione — proprio questo script di verifica manuale MASCHERA il bug
reale più insidioso di tutti: `captureException()` senza flush esplicito
NON invia mai l'evento da un processo Node long-running.** Bug reale
trovato solo con E2E completo (immagine ghcr reale, richiesta HTTP
multipart vera contro un'istanza standalone, verifica via API REST di
GlitchTip — mai visibile da unit test, che mockano `@sentry/node` di
default). `AllExceptionsFilter.catch()` chiamava `captureException()`
(che internamente fa solo `Sentry.captureException()`, nessun flush) — in
un processo che gira per giorni (il backend, non uno script one-off) 
l'evento restava in coda interna del transport e non veniva MAI inviato
spontaneamente: zero errore, zero log SDK anche con `debug:true`, sparisce
nel nulla. Ogni evento arrivato durante quella sessione di debug aveva
SEMPRE un flush/close esplicito a monte — lo script di verifica sopra
(`Sentry.close(8000)`, che flusha), oppure un crash imminente del processo
(`OnUncaughtException`, che flusha da solo prima di uscire) — **mai** il
caso reale di un errore HTTP catturato a runtime dal filtro globale. Fix
in `sentry.util.ts`: `Sentry.flush(2000)` fire-and-forget (mai `await` —
bloccherebbe la risposta HTTP all'utente) subito dopo
`Sentry.captureException()`. Diagnosticato isolando l'app reale (pull
immagine ghcr, Postgres/Redis/volume usa-e-getta su `docker run` standalone
per non toccare lo stack dev condiviso) e patchando `dist/common/
sentry.util.js` in-place nel container per aggiungere log diagnostici e
`Sentry.flush()` di prova, poi confermando l'arrivo dell'evento via
`GET /api/0/projects/<org>/<project>/issues/` (GlitchTip è API-compatibile
Sentry, nessun bisogno di MCP dedicato — basta un Auth Token da
Settings → API Tokens e query REST dirette).

**`pdf-extractor` (Python/FastAPI) non aveva Sentry — coperti solo
backend/frontend-admin/frontend-citizen.** Aggiunto `sentry_sdk` (stesso
pattern opt-in: no-op se `SENTRY_DSN_PDF_EXTRACTOR` non valorizzata),
`docker-compose.yml` aggiorna il blocco `environment:` del servizio (stesso
gotcha env-non-whitelistata di sopra — mancava del tutto, nessun
`environment:` esisteva per `pdf-extractor` prima). A differenza del bug
Node sopra, il SDK Python (`sentry_sdk`) usa un `BackgroundWorker` su
thread dedicato che drena la coda in continuo — **non richiede un
`flush()` esplicito per funzionare in un processo long-running**,
verificato dal vivo con `capture_exception()` senza flush (arrivato su
GlitchTip). Non equivale a "mai testarlo" — verificato comunque con lo
stesso principio (DSN reale, evento reale, conferma via API), solo
un'architettura SDK diversa da quella Node che ha causato il bug sopra.

Il progetto GlitchTip corrispondente NON esisteva (solo backend/admin/
citizen) — creato via API: `POST /api/0/teams/<org>/<team>/projects/`
(serve lo slug del team, non solo dell'org — `GET
/api/0/organizations/<org>/teams/` per trovarlo), poi DSN da `GET
/api/0/projects/<org>/<project>/keys/`.


## Operatori online (presence) — stato in RAM, istanza singola

`PresenceService`: `Map` username → ultimo heartbeat in RAM (nessun Redis,
nessuna persistenza), `POST admin/presence/heartbeat` ogni 60 s dal frontend,
`GET admin/presence/online` conta gli heartbeat degli ultimi 90 s. JWT stateless:
contare i token attivi è impossibile, da qui l'heartbeat. Come il bridge SSE
dei log arricchimento, funziona solo con **un solo processo backend**: con
più repliche servirebbe Redis. Un fallimento dell'endpoint non deve mai
mostrare errori, solo il badge senza numero.
