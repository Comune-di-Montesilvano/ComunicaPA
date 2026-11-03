# Baseline di sicurezza CI/CD

Riferimento per la supply chain di ComunicaPA (stato al 2026-11-03) e checklist per
misurare i gap di altri repository. Ogni voce dice **cosa**, **perché** e **come
verificarla**. Le parti specifiche di ComunicaPA (stack Node/Python, compose, Portainer)
sono segnate come tali: in un altro repo si sostituiscono con l'equivalente.

## Principi

1. **Nessuna fiducia implicita.** Ogni anello (codice, dipendenze, pipeline, artefatto,
   deploy, runtime) è verificato da quello successivo, non dato per buono.
2. **Fallire chiusi.** Un controllo che non può verificare blocca (merge, tag, avvio): mai
   "warning e si prosegue". Un controllo che non blocca è solo un report.
3. **Un solo cancello, senza eccezioni.** Tutto arriva su main dalla merge queue e in
   produzione dal job di release; nessun bypass, admin compresi.
4. **Tutto fissato e verificabile.** Action per SHA, immagini per digest, dipendenze per hash,
   tool per versione: ciò che è stato verificato è esattamente ciò che gira.
5. **Privilegio minimo.** Token di sola lettura di default, permessi di scrittura solo nel
   job che li usa; container non-root, senza capability, filesystem in sola lettura.
6. **Ritardo deliberato sulle novità.** Le nuove versioni delle dipendenze entrano dopo un
   periodo di attesa (le release compromesse di solito vengono ritirate entro giorni);
   gli advisory di sicurezza no.
7. **Provare ciò che si pubblica.** Lo stack reale viene avviato e testato con gli artefatti
   finali prima di renderli raggiungibili per tag.
8. **Costo proporzionato.** I controlli pesanti girano una volta, nel punto che protegge
   davvero (merge queue, release), non a ogni push.
9. **Il cancello non lo sceglie chi lo attraversa.** Nei controlli differenziali lo script
   che decide e il termine di confronto vengono dal branch di destinazione (o dall'artefatto
   già pubblicato), non dalla PR:
   una PR non può indebolire il controllo che la giudica.
10. **Le correzioni automatiche passano dagli stessi cancelli.** Un bot che corregge da solo
    apre una PR come chiunque altro (merge queue, check richiesti), con un token dai permessi
    minimi e potendo toccare solo i file previsti.

## 1. Impostazioni del repository

| Impostazione | Valore | Perché |
|---|---|---|
| Permessi di default `GITHUB_TOKEN` | `read`, non può approvare PR | un workflow compromesso non scrive nulla se non dichiarato |
| Action consentite | `selected`: GitHub + elenco esplicito delle action di terze parti usate (`owner/action@*`) | un'action non prevista (anche da una PR) non gira |
| SHA pinning | `sha_pinning_required: true` | GitHub rifiuta i workflow con action non fissate per SHA, anche annidate |
| Metodo di merge | solo squash: imposto dal ruleset e, a livello repo, `allow_merge_commit`/`allow_rebase_merge: false` | storia lineare, un commit per PR (su ComunicaPA i due flag repo sono ancora `true`: decide il ruleset) |
| `delete_branch_on_merge` | `true` | niente branch orfani |
| `allow_auto_merge` | `true` | serve alla merge queue e all'auto-merge Dependabot |
| Dependabot security updates | attivo | advisory → PR subito, senza cooldown |
| Secret scanning + push protection | attivi | un segreto noto non arriva nemmeno nel repo |
| Private vulnerability reporting | attivo | canale privato citato in `SECURITY.md` |
| CodeQL | default setup, suite `extended`, tutti i linguaggi (Actions compreso) | analisi su PR e su main |
| `CODEOWNERS`, template PR | presenti | checklist test/sicurezza a ogni PR |
| GitHub App del bot | secret `BOT_CLIENT_ID`/`BOT_PRIVATE_KEY` salvati **sia** come secret Actions **sia** come secret Dependabot; permessi App: Contents RW, Pull requests RW, Workflows RW, Metadata R | le azioni fatte con `GITHUB_TOKEN` non avviano altri workflow (la PR resterebbe senza check); sui run avviati da Dependabot sono visibili solo i secret Dependabot |

