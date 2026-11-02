# Correzioni di sicurezza autonome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le vulnerabilità HIGH/CRITICAL con versione corretta arrivano su `main` e `latest` senza intervento umano, e una vulnerabilità già su `main` non blocca più le PR.

**Architecture:** Script Node ESM senza dipendenze (`scripts/security/*.mjs`, test con `node --test`) normalizzano i risultati di `pnpm audit`/Trivy, calcolano il diff testa↔base e scelgono la versione corretta (età 48h + provenienza). `security.yml` e `release.yml` usano il diff come gate; il nuovo `security-autofix.yml` applica le correzioni (npm via script Node, pip via script Python con `packaging`/pip-tools, digest immagini base), apre la PR col token GitHub App e gestisce le issue.

**Tech Stack:** GitHub Actions, Node (major da `apps/backend/Dockerfile`), pnpm da `packageManager`, Python 3.14 + pip-tools, Trivy `v0.76.1`, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-02-security-autofix-design.md`

## Global Constraints

- Severità considerate: HIGH e CRITICAL; Trivy con `--ignore-unfixed` e `--ignorefile .trivyignore.yaml`; `pnpm audit --prod`; eccezioni da `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` (fonte unica).
- Età minima versione corretta: **48 ore** (`MIN_AGE_HOURS = 48`).
- Provenienza: "mai un downgrade di fiducia" — se una versione precedente aveva attestazione, la scelta deve averla e con lo stesso repository sorgente; firma registry npm sempre obbligatoria. `force` salta solo l'età, mai la provenienza.
- Versione scelta = la **più bassa** che corregge tutte le advisory aperte del pacchetto, preferendo la stessa major.
- Override npm limitati alla versione vulnerabile, nel blocco `overrides:` di `pnpm-workspace.yaml`, commentati (GHSA, data, "rimuovere quando il padre si aggiorna").
- Nomi dei required check invariati: `dependency-review`, `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)`, `run-tests`, `pdf-extractor-tests`.
- Stile workflow: `harden-runner` (egress audit), action fissate per SHA con commento versione, Trivy `v0.76.1`, permessi minimi per job, `persist-credentials: false`.
- Token di scrittura PR: GitHub App (`BOT_CLIENT_ID` / `BOT_PRIVATE_KEY`, `actions/create-github-app-token` allo SHA già usato in `dependabot-automerge.yml`).
- L'autofix gira solo da `main` (cron/`workflow_run`/dispatch), mai su codice di PR.
- Script senza dipendenze npm (solo `node:` built-in); niente Node sull'host: test locali in `node:26-alpine` / `python:3.14-slim` via `docker run` (mai `docker compose`).
- Fixture di test: dati fittizi o pubblici (advisory reali OK, sono pubbliche); nessun dato di cittadini.

## Review Focus

- `pnpm audit` con advisory su un pacchetto presente in più versioni nel lockfile (`findings[].version` multipli): ogni versione è un finding distinto, l'override copre solo quelle vulnerabili → test in Task 1 e Task 4.
- Range advisory composti (`<1.2.3 || >=2.0.0 <2.1.4`): `satisfies` deve gestire `||` e comparatori multipli; prerelease escluse → test in Task 3.
- Stessa vulnerabilità con ID diversi tra strumenti (GHSA in pnpm, CVE in Trivy): il diff confronta anche gli alias, altrimenti la base "non ha" il finding e la PR diventa rossa per nulla → test in Task 1.
- Base senza risultati (scan base fallito o JSON vuoto): il gate non deve passare in silenzio come "nessun finding nuovo" se la scansione della testa è valida ma quella base no — errore esplicito → test in Task 1.
- Registry irraggiungibile / pacchetto senza `time` per la versione: `chooseVersion` → `unfixable` con motivo, mai una versione scelta senza età verificata → test in Task 3.

---

### Task 1: Normalizzazione risultati e diff

**Files:**
- Create: `scripts/security/findings.mjs`
- Create: `scripts/security/diff-gate.mjs` (CLI)
- Create: `scripts/security/test/findings.test.mjs`
- Create: `scripts/security/test/fixtures/pnpm-audit-main.json`, `trivy-fs-main.json`, `trivy-image-sample.json`

**Interfaces:**
- Produces:
  - `type Finding = { tool: 'pnpm'|'trivy', ecosystem: 'npm'|'pip'|'os'|'image-lang', pkg: string, version: string, id: string, aliases: string[], severity: 'HIGH'|'CRITICAL', vulnerableRange: string|null, fixedRange: string|null, target: string }`
  - `parsePnpmAudit(json: object, { ignoreGhsas: string[] }): Finding[]` — solo HIGH/CRITICAL, un finding per (advisory × versione installata).
  - `parseTrivy(json: object): Finding[]` — solo `Vulnerabilities` HIGH/CRITICAL con `FixedVersion`; `ecosystem` da `Results[].Type` (`pnpm|npm|node-pkg` → `npm` se Target è un lockfile del repo, altrimenti `image-lang`; `pip|python-pkg` idem con `pip`; `alpine|debian|...` → `os`).
  - `findingKey(f: Finding): string` = `${ecosystem}:${pkg}:${id}`; il diff considera uguali due finding se pkg/ecosystem coincidono e `{id, ...aliases}` si intersecano.
  - `diffFindings(head: Finding[], base: Finding[]): Finding[]` — finding di `head` senza corrispondente in `base`.
  - `readIgnoreGhsas(workspaceYamlText: string): string[]` — legge la lista sotto `auditConfig.ignoreGhsas` (parsing a righe, niente lib YAML).
  - CLI: `node scripts/security/diff-gate.mjs --format pnpm|trivy --head <file> --base <file> [--workspace pnpm-workspace.yaml]` → stampa la tabella dei nuovi, exit 1 se ce ne sono, exit 2 se uno dei due file manca/non è JSON valido/non ha la struttura attesa.

- [ ] **Step 1: Catturare le fixture reali da `main`**

Da un checkout di `origin/main`, in container:
`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w node:26-alpine sh -c "npm i -g corepack@0.36.0 >/dev/null && corepack enable && pnpm audit --prod --json" > scripts/security/test/fixtures/pnpm-audit-main.json` (exit ≠0 atteso). Trivy fs JSON con `aquasec/trivy:0.76.1 fs --scanners vuln --format json --severity HIGH,CRITICAL --ignore-unfixed .`. Expected: `pnpm-audit-main.json` contiene `node-forge` e `follow-redirects`. Per `trivy-image-sample.json` ridurre a mano un output reale a 1 finding `alpine` + 1 `node-pkg`.

- [ ] **Step 2: Scrivere i test (falliscono)**

```js
test('pnpm: node-forge e follow-redirects da main', () => {
  const f = parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: ['GHSA-86w9-cpqp-85rv'] });
  assert.ok(f.some(x => x.pkg === 'node-forge' && x.id === 'GHSA-7wch-p9px-956x' && x.version === '1.4.0'));
  assert.ok(f.some(x => x.pkg === 'follow-redirects' && x.fixedRange === '>=1.16.2'));
  assert.ok(!f.some(x => x.id === 'GHSA-86w9-cpqp-85rv'));
  assert.ok(f.every(x => ['HIGH','CRITICAL'].includes(x.severity)));
});
test('diff: base uguale → nessun nuovo', () => assert.deepEqual(diffFindings(f, f), []));
test('diff: finding aggiunto → solo quello', ...);
test('diff: stesso problema GHSA in testa e CVE alias in base → non nuovo', ...);
test('diff: stessa advisory, versione installata diversa → non nuovo', ...);
test('trivy: ecosystem os/image-lang/npm assegnati', ...);
test('readIgnoreGhsas legge GHSA-86w9-cpqp-85rv dal pnpm-workspace.yaml reale', ...);
test('cli: base mancante → exit 2', ...);
test('cli: nuovo finding → exit 1 e pkg nel stdout', ...);
```

- [ ] **Step 3: Verificare che falliscano**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w node:26-alpine node --test scripts/security/test/`
Expected: FAIL (`Cannot find module '../findings.mjs'`).

