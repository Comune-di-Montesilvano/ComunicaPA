# E2E Playwright

Test end-to-end dei flussi principali sullo **stack di produzione di prova** (immagini
`ghcr.io/...:${IMAGE_TAG:-latest}` di `docker-compose.yml`) più Mailpit, con Playwright in un
container. Niente Node sull'host, niente stack dev toccato.

## Lancio

```bash
bash e2e/run.sh            # da Git Bash (Windows) o Linux/CI, dalla root del repo
```

Lo script:

1. genera `e2e/.env.e2e` (gitignorato) con `JWT_SECRET`/`DOWNLOAD_LINK_SECRET`/password Postgres
   random e `LDAP_HOST=mock` (admin/admin, operator/operator, simulatore cittadino);
2. avvia il progetto compose **`e2e`** — mai `comunicapa`, che è lo stack dev:
   `docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml -p e2e --env-file e2e/.env.e2e up -d`
   (porte host 3100/3101/18025, sovrascrivibili con `E2E_ADMIN_PORT`, `E2E_CITIZEN_PORT`,
   `E2E_MAILPIT_PORT`; immagini con `IMAGE_TAG`);
3. avvia `mcr.microsoft.com/playwright:v<versione>-noble` (pinnata per digest, stessa versione di
   `@playwright/test`) sulla rete interna dello stack, copia dentro i manifest del workspace e
   installa il solo pacchetto e2e dal lockfile (`--frozen-lockfile`), poi `tsc --noEmit`;
4. fase 1: `pnpm run e2e` (= `playwright test --grep-invert @phase2`);
5. `docker compose ... restart backend`;
6. fase 2: `pnpm run e2e:phase2` (= `playwright test --grep @phase2`);
7. `down -v` dello stack (`E2E_KEEP_STACK=1` per lasciarlo su e ispezionarlo, poi `down -v` a mano).

Report HTML in `e2e/playwright-report/<fase>/`, trace e screenshot **solo dei test falliti** in
`e2e/test-results/<fase>/`.

Le immagini sono quelle `ghcr.io/...:${IMAGE_TAG:-latest}` già presenti in locale (compose le
scarica solo se mancano): si testano le immagini, non il working tree. Per le ultime,
`docker pull ghcr.io/comune-di-montesilvano/comunicapa-<servizio>:latest` prima del run.

In CI lo lancia il job `e2e` di `.github/workflows/release.yml` con `IMAGE_TAG=e2e` (tag locale
sui digest appena firmati dalla run, come il job `smoke`), solo quando il codice è cambiato; il
type-check (`pnpm --filter @comunicapa/e2e run typecheck`) gira invece sulle PR in `tests.yml`.

Il pacchetto non ha uno script `test`: `pnpm -r test` / `test:coverage` (CI) non lo eseguono.

## Configurazione

`playwright.config.ts` legge dall'ambiente `ADMIN_URL`, `CITIZEN_URL`, `API_URL` (default
`${ADMIN_URL}/api`, il proxy nginx del frontend) e `MAILPIT_URL`. `run.sh` li punta ai servizi
interni (`http://frontend-admin:8080`, ...); i default sono le porte host di `run.sh`.

`global-setup.ts` (gira a ogni fase, idempotente): attende `/version`, login `admin`/`admin` via
API, crea la mail-config EMAIL predefinita `E2E Mailpit` (`mailpit:1025`) e la attiva con un test,
svuota Mailpit.

## Flussi

| Spec | Cosa verifica |
|------|---------------|
| `tests/operator-email-campaign.spec.ts` | operatore (`operator`, ruolo `user`): wizard Email → CSV di 3 righe con suffisso del run → lancio → campagna `completed` (polling API, 120 s) → Mailpit ha i 3 messaggi, oggetti con segnaposto risolti |
| `tests/citizen-pf-pg.spec.ts` | campagna creata via API con un destinatario CF `RSSMRA80A01H501U` e uno P.IVA `12345678903` (colonna `codice_fiscale`); simulatore cittadino PF → solo la notifica del CF; "per conto di un'impresa" → solo quella della P.IVA |
| `tests/settings-secret.spec.ts` | `@phase1`: mail-config con password salvata da UI → in UI e API solo `••••••••`; `@phase2` (dopo il restart del backend) → "Invia Test" riuscito, quindi la password è stata decifrata dal processo nuovo |

Regole: ogni flusso crea i propri dati con un suffisso random (`runSuffix()`), nessun
`waitForTimeout` (solo `expect`/`expect.poll`), un retry solo in CI (il test che passa al secondo tentativo risulta "flaky"), dati solo fittizi
(`ROSSI MARIO`/`RSSMRA80A01H501U`, `ACME SRL`/`12345678903`). Un difetto di prodotto trovato da un
test non si corregge qui: commento `KNOWN_GAP` e `test.fail()` sul test.

## Aggiornare Playwright

Cambiare insieme la versione esatta di `@playwright/test` in `package.json` (lockfile con la
procedura di `CLAUDE.md`) e l'immagine `PW_IMAGE` in `run.sh` (tag `v<versione>-noble` + digest
da `docker buildx imagetools inspect`). Dependabot ignora `@playwright/test` (`.github/dependabot.yml`) e lo step "Versione Playwright allineata" di `tests.yml` fa fallire la PR se i due non coincidono: i due valori si bumpano sempre insieme.
