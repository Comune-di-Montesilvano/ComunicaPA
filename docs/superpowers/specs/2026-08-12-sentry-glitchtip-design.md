# Integrazione Sentry SDK verso GlitchTip self-hosted

Data: 2026-08-12

## Contesto

ComunicaPA è distribuito come immagini generiche (ghcr.io) su più istanze
indipendenti (un deploy per Comune/ente). Vogliamo error tracking centralizzato
su un'istanza GlitchTip self-hosted esistente, che riceve eventi da tutte le
istanze software distinte. Configurazione interamente via `.env` (bootstrap),
nessuna UI/DB coinvolta — coerente con la distinzione già in uso nel repo tra
variabili di bootstrap (`.env`) e configurazione runtime (`app_settings`/DB).

## Obiettivo

- Error tracking (no performance tracing) su backend NestJS, frontend-admin,
  frontend-citizen.
- Ogni istanza software distinguibile in GlitchTip via tag `environment`
  (es. nome ente), stesso progetto/DSN condiviso per tipo app.
- Attivo solo se la relativa DSN è valorizzata — nessun invio di default,
  specialmente in dev locale.

## Fuori scope

- Performance tracing / `tracesSampleRate` (solo error capture).
- Progetti GlitchTip separati per istanza (si usa un solo progetto per tipo
  app + tag `environment`).
- Session Replay o altre feature avanzate di Sentry.
- Integrazione lato DB/UI Impostazioni: resta bootstrap-only in `.env`.

## Variabili `.env` (nuove, tutte opzionali)

```
# ── Error tracking (Sentry SDK → GlitchTip self-hosted) ────────────────────
# Opzionali: SDK disattivato se la relativa DSN è vuota (default dev locale).
# Un solo progetto GlitchTip per tipo app (backend/admin/citizen), tag
# "environment" per distinguere le istanze/enti sullo stesso progetto.
SENTRY_DSN_BACKEND=
SENTRY_DSN_ADMIN=
SENTRY_DSN_CITIZEN=
SENTRY_ENVIRONMENT=dev-locale
```

`SENTRY_ENVIRONMENT` è condivisa dalle tre app (stessa istanza software).

## Backend (`apps/backend`)

- Nuova dipendenza `@sentry/node` (workspace `apps/backend/package.json`,
  rispettare il pattern pnpm v11 `--ignore-scripts` già documentato in
  CLAUDE.md per Dockerfile/Dockerfile.dev).
- Init in `main.ts`, primissima istruzione di `bootstrap()`, **prima** di
  `NestFactory.create`: se `process.env['SENTRY_DSN_BACKEND']` è vuota/assente,
  skip completo (nessuna chiamata `Sentry.init`). Se valorizzata:
  ```ts
  Sentry.init({
    dsn: process.env['SENTRY_DSN_BACKEND'],
    environment: process.env['SENTRY_ENVIRONMENT'] ?? 'unknown',
    tracesSampleRate: 0,
  });
  ```
- Nuovo `AllExceptionsFilter` (`src/common/all-exceptions.filter.ts`),
  `@Catch()` senza tipo (cattura qualunque eccezione, incluse quelle non
  `HttpException`). Comportamento: chiama `Sentry.captureException(exception)`
  quando l'SDK è inizializzato (guardia su un flag/`Sentry.isInitialized()`),
  poi ridelega al comportamento standard Nest (stesso status/body che
  produrrebbe senza il filtro — nessuna modifica al contratto HTTP esistente,
  incluso il pattern "200 + `{blocked:true}`" già documentato per gli
  endpoint che il reverse proxy esterno intercetta). Registrato con
  `app.useGlobalFilters(new AllExceptionsFilter())` in `main.ts`, dopo la
  creazione dell'app. Non sostituisce `ExternalApiExceptionFilter` esistente
  (resta scoped su `external-api/*`, applicato a livello di controller/modulo
  — i filtri Nest più specifici vincono su quello globale).
- BullMQ processor (`notification.processor.ts`, `protocollazione.processor.ts`,
  job di enrichment): nel punto in cui un'eccezione viene già catturata per
  marcare l'attempt/job come FAILED prima del rethrow (pattern esistente,
  vedi CLAUDE.md "side-effect su NotificationAttempt... solo in
  notification.processor.ts" e "stato terminale scritto PRIMA di uscire dal
  job"), aggiungere una chiamata a un helper condiviso
  `captureProcessorException(error, context)` (`src/common/sentry.util.ts`)
  — stessa guardia "solo se inizializzato", nessun processor introduce la
  propria logica Sentry duplicata.

