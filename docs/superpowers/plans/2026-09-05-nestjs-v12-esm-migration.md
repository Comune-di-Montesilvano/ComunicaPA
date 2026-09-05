# Migrazione backend NestJS v12 (ESM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrare `apps/backend` da NestJS v10 (CommonJS) a NestJS v12 (ESM puro), sostituendo Jest con Vitest, senza regressioni sulla suite di test esistente (1142 test) né sul comportamento a runtime.

**Architecture:** Conversione ESM completa (`"type": "module"`, `moduleResolution: NodeNext`), build invariata su `nest build` (tsc), test runner sostituito con Vitest (scelta esplicita, non Jest con adattamenti). Rollout big-bang su branch dedicato, merge in main solo a verifica completa.

**Tech Stack:** NestJS 12, TypeScript 5.9 (NodeNext), Vitest 3 + unplugin-swc, Node 26, pnpm 11.9.0 (invariato), Docker multi-stage build invariato salvo CMD/entrypoint.

**Spec:** `docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md`

## Global Constraints

- Node runtime: 26 (già in produzione, `node:26-alpine`).
- pnpm: pin esplicito `11.9.0` (mai `@latest` — vedi CLAUDE.md, drift già causato un incidente in questa sessione).
- Test: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` diventa `vitest run` — stesso principio di limitare i worker (`poolOptions.forks.maxForks: 2`), non solo un cambio di comando.
- Baseline test: failure set identico a quello Jest attuale — 1 solo fallimento noto (`app.controller.spec.ts`, `isLdapMock`). Qualunque nuovo fallimento è una regressione, non baseline nota.
- Nessun merge in main prima che TUTTI i task abbiano superato la propria verifica — rollout big-bang, non incrementale (vedi spec, sezione Rollout).
- Rebuild obbligatorio del volume `comunicapa_backend_node_modules` a ogni cambio di `package.json` (pattern già documentato in CLAUDE.md).
- **Risorse di sistema — vincolo aggiunto dopo lo spike (host già andato in low-memory durante suite complete in container throwaway parallele).** Ogni implementer:
  - Mai eseguire la suite completa (jest o vitest) in locale — solo test mirati sui file/aree toccate dal proprio task. La verifica di regressione whole-suite è demandata a CI (`.github/workflows/tests.yml`, gira su push/PR verso `main` — vedi Task 12 per il trigger PR aggiunto).
  - Un solo container Docker throwaway alla volta, mai in parallelo. Sempre `--rm` o pulizia esplicita (`docker rm -f`) subito dopo l'uso — mai lasciare container `Up` non necessari.
  - Passare sempre un limite esplicito (`--memory=2g` o simile) ai container throwaway usati per compilazioni/test pesanti.
  - Se un comando va in background/timeout, verificare lo stato con `docker ps`/`docker wait` invece di rilanciarlo — rilanci multipli dello stesso comando sono la causa più comune di esaurimento memoria osservata in questa sessione.

---

## Task 1: Verifica `pnpm deploy --prod` con `type: module` (rischio critico, isolato)

Il rischio più alto non coperto dallo spike: se l'albero standalone prodotto da `pnpm --filter backend deploy --prod` non propaga `"type": "module"`, l'intera migrazione è bloccata da un problema equivalente al bug storico di `@comunicapa/shared-types` (CLAUDE.md). Verificarlo PRIMA di investire nel resto del piano.

**Files:**
- Nessun file di progetto modificato — solo verifica in un ambiente throwaway.

**Interfaces:**
- Nessuna (task di sola verifica, nessun codice prodotto per i task successivi).

- [ ] **Step 1: Creare branch dedicato**

```bash
git checkout main
git pull origin main
git checkout -b feature/nestjs-v12-esm
```

- [ ] **Step 2: Verificare la propagazione di `type: module` attraverso `pnpm deploy --prod`**

In un container throwaway (mai `docker compose`, per non toccare lo stack dev condiviso — vedi CLAUDE.md sezione worktree):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w node:26-alpine sh -c "
  npm install -g corepack@latest && corepack enable && corepack prepare pnpm@11.9.0 --activate
  cd /tmp && mkdir test-deploy && cd test-deploy
  cat > package.json <<'EOF'
{\"name\":\"probe\",\"type\":\"module\",\"dependencies\":{}}
EOF
  echo 'export const x = 1;' > index.js
  cd /w
  node_modules/.bin/pnpm --filter backend deploy --prod --ignore-scripts --legacy /tmp/probe-deploy 2>&1 | tail -20 || true
  cat /tmp/probe-deploy/package.json | grep '\"type\"'
"
```

Se il comando fallisce perché `node_modules` non esiste ancora nel container, eseguire prima `pnpm install --ignore-scripts --no-frozen-lockfile` (repo non ancora bumpato in questo task — è normale che sia solo un probe strutturale, non serve installare le dipendenze reali qui).

Expected: `cat /tmp/probe-deploy/package.json` mostra `"type": "module"` — cioè `pnpm deploy` copia `package.json` verbatim (comportamento documentato di pnpm, ma va confermato empiricamente su QUESTO monorepo/lockfile prima di fidarsi).