- [ ] **Step 4: Implementare `findings.mjs` e `diff-gate.mjs`** con le firme sopra. Verificare nella fixture reale la struttura di `pnpm audit --json` di pnpm 11 (chiavi `advisories.<id>.module_name`, `github_advisory_id`, `findings[].version`, `cves`) prima di scrivere il parser.

- [ ] **Step 5: Test verdi** — stesso comando, Expected: PASS.

- [ ] **Step 6: Eseguire i test in CI** — in `.github/workflows/tests.yml`, job `run-tests`, dopo "Setup Node.js": step `Test script di sicurezza` → `node --test scripts/security/test/`.

- [ ] **Step 7: Commit** — `feat(ci): normalizzazione e diff dei risultati di sicurezza`

---

### Task 2: Gate differenziale in `security.yml`

**Files:**
- Modify: `.github/workflows/security.yml` (job `dependency-review`, `pnpm-audit`, `trivy-fs`, `trivy-image`)

**Interfaces:**
- Consumes: `diff-gate.mjs` CLI, `readIgnoreGhsas` (Task 1).

- [ ] **Step 1: `pnpm-audit`** — su `push`/`schedule`/`workflow_dispatch` comportamento attuale (`pnpm audit --prod --audit-level high`). Su `pull_request`/`merge_group`: checkout testa + checkout base (`github.event.pull_request.base.sha` / `github.event.merge_group.base_sha`) in `base/`, `pnpm audit --prod --json` in entrambi (`|| true`), poi `node scripts/security/diff-gate.mjs --format pnpm --head head.json --base base.json`. Setup Node come in `tests.yml` (major dal Dockerfile).

