# Migrazione backend a NestJS v12 (ESM) — design

## Contesto

6 PR dependabot (`@nestjs/common`, `config`, `typeorm`, `bullmq`, `core`,
`platform-express`) bumpano da v10 a v12. `@nestjs/core@12`/`@nestjs/common@12`
sono **ESM-only** (`"type": "module"`, verificato su registry npm) — non
richiedono via di mezzo, `@nestjs/config@12`/`@nestjs/passport@12` dichiarano
peer dep `@nestjs/common ^11 || ^12`, quindi niente adozione parziale.

Il backend oggi è CommonJS end-to-end: `tsconfig` compila CJS, `nest build`
emette CJS, jest/ts-jest gira in CJS, `pnpm --filter backend deploy --prod`
per l'immagine Docker assume CJS. Passare a Nest v12 richiede convertire
l'intero backend a moduli ES nativi.

**Spike di fattibilità già eseguito** (branch throwaway, scartato a fine
sessione): l'app boota completamente in ESM contro Postgres/Redis reali
(TypeORM/BullMQ/~110 route ok). Confermato fattibile, con 4 problemi reali
già diagnosticati (vedi sezione Problemi noti).

## Obiettivo

Migrazione **ESM completa** del backend (non un bridge `require(esm)` da
CJS — troppo fragile per il grafo DI di Nest, nessun top-level await
garantito). Build/test tooling: **tsc invariato** per `nest build`,
**Vitest** al posto di Jest (scelta esplicita dell'utente, nonostante il
maggior lavoro rispetto a tenere Jest — vedi sezione Test).

## Rollout

**Big bang su branch dedicato**, mai incrementale su main: nessuno stato
intermedio semi-ESM deployabile. Merge in main solo a verifica completa
(suite Vitest verde, `nest build` pulito, build Docker prod reale per
backend, boot smoke-test contro Postgres/Redis reali). Nessun blue-green
in produzione oggi (restart automatico `unless-stopped`) — il merge deve
essere sicuro al 100% prima di un deploy reale.

## Componenti toccati

### 1. `package.json` / `tsconfig.json`

- `apps/backend/package.json`: `"type": "module"`, bump di tutti gli
  `@nestjs/*` (common/config/core/jwt/passport/platform-express/typeorm/
  bullmq/schedule/cli/schematics/testing) a `^12.x`. Nessuno di questi va
  lasciato a v10 — vedi peer-dep constraint sopra.
- `apps/backend/tsconfig.json`: `module`/`moduleResolution` → `NodeNext`.
- Sostituire `jest`/`ts-jest`/`@types/jest` (runtime) con `vitest` +
  `unplugin-swc` + `vite-tsconfig-paths`. `@types/jest` resta come
  devDependency **solo per i tipi** (`jest.Mock`/`jest.Mocked<T>` usati nei
  1142 test esistenti) — nessun runtime jest realmente eseguito.

### 2. Import relativi — estensione `.js` esplicita

`moduleResolution: NodeNext` richiede `.js` su ogni import/export/dynamic-
import relativo nel sorgente TS (mappato da TS al file `.ts` corrispondente
in fase di compilazione — convenzione standard Node ESM, non un errore).
**749 specifier in 137 file** (spike, misurato con grep). Riscrittura
meccanica via codemod (script Node, non AST-based: pattern verificato
sufficientemente semplice — solo `from '/import\('` seguiti da path
relativo senza estensione, nessun caso limite trovato nel grep preliminare).

### 3. `__dirname`/`__filename`

Non esistono in ESM. Un solo punto nel codebase: `data-source.ts`
(`migrations: [\`${__dirname}/migrations/*.{ts,js}\`]`). Fix:
`fileURLToPath(import.meta.url)` + `dirname()`.

### 4. Interop CJS→ESM — problemi noti, non generalizzabili a priori

Tutte le dipendenze CJS del backend (ldapjs, soap, pg, multer, jsonwebtoken,
bullmq, ioredis, passport, class-validator/transformer, adm-zip, yauzl,
pdf-lib, reflect-metadata, rxjs) restano importabili da ESM senza problemi
strutturali — la direzione ESM→CJS è matura in Node. Il problema è
l'interop dei **default export sintetici**, verificato caso per caso:

- **`ioredis` v6**: `import Redis from 'ioredis'` (default import) NON
  risolve sotto `NodeNext` (`TS2709`/`TS2351`) — fix: `import { Redis }
  from 'ioredis'` (named export, esposto da ioredis stesso). 4 punti nel
  codebase (`oidc-flow.service.ts`, `oidc-citizen.strategy.ts`,
  `notification.processor.ts`, `queue.module.ts`).
- Non assumere che altri pacchetti CJS abbiano lo stesso problema o siano
  esenti: verificare `tsc --noEmit` dopo ogni bump, non prevedere a tavolino.
  Nello spike solo `ioredis` ha richiesto questo fix specifico.

### 5. `@nestjs/passport` v12 — regressione framework, non nostro bug

`AuthGuard()` (mixin di `@nestjs/passport`) inietta `AuthModuleOptions` con
`@Optional()` dichiarato nel sorgente del pacchetto, ma in v12 il fallimento
di risoluzione lancia comunque `UnknownDependenciesException` invece di
iniettare `undefined` come dovrebbe. Riprodotto e isolato nello spike
(guard `OidcAuthGuard` in `CitizenModule`). Fix pragmatico: **non basta**
esportare `PassportModule` da `AuthModule` (nessun provider realmente
fornito, `PassportModule` importato nudo è un modulo vuoto) — serve
`PassportModule.register({})` esplicito in `auth.module.ts`, che FORNISCE
`AuthModuleOptions` (anche vuoto) invece di affidarsi a `@Optional()`.

### 6. Vitest — 3 problemi reali, tutti risolti nello spike

- **Compatibilità API `jest.*`**: i 1142 test esistenti usano l'API
  globale `jest` (`jest.fn`/`spyOn`/`clearAllMocks`/`useFakeTimers`/
  `Mock`/`Mocked`). Fix a costo zero: `vitest.setup.ts` con
  `globalThis.jest = vi` — Vitest espone la stessa API sotto `vi`. Nessuna
  riscrittura dei file di test per queste chiamate.
- **`jest.mock()` non hoistato**: l'alias runtime `jest = vi` NON basta per
  `jest.mock()`/`vi.mock()` — l'hoisting di `vi.mock()` è **statico**
  (Vitest cerca sintatticamente la stringa `vi.mock` prima di transpilare),
  quindi una chiamata `jest.mock(...)` (anche se a runtime è `vi.mock`) non
  viene mai hoistata: il modulo reale viene importato prima del mock,
  causando timeout/chiamate di rete vere nei test che se ne aspettavano il
  mock. Fix: sostituire letteralmente `jest.mock(` → `vi.mock(` (18 file,
  identificati con grep) + `import { vi } from 'vitest'`.
- **Decorator metadata**: `unplugin-swc` (necessario per compilare i
  decorator Nest sotto Vite/Vitest, esbuild da solo non li supporta) NON
  emette `emitDecoratorMetadata` di default — senza,
  `Test.createTestingModule().compile()` va in **hang silenzioso** (timeout
  hook 10s, nessun errore leggibile) per perdita dei
  `design:paramtypes` su cui si basa la DI di Nest. Fix:
  `swc.vite({ jsc: { transform: { legacyDecorator: true, decoratorMetadata:
  true } } })` in `vitest.config.ts`.
- **Worker pool**: la suite completa in parallelo (default Vitest, un
  worker per core) produce hang/timeout diffusi per starvation CPU/RAM —
  stesso principio già noto per Jest in questo repo (`--maxWorkers=2`,
  vedi CLAUDE.md). Fix: `pool: 'forks', poolOptions: { forks: { maxForks:
  2 } }` in `vitest.config.ts`, più `testTimeout`/`hookTimeout` a 15s (i
  container CI/dev non sono mai istantanei sul primo cold-start SWC).

### 7. Build Docker (non ancora verificato nello spike — verificare in piano)