## Frontend (`frontend-admin`, `frontend-citizen`)

- Nuova dipendenza `@sentry/react` in entrambi i `package.json`.
- **Niente `VITE_*`**: le immagini Docker sono generiche (stesso ghcr.io
  artifact per tutte le istanze), quindi la DSN non può essere baked a
  build-time. Si estende il meccanismo già esistente di config runtime
  (`window.__COMUNICAPA_CONFIG__`, generato da `nginx/20-runtime-config.sh`
  all'avvio container, letto da `public/config.js`/`dist/config.js`):
  ```sh
  # 20-runtime-config.sh (entrambi i frontend)
  : "${SENTRY_DSN:=}"
  : "${SENTRY_ENVIRONMENT:=}"
  # stessa validazione whitelist caratteri già in uso per API_BASE
  cat > /usr/share/nginx/html/config.js <<EOF
  window.__COMUNICAPA_CONFIG__ = {
    apiBase: '${API_BASE}',
    sentryDsn: '${SENTRY_DSN}',
    sentryEnvironment: '${SENTRY_ENVIRONMENT}'
  };
  EOF
  ```
  `docker-compose.yml` passa `SENTRY_DSN_ADMIN`→`SENTRY_DSN` e
  `SENTRY_DSN_CITIZEN`→`SENTRY_DSN` ai rispettivi container (var interna al
  container sempre `SENTRY_DSN`, valore diverso per servizio via compose).
- Init in `main.tsx` (entrambi i frontend), prima del render React: skip se
  `window.__COMUNICAPA_CONFIG__?.sentryDsn` assente/vuota. Stesso
  `tracesSampleRate: 0`.
- Error boundary: se non esiste già un boundary globale in uno dei due
  frontend, aggiungerne uno minimale attorno al componente radice che chiama
  `Sentry.captureException` in `componentDidCatch` e mostra un fallback UI
  semplice ("Si è verificato un errore, ricarica la pagina") — verificare
  prima se un boundary esiste già (`grep -rn "componentDidCatch\|ErrorBoundary"`)
  per non duplicarlo.

## `docker-compose.yml`

Nuove env passate ai tre servizi (nessun default hardcoded, pattern
`${VAR:-}` già in uso):
```yaml
backend:
  environment:
    SENTRY_DSN_BACKEND: ${SENTRY_DSN_BACKEND:-}
    SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
frontend-admin:
  environment:
    SENTRY_DSN: ${SENTRY_DSN_ADMIN:-}
    SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
frontend-citizen:
  environment:
    SENTRY_DSN: ${SENTRY_DSN_CITIZEN:-}
    SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
```

## Testing

- Unit: `AllExceptionsFilter` (spec dedicato, verifica che `captureException`
  sia chiamato solo con SDK inizializzato, status/body HTTP invariati sia con
  `HttpException` che con errori generici).
- Unit: `captureProcessorException` helper (no-op se non inizializzato).
- Nessun test E2E reale contro GlitchTip (richiede istanza esterna) — verifica
  manuale post-merge: valorizzare `SENTRY_DSN_BACKEND` in `.env` locale
  puntato a un progetto GlitchTip di test, forzare un'eccezione, confermare
  l'evento in UI GlitchTip.
- Rebuild Docker obbligatorio dopo aggiunta dipendenze (`pnpm-lock.yaml` +
  rebuild immagine + drop volume `node_modules`, pattern già documentato in
  CLAUDE.md).

## Rischi/attenzioni note

- `AllExceptionsFilter` globale rischia di intercettare anche eccezioni già
  gestite da filtri più specifici (`ExternalApiExceptionFilter`) — verificare
  con test che l'ordine di risoluzione Nest (filtro più specifico vince)
  resti quello atteso, non solo assumerlo.
- Filtro globale deve preservare ESATTAMENTE lo status/body prodotto oggi
  senza Sentry per ogni classe di eccezione esistente nella suite — nessuna
  regressione sul contratto HTTP, incluso il pattern 200+blocked.
- Verificare che l'aggiunta di `Sentry.init` in cima a `main.ts` non interferisca
  con `assertProductionSecrets`/altre guardie di avvio già presenti.
