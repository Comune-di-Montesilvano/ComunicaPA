# Correzioni di sicurezza autonome su `latest` — design

Data: 2026-11-02 · Stato: bozza da approvare

## Perché

Lo scopo dell'automazione CI/CD è che le patch di sicurezza arrivino su `latest` senza
intervento umano. Il 2026-11-02 non è successo:

- `node-forge` 1.4.0 (5 advisory high, GHSA-7wch-p9px-956x e altre) e `follow-redirects`
  1.16.1 (GHSA-mrwp-f3q8-3g9p, transitiva via `soap`/`axios`) avevano versioni corrette
  pubblicate il 25–27/10; le advisory sono uscite il 30/10 23:00 UTC.
- La PR raggruppata minor/patch di Dependabot non le include: cooldown 7 giorni
  (`dependabot.yml`), sbloccate solo dal 03/11.
- Dependabot **non ha aperto alcun alert** per le nuove GHSA (dopo 2 giorni: nessun alert
  in nessuno stato), quindi nessuna security update, l'unica che salta il cooldown.
  Ritardo lato GitHub, non controllabile: non ci si può contare.
- `pnpm-audit` e `trivy-fs` sono required check che valutano lo **stato assoluto** del
  repo, non la differenza introdotta dalla PR. Risultato: bloccate anche PR non correlate
  (#287 pip, #288 npm) e bloccata in partenza qualsiasi PR che correggesse solo una delle
  due vulnerabilità (l'altra resta rossa). Il gate impedisce di mergiare le correzioni.
- Lo stesso schema esiste nel gate Trivy di `release.yml`: un'immagine con una CVE non
  correggibile blocca anche il rebuild che ne correggerebbe altre.

## Obiettivi

1. Una vulnerabilità HIGH/CRITICAL con versione corretta disponibile arriva su `main` e
   su `latest` senza intervento umano, anche se Dependabot non apre l'alert.
2. Una vulnerabilità già presente su `main` non blocca mai le PR non correlate né le PR
   che riducono le vulnerabilità.
3. Ciò che non si può correggere da solo (nessuna versione corretta, correzione che rompe
   i test, versione corretta troppo giovane o senza provenienza) produce **sempre** una
   issue di notifica, mai un blocco silenzioso.

Casi coperti (i più probabili, in ordine di frequenza attesa):

| Caso | Correzione |
|------|------------|
| npm transitiva (come `follow-redirects`) | override limitato alla versione vulnerabile |
| npm diretta (come `node-forge`) | bump della dipendenza alla prima versione corretta |
| pip (`services/pdf-extractor`) | bump in `requirements.in`/`requirements.txt` con hash rigenerati |
| Pacchetti OS dell'immagine (apk/apt) | già coperti: `PKG_REFRESH` + rebuild giornaliero |
| Immagine base (nuovo digest dello stesso tag, es. `node:26-alpine`) | bump del digest fissato nei Dockerfile |
| Nessuna versione corretta | issue di notifica (gestione manuale, come GHSA-86w9 oggi) |

## Non-obiettivi

- Aggiornamenti di routine: restano alla PR raggruppata Dependabot con cooldown 7 giorni.
- Upgrade major di runtime (Node, Python, Postgres): restano manuali, come oggi.
- Sostituire Dependabot security updates: se l'alert arriva, la PR Dependabot resta valida;
  l'autofix è la rete di sicurezza quando non arriva.
- devDependencies: fuori dall'audit di produzione oggi (`--prod`), restano fuori; le vede
  già `dependency-review` sulle PR.

## Anti-obiettivi (fallimento anche se "funziona")

- L'autofix porta in `main` una versione appena pubblicata e compromessa → vincoli di età
  e provenienza sotto.
- L'autofix aggiorna più del necessario (latest invece della prima versione corretta,
  altri pacchetti "di passaggio").
- Il gate differenziale lascia passare una PR che **introduce** una vulnerabilità.
- Una vulnerabilità resta aperta senza che nessuno lo sappia.

## Decisioni prese con l'utente

- **Merge automatico** delle PR di autofix: a bloccare malfunzionamenti gravi ci pensano i
  test della merge queue.
- **Eccezione al cooldown di 7 giorni** solo per le correzioni di sicurezza, con:
  - età minima **48 ore** della versione scelta (dalla data di pubblicazione sul registry);
  - **verifica di provenienza** della versione scelta prima di accettarla.

## Design

### A. Workflow `security-autofix.yml` (nuovo)

**Trigger:** cron giornaliero prima del rebuild di `latest` (04:30 UTC) e dopo il giro
Dependabot delle 01:00 Europe/Rome — es. 02:30 UTC; `workflow_run` su Sicurezza fallita
su `main` (push/schedule); `workflow_dispatch` (con input per forzare a mano un pacchetto
sotto i 48h, vedi C).

**Passi:**

1. **Rilevazione** sullo stato di `main`: `pnpm audit --prod --json` (rispettando
   `auditConfig.ignoreGhsas`) e Trivy fs/image in JSON con le stesse regole di
   `security.yml` (HIGH/CRITICAL, `--ignore-unfixed`, `.trivyignore.yaml`).
2. **Scelta della versione** per ogni pacchetto vulnerabile: la **più bassa** versione che
   corregge *tutte* le advisory aperte su quel pacchetto, entro la stessa major della
   versione in uso se esiste; altrimenti la prima major successiva corretta (i test
   decidono). Deve avere ≥ 48h (`time.<versione>` dal registry npm, `upload_time` da
   PyPI, data di creazione del manifest per le immagini) e superare la verifica di
   provenienza (sotto). Se la versione minima non le soddisfa, si prova la successiva
   corretta che le soddisfa; se nessuna, il pacchetto va in "in attesa" (C).
3. **Applicazione:**
   - npm diretta: aggiornare il range in `package.json` del workspace che la dichiara e il
     lockfile (`pnpm` dalla versione di `packageManager`).
   - npm transitiva: override in `pnpm-workspace.yaml` **limitato alla versione/range
     vulnerabile** (`'follow-redirects@<=1.16.1': 1.16.2`), stesso schema e stesso blocco
     commentato del `multer@2.4.0` esistente, con commento generato (GHSA, data, "rimuovere
     quando il padre si aggiorna"). Prima dell'override provare `pnpm update --depth
     Infinity <pkg>` entro i range dichiarati: se basta, niente override.
   - pip diretta: aggiornare il pin `==` in `requirements.in` e rigenerare
     `requirements.txt` con hash, con lo stesso strumento/flag già usati nel repo
     (`requirements-dev.*` idem se il pacchetto c'è).
   - pip transitiva (non in `requirements.in`): prima `--upgrade-package <pkg>==<v>` con
     `requirements.in` invariato; se il range del padre lo esclude, pin commentato in
     `requirements.in` (equivalente dell'override npm: GHSA, data, "rimuovere quando il
     padre si aggiorna"). Niente file di constraints separato. *(Scelta di design.)*
   - immagine base: aggiornare il digest fissato nei `Dockerfile`/`Dockerfile.dev` delle
     app interessate allo stesso tag (nessun cambio di tag), con le stesse regole 48h +
     attestazione. L'autofix **non** builda immagini: decide dai risultati Trivy di `main`
     e dal digest del tag sul registry; la verifica reale la fa `trivy-image` in merge
     queue. Vulnerabilità nei pacchetti bundled dell'immagine base (npm di Node, pacchetti
     Python di sistema) senza digest più recente che le corregga → "Non correggibile"
     (o "In attesa" se il digest c'è ma ha < 48h). *(Scelta di design.)*
4. **Verifica locale** prima di aprire la PR: rilanciare audit/Trivy sul risultato;
   ogni vulnerabilità corretta deve sparire e nessuna nuova deve comparire. Altrimenti
   niente PR, issue (C).
5. **PR unica** con tutte le correzioni di quel giro (una correzione parziale non deve
   dipendere da un'altra per passare il gate, ma un solo merge riduce i giri di coda),
   branch fisso `security-autofix/<data>` o riuso di quello aperto; titolo
   `fix(deps): correzioni di sicurezza <data>`; corpo con tabella pacchetto → da/a, GHSA,
   età, esito provenienza. Aperta con il token GitHub App (`BOT_CLIENT_ID` /
   `BOT_PRIVATE_KEY`, come `dependabot-automerge.yml`) così i check partono, e
   `gh pr merge --auto`. Se esiste già una PR autofix aperta, aggiornarla invece di aprirne
   un'altra.
   **Se la PR unica fallisce i test in merge queue:** al giro successivo l'autofix la
   chiude e apre **una PR per pacchetto** (il gate differenziale le rende indipendenti);
   quelle che passano si mergiano, quelle che falliscono finiscono in "Autofix fallito"
   e vengono escluse dai giri successivi finché cambia la versione corretta disponibile o
   un umano rimuove l'esclusione (stato tenuto nella issue o in un'etichetta, scelta del
   builder). Le PR per pacchetto che toccano lo stesso lockfile vengono riallineate dal
   bot quando vanno in conflitto. Una correzione che rompe i test non trattiene mai le
   altre per più di un giro. *(Scelta di design.)*
6. Dopo il merge il rebuild giornaliero di `latest` vede il commit su `main` (causa a di
   `rebuild-check.sh`) e ricostruisce. Nessuna modifica a `rebuild-check.sh`.

**Verifica di provenienza** (regola unica "mai un downgrade di fiducia"):

- npm: firma del registry valida obbligatoria; se **una qualsiasi versione precedente
  pubblicata** del pacchetto ha attestazione di provenance (Sigstore/trusted publishing),
  la versione scelta deve averla e il repository sorgente dell'attestazione deve
  coincidere con quello delle precedenti. Pacchetti che non l'hanno mai avuta: basta la
  firma del registry. Valutare `trustPolicy: no-downgrade` di pnpm (usato solo dentro il
  workflow) se nella versione di `packageManager` copre questa regola.
- PyPI: stessa regola sulle attestazioni PEP 740 (Integrity API di PyPI); gli hash in
  `requirements.txt` restano obbligatori come oggi.
- Immagini base Docker Official: firma/attestazione presente sul nuovo digest se presente
  sul precedente.
- Esito negativo → nessuna correzione per quel pacchetto, issue (C) con il motivo.

### B. Gate differenziale sulle PR e in merge queue (`security.yml`)

`pnpm-audit`, `trivy-fs` e `trivy-image` restano required check con lo stesso nome, ma su
`pull_request` e `merge_group` falliscono **solo per vulnerabilità presenti nel risultato
e assenti nella base** (identità = pacchetto + GHSA/CVE, non la versione, così un bump
parziale che lascia la stessa advisory non conta come nuova; una versione diversa con una
advisory diversa sì). Base: il commit base della PR / della merge queue, scansionato nello
stesso job con lo stesso DB vulnerabilità (stesso run, niente confronto con risultati di
giorni diversi). Per `trivy-image` la base è l'immagine buildata dal commit base (o
l'immagine `latest` corrente: scelta del builder, purché scansionata nello stesso run).

Su `push` a `main` e `schedule` i job restano **assoluti** (stato reale di `main`): il
fallimento non blocca nessuno (non sono required in quei contesti) e fa partire l'autofix
(trigger `workflow_run`). Il SARIF continua a essere caricato come oggi.

`dependency-review` è già differenziale; si aggiunge solo `allow-ghsas` generato da
`auditConfig.ignoreGhsas` (stessa fonte unica delle eccezioni), così una versione corretta
che resta affetta solo da advisory già accettate non blocca la PR autofix. *(Scelta di
design, non discussa con l'utente.)*

Lo scanner `secret` e `misconfig` di `trivy-fs` resta **assoluto** anche su PR: nuovi
risultati di quel tipo nascono da modifiche al repo (versione Trivy fissa), non da advisory
esterne, quindi non producono il blocco a catena. Il diff vale solo per `vuln`. *(Scelta
di design.)*

### B2. Gate differenziale sul rebuild di `latest` (`release.yml`)

Sul **rebuild** di `latest` lo scan Trivy bloccante diventa "non regressione": pubblicare
se l'immagine nuova non ha vulnerabilità HIGH/CRITICAL con fix assenti dalla `latest`
corrente (scansionate entrambe nello stesso run). Le vulnerabilità residue vanno nella
issue esistente "Vulnerabilità non risolvibile con un rebuild". Sui **tag di versione**
il gate resta assoluto come oggi.

### C. Notifiche

Una issue per stato, aggiornata (non duplicata), creata/chiusa dal workflow autofix, sul
modello di `security-alerts.yml`:

- **In attesa**: versione corretta esiste ma < 48h → pacchetto, versione, data prevista
  dell'autofix, istruzione per forzarlo a mano (`workflow_dispatch` con input
  `force=<pkg>@<versione>`, che salta solo l'età, mai la provenienza).
- **Non correggibile**: nessuna versione corretta / provenienza fallita / nessuna versione
  soddisfa i vincoli → pacchetto, GHSA, motivo. Gestione manuale (es. `ignoreGhsas` con
  motivazione, come GHSA-86w9 oggi).
- **Autofix fallito**: la PR autofix non passa i test o la verifica del passo 4 → link
  alla PR/run.

Issue chiusa automaticamente quando lo stato si risolve.

## Vincoli

- Stile esistente dei workflow: `harden-runner` in audit, action fissate per SHA, versione
  Trivy fissa (`v0.76.1`), pnpm dal campo `packageManager`, permessi minimi per job.
- Il token GitHub App serve sia come secret Actions che Dependabot (già documentato).
- Le Action che scrivono (branch/PR) non devono mai eseguire codice da una PR esterna:
  l'autofix gira solo su `main` (cron/`workflow_run`/dispatch).
- Nomi dei required check invariati (ruleset `main`, id 25888219).
- Ogni override aggiunto è limitato alla versione vulnerabile e commentato; la pulizia
  degli override diventati inutili resta fuori scope (si possono segnalare nella issue).
- Documentare in `docs/claude/ci-cd-deps.md` e `docs/ci-cd-security-baseline.md`
  (eccezione al cooldown, gate differenziale, issue).

## Lasciato al builder

- Linguaggio/forma dello script di autofix (bash + jq come `rebuild-check.sh`, o Node
  script nel repo) e come condividere la logica di "diff dei risultati" tra
  `security.yml`, `release.yml` e l'autofix.
- Formato esatto dell'identità delle vulnerabilità per il diff e parsing dei JSON di
  `pnpm audit`/Trivy.
- Strumenti concreti per la verifica di provenienza npm/PyPI/Docker.
- Orario esatto del cron, purché tra il giro Dependabot e il rebuild delle 04:30 UTC.
- Test: script di diff e scelta versione testabili offline con fixture JSON (dati fittizi).

## Riprova sul caso del 2026-11-02

Con questo design: il 31/10 il giro autofix avrebbe trovato `node-forge` (prima versione
corretta 1.4.1, pubblicata il 27/10, > 48h) e `follow-redirects` (1.16.2, 25/10, > 48h),
verificato la provenienza, aperto una PR unica (bump diretto + override), mergiata dopo i
test; `latest` ricostruita alle 04:30 del giorno dopo. #287/#288 non sarebbero state
bloccate in nessun caso (gate differenziale).
