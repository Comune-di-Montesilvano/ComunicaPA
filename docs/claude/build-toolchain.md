# Build & Toolchain — pnpm v11, shared-types, NestJS ESM, spec audit

## pnpm v11 in Docker — Regola critica

pnpm@latest è v11+ che blocca build script per default (`ERR_PNPM_IGNORED_BUILDS`). Pattern obbligatorio in ogni `Dockerfile.dev`:

```dockerfile
# Install senza lifecycle scripts
RUN pnpm install --ignore-scripts
# Per pacchetti Vite: rebuild esbuild esplicitamente
RUN pnpm install --ignore-scripts && pnpm rebuild esbuild

# CMD: usa il binario diretto — NON usare "pnpm run" o "pnpm --filter X dev"
# pnpm v11 esegue un deps-check preventivo che blocca di nuovo esbuild
WORKDIR /app/apps/backend
CMD ["node_modules/.bin/nest", "start", "--watch"]
```

## `@comunicapa/shared-types` — main deve puntare a `./dist`, mai a `./src`

Bug reale in produzione (crash-loop del backend): `packages/shared-types/package.json`
aveva `"main": "./src/index.ts"` (TS grezzo, nessuna build). In **dev**
funzionava per un caso fortuito — `docker-compose.override.yml` bind-monta
`packages/shared-types/src` e il layout pnpm workspace crea un **symlink**
`node_modules/@comunicapa/shared-types` → `../../packages/shared-types`
(fuori da `node_modules` una volta risolto il symlink), quindi Node 22 poteva
fare type-stripping nativo senza problemi. In **produzione**
(`apps/backend/Dockerfile`, `pnpm --filter backend deploy --prod`) il
pacchetto viene invece **copiato realmente dentro** `node_modules` (nessun
symlink — è il punto di `pnpm deploy`, un albero standalone) — e Node
blocca esplicitamente il type-stripping per qualunque file sotto
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), crashando il
backend al primo `require('@comunicapa/shared-types')` (es.
`payment-config.util.ts`). Mai riprodotto in dev, solo dal vivo in
produzione — l'ambiente dev bind-mount maschera completamente questa classe
di bug.

Fix (parte 1): `package.json` → puntare a `./dist`, mai a `./src`.

**Parte 2, bug successivo — CJS/ESM dual build.** Con `main` puntato a un
unico `./dist/index.js` compilato `CommonJS`, la build di produzione dei
frontend (`apps/frontend-admin/Dockerfile`, `tsc -b && vite build`) falliva
a sua volta: `"matchCountry" is not exported by ".../dist/index.js"` —
Rollup/Vite non rileva in modo affidabile i named export di un modulo CJS
risolto fuori da `node_modules` (via symlink workspace), anche quando il
pattern di export CJS è quello standard emesso da `tsc`. Riprodotto solo
buildando l'immagine Docker di produzione reale, mai nei container dev
(stesso motivo del bug precedente: dev maschera tutto).

Fix definitivo: **build duale**, `packages/shared-types/tsconfig.cjs.json`
(`module: CommonJS`, → `dist/cjs`) e `tsconfig.esm.json` (`module: ES2020`,
→ `dist/esm`, nessuna `.d.ts` — le dichiarazioni le emette solo la build
CJS). `package.json` usa `"exports"` condizionale:
```json
"exports": { ".": {
  "types": "./dist/cjs/index.d.ts",
  "import": "./dist/esm/index.js",
  "require": "./dist/cjs/index.js"
} }
```
Node (`require()`, backend) risolve `"require"` → CJS, invariato. Vite/Rollup
(frontend, sempre `import`) risolve `"import"` → ESM nativo, zero euristica
d'interop necessaria. `"main"`/`"types"` flat restano come fallback per tool
che non capiscono `"exports"`.

**Build in Docker — solo binario diretto, mai `pnpm --filter/run`.** Stesso
gotcha pnpm v11 già noto per `CMD` (vedi sezione sopra): `pnpm --filter
@comunicapa/shared-types build` fallisce in build con
`runDepsStatusCheck`/deps-check preventivo bloccante. Pattern corretto in
ogni Dockerfile/`Dockerfile.dev` (backend, frontend-admin, frontend-citizen
— tutti e tre consumano il pacchetto), subito dopo `pnpm install
--ignore-scripts`:
```dockerfile
RUN node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json \
 && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json
```
In CI (`.github/workflows/tests.yml`) invece va bene `pnpm --filter
@comunicapa/shared-types run build` — quella pipeline usa pnpm v9
(`pnpm/action-setup@v6 version: 9`), non v11, nessun deps-check bloccante.