- `Dockerfile`/`Dockerfile.dev` di backend: nessuna riga nota da toccare
  per il tooling pnpm/corepack (già a posto dal lavoro precedente in questa
  sessione), ma il `CMD`/entrypoint (`node dist/main.js`, non `node
  dist/main`) e ogni riferimento a `.js` esplicito vanno rivisti.
- `pnpm --filter backend deploy --prod --ignore-scripts --legacy
  /prod/backend`: non testato nello spike con `type: module` — verificare
  che l'albero standalone prodotto da `pnpm deploy` mantenga `package.json`
  con `"type": "module"` (necessario per Node interpreti correttamente
  `dist/*.js` come ESM in produzione).
- **`@comunicapa/shared-types`**: la build dual CJS/ESM esistente (vedi
  CLAUDE.md, sezione dedicata) resta invariata — il backend consumerà il
  ramo `"import"` degli `exports` invece di `"require"`. Warning osservato
  nello spike (`MODULE_TYPELESS_PACKAGE_JSON` su `dist/esm/index.js`,
  perché quella cartella non ha un proprio `package.json` con
  `"type":"module"`) — non bloccante ma da eliminare: aggiungere
  `dist/esm/package.json` con `{"type":"module"}` al termine della build
  ESM di `shared-types` (pattern standard per pacchetti dual CJS/ESM).
- **`typeorm-ts-node-esm`** (già presente in `node_modules/.bin`, drop-in
  per `typeorm-ts-node-commonjs`) sostituisce il binario nei comandi
  migration CLI documentati in CLAUDE.md.

### 8. Cosa NON è nello scope

- Nessuna riscrittura dei frontend (già ESM/Vite, non toccati).
- Nessuna migrazione degli script in `apps/backend/src/debug/` (esclusi da
  build/deploy, possono restare come sono o essere aggiornati opportunisticamente,
  non bloccante).
- Nessun cambio all'architettura DI/moduli oltre ai fix minimi sopra — non
  è un refactoring, è una migrazione di piattaforma.

## Testing

- `nest build` (tsc) pulito, zero errori.
- Vitest: suite completa verde (baseline = failure set identico a quello
  Jest attuale — 1 solo fallimento noto, `app.controller.spec.ts`
  `isLdapMock`). Se un nuovo fallimento emerge, è una regressione della
  migrazione, non una baseline nota — va risolto prima del merge.
- Boot smoke-test: `node dist/main.js` contro Postgres/Redis reali del
  dev stack (rete `comunicapa_comunicapa-net`), verificare log
  `Nest application successfully started` senza `ExceptionHandler` errors.
- Build Docker prod reale (`docker build -f apps/backend/Dockerfile .`,
  non solo `Dockerfile.dev`) — stesso principio già in CLAUDE.md per
  `shared-types`, il dev bind-mount ha già mascherato bug di produzione due
  volte in questo repo.
- `docker compose up -d backend` sullo stack dev reale, verifica manuale di
  almeno un flusso end-to-end (login LDAP mock + lista campagne via token
  debug, stesso smoke test usato nella sessione per ioredis v6).

## Rischi residui / non coperti dallo spike

- **`pnpm deploy --prod` con `type:module`**: non testato. Rischio reale
  che l'albero standalone perda o non propaghi correttamente `"type":
  "module"` — va verificato per primo nel piano, prima di investire tempo
  nel resto (potenziale showstopper equivalente al bug shared-types già
  documentato).
- Altri pacchetti CJS oltre `ioredis` potrebbero rivelare lo stesso
  problema di interop default-export solo durante la riscrittura completa
  (lo spike ha compilato l'intero `src/` ma non ha toccato ogni singolo
  branch a runtime — `tsc --noEmit` pulito non garantisce che ogni
  chiamata a runtime di un default-import CJS si comporti come atteso).
- Warning `unlisted peer dependency` / deprecazioni SWC non ancora
  auditate in dettaglio (visto solo un aggiornamento pnpm minor
  informativo nello spike, nulla di bloccante).
- Il modulo `enrichment` chiama il microservizio Python via HTTP interno —
  non impattato dalla migrazione (nessun import Node coinvolto), ma va
  comunque incluso nello smoke test end-to-end.