- [ ] **Step 2: `trivy-fs`** — lo step SARIF attuale resta (upload invariato) ma con `exit-code: 0` sulle PR/merge queue per lo scanner `vuln`; aggiungere: scan `--scanners secret,misconfig` con `exit-code: 1` (assoluto, sempre), e scan `vuln` JSON di testa e di `base/` + `diff-gate.mjs --format trivy`. Su push/schedule invariato (assoluto).

- [ ] **Step 3: `trivy-image`** — in merge queue: dopo lo scan JSON dell'immagine `scan/<app>:pr`, scan JSON di `ghcr.io/comune-di-montesilvano/comunicapa-<app>:latest` (pull anonimo) nello stesso run, poi `diff-gate.mjs --format trivy`. Se la `latest` non esiste (app nuova) → base vuota esplicita (`--base-empty`, flag da aggiungere al CLI in questo step: tutto è "nuovo"). SARIF caricato come ora. Su push/schedule assoluto.

- [ ] **Step 4: `dependency-review`** — step precedente che genera `allow-ghsas` da `readIgnoreGhsas` (output comma-separated) e lo passa all'action.

- [ ] **Step 5: Verifica** — push del branch e PR su `main`. Expected: su questa PR `pnpm-audit` e `trivy-fs` **verdi** nonostante `node-forge`/`follow-redirects` su `main` (presenti anche nella base); log del diff con "0 nuovi". Verifica negativa: commit temporaneo che aggiunge `"node-forge": "1.3.0"` a un `package.json` di prova → `pnpm-audit` rosso con `node-forge` nella tabella; poi revert del commit.

- [ ] **Step 6: Commit** — `feat(ci): gate di sicurezza differenziale su PR e merge queue`

---

### Task 3: Scelta della versione e provenienza npm

**Files:**
- Create: `scripts/security/semver-lite.mjs`
- Create: `scripts/security/choose-version.mjs`
- Create: `scripts/security/npm-registry.mjs`
- Test: `scripts/security/test/choose-version.test.mjs`, `scripts/security/test/semver-lite.test.mjs`

