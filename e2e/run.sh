#!/usr/bin/env bash
# Esegue la suite E2E completa sullo stack di PRODUZIONE di prova:
#   1. genera e2e/.env.e2e (secret random, LDAP_HOST=mock) e avvia il progetto compose `e2e`
#      (docker-compose.yml + e2e/docker-compose.e2e.yml: mai il progetto `comunicapa` del dev);
#   2. avvia Playwright in un container (immagine ufficiale, stessa versione di @playwright/test)
#      sulla rete interna dello stack e installa il solo pacchetto e2e;
#   3. fase 1 (tutto tranne @phase2) -> `docker compose restart backend` -> fase 2 (@phase2);
#   4. `down -v` dello stack (salvo E2E_KEEP_STACK=1).
# Artefatti (report HTML, trace/screenshot dei soli test falliti) in e2e/playwright-report e
# e2e/test-results. Uso: bash e2e/run.sh    (da Git Bash su Windows, o Linux/CI)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${E2E_PROJECT:-e2e}"
if [ "$PROJECT" = "comunicapa" ]; then
  echo "E2E_PROJECT=comunicapa e' lo stack dev: rifiutato" >&2
  exit 2
fi
ENV_FILE="e2e/.env.e2e"
# Stessa versione di @playwright/test in e2e/package.json (immagine pinnata per digest).
PW_IMAGE="mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe"
PW_CONTAINER="${PROJECT}-playwright"
NETWORK="${PROJECT}_comunicapa-net"

rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

cat > "$ENV_FILE" <<EOF
IMAGE_TAG=${IMAGE_TAG:-latest}
ADMIN_PORT=${E2E_ADMIN_PORT:-3100}
CITIZEN_PORT=${E2E_CITIZEN_PORT:-3101}
MAILPIT_PORT=${E2E_MAILPIT_PORT:-18025}
POSTGRES_USER=comunicapa_e2e
POSTGRES_PASSWORD=$(rand_hex 24)
POSTGRES_DB=comunicapa_e2e
JWT_SECRET=$(rand_hex 32)
DOWNLOAD_LINK_SECRET=$(rand_hex 32)
LDAP_HOST=mock
CITIZEN_ORIGIN=http://frontend-citizen:8080
LOG_LEVEL=info
EOF

COMPOSE=(docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml -p "$PROJECT" --env-file "$ENV_FILE")

cleanup() {
  docker rm -f "$PW_CONTAINER" >/dev/null 2>&1 || true
  if [ "${E2E_KEEP_STACK:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
  fi
}
trap cleanup EXIT

# Stack sempre da zero: volumi di un run precedente avrebbero la password Postgres vecchia.
docker rm -f "$PW_CONTAINER" >/dev/null 2>&1 || true
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d

mkdir -p e2e/test-results e2e/playwright-report
# MSYS_NO_PATHCONV: Git Bash su Windows non deve riscrivere i path unix passati al container.
MSYS_NO_PATHCONV=1 docker run -d --name "$PW_CONTAINER" --init --ipc=host \
  --network "$NETWORK" \
  -e CI="${CI:-}" \
  -e ADMIN_URL=http://frontend-admin:8080 \
  -e CITIZEN_URL=http://frontend-citizen:8080 \
  -e API_URL=http://frontend-admin:8080/api \
  -e MAILPIT_URL=http://mailpit:8025 \
  -v "$ROOT/e2e/test-results:/work/e2e/test-results" \
  -v "$ROOT/e2e/playwright-report:/work/e2e/playwright-report" \
  "$PW_IMAGE" sleep infinity >/dev/null

# Nel container entrano SOLO i manifest del workspace e il pacchetto e2e (mai il resto del repo,
# es. il .env di root con credenziali reali): tar dall'host via stdin, niente bind mount del repo
# (pnpm sul bind mount Windows e' anche lentissimo). Poi install del solo e2e dal lockfile.
tar -cf - --exclude=node_modules --exclude=test-results --exclude=playwright-report \
  --exclude=.env.e2e --exclude=.e2e-state \
  package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc pnpm.yaml tsconfig.base.json e2e \
  | MSYS_NO_PATHCONV=1 docker exec -i "$PW_CONTAINER" tar -C /work -xf -
MSYS_NO_PATHCONV=1 docker exec -w /work "$PW_CONTAINER" bash -ec '
  # Stessa versione di corepack della procedura lockfile (CLAUDE.md); --force: l immagine ha gia /usr/bin/yarn.
  npm install -g --force corepack@0.36.0 >/dev/null 2>&1
  corepack enable pnpm
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install >/dev/null
  pnpm install --filter @comunicapa/e2e --frozen-lockfile --ignore-scripts >/dev/null
  cd e2e && ./node_modules/.bin/tsc --noEmit
'

rc=0
MSYS_NO_PATHCONV=1 docker exec -w /work/e2e "$PW_CONTAINER" pnpm run e2e || rc=$?

if [ "$rc" -eq 0 ]; then
  # Restart reale del backend tra le due fasi: i secret salvati devono sopravvivere.
  "${COMPOSE[@]}" restart backend
  MSYS_NO_PATHCONV=1 docker exec -w /work/e2e "$PW_CONTAINER" pnpm run e2e:phase2 || rc=$?
else
  echo "Fase 1 fallita (exit $rc): fase 2 saltata" >&2
fi

exit "$rc"
