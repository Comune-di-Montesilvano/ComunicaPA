#!/usr/bin/env bash
# scripts/smoke-stack.sh — smoke test dello stack di produzione (docker-compose.yml) gia'
# avviato: servizi su, frontend e API attraverso nginx, query autenticata sul DB
# (migration applicate), upload su /tmp, estrazione PDF, filesystem in sola lettura.
# Usato da release.yml prima di pubblicare i tag; in locale:
#   docker compose -f docker-compose.yml -p smoke --env-file <env> up -d
#   COMPOSE="docker compose -f docker-compose.yml -p smoke --env-file <env>" scripts/smoke-stack.sh
set -euo pipefail

COMPOSE=${COMPOSE:-docker compose -f docker-compose.yml}
ADMIN=http://localhost:${ADMIN_PORT:-3000}
CITIZEN=http://localhost:${CITIZEN_PORT:-3001}
TIMEOUT=${SMOKE_TIMEOUT:-180}

fail() {
  echo "::error::$*"
  $COMPOSE ps -a || true
  $COMPOSE logs --no-color --tail 80 || true
  exit 1
}
ok() { echo "OK  $*"; }

# Backend pronto quando /version risponde attraverso il nginx dell'admin.
for ((i = 0; i < TIMEOUT; i += 5)); do
  curl -fsS "$ADMIN/api/version" >/dev/null 2>&1 && break
  sleep 5
done
version=$(curl -fsS "$ADMIN/api/version") || fail "backend non raggiungibile da $ADMIN/api/version entro ${TIMEOUT}s"
ok "versione $version"

for svc in postgres redis backend pdf-extractor frontend-admin frontend-citizen; do
  state=$($COMPOSE ps -a --format '{{.State}}' "$svc")
  [ "$state" = running ] || fail "$svc in stato '$state'"
done
verify=$($COMPOSE ps -a --format '{{.State}} {{.ExitCode}}' verify-images)
[ "$verify" = "exited 0" ] || fail "verify-images: '$verify'"
ok "servizi in esecuzione"

for url in "$ADMIN" "$CITIZEN"; do
  curl -fsS "$url/config.js" | grep -q "apiBase: '/api'" || fail "$url/config.js non generato"
  curl -fsS -o /dev/null "$url/" || fail "$url/ non servito"
  curl -fsS "$url/api/branding" | grep -q '"name"' || fail "$url/api/branding"
done
curl -fsS -o /dev/null "$ADMIN/guida/guida.md" || fail "guida operatori non servita"
ok "frontend, config.js e proxy /api"

# Token operatore firmato con il JWT_SECRET del container: lista campagne (schema DB
# creato dalle migration) e upload di un chunk via multer su /tmp.
$COMPOSE exec -T backend node - <<'EOF' || fail "API autenticate"
const jwt = require('/app/node_modules/jsonwebtoken');
const token = jwt.sign({ sub: 'smoke', username: 'smoke', role: 'admin', type: 'operator' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const h = { Authorization: `Bearer ${token}` };
(async () => {
  const list = await fetch('http://localhost:8080/admin/campaigns', { headers: h });
  if (list.status !== 200) throw new Error(`GET /admin/campaigns ${list.status}`);
  const base = 'http://localhost:8080/admin/domicile-verification/verify/upload';
  const init = await fetch(`${base}/init`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'smoke.csv', totalChunks: 1 }),
  });
  if (init.status !== 201) throw new Error(`upload init ${init.status}`);
  const { uploadId } = await init.json();
  const fd = new FormData();
  fd.append('chunk', new Blob(['codice_fiscale\nRSSMRA80A01H501U\n']), 'smoke.csv');
  const chunk = await fetch(`${base}/chunk/${uploadId}/0`, { method: 'POST', headers: h, body: fd });
  if (chunk.status !== 201) throw new Error(`upload chunk ${chunk.status}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
ok "API autenticate: query DB e upload su /tmp"

$COMPOSE exec -T pdf-extractor python - <<'EOF' || fail "pdf-extractor /extract"
import json, urllib.request, uuid
import pymupdf
doc = pymupdf.open()
doc.new_page().insert_text((72, 72), "Residente in: VIA ROMA 1 65015 MONTESILVANO (PE)")
b = uuid.uuid4().hex
body = (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="smoke.pdf"\r\n'
        'Content-Type: application/pdf\r\n\r\n').encode() + doc.tobytes() + f'\r\n--{b}--\r\n'.encode()
req = urllib.request.Request('http://localhost:8000/extract', data=body,
                             headers={'Content-Type': f'multipart/form-data; boundary={b}'})
assert 'warnings' in json.load(urllib.request.urlopen(req))
EOF
ok "pdf-extractor"

if $COMPOSE exec -T backend sh -c 'touch /app/smoke' 2>/dev/null; then
  fail "filesystem del backend scrivibile: read_only non applicato"
fi
ok "filesystem in sola lettura"

# Il messaggio informativo dello script ipv6 di nginx menziona "read-only file system?".
if $COMPOSE logs --no-color | grep -iE 'EROFS|read-only file system|EACCES|permission denied' | grep -v 10-listen-on-ipv6; then
  fail "errori di filesystem nei log"
fi
ok "nessun errore di filesystem nei log"