- [ ] **Step 3: Se il test fallisce, documentare il blocco e fermarsi**

Se `"type": "module"` non compare nell'output deployato, il problema è più profondo (serve investigare `pnpm deploy` versione per versione, o un postbuild che scrive un `package.json` custom nell'immagine finale). In quel caso: annotare il finding in un commento su questo task e chiedere conferma prima di proseguire — non improvvisare un workaround senza discuterlo.

Se il test passa, procedere al Task 2.

---

## Task 2: `package.json` — ESM, bump NestJS v12, rimozione Jest

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/tsconfig.json`

**Interfaces:**
- Produce: `"type": "module"` nel package.json backend, tutti gli `@nestjs/*` a v12, `vitest`/`unplugin-swc`/`@swc/core`/`vite-tsconfig-paths` come devDependencies. Consumato da tutti i task successivi (nessun task successivo può girare senza questo).

- [ ] **Step 1: Modificare `apps/backend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "incremental": true,
    "tsBuildInfoFile": "./dist/tsconfig.build.tsbuildinfo",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "**/*spec.ts"]
}
```

- [ ] **Step 2: Modificare `apps/backend/package.json`**

Header (`name`/`version`/`private`/`scripts`):

```json
{
  "name": "backend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "vitest run"
  },
```

`dependencies` — bump `@nestjs/*`:

```json
    "@nestjs/common": "^12.0.1",
    "@nestjs/config": "^12.0.0",
    "@nestjs/core": "^12.0.1",
    "@nestjs/jwt": "^12.0.1",
    "@nestjs/passport": "^12.0.0",
    "@nestjs/platform-express": "^12.0.1",
    "@nestjs/typeorm": "^12.0.1",
    "@nestjs/bullmq": "^12.0.0",
    "@nestjs/schedule": "^12.0.1",
```

(tutte le altre dependencies restano invariate — `ioredis`, `bullmq`, `typeorm`, ecc. sono già alle versioni corrette dai bump dependabot precedenti in questa stessa sessione).

`devDependencies` — sostituire jest/ts-jest, bump nest tooling:

```json
  "devDependencies": {
    "@nestjs/cli": "^12.0.0",
    "@nestjs/schematics": "^12.0.0",
    "@nestjs/testing": "^12.0.1",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.0",
    "@types/ldapjs": "^3.0.0",
    "@types/multer": "^2.2.0",
    "@types/nodemailer": "^6.4.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/node": "^22.0.0",
    "@types/adm-zip": "^0.5.5",
    "@types/yauzl": "^3.4.0",
    "@types/passport-jwt": "^4.0.0",
    "@types/supertest": "^6.0.0",
    "supertest": "^7.0.0",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "vite-tsconfig-paths": "^5.1.0",
    "unplugin-swc": "^1.5.0",
    "@swc/core": "^1.9.0"
  }
}
```

Rimuovere completamente il blocco `"jest": {...}` in fondo al file (sostituito da `vitest.config.ts`, Task 8). `@types/jest` resta **solo per i tipi** (`jest.Mock`/`jest.Mocked<T>` usati nei test esistenti) — nessun runtime jest eseguito.

- [ ] **Step 3: Aggiornare il lockfile**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w node:26-alpine sh -c "
  npm install -g corepack@latest && corepack enable && corepack prepare pnpm@11.9.0 --activate
  pnpm install --ignore-scripts --no-frozen-lockfile
"
```

Expected: install completa senza errori (warning su peer dependencies sono attesi e non bloccanti — verificare comunque che non ci siano `ERR_PNPM` fatali).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/package.json apps/backend/tsconfig.json pnpm-lock.yaml
git commit -m "chore(backend): bump NestJS a v12, ESM, rimuovi jest da package.json

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 3: Codemod — estensione `.js` sui relative import

`moduleResolution: NodeNext` richiede `.js` esplicito su ogni import/export/dynamic-import relativo. Verificato nello spike: 749 specifier in 137 file, nessun caso limite oltre il pattern semplice `from '...'` / `import('...')`.

**Files:**
- Create: `apps/backend/scripts/add-js-ext.mjs` (script one-off, resta nel repo come documentazione del fix — non eseguito di nuovo se non per nuovi file che dovessero sfuggire).
- Modify: tutti i file `.ts` sotto `apps/backend/src/**` con almeno un import relativo (137 file, non elencabili singolarmente — lo script li trova).

**Interfaces:**
- Nessuna nuova interfaccia — trasformazione sintattica pura, nessun comportamento cambia.

- [ ] **Step 1: Creare lo script del codemod**

```js
// apps/backend/scripts/add-js-ext.mjs
// Codemod one-off: aggiunge estensione .js ai relative import/export/
// dynamic-import per compatibilita NodeNext ESM. Verificato sufficiente
// per questo backend (nessun caso limite oltre from/import() con path
// relativo senza estensione - vedi spec 2026-09-05).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2] ?? 'src';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const RE = /((?:from|import\()\s*)(['"])(\.[^'"]*)\2/g;
let changedFiles = 0;
let totalSubs = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  let subs = 0;
  const next = src.replace(RE, (match, prefix, quote, specifier) => {
    if (/\.(js|json|css|node)$/.test(specifier)) return match;
    subs++;
    return `${prefix}${quote}${specifier}.js${quote}`;
  });
  if (subs > 0) {
    writeFileSync(file, next, 'utf8');
    changedFiles++;
    totalSubs += subs;
  }
}

console.log(`File modificati: ${changedFiles}, sostituzioni: ${totalSubs}`);
```

- [ ] **Step 2: Eseguire il codemod**

```bash
node apps/backend/scripts/add-js-ext.mjs apps/backend/src
```

Expected: output tipo `File modificati: 247, sostituzioni: 1069` (i numeri esatti dipendono dallo stato corrente del codice — l'ordine di grandezza atteso dallo spike era ~250 file, ~1070 sostituzioni, includendo sia `src/**/*.ts` che `src/**/*.spec.ts`).

- [ ] **Step 3: Verifica compilazione**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w node:26-alpine sh -c "
  node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json
  node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json
  cd apps/backend && node_modules/.bin/tsc --noEmit
"
```