**Conseguenza per lo sviluppo**: modificare `packages/shared-types/src/*.ts`
richiede un rebuild dei container che lo consumano (`docker compose build
backend frontend-admin frontend-citizen`) — il bind mount dev aggiorna solo
`src/`, mai `dist/cjs`/`dist/esm`, stesso pattern già noto per modifiche
fuori da `src/` dell'app stessa. **Prima di pushare qualunque modifica a
questo pacchetto o ai Dockerfile che lo buildano, verificare SEMPRE
buildando l'immagine di produzione reale in locale** (`docker build -f
apps/<app>/Dockerfile .`, non solo `Dockerfile.dev`) — il dev bind-mount ha
già mascherato due bug di produzione consecutivi in questa storia.

## `packages/shared-types` — ts-jest usa una lib vecchia (~ES2016), niente Object.entries/altri builtin ES2017+

Il pacchetto non ha un `tsconfig.json` bare (solo `tsconfig.cjs.json`/
`tsconfig.esm.json`) — ts-jest senza `jest.config` esplicito non eredita
`tsconfig.base.json` (target ES2022), usa un default più basso. Bug reale
preso in CI: `Object.entries()` in `index.ts` compilava pulito ovunque
tranne che nel test run (`TS2550`). Verificato isolando la compilazione
con `--lib es2016`: `Object.keys()` + accesso per chiave, stesso
risultato, compila pulito. Prima di usare un builtin ES2017+ (Object.entries/
values, Array.flatMap, ecc.) in questo pacchetto, verificare con lo stesso
isolamento o preferire l'equivalente ES2016.

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
- **`node-forge` — caso opposto a `ioredis` sopra: usare `import forge
  from 'node-forge'` (default), MAI `import * as forge from
  'node-forge'`.** Bug reale: node-forge non ha `exports` in
  `package.json` e il suo entry point attacca i sottomoduli dinamicamente
  (`require('./pki')` da FUORI del file, mai `module.exports.pki = ...`
  testuale) — sotto il loader ESM nativo di Node un `import * as forge`
  costruisce il namespace con SOLO `default` valorizzato:
  `forge.pki`/`forge.util`/`forge.asn1` tutti `undefined`. Nessun crash
  all'avvio, nessun log — solo un `TypeError` alla prima chiamata reale.
  **Mai riprodotto sotto Vitest** (esbuild/swc trasformano l'import in un
  `require()` diretto, aggirando l'interop nativo) — un fix su un
  pacchetto CJS del genere va sempre verificato anche con l'app reale o
  uno script standalone (`node --input-type=module -e "..."`), mai
  fidandosi della sola suite unit.
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

## Nuova dependency in un costruttore — audit spec esistenti

Aggiungere un parametro al costruttore di un Controller/Service rompe
silenziosamente ogni spec file che lo istanzia manualmente con `new X(a,
b)` altrove nel repo — TypeScript lo segnala solo se quello spec file
viene compilato, e `jest <pattern-mirato>` non tocca spec non correlati.
Bug reale: fase INAD aggiunge `InadService` al costruttore di
`SettingsController`, `settings.controller.spec.ts` (3 istanziazioni
dirette) resta rotto per settimane — scoperto solo eseguendo la suite
COMPLETA (`jest --maxWorkers=2`, non un pattern) durante un task
successivo non correlato. Dopo ogni modifica a una firma di costruttore,
lanciare la suite intera prima di dichiarare la baseline pulita.

**Un service molto testato può avere PIÙ `Test.createTestingModule` indipendenti anche nello stesso file, e/o in
file spec separati.** Aggiungere un parametro al costruttore non basta patchare un solo `beforeEach`: grep
`createTestingModule` nell'intero file E in tutto `src/` per lo stesso service prima di considerare il fix
completo — bug reale: `campaigns.service.spec.ts` aveva 12 builder indipendenti, più un tredicesimo in
`campaigns.service.cost.spec.ts`, scoperti solo eseguendo la suite completa dopo un fix parziale.