**Interfaces:**
- Produces:
  - `compare(a: string, b: string): -1|0|1`, `satisfies(v: string, range: string): boolean` — comparatori `<,<=,>,>=,=`, spazio = AND, `||` = OR; versioni prerelease mai considerate candidate.
  - `type Candidate = { version: string, publishedAt: Date|null, provenanceRepo: string|null, registrySigned: boolean }`
  - `chooseVersion({ current: string, vulnerableRanges: string[], candidates: Candidate[], previous: Candidate[], now: Date, minAgeHours = 48, forceVersion?: string }): { action: 'fix', version } | { action: 'pending', version, eta: Date } | { action: 'unfixable', reason: string }`
    — candidate = versioni > current che non soddisfano nessun `vulnerableRange`; ordine: stessa major crescente, poi major successive crescenti; prima candidata che passa età e provenienza → `fix`; se l'unico ostacolo è l'età → `pending` con `eta = publishedAt + 48h` della prima; nessuna → `unfixable` (`'nessuna versione corretta'`, `'provenienza assente o diversa'`, `'data di pubblicazione sconosciuta'`).
    — provenienza: se `previous.some(p => p.provenanceRepo)` allora richiesta `provenanceRepo` uguale (normalizzato: senza `git+`, `.git`, case-insensitive); `registrySigned` sempre richiesto.
  - `fetchCandidates(pkg: string): Promise<{ candidates: Candidate[], previous: Candidate[] }>` in `npm-registry.mjs` — packument `https://registry.npmjs.org/<pkg>`; `publishedAt` da `time[v]`; `registrySigned` = firma ECDSA in `dist.signatures` verificata con le chiavi di `https://registry.npmjs.org/-/npm/v1/keys` su `${name}@${version}:${dist.integrity}` (`node:crypto`); `provenanceRepo` dal predicato SLSA dell'attestazione (`dist.attestations.url`, campo `buildDefinition.externalParameters.workflow.repository`). La verifica completa del bundle Sigstore è delegata al registry (che la fa alla pubblicazione): documentarlo nel commento del file.

- [ ] **Step 1: Test (falliscono)**

```js
const now = new Date('2026-10-31T02:30:00Z');
test('node-forge: sceglie 1.4.1, non 1.4.2', () => assert.deepEqual(
  chooseVersion({ current:'1.4.0', vulnerableRanges:['<=1.4.0'], candidates:[c('1.4.1','2026-10-27T04:44:07Z'), c('1.4.2','2026-10-27T14:09:15Z')], previous:[c('1.4.0','2026-03-24T21:44:34Z')], now }),
  { action:'fix', version:'1.4.1' }));
test('< 48h → pending con eta', () => /* publishedAt now-10h → action 'pending', eta = publishedAt+48h */);
test('forceVersion salta età, non provenienza', ...);
test('precedente con provenance, candidata senza → unfixable "provenienza assente o diversa"', ...);
test('provenance repo diverso → unfixable', ...);
test('mai avuta provenance → basta registrySigned', ...);
test('registrySigned false → unfixable', ...);
test('preferisce stessa major: 1.9.3 prima di 2.0.0', ...);
test('publishedAt null → unfixable "data di pubblicazione sconosciuta"', ...);
test('satisfies: "1.5.0" in "<1.2.3 || >=1.5.0 <1.5.4"', ...);
test('satisfies: prerelease 1.4.1-rc.1 mai candidata', ...);
```

- [ ] **Step 2: Run** `... node:26-alpine node --test scripts/security/test/` → FAIL.
- [ ] **Step 3: Implementare** `semver-lite.mjs`, `choose-version.mjs` (puro, nessun I/O), `npm-registry.mjs` (I/O, non coperto da unit test; firma verificata in Step 5).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Verifica live** — `docker run ... node -e "import('./scripts/security/npm-registry.mjs').then(m=>m.fetchCandidates('node-forge')).then(r=>console.log(r.candidates.find(c=>c.version==='1.4.1')))"` Expected: `registrySigned: true`, `publishedAt` 2026-10-27. Ripetere con un pacchetto noto con provenance (es. `follow-redirects` o `vite`) → `provenanceRepo` valorizzato.
- [ ] **Step 6: Commit** — `feat(ci): scelta versione corretta con età minima e provenienza`

---

### Task 4: Applicazione correzioni npm

**Files:**
- Create: `scripts/security/apply-npm.mjs`
- Test: `scripts/security/test/apply-npm.test.mjs`

