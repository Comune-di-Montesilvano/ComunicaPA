# CI/CD & Dependabot

## CI/CD

## Dependabot — bump "a scaglioni" su pacchetti fratelli, verificare sempre l'intera famiglia

Dependabot bumpa un pacchetto per volta: un major su un solo membro di
una famiglia (`@tiptap/starter-kit` senza `@tiptap/react`/
`@tiptap/extension-link`) lascia versioni incrociate nell'albero —
doppio `@tiptap/core` risolto, TS rifiuta i tipi (`ChainedCommands`
senza `toggleBold` ecc.), pur senza errore a runtime. Prima di mergiare
un major su un pacchetto con "fratelli" nello stesso `package.json`,
allinearli tutti alla stessa major a mano, poi `pnpm install
--lockfile-only` (pattern Docker già noto) e riverificare la build.

**Bump TypeScript major (5→6, es. dependabot) — TS 6.0 cambia il default di
`types` da "tutto `node_modules/@types`" a `[]`.** Rompe silenziosamente
`tsc -p tsconfig.spec.json`/jest ovunque il codice usi globali ambient senza
import esplicito (`describe`/`it`/`expect` di `@types/jest`, mai importati
nei `.spec.ts` che girano su vitest con `globals:true`) — decine di file,
zero errore a runtime, solo type-check. Fix: `"types": ["node", "jest"]`
esplicito in `apps/backend/tsconfig.spec.json`; per
`packages/shared-types` (niente tsconfig.json bare, ts-jest sui default)
va nel `transform` di `jest.config.js`:
`['ts-jest', { tsconfig: { types: ['jest', 'node'] } }]`. `@types/node`
resta incluso com'era (pull-in transitivo via `/// <reference types="node"/>`
di altri `@types` importati), non serve toccarlo nel tsconfig prod.
**TS 7 resta bloccato a monte**: typescript-eslint 8.70 rifiuta
esplicitamente la riscrittura tsgo (`typescript-eslint/typescript-eslint#10940`,
ancora open) — peer range attuale `>=4.8.4 <6.1.0`, fermarsi a 6.x finché
non c'è supporto.

**Merge sequenziale di più PR dependabot**: dopo ogni merge, le PR
successive passano da `mergeable:true` a `CONFLICTING`/`BEHIND` (lockfile
cambiato) — un solo `@dependabot rebase` non basta se altre merge
arrivano nel frattempo, va ripetuto finché `gh pr view N --json
mergeStateStatus` non torna `CLEAN` (non fidarsi del solo `mergeable`,
resta `MERGEABLE` anche con branch behind se `strict` non lo blocca
ancora).

**Merge PR dependabot — usare update-branch diretto, non `@dependabot rebase`, quando possibile.**
Se `mergeStateStatus` è `BEHIND` (mai conflitto reale), `gh api -X PUT
repos/<org>/<repo>/pulls/<N>/update-branch` aggiorna il branch in pochi
secondi — molto più veloce di commentare `@dependabot rebase`, che può
metterci 10-20+ minuti o non rispondere affatto. Riservare
`@dependabot rebase` al solo caso `CONFLICTING` (conflitto vero, es.
lockfile), dove update-branch non basta.

**vitest 3→5 — mock costruiti con `new` devono usare `function`, mai arrow
function, in `mockImplementation()`.** Vitest 5 fa `Reflect.construct()`
sull'implementation per incatenare il prototype quando il mock viene
chiamato con `new` — un'arrow function non ha `[[Construct]]` e lancia
`"...is not a constructor"`. Sintomo tipico: mock di un client
(`ioredis`, ecc.) che prima funzionava con `jest.fn().mockImplementation(()
=> obj)`.

**eslint-plugin-react-hooks 5→7 aggiunge il ruleset "React Compiler" al
preset `recommended`**, anche per progetti che non l'hanno adottato —
nuove regole (`set-state-in-effect`, riferimento a variabile prima della
dichiarazione, mutazione di `window.location`/valori esterni al
componente) diventano errori bloccanti. Per un progetto senza React
Compiler: fixare i casi genuini (riordino dichiarazioni, helper esterno
per `window.location`), disattivare solo la regola specifica rumorosa
(`react-hooks/set-state-in-effect`) con commento — mai l'intero preset.

**`@eslint/js` 9→10 abilita `no-useless-assignment`** — trova
assegnazioni iniziali sempre sovrascritte in ogni ramo prima di essere
lette (bug reale, non solo stile): fixare rimuovendo l'inizializzatore
morto (`let x: T;` invece di `let x: T = default;`).

`.github/workflows/release.yml`: triggera SOLO su tag `v*` (mai su push a main, nonostante il tag `dev` nel metadata-action — condizione mai raggiunta, riga corretta dopo audit). Push tag → `:vX.Y.Z` + `:latest` su `ghcr.io/comune-di-montesilvano/comunicapa-*`. Namespace hardcoded lowercase (il nome org ha maiuscole e romperebbe il cache exporter buildx). Allegati: path fisso `/data/attachments` nel container, volume named `attachments_data`.

**`main` è protetto (dal 2026-09-06): required check `run-tests`, no force-push, no delete branch.** Push diretto a main viene RIFIUTATO — serve sempre branch + PR + CI verde + merge. `tests.yml` triggera anche su `pull_request` (non solo push a main), quindi il check gira già sulla PR prima del merge.

**`tests.yml` usa pnpm v11.9.0/Node 26** (stesso pattern `--ignore-scripts` + `pnpm rebuild esbuild` dei Dockerfile, vedi sezione sotto) ed esegue anche `pnpm lint` (reale, non più placeholder — vedi `apps/*/eslint.config.{mjs,js}`) e `pnpm build` (stesso comando delle immagini Docker) prima dei test — un errore di compilazione o lint viene preso qui, non solo al build immagine su tag.

**`release.yml` scansiona ogni immagine con Trivy** (CRITICAL/HIGH, report-only, risultati su tab Security) subito dopo il push su ghcr.

**Tutte le Actions nei 3 workflow sono pinnate per commit SHA** (non tag mobile `@v7`), con commento `# vX` per leggibilità — dependabot (ecosistema `github-actions` già configurato) apre PR per bump futuri.

**Tag pushato = solo build immagine, MAI deploy automatico.** Push+tag
fanno partire CI che builda/pusha su ghcr — il container di produzione
resta sul vecchio codice finché qualcuno non fa pull+redeploy su Portainer.
`gh run list --workflow=release.yml` conferma solo che la build è
riuscita, non che prod la stia servendo.

**Spostare un tag Git (delete+recreate) scollega la GitHub Release.**
Prima di spostare: `gh release view <tag>` — se torna "release not found",
nessuna Release è collegata e lo spostamento è sicuro senza bisogno di
alcun fix successivo.
Cancellare e ricreare un tag già associato a una Release lo trasforma in
una release "draft"/`untagged-<sha>` (nascosta, scollegata). Fix: `gh
release edit <tag> --tag <tag> --draft=false` — riattacca la release al
tag senza bisogno di cancellarla e ricrearla. `gh release delete` (e a
volte anche `gh release edit --help`) vengono bloccati dal classificatore
di sicurezza di Claude Code (cancellazione irreversibile) — preferire
sempre il fix non distruttivo sopra.

