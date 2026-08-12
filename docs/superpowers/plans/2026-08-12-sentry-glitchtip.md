# Integrazione Sentry SDK verso GlitchTip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere error tracking (no performance tracing) verso un'istanza GlitchTip self-hosted da backend NestJS, frontend-admin e frontend-citizen, interamente configurabile via `.env`, disattivo di default.

**Architecture:** `@sentry/node` nel backend (init in `main.ts`, filtro eccezioni globale + hook nei processor BullMQ sui path FAILED già esistenti). `@sentry/react` in entrambi i frontend, DSN iniettata a runtime (stesso meccanismo `window.__COMUNICAPA_CONFIG__`/`config.js` già usato per `apiBase`, mai `VITE_*` — le immagini ghcr sono generiche, condivise da tutte le istanze). Un solo progetto GlitchTip per tipo app, istanze distinte via tag `environment`.

**Tech Stack:** NestJS 10, TypeScript 5.7, `@sentry/node` v8, `@sentry/react` v8, React 19, nginx runtime config injection, Docker Compose.

## Global Constraints

- Nessuna DSN di default: SDK disattivato se la relativa env var è vuota/assente (dev locale di default non manda nulla).
- Solo error tracking: `tracesSampleRate: 0` ovunque, nessuna performance tracing.
- Frontend: DSN SOLO da `window.__COMUNICAPA_CONFIG__` (runtime, generato da nginx entrypoint), mai `import.meta.env`/`VITE_*` — le immagini sono generiche ghcr.io condivise tra istanze.
- `SENTRY_ENVIRONMENT` condivisa dalle tre app della stessa istanza.
- Nuove dipendenze richiedono, dopo l'edit di `package.json`: aggiornamento `pnpm-lock.yaml` via
  `MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"`
  poi rebuild immagine interessata (`docker compose build <servizio>`) e, per il backend, drop del volume named `node_modules` (vedi CLAUDE.md "pnpm v11 in Docker").
- Filtro eccezioni globale backend NON deve alterare status/body HTTP prodotti oggi per nessuna classe di eccezione (nessuna regressione sul contratto esistente, incluso pattern "200+blocked").
- `AllExceptionsFilter` globale ha precedenza PIÙ BASSA di `ExternalApiExceptionFilter` (scoped via `@UseFilters` sui controller `external-api/*`) — non deve interferire con quel path, che riceve un trattamento dedicato nel Task 3.

---

### Task 1: Backend — dipendenza `@sentry/node`, helper `captureException`, init in `main.ts`

**Files:**
- Modify: `apps/backend/package.json` (dependencies)
- Create: `apps/backend/src/common/sentry.util.ts`
- Create: `apps/backend/src/common/sentry.util.spec.ts`
- Modify: `apps/backend/src/main.ts`

**Interfaces:**
- Produces: `captureException(error: unknown, context?: Record<string, unknown>): void` da `apps/backend/src/common/sentry.util.ts` — no-op se `Sentry.getClient()` è `undefined` (SDK non inizializzato). Usata da Task 2, 3, 4.

- [ ] **Step 1: Aggiungi la dipendenza**

In `apps/backend/package.json`, blocco `dependencies` (ordine alfabetico esistente, va vicino a `@nestjs/schedule`/`@nestjs/bullmq`):

```json
    "@sentry/node": "^8.0.0",
```

- [ ] **Step 2: Aggiorna il lockfile e ricostruisci il container**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build backend
docker compose rm -sf backend && docker volume rm comunicapa_backend_node_modules && docker compose up -d backend
```

Verifica: `docker compose exec backend node -e "require('@sentry/node')"` non lancia errori.

- [ ] **Step 3: Scrivi il test del helper (fallisce)**

`apps/backend/src/common/sentry.util.spec.ts`:

```ts
import * as Sentry from '@sentry/node';
import { captureException } from './sentry.util';