**Interfaces:**
- Consumes: `Finding` (Task 1), risultato `fix` di `chooseVersion` (Task 3).
- Produces:
  - `planNpmFix(finding: Finding, version: string, manifests: { path: string, json: object }[]): { kind: 'direct', path: string, depField: 'dependencies'|'devDependencies', from: string, to: string } | { kind: 'override', selector: string, to: string }` — `direct` se il pacchetto è dichiarato in un `package.json` del workspace (mantenere il prefisso `^`/`~` del range esistente: `^1.3.1` → `^1.4.1`); altrimenti `override` con `selector = '<pkg>@<vulnerableRange>'`.
  - `applyOverride(workspaceYamlText: string, fix, { ghsa: string[], date: string }): string` — inserisce in fondo al blocco `overrides:` le righe di commento (`# <ghsa...> (<date>, security-autofix): rimuovere quando il padre si aggiorna`) e `  '<selector>': <to>`; se il selettore esiste già, ne aggiorna il valore. Crea il blocco se assente.
  - `applyDirect(packageJsonText: string, fix): string` — preserva formattazione (indent 2, newline finale).
  - CLI `node scripts/security/apply-npm.mjs --fixes fixes.json` — applica tutto, poi tenta prima `pnpm update --depth Infinity <pkg>` per i transitivi e usa l'override solo se il lockfile ha ancora la versione vulnerabile; infine `pnpm install --lockfile-only --ignore-scripts`.

- [ ] **Step 1: Test (falliscono)**

```js
test('node-forge diretta in apps/backend → direct ^1.4.1', ...);
test('follow-redirects transitiva → override "follow-redirects@<=1.16.1": 1.16.2', ...);
test('applyOverride aggiunge dopo multer@2.4.0 con commento GHSA e data', () => {
  const out = applyOverride(realWorkspaceYaml, fix, { ghsa:['GHSA-mrwp-f3q8-3g9p'], date:'2026-10-31' });
  assert.match(out, /'multer@2\.4\.0': 2\.5\.0\n\s+# GHSA-mrwp-f3q8-3g9p \(2026-10-31, security-autofix\)[^\n]*\n\s+'follow-redirects@<=1\.16\.1': 1\.16\.2/);
  assert.match(out, /auditConfig:/); // resto del file intatto
});
test('applyOverride idempotente su selettore esistente', ...);
test('applyDirect preserva ~ e newline finale', ...);
test('pacchetto in due versioni nel lockfile: override solo sul range vulnerabile', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implementare.** **Step 4: Run** → PASS.
- [ ] **Step 5: Verifica reale** su copia del repo in container (`git archive HEAD` → `docker cp` in `node:26-alpine --memory 3g`, come da CLAUDE.md): fixes per `node-forge@1.4.1` e `follow-redirects@1.16.2`, poi `pnpm audit --prod --audit-level high`. Expected: nessuna HIGH residua oltre a quelle ignorate.
- [ ] **Step 6: Commit** — `feat(ci): applicazione automatica correzioni npm`

---

### Task 5: Correzioni pip

**Files:**
- Create: `scripts/security/pip_fix.py`
- Test: `scripts/security/test/test_pip_fix.py` (unittest stdlib + `packaging`)

**Interfaces:**
- Consumes: `Finding` JSON con `ecosystem: 'pip'` (Task 1); età/provenienza con la stessa regola di Task 3.
- Produces: CLI `python scripts/security/pip_fix.py --fixes fixes.json --dir services/pdf-extractor --out result.json`, dove per ogni pacchetto in input (`{ pkg, current, vulnerable_ranges[], force_version? }`) scrive `{ pkg, action: 'fix'|'pending'|'unfixable', version?, eta?, reason?, kind?: 'direct'|'upgrade'|'pin' }`.
  - Funzioni: `choose_version(current, vulnerable_specs, candidates, previous, now, min_age_hours=48, force_version=None) -> dict` (stessa semantica di `chooseVersion`, PEP 440 via `packaging.version`/`specifiers`); `fetch_candidates(pkg) -> (candidates, previous)` da `https://pypi.org/pypi/<pkg>/json` (`upload_time_iso_8601` del primo file) e provenance dalla Integrity API `https://pypi.org/integrity/<pkg>/<ver>/<file>/provenance` (repo dal publisher Trusted Publishing); `apply(dir, pkg, version) -> kind`: diretta → pin `==` in `requirements.in`; transitiva → `pip-compile --upgrade-package <pkg>==<v>` con i flag dell'header di `requirements.txt` (`--allow-unsafe --generate-hashes --no-emit-index-url --strip-extras`); se pip-compile fallisce per conflitto di range → pin commentato in `requirements.in` (`# <ghsa> (<data>, security-autofix): rimuovere quando il padre si aggiorna`) e ricompilazione; `requirements-dev.txt` ricompilato se contiene il pacchetto.

