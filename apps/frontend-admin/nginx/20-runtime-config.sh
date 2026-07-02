#!/bin/sh
# apps/frontend-admin/nginx/20-runtime-config.sh
# Genera la config runtime del frontend dalla variabile API_BASE.
set -eu
: "${API_BASE:=http://localhost:8080}"
case "$API_BASE" in
  *[!A-Za-z0-9_.:/-]*)
    echo "API_BASE contiene caratteri non ammessi: $API_BASE" >&2
    exit 1
    ;;
esac
cat > /usr/share/nginx/html/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}' };
EOF
