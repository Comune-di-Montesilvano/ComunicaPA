#!/bin/sh
# apps/frontend-admin/nginx/20-runtime-config.sh
# Genera la config runtime del frontend dalla variabile API_BASE.
set -eu
: "${API_BASE:=http://localhost:8080}"
cat > /usr/share/nginx/html/config.js <<EOF
window.__COMUNICAPA_CONFIG__ = { apiBase: '${API_BASE}' };
EOF