- [ ] **Step 1: Test** per `choose_version` (casi speculari a Task 3: minima corretta, pending, provenienza assente/diversa, mai avuta provenienza) e per la modifica testuale di `requirements.in` (pin diretto aggiornato, pin commentato aggiunto per transitiva, file intatto altrove).
- [ ] **Step 2: Run** `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/w" -w /w python:3.14-slim sh -c "pip install -q packaging && python -m unittest discover -s scripts/security/test -p 'test_*.py'"` → FAIL.
- [ ] **Step 3: Implementare.** **Step 4: Run** → PASS.
- [ ] **Step 5: Test CI** — job `pdf-extractor-tests` di `tests.yml`: step aggiuntivo con lo stesso comando unittest.
- [ ] **Step 6: Commit** — `feat(ci): correzioni pip automatiche con hash`

---

### Task 6: Digest immagini base

**Files:**
- Create: `scripts/security/base-image.mjs`
- Test: `scripts/security/test/base-image.test.mjs`

**Interfaces:**
- Produces:
  - `parseFromLines(dockerfileText: string): { line: number, image: string, tag: string, digest: string }[]`
  - `replaceDigest(dockerfileText: string, image: string, tag: string, newDigest: string): string` — sostituisce tutte le righe `FROM <image>:<tag>@sha256:...` (anche multi-stage), nient'altro.
  - CLI `node scripts/security/base-image.mjs --apps backend,pdf-extractor --out result.json` — per ogni `image:tag` usato dalle app con finding `os`/`image-lang` non risolti dal rebuild, legge il digest corrente del tag (`docker buildx imagetools inspect <image>:<tag> --format '{{json .}}'`), data di creazione e presenza di attestazione provenance del digest nuovo e di quello in uso; stessa regola età 48h / "mai downgrade di fiducia"; `fix` → `replaceDigest` su `Dockerfile` e `Dockerfile.dev` dell'app; altrimenti `pending`/`unfixable` (`'nessun digest più recente'`).