Expected: zero errori relativi a import mancanti/non risolti (`Cannot find module`). Se compaiono errori NON legati a import (es. errori di tipo pre-esistenti), sono normali a questo punto del piano — verranno risolti nei task successivi (4-6).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/scripts/add-js-ext.mjs apps/backend/src
git commit -m "chore(backend): aggiungi estensione .js ai relative import (NodeNext ESM)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 4: Fix `__dirname` in `data-source.ts`

**Files:**
- Modify: `apps/backend/src/database/data-source.ts`

**Interfaces:**
- Nessuna nuova interfaccia esposta — `DataSource` esportato di default resta invariato nella forma, cambia solo come viene calcolato il path delle migration.

- [ ] **Step 1: Modificare l'import e il calcolo di `__dirname`**

Nel file, dopo l'ultimo import di entity e prima di `export default new DataSource({`:

```typescript
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
```

(aggiungere questi due import subito dopo `import 'reflect-metadata';` in cima al file, prima di `import { DataSource } from 'typeorm';`)

Poi, subito prima di `export default new DataSource({`:

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));

export default new DataSource({
```

Il resto del file (`entities: [...]`, `migrations: [...]`) resta invariato — `__dirname` ora è una costante locale calcolata a runtime invece della variabile globale CJS.

- [ ] **Step 2: Verifica compilazione**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w/apps/backend node:26-alpine node_modules/.bin/tsc --noEmit
```

Expected: nessun errore su `data-source.ts` (in particolare nessun `Cannot find name '__dirname'`).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/database/data-source.ts
git commit -m "fix(backend): __dirname non esiste in ESM, sostituito con fileURLToPath

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 5: Fix import `ioredis` — named export sotto NodeNext

Verificato nello spike: `import Redis from 'ioredis'` (default import) non risolve sotto `moduleResolution: NodeNext` (`TS2709`/`TS2351`). `ioredis` v6 espone `Redis` come named export.

**Files:**
- Modify: `apps/backend/src/auth/oidc/oidc-flow.service.ts`
- Modify: `apps/backend/src/auth/strategies/oidc-citizen.strategy.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Modify: `apps/backend/src/queue/queue.module.ts`

**Interfaces:**
- Consuma: `Redis` da `ioredis` (già usato in tutti e 4 i file come `new Redis(...)`) — solo la forma dell'import cambia, non l'uso.

- [ ] **Step 1: Sostituire l'import in tutti e 4 i file**

In ciascuno dei 4 file, cambiare:

```typescript
import Redis from 'ioredis';
```

in:

```typescript
import { Redis } from 'ioredis';
```

Nessun altro cambiamento nei file — ogni uso di `new Redis(...)`/`Redis` come tipo resta identico, perché è lo stesso identificatore importato in modo diverso.

```bash
for f in \
  apps/backend/src/auth/oidc/oidc-flow.service.ts \
  apps/backend/src/auth/strategies/oidc-citizen.strategy.ts \
  apps/backend/src/queue/notification.processor.ts \
  apps/backend/src/queue/queue.module.ts; do
  sed -i "s/^import Redis from 'ioredis';/import { Redis } from 'ioredis';/" "$f"
done
```

- [ ] **Step 2: Verifica compilazione**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w/apps/backend node:26-alpine node_modules/.bin/tsc --noEmit
```

Expected: zero errori `TS2709`/`TS2351` relativi a `ioredis`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/auth/oidc/oidc-flow.service.ts apps/backend/src/auth/strategies/oidc-citizen.strategy.ts apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/queue.module.ts
git commit -m "fix(backend): ioredis v6 named export Redis, default import non risolve sotto NodeNext

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 6: Fix `@nestjs/passport` v12 (`AuthModuleOptions`) e tipo `jwt.expiresIn`

Due bug reali isolati nello spike, entrambi in `auth.module.ts`.

**Files:**
- Modify: `apps/backend/src/auth/auth.module.ts`
- Modify: `apps/backend/src/auth/oidc/oidc-flow.service.ts`

**Interfaces:**
- Nessuna nuova interfaccia pubblica — fix interni a `AuthModule`.

- [ ] **Step 1: `PassportModule.register({})` esplicito**

In `apps/backend/src/auth/auth.module.ts`, l'import di `PassportModule` resta invariato. Nel blocco `imports: [...]`, cambiare:

```typescript
    PassportModule,
```

in:

```typescript
    PassportModule.register({}),
```

E nel blocco `exports: [...]` in fondo al file, aggiungere `PassportModule`:

```typescript
  exports: [AuthService, JwtModule, PassportModule],
```

Motivo (da riportare come commento nel file, subito sopra `PassportModule.register({})`):

```typescript
    // @nestjs/passport v12: AuthGuard() richiede AuthModuleOptions via DI
    // anche se dichiarato @Optional() nel mixin (regressione framework,
    // verificata su OidcAuthGuard in CitizenModule) - import nudo di
    // PassportModule non fornisce alcun provider (modulo vuoto), serve
    // .register({}) esplicito per fornire AuthModuleOptions anche vuoto.
    PassportModule.register({}),
```

- [ ] **Step 2: Fix tipo `expiresIn` (jsonwebtoken/@nestjs/jwt più recenti tipizzano `expiresIn` come `number | StringValue`, non `string` generico)**

In `apps/backend/src/auth/auth.module.ts`, aggiungere due import in cima al file (dopo gli import esistenti di `@nestjs/*`):

```typescript
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
```

(sostituendo il precedente `import { JwtModule } from '@nestjs/jwt';` con la versione che include `type JwtModuleOptions`)

Nel blocco `JwtModule.registerAsync({...})`, cambiare la `useFactory`:

```typescript
      useFactory: (config: ConfigService<AppConfiguration, true>): JwtModuleOptions => ({
        secret: config.get('jwt.secret', { infer: true }),
        signOptions: {
          expiresIn: config.get('jwt.expiresIn', { infer: true }) as SignOptions['expiresIn'],
        },
      }),
```

- [ ] **Step 3: Fix `err` implicito `any` in `oidc-flow.service.ts`**

In `apps/backend/src/auth/oidc/oidc-flow.service.ts`, cercare il blocco (vicino al salvataggio dei claims su Redis):

```typescript
      ).catch((err) => {
```

e cambiarlo in:

```typescript
      ).catch((err: unknown) => {
```

- [ ] **Step 4: Verifica compilazione**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w/apps/backend node:26-alpine node_modules/.bin/tsc --noEmit
```

Expected: **zero errori** — a questo punto (Task 2-6 completati) `tsc --noEmit` deve essere completamente pulito. Se restano errori, non procedere al Task 7 finché non sono risolti.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth/auth.module.ts apps/backend/src/auth/oidc/oidc-flow.service.ts
git commit -m "fix(backend): @nestjs/passport v12 AuthModuleOptions regression + tipi jwt.expiresIn

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 7: `@comunicapa/shared-types` — `dist/esm/package.json` con `type: module`

Warning osservato nello spike (`MODULE_TYPELESS_PACKAGE_JSON`) — non bloccante ma da eliminare prima del merge, pattern standard per pacchetti dual CJS/ESM.

**Files:**
- Modify: `packages/shared-types/tsconfig.esm.json` (o script di build, a seconda di come è strutturato oggi — verificare con `cat` prima di modificare).
- Create (a runtime, non nel repo): `packages/shared-types/dist/esm/package.json`

**Interfaces:**
- Nessuna — fix di metadata, nessun export cambia.

- [ ] **Step 1: Ispezionare la build attuale di `shared-types`**

```bash
cat packages/shared-types/tsconfig.esm.json
cat packages/shared-types/package.json | grep -A 10 '"exports"'
```

- [ ] **Step 2: Aggiungere un `package.json` minimale in `dist/esm/`**

Il modo più semplice e portabile: un file statico committato nel repo sorgente che la build copia (o, se la build già ha un passo di post-processing, aggiungerlo lì). Verificare prima se esiste già uno script di build per `shared-types` oltre alle due chiamate `tsc` documentate in CLAUDE.md:

```bash
grep -rn "shared-types" apps/backend/Dockerfile apps/backend/Dockerfile.dev
```

Se la build è solo le due chiamate `tsc -p tsconfig.cjs.json && tsc -p tsconfig.esm.json` (come documentato in CLAUDE.md), aggiungere un source file dedicato che tsc copierà: creare `packages/shared-types/src/esm-package.json` NON è un file `.ts`, quindi tsc non lo tocca — il modo corretto è aggiungere una riga esplicita nei Dockerfile subito dopo le due chiamate `tsc`:

In **ogni Dockerfile/Dockerfile.dev che builda shared-types** (backend, frontend-admin, frontend-citizen — tutti e tre, per lo stesso principio già documentato in CLAUDE.md sulla build duale), dopo la riga:

```dockerfile
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json \
 && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json
```

aggiungere:

```dockerfile
RUN echo '{"type":"module"}' > packages/shared-types/dist/esm/package.json
```

- [ ] **Step 3: Applicare la stessa riga anche in locale per testare**

```bash
echo '{"type":"module"}' > packages/shared-types/dist/esm/package.json
```

(questo comando va rieseguito a ogni build pulita in locale — è il motivo per cui va nel Dockerfile, non lasciato come passo manuale).

- [ ] **Step 4: Verifica — nessun warning `MODULE_TYPELESS_PACKAGE_JSON` al boot**

Verificata nel Task 11 (boot smoke test) — qui solo applicare la modifica ai Dockerfile.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/Dockerfile apps/backend/Dockerfile.dev apps/frontend-admin/Dockerfile apps/frontend-admin/Dockerfile.dev apps/frontend-citizen/Dockerfile apps/frontend-citizen/Dockerfile.dev
git commit -m "fix(shared-types): dist/esm/package.json con type:module, elimina warning Node

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 8: Configurazione Vitest

**Files:**
- Create: `apps/backend/vitest.config.ts`
- Create: `apps/backend/vitest.setup.ts`

**Interfaces:**
- Produce: `globalThis.jest` alias a `vi` (consumato da tutti i 109 file `.spec.ts` esistenti, che usano `jest.fn`/`jest.spyOn`/`jest.clearAllMocks`/ecc. senza modifiche).

- [ ] **Step 1: Creare `apps/backend/vitest.config.ts`**

```typescript
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Vitest sostituisce Jest/ts-jest per il backend ESM (Nest v12).
// swc gestisce decorator/metadata (esbuild di default non li supporta),
// stesso pattern documentato nei progetti e2e ufficiali NestJS+Vitest.
export default defineConfig({
  test: {
    globals: true,
    root: './src',
    include: ['**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['../vitest.setup.ts'],
    // Stesso vincolo gia' noto per jest (--maxWorkers=2, vedi CLAUDE.md):
    // troppi worker paralleli saturano CPU/RAM e gli hook
    // Test.createTestingModule vanno in timeout non per un bug reale ma
    // per starvation.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      include: ['**/*.(t|j)s'],
      reportsDirectory: '../coverage',
    },
  },
  plugins: [
    tsconfigPaths(),
    swc.vite({
      module: { type: 'es6' },
      // Senza questo, Test.createTestingModule().compile() va in hang
      // silenzioso (timeout hook 10s, nessun errore leggibile) per
      // perdita dei design:paramtypes su cui si basa la DI di Nest.
      jsc: {
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});
```

- [ ] **Step 2: Creare `apps/backend/vitest.setup.ts`**

```typescript
// Shim di compatibilita': i 1142 test esistenti usano l'API globale `jest`
// (jest.fn/mock/spyOn/clearAllMocks/useFakeTimers/Mock/Mocked...). Vitest
// espone la stessa API sotto `vi` - alias globale per zero riscrittura dei
// file .spec.ts esistenti durante la migrazione a Vitest.
import { vi } from 'vitest';

(globalThis as unknown as { jest: typeof vi }).jest = vi;
```

- [ ] **Step 3: Verifica — un singolo file di test gira**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w/apps/backend node:26-alpine node_modules/.bin/vitest run channels/anpr/anpr.service.spec.ts
```

Expected: `Test Files 1 passed`, tutti i test del file verdi (7 test attesi, verificato nello spike).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/vitest.config.ts apps/backend/vitest.setup.ts
git commit -m "feat(backend): configurazione Vitest, shim compatibilita jest->vi

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 9: `jest.mock()` → `vi.mock()` (hoisting statico)

L'alias `globalThis.jest = vi` (Task 8) copre `jest.fn`/`spyOn`/`clearAllMocks`/ecc., ma NON `jest.mock()`: l'hoisting di `vi.mock()` è statico (Vitest cerca sintatticamente `vi.mock` prima di transpilare) — una chiamata `jest.mock(...)` non viene mai hoistata, causando import del modulo reale prima del mock.

**Files:**
- Modify: 18 file `.spec.ts` sotto `apps/backend/src/**` (identificati da grep, elencati sotto).

**Interfaces:**
- Nessuna — sostituzione 1:1 di `jest.mock(` con `vi.mock(`, stessa firma e comportamento della funzione.

- [ ] **Step 1: Identificare i file**

```bash
grep -rl "jest\.mock(" apps/backend/src --include=*.spec.ts
```

Expected (18 file, verificato nello spike):
```
apps/backend/src/auth/ldap/ldap.service.spec.ts
apps/backend/src/auth/oidc/oidc-flow.service.spec.ts
apps/backend/src/auth/strategies/oidc-citizen.strategy.spec.ts
apps/backend/src/campaigns/campaigns.service.spec.ts
apps/backend/src/campaigns/retention-cleanup.service.spec.ts
apps/backend/src/channels/app-io/app-io-delivery.service.spec.ts
apps/backend/src/channels/email/email.strategy.spec.ts
apps/backend/src/channels/pec/pec.strategy.spec.ts
apps/backend/src/channels/postal/globalcom-client.service.spec.ts
apps/backend/src/common/all-exceptions.filter.spec.ts
apps/backend/src/common/sentry.util.spec.ts
apps/backend/src/enrichment/enrichment-resume.service.spec.ts
apps/backend/src/external-api/external-api-exception.filter.spec.ts
apps/backend/src/external-api/external-api.service.spec.ts
apps/backend/src/external-api/external-attachment-tokens.service.spec.ts
apps/backend/src/external-api/external-attachments.controller.spec.ts
apps/backend/src/queue/notification.processor.spec.ts
apps/backend/src/queue/protocollazione.processor.spec.ts
```

Se la lista differisce (nuovo codice aggiunto medio tempo), usare l'output reale del grep — questa lista è un riferimento, non una fonte di verità assoluta.

- [ ] **Step 2: Sostituire, aggiungendo l'import se mancante**

```bash
for f in $(grep -rl "jest\.mock(" apps/backend/src --include=*.spec.ts); do
  if ! grep -q "from 'vitest'" "$f"; then
    sed -i "1i import { vi } from 'vitest';" "$f"
  fi
  sed -i "s/jest\.mock(/vi.mock(/g" "$f"
done
```

- [ ] **Step 3: Verifica — zero occorrenze residue**

```bash
grep -rl "jest\.mock(" apps/backend/src --include=*.spec.ts | wc -l
```

Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src
git commit -m "fix(backend): jest.mock -> vi.mock, hoisting statico Vitest non intercetta l'alias runtime

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 10: Verifica mirata Vitest + `nest build` pulito (suite completa demandata a CI)

**Vincolo risorse (vedi Global Constraints): niente suite completa in locale.** Questo task esegue solo un sottoinsieme rappresentativo mirato — un file per area/canale toccato dai fix dei task precedenti — non l'intera suite da 1142 test. La verifica whole-suite avviene in CI dopo il push (Task 12).

**Files:**
- Nessuna modifica di file prevista in questo task — è verifica pura. Se emergono fallimenti reali (non i 3 problemi già risolti nei task 2-9) nel sottoinsieme testato, la loro fix va aggiunta qui come step extra, con lo stesso rigore "no placeholder": codice reale, non "sistemare i test che falliscono".

**Interfaces:**
- Nessuna.

- [ ] **Step 1: Rebuild del container/volume node_modules**

```bash
docker compose build backend
docker compose rm -sf backend
docker volume rm comunicapa_backend_node_modules
docker compose up -d backend
```

- [ ] **Step 2: Verificare che il container backend dev bootI correttamente**

```bash
docker compose logs backend --tail 30
```

Expected: `Nest application successfully started`, nessun `ExceptionHandler` error nei log.

- [ ] **Step 3: `nest build` pulito**

```bash
docker compose exec backend node_modules/.bin/nest build
```

Expected: nessun output (successo silenzioso, come per `tsc`).

- [ ] **Step 4: Verifica mirata — un file rappresentativo per ciascuna area toccata dai fix**

```bash
docker compose exec backend node_modules/.bin/vitest run \
  auth/auth.module.spec.ts \
  auth/oidc/oidc-flow.service.spec.ts \
  auth/strategies/oidc-citizen.strategy.spec.ts \
  queue/notification.processor.spec.ts \
  queue/queue.module.spec.ts \
  channels/anpr/anpr.service.spec.ts \
  channels/postal/globalcom-client.service.spec.ts \
  channels/domicilio/domicilio.service.spec.ts \
  database/data-source.spec.ts
```

(se uno di questi file non esiste — es. `auth.module.spec.ts`/`queue.module.spec.ts`/`data-source.spec.ts` potrebbero non avere uno spec dedicato — ometterlo dalla lista, non crearne uno nuovo: non è nello scope di questo task).

Expected: tutti i file eseguiti passano, **zero fallimenti nuovi** rispetto alla baseline nota.

- [ ] **Step 5: `tsc --noEmit` finale (include gli spec file, esclusi dalla build ma non dal type-check)**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: zero errori.

- [ ] **Step 6: Se emergono fallimenti non attesi, diagnosticare con `superpowers:systematic-debugging` prima di patchare**

Non a caso qui non ci sono step di "fix" pre-scritti: qualunque fallimento oltre alla baseline nota è per definizione un problema non ancora diagnosticato in questo piano. Seguire il processo di debug sistematico invece di patch-e-spera.

- [ ] **Step 7: Commit (solo se sono stati necessari fix aggiuntivi in Step 6)**

```bash
git add -A
git commit -m "fix(backend): risolvi regressioni emerse dalla suite Vitest completa

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 11: Dockerfile prod — verifica build reale e boot smoke test

**Files:**
- Modify: `apps/backend/Dockerfile` (verificare `CMD`/entrypoint, aggiornare se necessario).
- Modify: `apps/backend/Dockerfile.dev` (verificare `CMD`, tipicamente `node_modules/.bin/nest start --watch` — verificare che non serva `.js` esplicito lì, essendo gestito dalla CLI Nest).

**Interfaces:**
- Nessuna.

- [ ] **Step 1: Ispezionare il `CMD`/entrypoint attuale**

```bash
grep -n "CMD\|ENTRYPOINT" apps/backend/Dockerfile apps/backend/Dockerfile.dev
```

Se compare `CMD ["node", "dist/main"]` (senza `.js`), cambiarlo in `CMD ["node", "dist/main.js"]` — Node ESM non applica la risoluzione automatica delle estensioni che CJS applicava.

- [ ] **Step 2: Build immagine prod reale (non `Dockerfile.dev`)**

```bash
docker build --no-cache -f apps/backend/Dockerfile -t comunicapa-backend-esm-test .
```

Expected: build completa senza errori. Se fallisce sul passo `pnpm --filter backend deploy --prod`, tornare al Task 1 (il probe isolato lì potrebbe non aver colto un dettaglio specifico di questo Dockerfile — confrontare gli step esatti).

- [ ] **Step 3: Boot smoke test contro Postgres/Redis reali del dev stack**

```bash
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker run --rm --network comunicapa_comunicapa-net \
  -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/comunicapa_db" \
  -e REDIS_URL="redis://redis:6379" \
  -e JWT_SECRET="dev-secret-change-in-production" \
  -e DOWNLOAD_LINK_SECRET="change-me-in-production-use-openssl-rand-hex-32" \
  -e LDAP_HOST="mock" \
  -e PORT=8081 \
  comunicapa-backend-esm-test > /tmp/boot-final.log 2>&1 &
sleep 15
docker stop $(docker ps -q --filter ancestor=comunicapa-backend-esm-test) 2>/dev/null
cat /tmp/boot-final.log | tail -50
```

Expected: `Nest application successfully started`, `Backend running on http://0.0.0.0:8081`, **nessun** warning `MODULE_TYPELESS_PACKAGE_JSON` (verifica che il Task 7 abbia funzionato), nessun `ExceptionHandler` error.

- [ ] **Step 4: Commit (se sono stati necessari cambi al Dockerfile)**

```bash
git add apps/backend/Dockerfile apps/backend/Dockerfile.dev
git commit -m "fix(backend): CMD dist/main.js esplicito, Node ESM non risolve estensioni implicite

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

---

## Task 12: Smoke test funzionale end-to-end + aggiornamento CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (nuova sezione con i learning di questa migrazione — pattern già in uso nel repo per ogni bug reale scoperto).

**Interfaces:**
- Nessuna.

- [ ] **Step 1: Smoke test funzionale sul dev stack reale**

```bash
docker compose up -d backend
TOKEN=$(docker compose exec backend node -e "
const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');
console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))
" | tr -d '\r')
docker compose exec -e TOKEN="$TOKEN" backend node -e "
fetch('http://localhost:8080/admin/campaigns', { headers: { Authorization: 'Bearer '+process.env.TOKEN } })
  .then(r => r.json())
  .then(d => console.log('campaigns count:', Array.isArray(d) ? d.length : JSON.stringify(d).slice(0,200)))
  .catch(e => console.error('ERR', e));
"
```

Expected: `campaigns count: N` (un numero, non un errore) — conferma che DB, JWT, routing HTTP funzionano end-to-end sul container ESM.

Nota: lo script inline `node -e` con `require()` funziona ancora perché Node permette `require()` di moduli CJS anche da un contesto lanciato come one-off (`node -e` non eredita `"type":"module"` del package.json del progetto per il proprio contesto di esecuzione top-level in questo modo — se questo comando fallisse con `ERR_REQUIRE_ESM` o simile, sostituire con equivalente `import()` dinamico e adattare CLAUDE.md di conseguenza).

- [ ] **Step 2: Aggiornare CLAUDE.md**

Aggiungere una sezione (posizione: dopo la sezione `@comunicapa/shared-types` esistente, prima di `## TypeScript`) con il seguente contenuto, adattando eventuali dettagli emersi durante l'esecuzione reale di questo piano che differiscono da quanto previsto qui:

```markdown
## Backend NestJS v12 (ESM) — migrazione completata

Il backend è ESM puro (`"type": "module"`, `moduleResolution: NodeNext`)
dalla migrazione a NestJS v12 (v10 era CommonJS). Punti che restano
gotcha per lavoro futuro:

- **Ogni nuovo import relativo richiede `.js` esplicito**
  (`from './foo.js'`, non `from './foo'`) — vincolo Node ESM nativo con
  `moduleResolution: NodeNext`, TS lo mappa al file `.ts` corrispondente
  in compilazione. Dimenticarlo produce `Cannot find module` solo a
  runtime su `dist/`, non sempre a `tsc --noEmit` (dipende dal path).
- **Import di pacchetti CJS**: verificare sempre se il pacchetto espone
  un default export "sintetico" problematico sotto NodeNext (visto con
  `ioredis` v6: serve `import { Redis } from 'ioredis'`, non l'import di
  default) — non assumere che un pacchetto CJS funzioni automaticamente
  con l'import di default solo perché ha sempre funzionato in CJS.
- **`@nestjs/passport` — `AuthGuard()` richiede sempre
  `PassportModule.register({})` esplicito**, mai l'import nudo di
  `PassportModule` (che non fornisce alcun provider) — regressione v12
  dove `@Optional()` sul provider `AuthModuleOptions` non è rispettato
  dal mixin, causa `UnknownDependenciesException` invece di `undefined`.
- **Vitest sostituisce Jest** (`docker compose exec backend
  node_modules/.bin/vitest run`, stesso vincolo `--maxWorkers`→
  `poolOptions.forks.maxForks: 2` già noto per jest). `vitest.setup.ts`
  fa da shim (`globalThis.jest = vi`) per i test esistenti — ma
  **`jest.mock()` non viene hoistato** dallo shim (l'hoisting di
  `vi.mock()` è statico, cerca sintatticamente `vi.mock` nel sorgente):
  ogni nuovo test che deve mockare un modulo intero va scritto con
  `vi.mock(...)` letterale, mai `jest.mock(...)`.
- **`unplugin-swc` in `vitest.config.ts` richiede
  `jsc.transform.decoratorMetadata: true` esplicito** — senza, la DI di
  Nest (`Test.createTestingModule().compile()`) va in **hang silenzioso**
  (timeout hook, nessun errore) per perdita dei `design:paramtypes`.
- **`typeorm-ts-node-esm`** sostituisce `typeorm-ts-node-commonjs` in
  tutti i comandi di migration CLI documentati sopra (sezione
  "Migration DB") — stesso utilizzo, solo binario diverso.
- **`dist/esm/package.json` con `{"type":"module"}`** va rigenerato a
  ogni build di `@comunicapa/shared-types` (i Dockerfile lo fanno con un
  `echo` dopo le due chiamate `tsc` — vedi Dockerfile backend/frontend-
  admin/frontend-citizen) — senza, Node logga
  `MODULE_TYPELESS_PACKAGE_JSON` a ogni boot (non bloccante, ma da
  eliminare).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: aggiorna CLAUDE.md con learning migrazione NestJS v12 ESM

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

- [ ] **Step 4: Abilitare CI (`tests.yml`) anche su pull request**

`tests.yml` oggi triggera solo su `push: branches: [main]` — non gira mai su un branch feature/PR. Dato che la verifica whole-suite di questa migrazione è demandata esplicitamente a CI (vedi Global Constraints/Task 10), serve farla girare PRIMA del merge, non dopo. In `.github/workflows/tests.yml`, cambiare:

```yaml
on:
  push:
    branches: [main]
```

in:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

```bash
git add .github/workflows/tests.yml
git commit -m "ci: esegui tests.yml anche su pull_request verso main

Necessario per validare la suite Vitest completa in CI prima del merge
della migrazione NestJS v12 ESM (verifica locale volutamente limitata
a test mirati, vedi piano).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AzaWjo41oFJK2355bKqG8Z"
```

- [ ] **Step 5: Push branch e aprire PR**

```bash
git push -u origin feature/nestjs-v12-esm
gh pr create --base main --head feature/nestjs-v12-esm \
  --title "feat(backend): migrazione NestJS v12 (ESM)" \
  --body "Migrazione completa backend a NestJS v12 ESM. Spec: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md — Piano: docs/superpowers/plans/2026-09-05-nestjs-v12-esm-migration.md

Verifica locale: test mirati per area (vedi Task 10), suite completa demandata a questa CI. Attendere l'esito di tests.yml su questa PR prima del merge."
```

- [ ] **Step 6: Attendere l'esito di CI sulla PR prima di procedere al merge**

```bash
gh pr checks --watch
```

Expected: `tests.yml` verde. Se fallisce, NON forzare il merge — il fallimento in CI (ambiente pulito, Node 22, pnpm v9, nessuno dei workaround/volumi Docker locali) è il segnale più affidabile che questo piano abbia prodotto, esattamente perché è indipendente dallo stato locale mutato di questa sessione. Diagnosticare con `superpowers:systematic-debugging`.

Non fare merge diretto in main senza che CI sia verde — questo è un cambiamento ad alto impatto (intero backend, framework core). Seguire `superpowers:requesting-code-review` prima di procedere al merge, anche a CI verde.

- [ ] **Step 7: Chiudere le 6 PR dependabot obsolete**

```bash
gh pr close 12 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
gh pr close 15 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
gh pr close 17 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
gh pr close 18 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
gh pr close 20 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
gh pr close 21 -c "Sostituita da migrazione manuale coordinata: docs/superpowers/specs/2026-09-05-nestjs-v12-esm-migration-design.md"
```

(numeri PR verificati all'inizio di questa sessione — confermare con `gh pr list` che siano ancora questi prima di chiuderle, potrebbero essere cambiati nel frattempo).
