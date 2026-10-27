# Baseline di sicurezza CI/CD

Riferimento per la supply chain di ComunicaPA (stato al 2026-10-27) e checklist per
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

## 1. Impostazioni del repository

| Impostazione | Valore | Perché |
|---|---|---|
| Permessi di default `GITHUB_TOKEN` | `read`, non può approvare PR | un workflow compromesso non scrive nulla se non dichiarato |
| Action consentite | `selected`: GitHub + elenco esplicito delle action di terze parti usate (`owner/action@*`) | un'action non prevista (anche da una PR) non gira |
| SHA pinning | `sha_pinning_required: true` | GitHub rifiuta i workflow con action non fissate per SHA, anche annidate |
| Metodo di merge | solo squash (dal ruleset) | storia lineare, un commit per PR |
| `delete_branch_on_merge` | `true` | niente branch orfani |
| `allow_auto_merge` | `true` | serve alla merge queue e all'auto-merge Dependabot |
| Dependabot security updates | attivo | advisory → PR subito, senza cooldown |
| Secret scanning + push protection | attivi | un segreto noto non arriva nemmeno nel repo |
| Private vulnerability reporting | attivo | canale privato citato in `SECURITY.md` |
| CodeQL | default setup, suite `extended`, tutti i linguaggi (Actions compreso) | analisi su PR e su main |
| `CODEOWNERS`, template PR | presenti | checklist test/sicurezza a ogni PR |

Verifica:
```sh
R=repos/<owner>/<repo>
gh api $R -q '{delete_branch_on_merge,allow_auto_merge,security_and_analysis}'
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

> I check richiesti devono girare anche sull'evento `merge_group`, altrimenti la coda resta
> ferma in attesa. Un job saltato per `if:` vale verde; **un job matrice saltato no**: non
> crea i check `nome (<valore>)` e la PR resta bloccata. Nelle matrici si salta per step.

## 3. Regole per ogni workflow

- `permissions: contents: read` in testa; scritture solo a livello di job (`packages`,
  `security-events`, `id-token`, `attestations`, `issues`).
- Ogni `uses:` fissato per **SHA completo** con il tag in commento (`# v4`); Dependabot li aggiorna.
- `actions/checkout` con `persist-credentials: false`.
- Primo step di ogni job: `step-security/harden-runner`. `egress-policy: audit` ovunque,
  `block` con `allowed-endpoints` nei job che pubblicano. Elenco host ricavato dal log DNS del
  post-step di qualche run in audit; l'infrastruttura Actions è consentita in automatico.
- `timeout-minutes` su ogni job; `concurrency` (`cancel-in-progress: true` sui check, `false`
  sulla release: un push interrotto lascia manifest incompleti).
- Niente `pull_request_target` con checkout del codice della PR.
- Input non fidati (titoli PR, nomi branch) passati via `env:`, mai interpolati in `run:`.
- Tool scaricati a versione fissa (es. Trivy `version: v0.76.1`), con un workflow che apre
  una issue quando esce una nuova versione.

## 4. Pipeline