- [ ] **Step 1: Test** su testo reale di `apps/backend/Dockerfile` (due `FROM node:26-alpine@sha256:40cd…`, entrambi sostituiti) e `services/pdf-extractor/Dockerfile`; riga `FROM` senza digest ignorata.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implementare.** **Step 4: Run** → PASS.
- [ ] **Step 5: Verifica live** (con Docker sull'host): CLI su `backend` in `--dry-run` → stampa digest corrente del tag, età e provenienza senza scrivere file.
- [ ] **Step 6: Commit** — `feat(ci): bump automatico digest immagini base per CVE`

---

### Task 7: Workflow `security-autofix.yml` e issue

**Files:**
- Create: `.github/workflows/security-autofix.yml`
- Create: `scripts/security/autofix.mjs` (orchestratore: rileva → sceglie → applica → verifica → riepilogo)
- Create: `scripts/security/issues.mjs`
- Test: `scripts/security/test/issues.test.mjs`, `scripts/security/test/autofix.test.mjs`

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces:
  - `autofix.mjs --mode single|split --exclude excluded.json --out summary.json [--force <pkg>@<ver>] [--dry-run]` → `summary.json` = `{ fixed: Fix[], pending: Pending[], unfixable: Unfixable[], verification: 'ok'|'failed' }` e file modificati nel working tree. Verifica finale: rilancia audit/Trivy fs e richiede che ogni finding corretto sia sparito e `diffFindings(after, before)` vuoto, altrimenti `verification: 'failed'` e nessuna PR.
  - `renderIssue(kind: 'pending'|'unfixable'|'failed', items, state): { title: string, body: string }` — titoli fissi: `Autofix sicurezza: correzioni in attesa`, `Autofix sicurezza: vulnerabilità non correggibili`, `Autofix sicurezza: correzione fallita`. Lo stato delle esclusioni (pacchetto@versione falliti in test) vive nel body della issue "fallita" in un blocco `<!-- autofix-state {json} -->`; `parseIssueState(body: string): { excluded: string[] }`.
  - `prBody(summary): string` — tabella `pacchetto | da | a | tipo | GHSA | età | provenienza`.

- [ ] **Step 1: Test** per `renderIssue`/`parseIssueState` (round-trip dello stato, istruzione `force` presente nella issue "in attesa" con data prevista, body senza stato → `excluded: []`) e per la decisione single/split in `autofix.mjs` (funzione pura `nextMode({ openAutofixPr, lastQueueResult }): 'single'|'split'|'wait'`: PR single fallita in merge queue → `split`; PR aperta in corso → `wait`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implementare.** **Step 4: Run** → PASS.
- [ ] **Step 5: Workflow** `security-autofix.yml`:
  - `on`: `schedule: cron "30 2 * * *"`; `workflow_run: workflows: [Sicurezza], types: [completed], branches: [main]` (job solo se `conclusion == 'failure'` ed evento originale `push`/`schedule`); `workflow_dispatch` con input `force` (string, opzionale), `dry_run` (boolean, default false).
  - `concurrency: security-autofix`, `cancel-in-progress: false`.
  - Un job: harden-runner, checkout `main`, pnpm/Node (come `tests.yml`), Python 3.14 + `pip-tools packaging`, setup Trivy v0.76.1, token App; `gh pr list --head 'security-autofix/'` + stato del check in merge queue → `nextMode`; esecuzione `autofix.mjs`; se ci sono fix e verifica ok e non `dry_run`: branch `security-autofix/<YYYY-MM-DD>` (o `security-autofix/<pkg>` in split), commit `fix(deps): correzioni di sicurezza <data>`, push col token App, `gh pr create` + `gh pr merge --auto`; sempre: aggiornamento/chiusura delle tre issue con `gh issue`.
  - Permessi workflow `contents: read`; scritture solo via token App.
- [ ] **Step 6: Verifica** dopo merge su `main` (il workflow deve esistere sul default branch): `gh workflow run security-autofix.yml -f dry_run=true` → summary con `node-forge 1.4.0→1.4.1` e `follow-redirects →1.16.2` (o vuoto se già corretti dalle PR Dependabot nel frattempo), nessuna PR. Poi run reale → PR aperta con auto-merge, check verdi.
- [ ] **Step 7: Commit** — `feat(ci): workflow security-autofix con PR automatica e issue`

---

### Task 8: Gate di non regressione sul rebuild di `latest` + documentazione

**Files:**
- Modify: `.github/workflows/release.yml` (step "Trivy vulnerability scan" e "Issue vulnerabilita' non risolvibile con un rebuild")
- Modify: `docs/claude/ci-cd-deps.md`, `docs/ci-cd-security-baseline.md`, `.github/dependabot.yml` (solo commento sul cooldown)

**Interfaces:**
- Consumes: `diff-gate.mjs` (Task 1).

- [ ] **Step 1: release.yml** — sui tag `v*` lo scan resta bloccante assoluto. Sul rebuild (schedule/dispatch): scan SARIF con `exit-code: 0`, scan JSON dell'immagine nuova e della `latest` corrente (`$IMAGE:latest`, se esiste) nello stesso job, `diff-gate.mjs --format trivy`: exit 1 → blocca (regressione); exit 0 con finding residui → pubblica e aggiorna la issue esistente "Vulnerabilità non risolvibile con un rebuild (<app>)" con la tabella residua (condizione dello step: residui presenti, non più solo `failure()`).
- [ ] **Step 2: Verifica** — `gh workflow run release.yml --ref ci/security-autofix -f dry_run=true` non basta (salta il build): verificare dopo merge con `gh workflow run release.yml --ref main -f rebuild_latest=true` → job verdi, eventuali residui nella issue.
- [ ] **Step 3: Documentazione** — `docs/claude/ci-cd-deps.md`: sezione "Correzioni di sicurezza autonome" (eccezione cooldown 48h + provenienza, `force`, gate differenziale, issue, split su fallimento, come forzare a mano); `docs/ci-cd-security-baseline.md`: aggiornare la descrizione dei gate; commento in `dependabot.yml` che rimanda all'autofix quando l'alert Dependabot non arriva.
- [ ] **Step 4: Commit** — `feat(ci): rebuild di latest con gate di non regressione` + `docs(ci): correzioni di sicurezza autonome`
