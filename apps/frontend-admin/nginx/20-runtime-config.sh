#!/bin/sh
# apps/frontend-admin/nginx/20-runtime-config.sh
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
cat > /usr/share/nginx/html/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}', sentryDsn: '${SENTRY_DSN}', sentryEnvironment: '${SENTRY_ENVIRONMENT}' };
EOF
