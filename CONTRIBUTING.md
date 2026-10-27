# Contribuire a ComunicaPA

Issue e pull request sono benvenute. Le vulnerabilità di sicurezza **non** vanno aperte come issue pubbliche: vedi [SECURITY.md](SECURITY.md).

## Segnalare un bug o proporre una funzionalità

Apri una [issue](https://github.com/Comune-di-Montesilvano/ComunicaPA/issues) indicando versione (`/version` o tag immagine), passi per riprodurre, comportamento atteso e osservato. Mai dati personali reali (codici fiscali, nomi, PEC) nelle issue o negli allegati: usare dati fittizi (`ROSSI MARIO`, `RSSMRA80A01H501U`, `ACME SRL`).

## Pull request

Tutte le modifiche a `main` passano da pull request, con merge tramite merge queue solo a check verdi (test, lint, build, controlli di sicurezza).

Prima di aprire una PR:

1. La suite test passa (`docker compose exec backend node_modules/.bin/vitest run`; pdf-extractor: `python -m pytest tests/`).
2. Il controllo dei tipi di backend (spec inclusi) e frontend passa; la CI esegue anche lint e build completa.
3. Leggi `CLAUDE.md` e il file pertinente in `docs/claude/` per i pattern e i gotcha del progetto.

## Test automatici (policy)

**Ogni nuova funzionalità e ogni bugfix includono test automatici** che ne coprono il comportamento: unit test Vitest per backend e frontend, pytest per il pdf-extractor. Un bugfix aggiunge un test di regressione che fallisce senza la correzione. Una PR senza test va motivata nella descrizione (es. sola documentazione o configurazione).

Le funzioni che trasformano input non fidato (CSV, body HTTP, parametri di route) in path su disco, filtri LDAP o celle CSV hanno anche test di fuzzing property-based con [fast-check](https://fast-check.dev/) in `apps/backend/src/common/untrusted-input.fuzz.spec.ts`: una nuova funzione di questo tipo aggiunge lì la sua proprietà.

## Stile del codice

- TypeScript in strict mode (`tsconfig.base.json`), ESLint senza warning (`pnpm lint`).
- Commenti e messaggi utente in italiano; commit in formato [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `ci:`…).
- Nessun segreto o dato personale reale nel codice, nei test o nei commit.

## Licenza

Contribuendo accetti che il tuo contributo sia distribuito sotto [EUPL-1.2](LICENSE), la licenza del progetto.
