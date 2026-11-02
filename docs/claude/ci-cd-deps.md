# CI/CD & Dependabot

## CI/CD

## Dependabot auto-merge (`dependabot-automerge.yml`, pattern da GovPay-Interaction-Layer)

Minor/patch (gruppi `*-minor-patch` per ecosistema, schedule `daily`, `cooldown` 7 giorni, 14 sulle major solo per npm/pip (docker, docker-compose e github-actions non supportano `semver-major-days`, Dependabot rifiuta il file): una release compromessa ritirata nel frattempo non entra; gli advisory arrivano subito via security updates, a cui il cooldown non si applica; se l'alert non arriva li corregge `security-autofix.yml` dopo 48h, vedi "Pipeline di sicurezza") → `gh pr merge --auto` appena i required check sono verdi, poi la merge queue di main fa il resto (rimette la PR in pari con main e rilancia i check). Major e bump immagine `python` (minor per dependabot, upgrade runtime per noi) → PR lasciata aperta, manuale. Il vecchio job `update-behind` (aggiornava una PR `BEHIND` alla volta con la protection `strict`) è stato tolto con l'arrivo della merge queue.
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

**Merge di più PR in sequenza (merge queue)**: una PR solo `BEHIND` non
va più aggiornata a mano — `gh pr merge <N> --auto` la mette in coda e la
coda la ricombina con main e rilancia i check da sola. Resta manuale solo
il conflitto vero (`CONFLICTING`, tipicamente il lockfile dopo un altro
bump): su una PR Dependabot `@dependabot rebase` (può metterci 10-20+
minuti), su una PR nostra rebase/merge di main nel branch.

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

`.github/workflows/release.yml`: push tag `v*` → `:vX.Y.Z` + `:latest` su `ghcr.io/comune-di-montesilvano/comunicapa-*` (Trivy report-only). Più rebuild giornaliero di `main` (cron 04:30 UTC, dopo il giro Dependabot delle 01:00 Europe/Rome, o `workflow_dispatch`): push `:latest-YYYYMMDD`, `APP_VERSION` = ultimo tag `v*`, Trivy BLOCCANTE (CRITICAL/HIGH con fix), solo se passa `latest` viene ripuntato al nuovo digest (`imagetools create`). Mai tocca i tag `vX.Y.Z`. **Lo schedule ricostruisce solo su causa reale** (dal 2026-10-27, `scripts/rebuild-check.sh` nel job `setup`): a = commit su main dopo la label `org.opencontainers.image.revision` di `latest`, b = `apk list -u`/`apt list --upgradable` non vuoto dentro l'immagine (root nel container usa e getta; senza shell → Trivy `--pkg-types os`), c = Trivy HIGH/CRITICAL con fix sul digest di `latest`. Errore di un controllo = causa (mai skip per errore). Cause nel summary e nella label `comunicapa.rebuild.reason`. Causa c che fallisce comunque Trivy → issue "Vulnerabilità non risolvibile con un rebuild (<app>)". Prova senza rebuild: `gh workflow run release.yml --ref <branch> -f dry_run=true` (confronta sempre con `origin/main`, quindi anche da un branch). In locale lo script gira con wrapper `trivy`/`jq` che li lanciano in container (Trivy con `-v //var/run/docker.sock:...`). Il vecchio salto "tag nelle ultime 24 ore" è stato tolto: coperto dalla causa a.

**`trivy-action` con `format: sarif` ignora `severity` se `limit-severities-for-sarif` non è `true`** (log: "Building SARIF report with all severities") → `exit-code: 1` scatta anche su LOW/MEDIUM. Nel rebuild il flag è attivo; in locale una scansione `--severity CRITICAL,HIGH` pulita non basta a dimostrare che la CI passi se il flag manca.

**Rebuild bloccato da Trivy = di solito CVE reali.** Il formato SARIF non stampa le CVE nel log (solo `exit code 1`): per vederle `docker run --rm aquasec/trivy image --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed ghcr.io/comune-di-montesilvano/comunicapa-<app>:latest-YYYYMMDD`. Tre fonti tipiche:
- pacchetti OS dell'immagine base → `apk/apt upgrade` nel runtime stage, rinfrescato ogni giorno da `ARG PKG_REFRESH` (data del giorno passata da `release.yml`; senza, la cache registry congela il layer);
- tool non usati a runtime con dipendenze bundled (npm/corepack nell'immagine node, pip `_vendor` nel pdf-extractor) → rimossi nei Dockerfile;
- npm transitive (Dependabot bumpa solo le dirette) → `pnpm update -r --lockfile-only --depth Infinity <pkg...>`; se un padre fissa la versione esatta (es. `@nestjs/platform-express` → `multer` 2.4.0) → `overrides` in `pnpm-workspace.yaml` limitato alla versione vulnerabile (`'multer@2.4.0': 2.5.0`), da rimuovere quando il padre si aggiorna. Namespace hardcoded lowercase (il nome org ha maiuscole e romperebbe il cache exporter buildx). Allegati: path fisso `/data/attachments` nel container, volume named `attachments_data`.

**`main` è protetto (dal 2026-09-06): required check `run-tests`, no force-push, no delete branch.** Push diretto a main viene RIFIUTATO — serve sempre branch + PR + CI verde + merge. `tests.yml` triggera anche su `pull_request` (non solo push a main), quindi il check gira già sulla PR prima del merge.

**`tests.yml` usa il pnpm di `packageManager` e la major di Node del `FROM` di `apps/backend/Dockerfile`** (stesso pattern `--ignore-scripts` + `pnpm rebuild esbuild` dei Dockerfile, vedi sezione sotto) ed esegue anche `pnpm lint` (reale, non più placeholder — vedi `apps/*/eslint.config.{mjs,js}`) e `pnpm build` (stesso comando delle immagini Docker) prima dei test — un errore di compilazione o lint viene preso qui, non solo al build immagine su tag.

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

- **Action consentite = elenco esplicito** (Settings → Actions: `allowed_actions: selected`, GitHub + `owner/action@*` per le 12 di terze parti, `sha_pinning_required: true`, dal 2026-10-27): un'action di terze parti NUOVA (o annidata in una composite) va aggiunta con `gh api -X PUT repos/<repo>/actions/permissions/selected-actions` (elenco completo, sostituisce), altrimenti il workflow fallisce. Riepilogo generale: `docs/ci-cd-security-baseline.md`.
- **Ruleset di main con merge queue** (squash, ALLGREEN): PR obbligatoria, niente force-push/cancellazione, nessun bypass (vale anche per gli admin). Required check: `run-tests`, `pdf-extractor-tests`, `dependency-review`, `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)` ×4. Regola **code scanning**: blocca le PR con alert CodeQL nuovi di livello error o security high/critical (CodeQL default setup, suite extended). I workflow con check obbligatori hanno il trigger `merge_group`, altrimenti la coda resta ferma in attesa. **Merge manuale = `gh pr merge <N> --auto`** (mette in coda): `gh pr merge --squash` diretto viene rifiutato. **Check pesanti solo in coda** (dal 2026-10-27): sulle PR `run-tests` fa solo install, lint e type-check (build e test saltati per step), `pdf-extractor-tests` e gli step di `trivy-image (<app>)` sono saltati (verde per il ruleset); in merge queue gira tutto sul commit che verrà unito. Un test rotto si vede quando la PR entra in coda (che la rimanda indietro), non al push. `trivy-image` è una matrice: skip per step, MAI `if` a livello di job (un job matrice saltato non crea i check `trivy-image (<app>)` e la PR resta bloccata). `tests.yml` non gira su push main (commit identico a quello testato in coda); il badge README usa `?event=merge_group`. Branch delle PR cancellati in automatico dopo il merge (`delete_branch_on_merge`).
- **`dependency-review`** (solo PR, in `security.yml`): blocca dipendenze nuove o aggiornate con advisory high/critical, devDependencies e Actions comprese. In merge queue risulta saltato, che per un required check vale verde.
- **`security.yml`** (PR, merge queue, push main, giornaliero 05:00 UTC): `pnpm-audit` (prod, HIGH+; eccezioni motivate in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`), `trivy-fs` (CVE nei lockfile npm/pip, segreti, misconfig Dockerfile/compose; eccezioni per percorso in `.trivyignore.yaml`), `trivy-image (<app>)` (build delle 4 immagini prod dalla PR senza push + Trivy). Tutti bloccanti su CRITICAL/HIGH con fix e **required check** insieme a `run-tests`: l'auto-merge Dependabot li aspetta, quindi un bump con CVE non arriva mai su main. **Su PR e merge queue sono differenziali** (dal 2026-11-02, `scripts/security/diff-gate.mjs`): falliscono solo per vulnerabilità assenti dalla base (commit base per `pnpm-audit`/`trivy-fs`, `latest` pubblicata per `trivy-image`, scansionate nello stesso run con lo stesso DB). Prima un advisory uscito dopo il merge bloccava TUTTE le PR, comprese quelle che lo correggevano solo in parte (incidente 2026-11-02: node-forge + follow-redirects, Dependabot fermo). Secret e misconfig di `trivy-fs` restano assoluti; su push main e giornaliero tutto resta assoluto e il fallimento fa partire l'autofix. `dependency-review` riceve `allow-ghsas` da `auditConfig.ignoreGhsas` (fonte unica delle eccezioni).
- **Correzioni di sicurezza autonome — `security-autofix.yml`** (dal 2026-11-02; design `docs/superpowers/specs/2026-11-02-security-autofix-design.md`, script in `scripts/security/`, test `node --test scripts/security/test/` + unittest Python nel job `pdf-extractor-tests`). Giornaliero 02:30 UTC (tra Dependabot e il rebuild delle 04:30), su Sicurezza fallita su main e a mano. Rete di sicurezza per quando Dependabot non apre l'alert (visto dal vivo: GHSA pubblicate da 2 giorni, zero alert) o il cooldown blocca la PR raggruppata. **Eccezione voluta al cooldown di 7 giorni**, solo per pacchetti con advisory HIGH/CRITICAL: versione corretta **più bassa** (stessa major prima), pubblicata da **almeno 48h**, **provenienza** verificata ("mai un downgrade di fiducia": firma registry npm sempre; se una versione precedente aveva attestazione SLSA/PEP 740/Docker, la nuova deve averla dallo stesso repository). npm diretta → `pnpm add pkg@ver --lockfile-only` (stesso prefisso di range); transitiva → override `'pkg@<versione installata>': <corretta>` commentato in `pnpm-workspace.yaml` (da rimuovere quando il padre si aggiorna); pip → pin + `pip-compile` con hash nel container Python del pdf-extractor (transitiva: prima `--upgrade-package`, poi pin commentato in `requirements.in`); immagine base → digest più recente dello stesso tag. Verifica locale (corrette sparite, nessuna nuova) → commit verificato via GraphQL `createCommitOnBranch` col token della GitHub App → PR `security-autofix/<data>` con auto-merge. PR non mergiata entro 6h o con check rossi → chiusa, al giro dopo una PR per pacchetto (`security-autofix/split-*`); quelle che falliscono restano escluse (stato nella issue "Autofix sicurezza: correzione fallita", blocco `<!-- autofix-state -->`) — al giro dopo si prova la versione/digest corretta successiva, `force` riprova anche un'esclusa. Verifica locale fallita → stesso giro per pacchetto, escluso solo chi fallisce da solo. **Guardie della catena**: il bot committa solo lockfile/`package.json`/`requirements*`/Dockerfile (`gh-commit.mjs`, altro → errore); pip-tools da `scripts/security/requirements-autofix.txt` (hash) con repo montato in sola lettura tranne `services/pdf-extractor`; anche le dipendenze trascinate devono avere 48h (`--config.minimum-release-age=2880` su pnpm, controllo PyPI dei pin cambiati); i gate differenziali di `security.yml` girano dallo script della base (`.base/`), così una PR non indebolisce il gate che la giudica. Issue "correzioni in attesa" (con data e comando) e "vulnerabilità non correggibili". Forzare prima delle 48h: `gh workflow run security-autofix.yml -f force=pkg@versione` (o `image:tag`; salta solo l'età, mai la provenienza). Solo analisi: `-f dry_run=true`.
- **`release.yml`**: `build-push` (matrice) push **solo per digest** (nessun tag) → Trivy bloccante sui tag `v*`, di **non regressione** sul rebuild di `latest` (dal 2026-11-02: si pubblica se l'immagine nuova non ha CVE assenti dalla `latest` attuale; le residue vanno nella issue "Vulnerabilità non risolvibile con un rebuild (<app>)" — prima una CVE senza fix nelle immagini base fermava anche i rebuild che ne correggevano altre) → attestazioni → `cosign sign` keyless → digest e tag previsti in un artifact `release-<app>` → job `smoke` (stack `docker-compose.yml` completo con le 4 immagini taggate localmente `smoke`, `scripts/smoke-stack.sh`: servizi su, config.js e /api via nginx, query DB autenticata, upload su /tmp, /extract, sola lettura, log senza EROFS) → solo se verde il job `publish` (matrice) fa `imagetools create` di `vX.Y.Z`/`latest`/`latest-YYYYMMDD`. Smoke fallito = nessun tag spostato, `latest` resta il precedente. In locale: `COMPOSE="docker compose -f docker-compose.yml -p smoke --env-file <env>" scripts/smoke-stack.sh` dopo `up -d`. Un'immagine non scansionata o non firmata non è mai raggiungibile per tag; i digest orfani li toglie `ghcr-cleanup.yml`. Attestazioni **firmate** su GitHub (dal 2026-10-27): provenance SLSA (`attest-build-provenance`) e SBOM CycloneDX generato da Trivy (`attest-sbom`), legate al digest; quelle BuildKit (`sbom`/`provenance: mode=max`) restano nel registry ma non sono firmate. `harden-runner` in `egress-policy: block` su entrambi i job (dal 2026-10-27, lista dagli host DNS risolti nella release v1.11.12): l'agent instrada anche il DNS dei container di `docker build` e consente da solo gli endpoint Actions (`*.actions.githubusercontent.com`, `productionresultssa*.blob.core.windows.net`, domini dell'API meta). Release fallita con host bloccato → nome nel log del post-step harden-runner (`domain resolved:` / blocked) o nella pagina insights StepSecurity della run → aggiungerlo a `allowed-endpoints` se legittimo (es. nuovo registry di un'immagine base). Tutti gli altri workflow hanno `harden-runner` in `audit` (traffico registrato, non bloccato).
- **Verifica prima del deploy**: `scripts/verify-images.sh vX.Y.Z` (cosign nell'immagine ufficiale fissata per digest, niente installazioni; `CONTAINER_CLI=podman` sull'host podman) verifica che le 4 immagini del tag siano firmate da `release.yml` di questo repo su un tag `v*` o su main e, con `gh` disponibile, le attestazioni provenance e SBOM. Stampa i digest verificati. Se fallisce, NON aggiornare lo stack. Le release precedenti alla v1.11.12 non hanno attestazioni GitHub: per quelle solo la firma (eseguire senza `gh` nel PATH). **Nel deploy**: `VERIFY_IMAGES=true` (stack Portainer) attiva il servizio one-shot `verify-images` del compose (cosign `-dev` con busybox, fissato per digest, ~10 s): backend/pdf-extractor/frontend dipendono da lui con `service_completed_successfully`, quindi firma assente o tag inesistente → servizi creati ma non avviati e deploy in errore (rimettere il tag precedente). Spento → `exit 0` immediato. NON usare `profiles` + `depends_on.required: false`: con il profilo attivo una verifica fallita produce solo un warning e i servizi partono lo stesso (provato con Compose 5.6).
- **Tag `v*` protetti** (ruleset `release-tags`): creazione, modifica e cancellazione solo per gli admin del repo; chi ha solo scrittura non può far partire una release firmata.
- **Trivy fissato** (`version: v0.76.1` in release/security, mai `latest`); `trivy-version-check.yml` apre una issue per le release nuove (attesa 3 giorni).
- **Immagini base con digest** (`FROM image:tag@sha256:…`, anche postgres/redis nel compose, ecosistema Dependabot `docker-compose`): build riproducibili, Dependabot apre la PR quando il digest cambia. `corepack` fissato con hash (`ADD --checksum=sha256:` del tarball npm, era `npm install -g corepack@latest`).
- **Runtime**: tutte le immagini prod non-root (pdf-extractor uid 10001); compose con `no-new-privileges` + `cap_drop: ALL` (anchor `x-hardening`); tutti i servizi `read_only: true` (dal 2026-10-27): scrivono solo nei volumi e nei tmpfs dichiarati — backend `/tmp` sul volume `backend_tmp` (upload grandi, mai tmpfs in RAM), pdf-extractor `/tmp` tmpfs 64m, nginx `/tmp` tmpfs con `config.js` generato in `/tmp/runtime-config` (servito da `default.conf`), postgres tmpfs `/var/run/postgresql` e `/tmp`, verify-images tmpfs `/home/nonroot:mode=1777` (cache TUF di cosign; senza mode → permission denied; MAI `uid=`/`gid=`: podman li rifiuta, "unknown mount option", deploy Portainer fallito il 2026-10-27). Le immagini frontend precedenti scrivono `config.js` nella root html: compose nuovo + `IMAGE_TAG` vecchio → frontend non parte, aggiornare insieme. L'override dev rimette `read_only: false` sui 4 servizi applicativi (build/watch/pip), postgres/redis riaggiungono solo CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID per il drop di privilegi dell'entrypoint.
- **Workflow**: `permissions: contents: read` a livello di workflow e permessi di scrittura solo nel job che li usa, `persist-credentials: false` su ogni checkout, `timeout-minutes` su ogni job. `scorecard.yml` (OpenSSF) pubblica il punteggio su scorecard.dev.
- **pytest pdf-extractor** (`pdf-extractor-tests` in `tests.yml`, required): immagine `Dockerfile.dev` + `requirements-dev.txt` con hash. Il bug noto del CAP estero è `xfail(strict=True)`: quando viene corretto il test passa e il job fallisce finché non si toglie il marker.
- **`security-alerts.yml`** (giornaliero 06:00 UTC + push main): la regola code scanning blocca solo gli alert nuovi di una PR, questo job conta quelli già aperti su main (CodeQL/Trivy high/critical, Scorecard escluso). Se ce ne sono fallisce e aggiorna la issue "Alert di sicurezza aperti su main"; senza alert la chiude. Ogni alert va corretto o chiuso dalla tab Security con motivazione. Non è required (bloccherebbe anche la PR che corregge).
- **Segnalazione privata delle vulnerabilità** attiva (Security → Advisories → Report a vulnerability), indicata in `SECURITY.md`.

## Versioni fissate e da dove si aggiornano (dal 2026-10-26)

| Cosa | Dove è fissata | Chi la aggiorna |
|---|---|---|
| npm (dirette + transitive) | `pnpm-lock.yaml` | Dependabot `npm` |
| Python pdf-extractor (dirette + transitive, con hash) | `services/pdf-extractor/requirements.txt`, generato da `requirements.in` | Dependabot `pip` (riconosce l'header pip-compile e rigenera il lock) |
| Python di test | `requirements-dev.txt` da `requirements-dev.in` (`-c requirements.txt`) | idem |
| pnpm | `packageManager` in `package.json`, con `+sha512.<hex>` verificato da corepack | a mano, su issue di `toolchain-version-check.yml` |
| corepack | `ADD --checksum=sha256:… …/corepack-X.Y.Z.tgz` nei 6 Dockerfile di `apps/*/` (tutti uguali, il job lo controlla; sha256 calcolato sul tarball dopo averne confrontato lo sha512 con `dist.integrity` del registry) | a mano, su issue di `toolchain-version-check.yml` |
| Trivy | `version:` in `release.yml`/`security.yml` | a mano, su issue di `trivy-version-check.yml` |
| Node di CI | major del `FROM node:<N>` di `apps/backend/Dockerfile` | Dependabot `docker` (con l'immagine) |
| Immagini base, postgres/redis | tag + digest | Dependabot `docker` / `docker-compose` |
| Actions | SHA | Dependabot `github-actions` |

- **Rigenerare il lock Python** dopo aver cambiato `requirements*.in` (stessa immagine del Dockerfile):
  `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w/services/pdf-extractor <FROM di services/pdf-extractor/Dockerfile> sh -c "pip install -q pip-tools && pip-compile -q --generate-hashes --allow-unsafe --strip-extras --no-emit-index-url -o requirements.txt requirements.in && pip-compile -q --generate-hashes --allow-unsafe --strip-extras --no-emit-index-url -o requirements-dev.txt requirements-dev.in"`.
  L'install è `pip install --require-hashes --no-deps -r requirements.txt`: un pacchetto con hash diverso o non elencato fa fallire la build.
- **Aggiornare pnpm**: `packageManager` = `pnpm@X.Y.Z+sha512.<hex>`, dove `<hex>` è l'`integrity` del registry npm (`https://registry.npmjs.org/pnpm/X.Y.Z`, campo `dist.integrity`, base64 → hex). Poi rigenerare il lockfile con il comando di CLAUDE.md.