```
PR ──► check leggeri (lint, type-check, dependency-review, pnpm-audit, trivy-fs, CodeQL)
        │
        ▼
merge queue ──► check completi sul commit che verrà unito
        │        (build, test, pytest, build immagini + Trivy)
        ▼
main ──► security.yml (giornaliero) · CodeQL · Scorecard · security-alerts (giornaliero)
        │
        ▼
release.yml (tag v* · rebuild giornaliero 04:30 · dispatch)
   build-push ×4: build → push SOLO per digest → Trivy bloccante → SBOM
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
| `tests.yml` | PR, merge queue | `run-tests` (sulla PR: install, lint, type-check; in coda + build e test), `pdf-extractor-tests` (solo in coda) |
| `security.yml` | PR, coda, push main, giornaliero | `dependency-review` (solo PR), `pnpm-audit`, `trivy-fs`, `trivy-image (<app>)` (solo coda/main/giornaliero) |
| CodeQL (default setup) | PR, main, settimanale | SAST, suite extended |
| `scorecard.yml` | push main, settimanale | OpenSSF Scorecard, risultati pubblici |
| `security-alerts.yml` | giornaliero, push main | fallisce e apre/aggiorna una issue se ci sono alert high/critical aperti su main (la regola code scanning blocca solo i nuovi) |
| `release.yml` | tag `v*`, giornaliero, dispatch | build, firma, smoke, pubblicazione |
| `ghcr-cleanup.yml` | settimanale | rimuove i digest orfani (build non pubblicati) e le loro firme |
| `dependabot-automerge.yml` | PR Dependabot | auto-merge minor/patch via token GitHub App; major e runtime restano manuali |
| `toolchain-version-check.yml`, `trivy-version-check.yml` | settimanale (lunedì) | issue quando escono nuove versioni dei tool fissati |
| `publiccode-validate.yml` | PR, push | validazione `publiccode.yml` |

## 5. Dipendenze

| Cosa | Come | Verifica |
|---|---|---|
| Lockfile | `pnpm install --frozen-lockfile`; pip `--require-hashes` con lock completo (dirette + transitive) | build fallisce su lock non allineato |
| Package manager | versione e hash da `packageManager`; corepack installato da tarball con `ADD --checksum=sha256:` | nessun `@latest` |
| Immagini base | `FROM image:tag@sha256:…` | Dependabot aggiorna il digest |
| Dependabot | ecosistemi npm, pip, docker, docker-compose, github-actions; giornaliero; `cooldown` 7 giorni (14 per le major npm/pip); gruppi minor/patch | security updates senza cooldown |
| Audit | `pnpm audit --prod` HIGH+, Trivy fs (lockfile, segreti, misconfig Dockerfile/compose), dependency-review su PR (dev e Actions compresi) | eccezioni solo motivate (`auditConfig.ignoreGhsas`, `.trivyignore.yaml`) |
| Runtime minimale | npm/npx/corepack rimossi dall'immagine di produzione; `apk/apt upgrade` invalidato una volta al giorno (`PKG_REFRESH`) | meno CVE trasportate |

## 6. Release e artefatti

- Push **solo per digest**, senza tag: un'immagine non scansionata, non firmata o non provata
  non è mai raggiungibile per tag (resta un digest orfano rimosso dalla pulizia settimanale).
- Trivy bloccante su CRITICAL/HIGH con fix disponibile, anche nel rebuild giornaliero.
- Attestazioni firmate su GitHub: provenance SLSA (`attest-build-provenance`) e SBOM CycloneDX
  (`attest-sbom`), legate al digest.
- Firma **keyless** cosign del digest (identità OIDC del workflow, log di trasparenza Rekor).
- **Smoke test** dello stack completo (`scripts/smoke-stack.sh`): servizi su, frontend e API
  via reverse proxy, query autenticata sul DB (migration applicate), upload su disco,
  servizio PDF, filesystem in sola lettura, log senza errori di filesystem.
- Tag: `vX.Y.Z` solo dal maintainer (ruleset), `latest` e `latest-YYYYMMDD` dal rebuild
  giornaliero; `latest-YYYYMMDD` del giorno prima = rollback immediato.

Verifica manuale di un tag:
```sh
scripts/verify-images.sh v1.11.12          # Docker
CONTAINER_CLI=podman scripts/verify-images.sh v1.11.12
```
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
| Utente | tutte le immagini non-root (uid dedicato) |
| Privilegi | `security_opt: no-new-privileges:true`, `cap_drop: ALL`; solo DB e cache riaggiungono le 5 capability dell'entrypoint |
| Filesystem | `read_only: true` su tutti i servizi; scritture solo su volumi named e tmpfs dichiarati |
| Temporanei | upload grandi su volume su disco (non tmpfs in RAM); `/tmp` in tmpfs piccolo dove basta |
| Config runtime generata | scritta in tmpfs (es. `config.js` di nginx in `/tmp/runtime-config`), mai nella root servita |
| Rete | backend non esposto dal proxy esterno; frontend same-origin via nginx |
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

## Checklist per la gap analysis di un altro repo

Segnare ✅ / ⚠️ (parziale) / ❌ / n.a. Le voci marcate (★) danno il valore maggiore per lo sforzo.

**Repository**
- [ ] ★ Token `GITHUB_TOKEN` di default in sola lettura, non approva PR
- [ ] Secret scanning + push protection attivi
- [ ] Private vulnerability reporting attivo, `SECURITY.md` presente
- [ ] Dependabot security updates attivi
- [ ] CodeQL (o SAST equivalente) su PR e branch principale
- [ ] SHA pinning imposto da impostazione (`sha_pinning_required`), action consentite ristrette a un elenco
- [ ] Branch cancellati dopo il merge, solo squash

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

**Dipendenze**
- [ ] ★ Lockfile obbligatorio e congelato in CI; hash per pip/altri
- [ ] ★ Audit dipendenze bloccante (HIGH+) e dependency-review sulle PR
- [ ] Dependabot su tutti gli ecosistemi (codice, Docker, compose, Actions) con cooldown
- [ ] Immagini base fissate per digest, tool CI a versione fissa
- [ ] Scansione segreti e misconfig (Trivy fs o equivalente)

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

**Governance**
- [ ] `CONTRIBUTING.md` con policy test, template PR
- [ ] Scorecard attivo, badge Best Practices
- [ ] Controllo periodico degli alert aperti (non solo dei nuovi)
- [ ] Fuzzing/property-based sulle funzioni che toccano input non fidato