Verifica:
```sh
R=repos/<owner>/<repo>
gh api $R -q '{delete_branch_on_merge,allow_auto_merge,allow_squash_merge,allow_merge_commit,allow_rebase_merge,security_and_analysis}'
gh api $R/actions/permissions/workflow
gh api $R/actions/permissions                       # allowed_actions, sha_pinning_required
gh api $R/actions/permissions/selected-actions      # elenco action di terze parti consentite
gh api $R/code-scanning/default-setup -q '{state,query_suite,languages}'
gh api $R/private-vulnerability-reporting
```

> **Action consentite: una nuova action di terze parti va aggiunta all'elenco** (Settings →
> Actions → General, o `PUT $R/actions/permissions/selected-actions`), altrimenti il workflow
> fallisce. Contano anche le action annidate nelle composite (es. `aquasecurity/setup-trivy`
> dentro `trivy-action`). Prima di attivare `sha_pinning_required` verificare che anche le
> composite usate fissino per SHA le loro action interne.

Non disponibili su ComunicaPA: secret scanning `non_provider_patterns` e `validity_checks`
(l'API accetta la richiesta ma restano spenti: richiedono la licenza GitHub Secret Protection).

## 2. Ruleset

### `main` (branch di default)

| Regola | Parametri | Perché |
|---|---|---|
| `deletion`, `non_fast_forward` | — | main non si cancella né si riscrive |
| `pull_request` | approvazioni richieste 0 (unico maintainer), thread risolti obbligatori, solo squash | nessun push diretto |
| `required_status_checks` | `run-tests`, `pdf-extractor-tests`, `dependency-review`, `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)` ×4; non strict | la coda rimette già la PR in pari |
| `merge_queue` | squash, ALLGREEN, build/merge fino a 5, timeout check 60 min | ogni commit su main è testato così com'è |
| `code_scanning` | CodeQL: alert `errors`, sicurezza `high_or_higher` | una PR non introduce alert nuovi |
| bypass | **nessuno** (admin compresi) | il cancello vale per tutti |

### `release-tags` (tag `refs/tags/v*`)

| Regola | Perché |
|---|---|
| `creation`, `update`, `deletion`, `non_fast_forward` | solo gli admin creano tag di release; un tag non si sposta né si cancella |
| bypass: ruolo admin | il maintainer crea i tag (dopo aver scelto il numero di versione) |

Verifica:
```sh
gh api repos/<owner>/<repo>/rulesets -q '.[] | {id,name,target,enforcement}'
gh api repos/<owner>/<repo>/rulesets/<id> -q '{bypass_actors, rules}'
```

> L'API del ruleset `main` riporta anche `require_extra_approval_for_unattributed_changes: true`
> nella regola `pull_request`: parametro non descritto nella documentazione pubblica di
> GitHub, lasciato al valore impostato da GitHub. Va ricontrollato quando la documentazione
> lo descrive.

> I check richiesti devono girare anche sull'evento `merge_group`, altrimenti la coda resta
> ferma in attesa. Un job saltato per `if:` vale verde; **un job matrice saltato no**: non
> crea i check `nome (<valore>)` e la PR resta bloccata. Nelle matrici si salta per step.

## 3. Regole per ogni workflow

- `permissions: contents: read` in testa; scritture solo a livello di job (`packages`,
  `security-events`, `id-token`, `attestations`, `issues`, `pull-requests`). Eccezione:
  `scorecard.yml` ha `permissions: read-all` in testa, come nel template OpenSSF (nessuna
  scrittura; le due scritture sono nel job).
- Un job che deve scrivere sul repo (commit, PR) usa un token di GitHub App generato nel job
  (`actions/create-github-app-token`) con i soli permessi che servono
  (`permission-contents: write`, `permission-pull-requests: write`), non un PAT.
- Ogni `uses:` fissato per **SHA completo** con il tag in commento (`# v4`); Dependabot li aggiorna.
- `actions/checkout` con `persist-credentials: false`.
- Primo step di ogni job: `step-security/harden-runner`. `egress-policy: audit` ovunque,
  `block` con `allowed-endpoints` nei job che pubblicano. Elenco host ricavato dal log DNS del
  post-step di qualche run in audit; l'infrastruttura Actions è consentita in automatico.
- `timeout-minutes` su ogni job; `concurrency` su ogni workflow (eccezione: `scorecard.yml`):
  `cancel-in-progress: true` sui check di sola lettura, `false` su quelli che scrivono
  (release: un push interrotto lascia manifest incompleti; autofix, pulizia ghcr, auto-merge).
- Niente `pull_request_target` con checkout del codice della PR.
- Input non fidati (titoli PR, nomi branch) passati via `env:`, mai interpolati in `run:`.
- Tool scaricati a versione fissa (es. Trivy `version: v0.76.1`), con un workflow che apre
  una issue quando esce una nuova versione (pnpm e corepack: dopo 7 giorni, come il cooldown).
- Controlli differenziali: lo script del gate si prende dal checkout della base quando esiste
  (`GATE=.base/scripts/security/diff-gate.mjs`, fallback sulla copia della PR solo se la base
  non lo ha ancora), stesso binario e stesso DB di vulnerabilità per testa e base.
- Gli script di sicurezza (gate, autofix) hanno test propri: `node --test scripts/security/test/`
  in `run-tests`, gli unittest di `pip_fix.py` in `pdf-extractor-tests`. I test lavorano su
  **copie fisse** dei file (`scripts/security/test/fixtures/`), mai sui file vivi del repo:
  Dependabot e l'autofix li modificano e i test fallirebbero proprio sulle loro PR.

## 4. Pipeline

```
PR ──► check leggeri (lint, type-check, dependency-review, pnpm-audit, trivy-fs, CodeQL)
        │        audit e Trivy vuln differenziali: bloccano solo le vulnerabilità NUOVE
        │        (gate preso dalla base); segreti e misconfig sempre assoluti
        ▼
merge queue ──► check completi sul commit che verrà unito
        │        (build, test, pytest, build immagini + Trivy differenziale su latest)
        ▼
main ──► security.yml (giornaliero, assoluto) · CodeQL · Scorecard · security-alerts
        │   └─ fallito → security-autofix (anche giornaliero 02:30): PR con le
        │      correzioni (≥48h, provenienza verificata) → auto-merge in coda
        │
        ▼
release.yml (tag v* · controllo giornaliero 04:30 · dispatch)
   setup:         solo schedule (o dry_run): rebuild-check sulle 4 latest
                  (a commit su main · b patch di sistema · c Trivy HIGH/CRITICAL con fix)
                  → nessuna causa = skip, latest invariato
   build-push ×4: build → push SOLO per digest → Trivy (tag: bloccante;
                  rebuild: nessuna regressione rispetto a latest) → SBOM
                  → attestazioni provenance + SBOM → firma cosign keyless
   smoke:         stack compose di produzione con i 4 digest → smoke-stack.sh
   publish ×4:    solo se smoke verde → tag vX.Y.Z / latest / latest-YYYYMMDD
        │
        ▼
deploy ──► verify-images (cosign, VERIFY_IMAGES=true) → servizi avviati solo se verificati
        │
        ▼
runtime ──► non-root · cap_drop ALL · no-new-privileges · read_only + tmpfs/volumi
```

### Workflow di ComunicaPA

| Workflow | Trigger | Ruolo |
|---|---|---|
| `tests.yml` | PR, merge queue | `run-tests` (sulla PR: test degli script di sicurezza, install, lint, type-check; in coda + build e test), `pdf-extractor-tests` (solo in coda: pytest, test di `pip_fix.py`) |
| `security.yml` | PR, coda, push main, giornaliero 05:00 | `dependency-review` (solo PR, HIGH+, rispetta `ignoreGhsas`), `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)` (sulla PR job verde senza scansione, per step; scansione in coda/main/giornaliero); vulnerabilità differenziali su PR e coda (`trivy-image` in coda: rispetto alla `latest` pubblicata), assolute su main e nel giornaliero |
| `security-autofix.yml` | giornaliero 02:30, Sicurezza fallita su main, dispatch (`force`, `dry_run`) | corregge da solo le HIGH/CRITICAL con versione corretta (vedi §5 "Correzioni autonome") |
| CodeQL (default setup) | PR, main, settimanale | SAST, suite extended |
| `scorecard.yml` | push main, settimanale | OpenSSF Scorecard, risultati pubblici |
| `security-alerts.yml` | giornaliero, push main | fallisce e apre/aggiorna una issue se ci sono alert code scanning (CodeQL, Trivy) high/critical aperti su main, Scorecard escluso; la chiude quando non ce ne sono. La regola code scanning blocca solo i nuovi. **Non** è un check richiesto: bloccherebbe anche la PR che corregge l'alert |
| `release.yml` | tag `v*`, giornaliero, dispatch | build, firma, smoke, pubblicazione; il giornaliero ricostruisce `latest` solo su causa reale (`scripts/rebuild-check.sh`) |
| `ghcr-cleanup.yml` | settimanale | rimuove i digest orfani (build non pubblicati) e le loro firme |
| `dependabot-automerge.yml` | PR Dependabot | auto-merge minor/patch via token GitHub App (la PR passa comunque dalla merge queue); major e cambi di runtime (es. tag `python` 3.14 → 3.15, che Dependabot classifica minor) restano manuali |
| `toolchain-version-check.yml`, `trivy-version-check.yml` | settimanale (lunedì) | issue quando escono nuove versioni dei tool fissati |
| `publiccode-validate.yml` | PR, push | validazione `publiccode.yml` |

## 5. Dipendenze

| Cosa | Come | Verifica |
|---|---|---|
| Lockfile | `pnpm install --frozen-lockfile`; pip `--require-hashes` con lock completo (dirette + transitive) | build fallisce su lock non allineato |
| Package manager | versione e hash da `packageManager`; corepack installato da tarball con `ADD --checksum=sha256:` | nessun `@latest` |
| Immagini base | `FROM image:tag@sha256:…` | Dependabot aggiorna il digest |
| Dependabot | ecosistemi npm, pip, docker, docker-compose, github-actions; giornaliero alle 01:00 Europe/Rome; `cooldown` 7 giorni (14 per le major npm/pip; docker e Actions non supportano `semver-major-days`); gruppi minor/patch; major di `postgres` ignorate (richiedono migrazione dei dati, mai un bump) | security updates senza cooldown; se l'alert non arriva o il cooldown blocca la PR raggruppata, `security-autofix.yml` |
| Audit | `pnpm audit --prod` HIGH+, Trivy fs (lockfile, segreti, misconfig Dockerfile/compose), dependency-review su PR HIGH+ (dev e Actions compresi) | eccezioni solo motivate (vedi sotto) |
| Runtime minimale | npm/npx/corepack rimossi dall'immagine di produzione; `apk/apt upgrade` invalidato una volta al giorno (`PKG_REFRESH`) | meno CVE trasportate |

**Tre strumenti per le eccezioni, ognuno con motivazione scritta accanto:**
- `overrides` in `pnpm-workspace.yaml`: forza una versione corretta quando il pacchetto padre
  non si è ancora aggiornato. Va limitato alla versione vulnerabile (`'pkg@<11.0.1': ^11.0.4`,
  non `pkg: ^11`) e ha nel commento l'advisory e la condizione di rimozione ("quando i padri
  passano a ^11"). Per un salto di major (fix senza backport) verificare che i padri non usino
  le API rimosse e che lint, build e test restino verdi.
- `auditConfig.ignoreGhsas`: solo advisory **senza** versione corretta e con codice vulnerabile
  non raggiungibile, dimostrato da un test di regressione. Letto anche da dependency-review.
- `.trivyignore.yaml`: per ID e **limitato per percorso** (es. `DS-0002` "utente root" solo sui
  `Dockerfile.dev`), con `statement`.

### Correzioni autonome (`security-autofix.yml`)

Rete di sicurezza per le HIGH/CRITICAL con versione corretta, quando Dependabot non apre
l'alert o il cooldown ferma la PR. Elementi da replicare:
- **Eccezione al cooldown, non abolizione**: la versione scelta è la più bassa che corregge,
  pubblicata da almeno **48 ore**, con **provenienza verificata** (firma del registry npm,
  attestazione SLSA o PEP 740 dallo **stesso repository** delle versioni precedenti). Il
  dispatch `force` salta solo le 48 ore, mai la provenienza.
- Per tipo: npm diretta → bump; npm transitiva → `override` sulla sola versione vulnerabile;
  pip → pin in `requirements.in` e lock ricompilato con hash; immagine base → digest più recente
  dello stesso tag.
- Commit creati via API GraphQL `createCommitOnBranch` col token della GitHub App: commit
  verificati da GitHub, nessuna chiave di firma nel runner. Il commit fallisce se il working
  tree tocca file fuori da un elenco consentito (un tool di terze parti eseguito durante la
  correzione non può modificare workflow, gate o sorgenti).
- Una PR unica con auto-merge, quindi merge queue e check richiesti come ogni altra; se
  fallisce, al giro dopo una PR per pacchetto, e le correzioni fallite restano escluse.
- Tre issue di stato (in attesa / non correggibili / fallite), chiuse quando si svuotano.
- Il merge su main è una causa reale per il rebuild di `latest` delle 04:30.

## 6. Release e artefatti

- Push **solo per digest**, senza tag: un'immagine non scansionata, non firmata o non provata
  non è mai raggiungibile per tag (resta un digest orfano rimosso dalla pulizia settimanale).
- Trivy bloccante su CRITICAL/HIGH con fix disponibile sui tag `v*`; nel rebuild giornaliero
  blocca solo le regressioni rispetto alla `latest` pubblicata, così un rebuild che corregge
  qualcosa non resta fermo per una CVE che nessun rebuild può correggere.
- **Rebuild giornaliero su causa reale**, non incondizionato: lo schedule delle 04:30 esegue
  `scripts/rebuild-check.sh` sulle 4 immagini `latest` attuali (per digest) e ricostruisce
  solo se trova almeno una causa:
  - **a** commit su main dopo la label `org.opencontainers.image.revision` di `latest`
    (codice e merge Dependabot: npm, pip, immagini base fissate per digest, Actions);
  - **b** patch di sistema disponibili (`apk list -u` / `apt list --upgradable` dentro
    l'immagine, distro letta da `/etc/os-release`; senza shell o package manager Trivy sui
    pacchetti OS);
  - **c** Trivy con DB aggiornato: almeno una HIGH/CRITICAL con fix.

  Nessuna causa → run verde, nessun digest nuovo (le istanze su `latest` non si riavviano,
  ghcr non accumula digest); esito per immagine e controllo nel summary della run. Un
  controllo che non riesce a verificare conta come causa (fallire chiusi = ricostruire).
  Le cause finiscono nel summary e nella label `comunicapa.rebuild.reason` dell'immagine
  (`docker inspect --format '{{index .Config.Labels "comunicapa.rebuild.reason"}}'`).
  Rebuild con CVE ancora presenti (fix non ancora nelle immagini base) → `latest` pubblicata
  se non peggiora, issue "Vulnerabilità non risolvibile con un rebuild (<app>)"; il bump del
  digest dell'immagine base lo fa `security-autofix.yml`.
  Tag `v*` e dispatch con `rebuild_latest=true` ricostruiscono sempre; dispatch con
  `dry_run=true` esegue solo il controllo e ne stampa l'esito. Il vecchio salto "tag nelle
  ultime 24 ore" non c'è più: dopo un tag la revision di `latest` è il commit taggato, quindi
  la causa a lo copre, mentre il salto a tempo ignorava per un giorno le cause b e c.
- Attestazioni firmate su GitHub: provenance SLSA (`attest-build-provenance`) e SBOM CycloneDX
  (`attest-sbom`), legate al digest.
- Firma **keyless** cosign del digest (identità OIDC del workflow, log di trasparenza Rekor).
- **Smoke test** dello stack completo (`scripts/smoke-stack.sh`): servizi su, frontend e API
  via reverse proxy, query autenticata sul DB (migration applicate), upload su disco,
  servizio PDF, filesystem in sola lettura, log senza errori di filesystem.
- Tag: `vX.Y.Z` solo dal maintainer (ruleset), `latest` e `latest-YYYYMMDD` dal rebuild
  giornaliero (solo nei giorni con una causa); il `latest-YYYYMMDD` precedente = rollback
  immediato.

Verifica manuale di un tag (firma cosign; con `gh` disponibile anche le attestazioni
provenance e SBOM, via `gh attestation verify`):
```sh
scripts/verify-images.sh v1.11.12          # Docker
CONTAINER_CLI=podman scripts/verify-images.sh v1.11.12
```
Il servizio `verify-images` del compose (§7) verifica solo la firma cosign.
Identità attesa: `^https://github.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$`,
issuer `https://token.actions.githubusercontent.com`.

## 7. Deploy (specifico: Portainer + podman rootless, compose da git)

- Servizio one-shot `verify-images` nel compose: con `VERIFY_IMAGES=true` verifica con cosign
  le firme di tutte le immagini di `IMAGE_TAG`; i servizi applicativi dipendono da lui con
  `condition: service_completed_successfully`. Firma assente o tag inesistente → servizi
  creati ma non avviati, deploy in errore. Circa 10 secondi.
- Opzionale con una **variabile**, non con `profiles` + `required: false`: con il profilo
  una verifica fallita dà solo un warning e i servizi partono comunque.
- Ogni modifica al compose va provata pensando a **podman**, non solo a Docker
  (es. le opzioni tmpfs `uid=`/`gid=` sono accettate da Docker e rifiutate da podman).
- Compose nuovo che richiede immagini nuove: lanciare subito il rebuild di `latest`.

## 8. Runtime (compose di produzione)

| Misura | Dettaglio |
|---|---|
| Utente | immagini applicative non-root (uid dedicato: `node`, 101, 10001) e cosign `nonroot`; DB e cache (immagini ufficiali) partono root e l'entrypoint passa all'utente dedicato |
| Privilegi | `security_opt: no-new-privileges:true`, `cap_drop: ALL` su tutti i servizi; solo DB e cache riaggiungono le 5 capability che servono al loro entrypoint (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`) |
| Filesystem | `read_only: true` su tutti i servizi; scritture solo su volumi named e tmpfs dichiarati |
| Temporanei | upload grandi su volume su disco (non tmpfs in RAM); `/tmp` in tmpfs piccolo dove basta |
| Config runtime generata | scritta in tmpfs (es. `config.js` di nginx in `/tmp/runtime-config`), mai nella root servita |
| Rete | porte sull'host solo per i due frontend (il proxy esterno punta lì); backend, DB, cache e servizio PDF solo sulla rete interna; frontend same-origin via nginx verso `backend:8080`. Le porte dirette di sviluppo stanno solo in `docker-compose.override.yml` |
| Segreti | solo da variabili dello stack (`:?` per gli obbligatori), mai nell'immagine |

## 9. Monitoraggio e governance

- OpenSSF Scorecard pubblicato; badge OpenSSF Best Practices (livello passing).
- `SECURITY.md` (segnalazione privata, tempi di risposta), `CONTRIBUTING.md` (policy test:
  ogni fix ha un test di regressione), template PR con checklist.
- Test di fuzzing property-based (`fast-check`) sulle funzioni che trasformano input non fidato
  in path, filtri LDAP, celle CSV.
- Alert dismessi solo con motivazione scritta e verificata.

## 10. Gap residui noti di ComunicaPA

1. **Review da una seconda persona** (0 approvazioni richieste): chi controlla l'account del
   maintainer porta codice in produzione, firmato. Mitigazione: passkey/chiave hardware come
   2FA, secondo maintainer appena possibile.
2. **SLSA livello 3**: il build gira nello stesso job che firma la provenance; serve un
   workflow riutilizzabile isolato.
3. Secret scanning dei pattern generici e verifica di validità dei segreti (licenza Secret Protection).
4. Fuori dalla CI/CD: rotazione dei segreti dello stack, accesso a Portainer, backup con
   ripristino provato, monitoraggio a runtime.
5. **Metodi di merge a livello repo**: merge commit e rebase restano abilitati; oggi li blocca
   solo il ruleset.

## Checklist per la gap analysis di un altro repo

Segnare ✅ / ⚠️ (parziale) / ❌ / n.a. Le voci marcate (★) danno il valore maggiore per lo sforzo.

**Repository**
- [ ] ★ Token `GITHUB_TOKEN` di default in sola lettura, non approva PR
- [ ] Secret scanning + push protection attivi
- [ ] Private vulnerability reporting attivo, `SECURITY.md` presente
- [ ] Dependabot security updates attivi
- [ ] CodeQL (o SAST equivalente) su PR e branch principale
- [ ] SHA pinning imposto da impostazione (`sha_pinning_required`), action consentite ristrette a un elenco
- [ ] Branch cancellati dopo il merge, solo squash (anche a livello repo, non solo nel ruleset)
- [ ] Bot con GitHub App (non PAT né `GITHUB_TOKEN`), secret anche lato Dependabot

**Ruleset / protezione**
- [ ] ★ Branch principale: PR obbligatoria, niente force-push/cancellazione, **nessun bypass**
- [ ] ★ Required check su test e controlli di sicurezza
- [ ] Merge queue (o almeno "branch aggiornato" obbligatorio), workflow con trigger `merge_group`
- [ ] Regola code scanning (alert nuovi bloccano)
- [ ] Tag di release protetti (creazione/modifica solo admin)
- [ ] Review di una seconda persona

**Workflow**
- [ ] ★ `permissions` minimi in testa, scritture solo nei job
- [ ] ★ Tutte le action fissate per SHA
- [ ] `persist-credentials: false`, niente `pull_request_target` pericoloso, input via `env:`
- [ ] `harden-runner` (audit ovunque, block sui job che pubblicano)
- [ ] `timeout-minutes` e `concurrency` su ogni job
- [ ] Controlli pesanti solo dove servono (coda/release), niente run duplicati su push main
- [ ] Gate differenziali con script e termine di confronto presi dalla base, non dalla PR
- [ ] Script di sicurezza con test propri, su copie fisse dei file (mai sui file vivi)

**Dipendenze**
- [ ] ★ Lockfile obbligatorio e congelato in CI; hash per pip/altri
- [ ] ★ Audit dipendenze bloccante (HIGH+) e dependency-review sulle PR
- [ ] Dependabot su tutti gli ecosistemi (codice, Docker, compose, Actions) con cooldown
- [ ] Immagini base fissate per digest, tool CI a versione fissa
- [ ] Scansione segreti e misconfig (Trivy fs o equivalente)
- [ ] Eccezioni (override, ignore) con motivazione, limitate alla versione/al percorso, con condizione di rimozione
- [ ] Correzione automatica delle vulnerabilità con versione corretta: età minima + provenienza, stessa merge queue, file consentiti

**Release**
- [ ] ★ Build in CI, mai dal PC del maintainer
- [ ] ★ Scansione dell'artefatto bloccante prima della pubblicazione
- [ ] Push per digest, tag applicati solo a fine pipeline
- [ ] Firma (cosign keyless) + provenance + SBOM attestati
- [ ] Smoke test dello stack con gli artefatti finali prima del tag
- [ ] Pulizia degli artefatti orfani

**Deploy e runtime**
- [ ] Verifica delle firme prima dell'avvio (automatica o procedura documentata)
- [ ] Rollback documentato (tag precedente / datato)
- [ ] ★ Container non-root, `cap_drop: ALL`, `no-new-privileges`
- [ ] Filesystem in sola lettura con tmpfs/volumi espliciti
- [ ] Segreti solo da ambiente, obbligatori con errore esplicito
- [ ] Solo i servizi d'ingresso pubblicano porte sull'host; DB, cache e API interne solo in rete interna

**Governance**
- [ ] `CONTRIBUTING.md` con policy test, template PR
- [ ] Scorecard attivo, badge Best Practices
- [ ] Controllo periodico degli alert aperti (non solo dei nuovi)
- [ ] Fuzzing/property-based sulle funzioni che toccano input non fidato