jest.mock('@sentry/node', () => ({
  getClient: jest.fn(),
  captureException: jest.fn(),
}));

describe('captureException', () => {
  afterEach(() => jest.clearAllMocks());

  it('non chiama Sentry.captureException se il client non è inizializzato', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue(undefined);
    captureException(new Error('boom'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('chiama Sentry.captureException se il client è inizializzato', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    const err = new Error('boom');
    captureException(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, undefined);
  });

  it('passa il context come extra quando fornito', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    const err = new Error('boom');
    captureException(err, { attemptId: 'abc-123' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { extra: { attemptId: 'abc-123' } });
  });
});
```

- [ ] **Step 4: Esegui il test, verifica fallisca**

Run: `docker compose exec backend node_modules/.bin/jest sentry.util --maxWorkers=2`
Expected: FAIL — `Cannot find module './sentry.util'`

- [ ] **Step 5: Implementa il helper**

`apps/backend/src/common/sentry.util.ts`:

```ts
import * as Sentry from '@sentry/node';

/**
 * Wrapper su Sentry.captureException che è no-op se l'SDK non è stato
 * inizializzato (nessuna SENTRY_DSN_BACKEND in .env — default dev locale).
 * Unico punto da usare in tutto il backend per riportare eccezioni a
 * GlitchTip: mai chiamare Sentry.captureException direttamente altrove.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!Sentry.getClient()) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
```

- [ ] **Step 6: Esegui il test, verifica passi**

Run: `docker compose exec backend node_modules/.bin/jest sentry.util --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 7: Init in `main.ts`**

Modifica `apps/backend/src/main.ts` — aggiungi l'import in cima e l'init come prima istruzione di `bootstrap()`:

```ts
import * as Sentry from '@sentry/node';
```

(subito dopo `import { assertProductionSecrets } from './config/production-guards';`)

```ts
async function bootstrap(): Promise<void> {
  // Attivo SOLO se SENTRY_DSN_BACKEND è valorizzata — nessun invio di
  // default, specialmente in dev locale. Un solo progetto GlitchTip
  // condiviso per il backend, le istanze si distinguono con SENTRY_ENVIRONMENT.
  const sentryDsn = process.env['SENTRY_DSN_BACKEND'];
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: process.env['SENTRY_ENVIRONMENT'] ?? 'unknown',
      tracesSampleRate: 0,
    });
  }

  mkdirSync('/tmp/comunicapa-uploads', { recursive: true });
  // ... resto invariato
```

(sostituisce solo la riga `mkdirSync(...)` esistente aggiungendo il blocco sopra prima di essa, resto del file invariato)

- [ ] **Step 8: Type-check e suite completa**

Run:
```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: nessun nuovo errore tsc, stesso failure set noto (1 fallimento pre-esistente `app.controller.spec.ts`).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml apps/backend/src/common/sentry.util.ts apps/backend/src/common/sentry.util.spec.ts apps/backend/src/main.ts
git commit -m "feat(backend): init Sentry SDK verso GlitchTip, opzionale via SENTRY_DSN_BACKEND"
```

---

### Task 2: Backend — filtro eccezioni globale con capture Sentry

**Files:**
- Create: `apps/backend/src/common/all-exceptions.filter.ts`
- Create: `apps/backend/src/common/all-exceptions.filter.spec.ts`
- Modify: `apps/backend/src/main.ts`

**Interfaces:**
- Consumes: `captureException` da `apps/backend/src/common/sentry.util.ts` (Task 1).
- Produces: `AllExceptionsFilter` — registrato globalmente in `main.ts`, nessun altro modulo lo consuma direttamente.

- [ ] **Step 1: Scrivi il test (fallisce)**

`apps/backend/src/common/all-exceptions.filter.spec.ts`:

```ts
import { ArgumentsHost, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as sentryUtil from './sentry.util';

jest.mock('./sentry.util', () => ({ captureException: jest.fn() }));

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  afterEach(() => jest.clearAllMocks());

  it('per HttpException risponde con lo stesso status/body che Nest produrrebbe di default', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('destinatario non trovato'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.NOT_FOUND, message: 'destinatario non trovato', error: 'Not Found' });
  });

  it('per errore generico risponde 500 con body standard Nest', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  });

  it('chiama sempre captureException, sia per HttpException che per errore generico', () => {
    const { host } = makeHost();
    const httpErr = new NotFoundException('x');
    const genericErr = new Error('boom');
    filter.catch(httpErr, host);
    filter.catch(genericErr, host);
    expect(sentryUtil.captureException).toHaveBeenNthCalledWith(1, httpErr);
    expect(sentryUtil.captureException).toHaveBeenNthCalledWith(2, genericErr);
  });
});
```

- [ ] **Step 2: Esegui, verifica fallisca**

Run: `docker compose exec backend node_modules/.bin/jest all-exceptions --maxWorkers=2`
Expected: FAIL — `Cannot find module './all-exceptions.filter'`

- [ ] **Step 3: Implementa il filtro**

`apps/backend/src/common/all-exceptions.filter.ts`:

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { captureException } from './sentry.util';

/**
 * Filtro globale di ultima istanza — replica ESATTAMENTE il comportamento
 * di default di Nest (stesso status/body per HttpException e per errori
 * generici), aggiungendo solo la segnalazione a Sentry/GlitchTip. Ha
 * precedenza più bassa dei filtri scoped via @UseFilters (es.
 * ExternalApiExceptionFilter su external-api/*), che restano intoccati.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    captureException(exception);

    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
```

- [ ] **Step 4: Esegui, verifica passi**

Run: `docker compose exec backend node_modules/.bin/jest all-exceptions --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: Registra il filtro globalmente in `main.ts`**

In `apps/backend/src/main.ts`, aggiungi l'import:

```ts
import { AllExceptionsFilter } from './common/all-exceptions.filter';
```

Subito dopo `app.useGlobalPipes(...)` (prima di `app.enableCors(...)`):

```ts
app.useGlobalFilters(new AllExceptionsFilter());
```

- [ ] **Step 6: Type-check e suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```
Expected: stesso failure set noto (1 pre-esistente).

- [ ] **Step 7: Verifica manuale che `ExternalApiExceptionFilter` resti intoccato**

```bash
docker compose restart backend
```
Poi genera un token debug (vedi CLAUDE.md sezione Test) e chiama un endpoint `external/v1/*` che lancia un errore noto (es. capabilities con key mancante) — conferma risposta ancora `200` con body `{success:false, error:{...}}` (formato `ExternalApiExceptionFilter`), non il body di `AllExceptionsFilter`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/common/all-exceptions.filter.ts apps/backend/src/common/all-exceptions.filter.spec.ts apps/backend/src/main.ts
git commit -m "feat(backend): filtro eccezioni globale con capture Sentry, invariato il contratto HTTP esistente"
```

---

### Task 3: Backend — capture Sentry su `ExternalApiExceptionFilter` (path INTERNAL_ERROR)

**Files:**
- Modify: `apps/backend/src/external-api/external-api-exception.filter.ts:1,16`
- Modify: `apps/backend/src/external-api/external-api-exception.filter.spec.ts`

**Interfaces:**
- Consumes: `captureException` da `apps/backend/src/common/sentry.util.ts` (Task 1).

- [ ] **Step 1: Scrivi il test aggiuntivo (fallisce)**

Aggiungi a `apps/backend/src/external-api/external-api-exception.filter.spec.ts`, in cima al file dopo gli import esistenti:

```ts
import * as sentryUtil from '../common/sentry.util';

jest.mock('../common/sentry.util', () => ({ captureException: jest.fn() }));
```

E un nuovo test nel blocco `describe`:

```ts
  afterEach(() => jest.clearAllMocks());

  it('chiama captureException solo per errori generici (INTERNAL_ERROR), non per HttpException note', () => {
    const { host } = makeHost();
    filter.catch(new UnauthorizedException('key mancante'), host);
    expect(sentryUtil.captureException).not.toHaveBeenCalled();

    const genericErr = new Error('boom interno');
    filter.catch(genericErr, host);
    expect(sentryUtil.captureException).toHaveBeenCalledWith(genericErr);
  });
```

- [ ] **Step 2: Esegui, verifica fallisca**

Run: `docker compose exec backend node_modules/.bin/jest external-api-exception --maxWorkers=2`
Expected: FAIL — `captureException` mai chiamato (non ancora integrato)

- [ ] **Step 3: Integra la capture**

In `apps/backend/src/external-api/external-api-exception.filter.ts`, aggiungi l'import in cima:

```ts
import { captureException } from '../common/sentry.util';
```

Modifica il metodo `catch` (già presente, righe 13-20 circa) aggiungendo la chiamata dentro il branch esistente `if (body.error.code === 'INTERNAL_ERROR')`:

```ts
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.normalize(exception);
    if (body.error.code === 'INTERNAL_ERROR') {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      captureException(exception);
    }
    response.status(200).json(body);
  }
```

- [ ] **Step 4: Esegui, verifica passi**

Run: `docker compose exec backend node_modules/.bin/jest external-api-exception --maxWorkers=2`
Expected: PASS (tutti i test, inclusi quelli pre-esistenti)

- [ ] **Step 5: Suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set noto (1 pre-esistente).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/external-api/external-api-exception.filter.ts apps/backend/src/external-api/external-api-exception.filter.spec.ts
git commit -m "feat(backend): capture Sentry sugli errori INTERNAL_ERROR di external-api"
```

---

### Task 4: Backend — capture Sentry sui path FAILED dei processor BullMQ

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts:1,281-286`
- Modify: `apps/backend/src/queue/notification.processor.spec.ts` (se esiste — verifica con `find`; se assente, salta gli step di test automatico e verifica solo manualmente allo Step 5)
- Modify: `apps/backend/src/queue/protocollazione.processor.ts:1,200-214`

**Interfaces:**
- Consumes: `captureException` da `apps/backend/src/common/sentry.util.ts` (Task 1).

- [ ] **Step 1: Verifica presenza di spec file esistenti sui due processor**

Run: `find apps/backend/src/queue -iname "notification.processor.spec.ts" -o -iname "protocollazione.processor.spec.ts"`

Se uno o entrambi esistono, procedi con Step 2 mirato su quel file (aggiungi test lì, stesso pattern del mock usato in Task 3). Se nessuno esiste, salta a Step 3 (nessun test automatico disponibile per questi processor — pattern esistente nel repo, non introdurre un harness di test nuovo per questo task) e verifica manualmente allo Step 5.

- [ ] **Step 2 (solo se spec esistenti trovati): aggiungi test che verificano la chiamata a `captureException` sul path FAILED**

Nel file di spec trovato, mocka `../common/sentry.util` come nei task precedenti e aggiungi un'asserzione `expect(sentryUtil.captureException).toHaveBeenCalled()` nel test esistente che copre il path di fallimento canale primario (`notification.processor.spec.ts`) o il path `catch` di protocollazione (`protocollazione.processor.spec.ts`). Esegui e verifica che fallisca prima dell'implementazione.

- [ ] **Step 3: Integra la capture in `notification.processor.ts`**

Aggiungi l'import in cima al file:

```ts
import { captureException } from '../common/sentry.util';
```

Modifica il blocco esistente (righe 281-286):

```ts
    if (primaryError) {
      captureException(primaryError, { attemptId, channel, recipientId: recipient.id });
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: primaryError.message,
        responsePayload,
      });
```

(resto del blocco invariato)

- [ ] **Step 4: Integra la capture in `protocollazione.processor.ts`**

Aggiungi l'import in cima al file:

```ts
import { captureException } from '../common/sentry.util';
```

Modifica il blocco `catch` esistente (righe 200-214 circa):

```ts
    } catch (err: any) {
      captureException(err, { attemptId, recipientId });
      await this.attemptRepo.update(
        { id: attemptId, status: AttemptStatus.QUEUED },
        { status: AttemptStatus.FAILED, errorMessage: err.message },
      );
      // ... resto invariato (incluso l'update del recipient a riga 214)
```

(mantieni invariato tutto il resto del blocco `catch`, inserisci solo la riga `captureException` come prima istruzione)

- [ ] **Step 5: Se Step 2 eseguito, verifica i test passino; altrimenti verifica manuale**

Se test automatici presenti:
```bash
docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2
docker compose exec backend node_modules/.bin/jest protocollazione.processor --maxWorkers=2
```
Expected: PASS.

Se nessun test automatico: `docker compose exec backend node_modules/.bin/tsc --noEmit` deve passare senza errori (conferma solo correttezza di tipo, non comportamento — accettabile, pattern coerente con l'assenza di spec pre-esistenti su questi file).

- [ ] **Step 6: Suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set noto (1 pre-esistente).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/protocollazione.processor.ts
git commit -m "feat(backend): capture Sentry sui fallimenti invio canale primario e protocollazione"
```

---

### Task 5: Backend — variabili `.env`/`docker-compose.yml`

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:** nessuna (solo configurazione).

- [ ] **Step 1: Aggiungi le variabili a `.env.example`**

In `.env.example`, dopo la sezione `# ── Node ──...` (dove vive `LOG_LEVEL`), aggiungi una nuova sezione:

```
# ── Error tracking (Sentry SDK → GlitchTip self-hosted) ─────────────────────
# Opzionali: SDK disattivato se la relativa DSN è vuota (default dev locale).
# Un solo progetto GlitchTip per tipo app (backend/admin/citizen); più
# istanze/enti sullo stesso progetto si distinguono con SENTRY_ENVIRONMENT.
SENTRY_DSN_BACKEND=
SENTRY_DSN_ADMIN=
SENTRY_DSN_CITIZEN=
SENTRY_ENVIRONMENT=
```

- [ ] **Step 2: Aggiungi le env al servizio `backend` in `docker-compose.yml`**

Nel blocco `environment:` del servizio `backend` (dopo `LOG_LEVEL: ${LOG_LEVEL:-info}`), aggiungi:

```yaml
      SENTRY_DSN_BACKEND: ${SENTRY_DSN_BACKEND:-}
      SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
```

- [ ] **Step 3: Verifica config compose**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: nessun errore (le var restano opzionali, nessun `:?` aggiunto).

- [ ] **Step 4: Commit**

```bash
git add .env.example docker-compose.yml
git commit -m "chore: variabili .env per Sentry backend (opzionali, default disattivo)"
```

---

### Task 6: Frontend-admin — dipendenza `@sentry/react`, init runtime-guarded, error boundary

**Files:**
- Modify: `apps/frontend-admin/package.json`
- Modify: `apps/frontend-admin/src/App.tsx:26-31`
- Create: `apps/frontend-admin/src/ErrorBoundary.tsx`
- Modify: `apps/frontend-admin/src/main.tsx`
- Modify: `apps/frontend-admin/public/config.js`

**Interfaces:**
- Produces: componente `ErrorBoundary` (export default) da `apps/frontend-admin/src/ErrorBoundary.tsx`, wrappa `<App />` in `main.tsx`.

- [ ] **Step 1: Aggiungi la dipendenza**

In `apps/frontend-admin/package.json`, blocco `dependencies` (vicino a `react`):

```json
    "@sentry/react": "^8.0.0",
```

- [ ] **Step 2: Aggiorna lockfile e ricostruisci**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build frontend-admin
```

- [ ] **Step 3: Estendi il tipo della config runtime**

In `apps/frontend-admin/src/App.tsx`, righe 26-28, sostituisci:

```ts
declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}
```

con:

```ts
declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string; sentryDsn?: string; sentryEnvironment?: string };
  }
}
```

- [ ] **Step 4: Aggiorna `public/config.js` (solo dev, documentativo — in prod rigenerato dall'entrypoint)**

`apps/frontend-admin/public/config.js`:

```js
// In produzione questo file è rigenerato dall'entrypoint del container nginx
// a partire dalle variabili d'ambiente API_BASE/SENTRY_DSN/SENTRY_ENVIRONMENT.
window.__COMUNICAPA_CONFIG__ = { apiBase: 'http://localhost:8080', sentryDsn: '', sentryEnvironment: '' };
```

- [ ] **Step 5: Crea l'error boundary**

`apps/frontend-admin/src/ErrorBoundary.tsx`:

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <p>Si è verificato un errore. Ricarica la pagina.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 6: Init Sentry e wrap dell'app in `main.tsx`**

`apps/frontend-admin/src/main.tsx` — sostituisci il contenuto con:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './assets/css/tokens.css'
import './assets/css/no-bootstrap-compat.css'
import './assets/css/backoffice-shell.css'
import './assets/css/app.css'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'

// Attivo SOLO se sentryDsn è valorizzata in window.__COMUNICAPA_CONFIG__
// (config runtime generata da nginx/20-runtime-config.sh da SENTRY_DSN_ADMIN
// — mai VITE_*, l'immagine è generica e condivisa da tutte le istanze).
const sentryDsn = window.__COMUNICAPA_CONFIG__?.sentryDsn
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: window.__COMUNICAPA_CONFIG__?.sentryEnvironment || 'unknown',
    tracesSampleRate: 0,
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
```

- [ ] **Step 7: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Verifica build produzione reale (non solo dev)**

Run: `docker build -f apps/frontend-admin/Dockerfile .`
Expected: build completa senza errori (verifica che `@sentry/react` risolva correttamente lato Rollup/Vite — stesso rischio già noto in CLAUDE.md per `@comunicapa/shared-types`).

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-admin/package.json pnpm-lock.yaml apps/frontend-admin/src/App.tsx apps/frontend-admin/src/ErrorBoundary.tsx apps/frontend-admin/src/main.tsx apps/frontend-admin/public/config.js
git commit -m "feat(frontend-admin): init Sentry SDK runtime-guarded + error boundary"
```

---

### Task 7: Frontend-admin — nginx entrypoint runtime config + `docker-compose.yml`

**Files:**
- Modify: `apps/frontend-admin/nginx/20-runtime-config.sh`
- Modify: `docker-compose.yml`

**Interfaces:** nessuna (solo configurazione runtime).

- [ ] **Step 1: Estendi lo script di entrypoint**

`apps/frontend-admin/nginx/20-runtime-config.sh` — sostituisci interamente con:

```sh
#!/bin/sh
# apps/frontend-admin/nginx/20-runtime-config.sh
# Genera la config runtime del frontend da API_BASE/SENTRY_DSN/SENTRY_ENVIRONMENT.
set -eu
# Default: /api — il nginx del container proxya verso il backend sulla rete
# Docker (stesso dominio, niente CORS). Override solo per topologie particolari.
: "${API_BASE:=/api}"
case "$API_BASE" in
  *[!A-Za-z0-9_.:/-]*)
    echo "API_BASE contiene caratteri non ammessi: $API_BASE" >&2
    exit 1
    ;;
esac
# SENTRY_DSN/SENTRY_ENVIRONMENT sono opzionali (SDK disattivato se vuote).
: "${SENTRY_DSN:=}"
: "${SENTRY_ENVIRONMENT:=}"
case "$SENTRY_DSN" in
  *[!A-Za-z0-9_.:/@?-]*)
    echo "SENTRY_DSN contiene caratteri non ammessi: $SENTRY_DSN" >&2
    exit 1
    ;;
esac
case "$SENTRY_ENVIRONMENT" in
  *[!A-Za-z0-9_.-]*)
    echo "SENTRY_ENVIRONMENT contiene caratteri non ammessi: $SENTRY_ENVIRONMENT" >&2
    exit 1
    ;;
esac
cat > /usr/share/nginx/html/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}', sentryDsn: '${SENTRY_DSN}', sentryEnvironment: '${SENTRY_ENVIRONMENT}' };
EOF
```

- [ ] **Step 2: Passa le env al servizio `frontend-admin` in `docker-compose.yml`**

Nel blocco del servizio `frontend-admin` (dopo `image:`), aggiungi:

```yaml
    environment:
      SENTRY_DSN: ${SENTRY_DSN_ADMIN:-}
      SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
```

- [ ] **Step 3: Verifica config compose**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale dell'entrypoint**

```bash
docker compose build frontend-admin
SENTRY_DSN_ADMIN=https://test@glitchtip.example/1 SENTRY_ENVIRONMENT=test-locale docker compose up -d frontend-admin
docker compose exec frontend-admin cat /usr/share/nginx/html/config.js
```
Expected: contiene `sentryDsn: 'https://test@glitchtip.example/1'` e `sentryEnvironment: 'test-locale'`.

Poi ripristina lo stato locale senza DSN:
```bash
docker compose up -d frontend-admin
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/nginx/20-runtime-config.sh docker-compose.yml
git commit -m "feat(frontend-admin): inietta Sentry DSN a runtime via nginx entrypoint"
```

---

### Task 8: Frontend-citizen — dipendenza `@sentry/react`, init runtime-guarded, error boundary

**Files:**
- Modify: `apps/frontend-citizen/package.json`
- Modify: `apps/frontend-citizen/src/App.tsx:4-9`
- Create: `apps/frontend-citizen/src/ErrorBoundary.tsx`
- Modify: `apps/frontend-citizen/src/main.tsx`
- Modify: `apps/frontend-citizen/public/config.js`

**Interfaces:**
- Produces: componente `ErrorBoundary` (export default) da `apps/frontend-citizen/src/ErrorBoundary.tsx`, wrappa `<App />` in `main.tsx`. Identico a Task 6 ma copia indipendente (frontend-citizen non condivide bundle con frontend-admin, stesso principio già in CLAUDE.md per i registri canali).

- [ ] **Step 1: Aggiungi la dipendenza**

In `apps/frontend-citizen/package.json`, blocco `dependencies`:

```json
    "@sentry/react": "^8.0.0",
```

- [ ] **Step 2: Aggiorna lockfile e ricostruisci**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build frontend-citizen
```

- [ ] **Step 3: Estendi il tipo della config runtime**

In `apps/frontend-citizen/src/App.tsx`, righe 4-8, sostituisci:

```ts
declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}
```

con:

```ts
declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string; sentryDsn?: string; sentryEnvironment?: string };
  }
}
```

- [ ] **Step 4: Aggiorna `public/config.js`**

`apps/frontend-citizen/public/config.js` — stesso pattern del Task 6 Step 4, adattato: verifica prima il contenuto attuale con `cat apps/frontend-citizen/public/config.js` e applica la stessa estensione (`sentryDsn: ''`, `sentryEnvironment: ''`) mantenendo invariato il resto.

- [ ] **Step 5: Crea l'error boundary**

`apps/frontend-citizen/src/ErrorBoundary.tsx` — identico a `apps/frontend-admin/src/ErrorBoundary.tsx` (Task 6 Step 5), stesso contenuto file.

- [ ] **Step 6: Init Sentry e wrap dell'app in `main.tsx`**

`apps/frontend-citizen/src/main.tsx` — sostituisci il contenuto con:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './assets/css/tokens.css'
import './assets/css/fo-components.css'
import './assets/css/frontoffice.css'
import './assets/css/app.css'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'

// Attivo SOLO se sentryDsn è valorizzata in window.__COMUNICAPA_CONFIG__
// (config runtime generata da nginx/20-runtime-config.sh da SENTRY_DSN_CITIZEN
// — mai VITE_*, l'immagine è generica e condivisa da tutte le istanze).
const sentryDsn = window.__COMUNICAPA_CONFIG__?.sentryDsn
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: window.__COMUNICAPA_CONFIG__?.sentryEnvironment || 'unknown',
    tracesSampleRate: 0,
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
```

- [ ] **Step 7: Type-check**

Run: `docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Verifica build produzione reale**

Run: `docker build -f apps/frontend-citizen/Dockerfile .`
Expected: build completa senza errori.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend-citizen/package.json pnpm-lock.yaml apps/frontend-citizen/src/App.tsx apps/frontend-citizen/src/ErrorBoundary.tsx apps/frontend-citizen/src/main.tsx apps/frontend-citizen/public/config.js
git commit -m "feat(frontend-citizen): init Sentry SDK runtime-guarded + error boundary"
```

---

### Task 9: Frontend-citizen — nginx entrypoint runtime config + `docker-compose.yml`

**Files:**
- Modify: `apps/frontend-citizen/nginx/20-runtime-config.sh`
- Modify: `docker-compose.yml`

**Interfaces:** nessuna (solo configurazione runtime).

- [ ] **Step 1: Estendi lo script di entrypoint**

`apps/frontend-citizen/nginx/20-runtime-config.sh` — stesso contenuto del Task 7 Step 1, con il commento header che referenzia `apps/frontend-citizen/nginx/20-runtime-config.sh` invece di `apps/frontend-admin/...`.

- [ ] **Step 2: Passa le env al servizio `frontend-citizen` in `docker-compose.yml`**

Nel blocco del servizio `frontend-citizen` (dopo `image:`), aggiungi:

```yaml
    environment:
      SENTRY_DSN: ${SENTRY_DSN_CITIZEN:-}
      SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-}
```

- [ ] **Step 3: Verifica config compose**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale dell'entrypoint**

```bash
docker compose build frontend-citizen
SENTRY_DSN_CITIZEN=https://test@glitchtip.example/2 SENTRY_ENVIRONMENT=test-locale docker compose up -d frontend-citizen
docker compose exec frontend-citizen cat /usr/share/nginx/html/config.js
```
Expected: contiene `sentryDsn: 'https://test@glitchtip.example/2'` e `sentryEnvironment: 'test-locale'`.

Poi ripristina lo stato locale senza DSN:
```bash
docker compose up -d frontend-citizen
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-citizen/nginx/20-runtime-config.sh docker-compose.yml
git commit -m "feat(frontend-citizen): inietta Sentry DSN a runtime via nginx entrypoint"
```

---

## Verifica finale end-to-end (dopo Task 9)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set noto (1 pre-esistente, `app.controller.spec.ts`).

- [ ] **Step 2: Type-check completo (3 app)**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore su nessuna delle tre app.

- [ ] **Step 3: Verifica manuale contro GlitchTip reale (richiede istanza esterna, fuori scope automatizzabile)**

Valorizzare `SENTRY_DSN_BACKEND`/`SENTRY_ENVIRONMENT` in `.env` locale puntato a un progetto GlitchTip di test, `docker compose up -d --build backend`, forzare un'eccezione nota (es. chiamare un endpoint con parametro invalido che il `ValidationPipe` non intercetta, o temporaneamente far lanciare un errore da un controller di test), confermare che l'evento compaia nella UI GlitchTip con il tag `environment` corretto.
