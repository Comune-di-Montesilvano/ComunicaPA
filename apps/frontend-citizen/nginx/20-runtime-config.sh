#!/bin/sh
# apps/frontend-citizen/nginx/20-runtime-config.sh
# Genera la config runtime del frontend da API_BASE/SENTRY_DSN/SENTRY_ENVIRONMENT.
set -eu
# Default: /api — il nginx del container proxya verso il backend sulla rete
# Docker (stesso dominio, niente CORS). Override solo per topologie particolari.
: "${API_BASE:=/api}"
case "$API_BASE" in
  *[!A-Za-z0-9_.:/-]*)
    echo "API_BASE contiene caratteri non ammessi: $API_BASE" >&2
    exit 1
    ;;
esac
# SENTRY_DSN/SENTRY_ENVIRONMENT sono opzionali (SDK disattivato se vuote).
: "${SENTRY_DSN:=}"
: "${SENTRY_ENVIRONMENT:=}"
case "$SENTRY_DSN" in
  *[!A-Za-z0-9_.:/@?-]*)
    echo "SENTRY_DSN contiene caratteri non ammessi: $SENTRY_DSN" >&2
    exit 1
    ;;
esac
# SENTRY_ENVIRONMENT è per design un nome di istanza/ente scelto liberamente
# dall'operatore (es. "Comune di Montesilvano", con spazio) — il charset
# ammesso include lo spazio, escludendo solo i caratteri pericolosi per
# l'interpolazione shell nell'heredoc sotto (apice singolo, dollaro,
# backtick, backslash).
case "$SENTRY_ENVIRONMENT" in
  *[!A-Za-z0-9_.\ -]*)
    echo "SENTRY_ENVIRONMENT contiene caratteri non ammessi: $SENTRY_ENVIRONMENT" >&2
    exit 1
    ;;
esac
# In /tmp (tmpfs) e non nella root html: il container gira con filesystem in sola
# lettura (read_only nel docker-compose.yml). default.conf serve /config.js da qui.
mkdir -p /tmp/runtime-config
# Resolver di nginx per il nome `backend` (default.conf): il DNS della rete dei container,
# cioe' il primo nameserver di /etc/resolv.conf (Docker 127.0.0.11, podman aardvark-dns sul
# gateway della rete). Gli eventuali successivi sono DNS dell'host, che non conoscono i nomi
# dei servizi: nginx li userebbe a turno e `backend` risulterebbe a tratti inesistente.
ns=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
case "$ns" in
  '' | *[!0-9A-Fa-f.:]*)
    echo "nameserver non valido in /etc/resolv.conf: '$ns'" >&2
    exit 1
    ;;
  *:*) ns="[$ns]" ;;
esac
echo "resolver $ns valid=10s;" > /tmp/runtime-config/resolver.conf
cat > /tmp/runtime-config/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}', sentryDsn: '${SENTRY_DSN}', sentryEnvironment: '${SENTRY_ENVIRONMENT}' };
EOF
