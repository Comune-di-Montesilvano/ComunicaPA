# CI/CD & Dependabot

## CI/CD

## Dependabot auto-merge (`dependabot-automerge.yml`, pattern da GovPay-Interaction-Layer)

Minor/patch (gruppi `*-minor-patch` per ecosistema, schedule `daily`, `cooldown` 7 giorni, 14 sulle major solo per npm/pip (docker, docker-compose e github-actions non supportano `semver-major-days`, Dependabot rifiuta il file): una release compromessa ritirata nel frattempo non entra; gli advisory arrivano subito via security updates, a cui il cooldown non si applica) → `gh pr merge --auto` appena i required check sono verdi, poi la merge queue di main fa il resto (rimette la PR in pari con main e rilancia i check). Major e bump immagine `python` (minor per dependabot, upgrade runtime per noi) → PR lasciata aperta, manuale. Il vecchio job `update-behind` (aggiornava una PR `BEHIND` alla volta con la protection `strict`) è stato tolto con l'arrivo della merge queue.
Token GitHub App `comune-montesilvano-bot` (installata su tutta l'org), secret `BOT_CLIENT_ID`/`BOT_PRIVATE_KEY` sia come **Actions** sia come **Dependabot** secret (sul trigger `pull_request` di dependabot si vedono solo i secret Dependabot). Con `GITHUB_TOKEN` merge/update-branch non triggerano `tests.yml` → PR bloccate. Prerequisito repo: `allow_auto_merge` attivo.

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

`.github/workflows/release.yml`: push tag `v*` → `:vX.Y.Z` + `:latest` su `ghcr.io/comune-di-montesilvano/comunicapa-*` (Trivy report-only). Più rebuild giornaliero di `main` (cron 04:30 UTC, dopo il giro Dependabot delle 01:00 Europe/Rome, o `workflow_dispatch`): push `:latest-YYYYMMDD`, `APP_VERSION` = ultimo tag `v*`, Trivy BLOCCANTE (CRITICAL/HIGH con fix), solo se passa `latest` viene ripuntato al nuovo digest (`imagetools create`). Lo schedule salta se un tag è stato pubblicato nelle ultime 24 ore. Mai tocca i tag `vX.Y.Z`.

**`trivy-action` con `format: sarif` ignora `severity` se `limit-severities-for-sarif` non è `true`** (log: "Building SARIF report with all severities") → `exit-code: 1` scatta anche su LOW/MEDIUM. Nel rebuild il flag è attivo; in locale una scansione `--severity CRITICAL,HIGH` pulita non basta a dimostrare che la CI passi se il flag manca.

**Rebuild bloccato da Trivy = di solito CVE reali.** Il formato SARIF non stampa le CVE nel log (solo `exit code 1`): per vederle `docker run --rm aquasec/trivy image --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed ghcr.io/comune-di-montesilvano/comunicapa-<app>:latest-YYYYMMDD`. Tre fonti tipiche:
- pacchetti OS dell'immagine base → `apk/apt upgrade` nel runtime stage, rinfrescato ogni giorno da `ARG PKG_REFRESH` (data del giorno passata da `release.yml`; senza, la cache registry congela il layer);
- tool non usati a runtime con dipendenze bundled (npm/corepack nell'immagine node, pip `_vendor` nel pdf-extractor) → rimossi nei Dockerfile;
- npm transitive (Dependabot bumpa solo le dirette) → `pnpm update -r --lockfile-only --depth Infinity <pkg...>`; se un padre fissa la versione esatta (es. `@nestjs/platform-express` → `multer` 2.4.0) → `overrides` in `pnpm-workspace.yaml` limitato alla versione vulnerabile (`'multer@2.4.0': 2.5.0`), da rimuovere quando il padre si aggiorna. Namespace hardcoded lowercase (il nome org ha maiuscole e romperebbe il cache exporter buildx). Allegati: path fisso `/data/attachments` nel container, volume named `attachments_data`.

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


**Procedura release**: bump `publiccode.yml` (`softwareVersion` + `releaseDate`) DENTRO la PR della feature (niente PR di solo bump), merge squash, poi `git tag -a vX.Y.Z` sul commit di merge + `git push origin vX.Y.Z`. GitHub Release creata solo occasionalmente (non a ogni tag).

**Tag solo dopo `git fetch origin`, e sempre per SHA esplicito** (`git tag -a vX.Y.Z <sha-merge>`), mai `origin/main` senza fetch: bug reale, v1.8.11 taggato su un `origin/main` locale fermo al merge precedente → immagini `:vX.Y.Z`/`:latest` col codice vecchio, tag da spostare. Verificare con `git ls-remote origin refs/tags/vX.Y.Z^{}`.

**Merge**: `gh pr merge N --squash -R Comune-di-Montesilvano/ComunicaPA`, poi verificare `gh pr view N --json state` prima del tag. In auto mode il classificatore di Claude Code può negarlo (`[Merge Without Review]`, anche dopo `/permissions`; un comando composto con attesa CI + merge viene negato più spesso del comando da solo): in quel caso lo lancia l'utente con `! gh pr merge N --squash -R Comune-di-Montesilvano/ComunicaPA`.

`gh` risolve il repo dalla cwd: da un'altra cartella (es. utenzepa) → "Could not resolve to a PullRequest". Usare sempre `-R Comune-di-Montesilvano/ComunicaPA`; con `-R`, `--delete-branch` cancella solo il branch remoto.

**Pulizia ghcr (`ghcr-cleanup.yml`, domenica 03:00 UTC + `workflow_dispatch` in dry-run per default).** Tiene ogni tag diverso da `latest-YYYYMMDD` e da `sha256-<digest>` (`vX.Y.Z`, `latest`, `buildcache`), le firme cosign `sha256-<digest>` solo se l'immagine `sha256:<digest>` è tenuta (trattate come tag normali resterebbero per sempre, anche quelle di immagini già cancellate), gli ultimi 30 `latest-YYYYMMDD`, i figli di ogni indice tenuto (manifest per piattaforma + attestazione, letti con `imagetools inspect --raw` + `jq`) e tutto ciò che ha meno di 6 ore; cancella il resto (versioni senza tag lasciate dalle build). Un errore nella lettura dei figli DEVE fermare il job (mai `|| true`): senza figli in `keep.txt` verrebbero cancellati i manifest delle immagini taggate, rompendo il pull. Versioni cancellate per errore: ripristinabili entro 30 giorni dalle impostazioni del package su GitHub.

## Pipeline di sicurezza (dal 2026-10-26)

- **Ruleset di main con merge queue** (squash, ALLGREEN): PR obbligatoria, niente force-push/cancellazione, nessun bypass (vale anche per gli admin). Required check: `run-tests`, `dependency-review`, `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)` ×4. I workflow con check obbligatori hanno il trigger `merge_group`, altrimenti la coda resta ferma in attesa. **Merge manuale = `gh pr merge <N> --auto`** (mette in coda): `gh pr merge --squash` diretto viene rifiutato.
- **`dependency-review`** (solo PR, in `security.yml`): blocca dipendenze nuove o aggiornate con advisory high/critical, devDependencies e Actions comprese. In merge queue risulta saltato, che per un required check vale verde.
- **`security.yml`** (PR, merge queue, push main, giornaliero 05:00 UTC): `pnpm-audit` (prod, HIGH+; eccezioni motivate in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`), `trivy-fs` (CVE nei lockfile npm/pip, segreti, misconfig Dockerfile/compose; eccezioni per percorso in `.trivyignore.yaml`), `trivy-image (<app>)` (build delle 4 immagini prod dalla PR senza push + Trivy). Tutti bloccanti su CRITICAL/HIGH con fix e **required check** insieme a `run-tests`: l'auto-merge Dependabot li aspetta, quindi un bump con CVE non arriva mai su main.
- **`release.yml`**: build push **solo per digest** (nessun tag) → Trivy bloccante → `cosign sign` keyless → solo allora `imagetools create` applica `vX.Y.Z`/`latest`/`latest-YYYYMMDD`. Un'immagine non scansionata o non firmata non è mai raggiungibile per tag; i digest orfani li toglie `ghcr-cleanup.yml`. SBOM + provenance `mode=max` come attestazioni nel registry. Verifica firma: `cosign verify --certificate-identity-regexp 'https://github.com/Comune-di-Montesilvano/ComunicaPA/.github/workflows/release.yml@.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com <immagine>`.
- **Trivy fissato** (`version: v0.76.1` in release/security, mai `latest`); `trivy-version-check.yml` apre una issue per le release nuove (attesa 3 giorni).
- **Immagini base con digest** (`FROM image:tag@sha256:…`, anche postgres/redis nel compose, ecosistema Dependabot `docker-compose`): build riproducibili, Dependabot apre la PR quando il digest cambia. `corepack` fissato (`corepack@0.36.0`, era `@latest`).
- **Runtime**: tutte le immagini prod non-root (pdf-extractor uid 10001); compose con `no-new-privileges` + `cap_drop: ALL` (anchor `x-hardening`), postgres/redis riaggiungono solo CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID per il drop di privilegi dell'entrypoint.
- **Workflow**: `permissions` esplicite ovunque, `persist-credentials: false` su ogni checkout, `timeout-minutes` su ogni job. `scorecard.yml` (OpenSSF) pubblica il punteggio su scorecard.dev.
