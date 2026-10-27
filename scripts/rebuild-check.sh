#!/usr/bin/env bash
# Rebuild giornaliero di `latest` (release.yml, schedule e dry_run): per ogni immagine
# `latest` attuale cerca una causa reale per ricostruirla.
#   a. commit su main successivi alla label org.opencontainers.image.revision (codice e
#      merge Dependabot: npm, pip, immagini base fissate per digest, Actions);
#   b. patch di sistema disponibili: `apk list -u` / `apt list --upgradable` dentro
#      l'immagine; senza shell o package manager, Trivy sui pacchetti OS;
#   c. Trivy (DB aggiornato): vulnerabilita' HIGH/CRITICAL con fix.
# Nessuna causa su nessuna immagine → skip=true. Un controllo che non riesce a verificare
# conta come causa (si ricostruisce, come prima): mai uno skip per un errore.
#
# Output (GITHUB_OUTPUT): skip, reasons (JSON app → cause, per la label
# comunicapa.rebuild.reason), cause_c (JSON array delle app con causa c).
# Esito di ogni controllo per ogni immagine in GITHUB_STEP_SUMMARY e nel log.
#
#   MAIN_REF=origin/main scripts/rebuild-check.sh    # richiede docker, git, jq, trivy
set -euo pipefail

REGISTRY="ghcr.io/comune-di-montesilvano"
APPS=(backend frontend-admin frontend-citizen pdf-extractor)
MAIN_REF="${MAIN_REF:-origin/main}"
OUT="${GITHUB_OUTPUT:-/dev/null}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
# Stesse regole della scansione bloccante di release.yml (solo fix disponibili, stesse eccezioni).
TRIVY_ARGS=(image --quiet --skip-db-update --scanners vuln --ignore-unfixed --format json
  --ignorefile .trivyignore.yaml)

# Primi 5 elementi (uno per riga) separati da virgola, poi "+N": la label resta corta.
short() { awk 'NF && ++n <= 5 { printf "%s%s", (n > 1 ? ", " : ""), $0 } END { if (n > 5) printf ", +%d", n - 5 }'; }
count() { awk 'NF { n++ } END { print n + 0 }'; }

# ID unici delle vulnerabilita' trovate da Trivy; $1 = immagine, resto = argomenti extra.
trivy_ids() {
  local ref=$1
  shift
  trivy "${TRIVY_ARGS[@]}" "$@" "$ref" | jq -r '[.Results[]?.Vulnerabilities[]?.VulnerabilityID] | unique | .[]'
}

db_ok=true
trivy image --download-db-only --quiet || db_ok=false

declare -A reason
cause_c=()
rows=()

for app in "${APPS[@]}"; do
  repo="$REGISTRY/comunicapa-$app"
  if ! docker pull -q "$repo:latest" >/dev/null; then
    reason[$app]="latest assente o non leggibile"
    rows+=("| $app | ⚠️ latest assente o non leggibile | — | — |")
    continue
  fi
  # Per digest: Trivy e i container lavorano sull'immagine esatta di latest.
  ref=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$repo:latest" | grep -m1 "^$repo@")
  rev=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$repo:latest")
  a=no b=no c=no

  # a. Commit su main dopo la revision di latest.
  if [[ -z "$rev" ]]; then
    a="label revision assente"
  elif git cat-file -e "$rev^{commit}" 2>/dev/null; then
    n=$(git rev-list --count "$rev..$MAIN_REF")
    if ((n > 0)); then a="$n commit dopo ${rev:0:7}"; fi
  else
    a="revision ${rev:0:7} non trovata nel repo"
  fi

  # b. Patch di sistema. Distro e package manager letti dall'immagine, senza rete.
  info=$(docker run --rm --network none --entrypoint sh "$ref" -c \
    '. /etc/os-release 2>/dev/null; echo "${ID:-ignota} $(command -v apk || command -v apt-get || echo nessuno)"' \
    2>/dev/null) || info="ignota nessuno"
  read -r distro pm <<<"$info"
  case "$pm" in
    */apk) cmd='apk update -q >/dev/null && apk list -u 2>/dev/null' ;;
    */apt-get) cmd='apt-get update -qq >/dev/null && apt list --upgradable 2>/dev/null' ;;
    *) cmd= ;;
  esac
  if [[ -n "$cmd" ]]; then
    # Root solo nel container usa e getta: l'indice dei pacchetti va scritto.
    if list=$(docker run --rm --user 0 --entrypoint sh "$ref" -c "$cmd"); then
      pkgs=$(grep -F 'upgradable from' <<<"$list" | awk '{ print $1 }' || true)
      n=$(count <<<"$pkgs")
      if ((n > 0)); then b="$n pacchetti $distro aggiornabili ($(short <<<"$pkgs"))"; fi
    else
      b="errore aggiornamento indice ${pm##*/}"
    fi
  elif $db_ok; then
    # Runtime minimale (senza shell o package manager): Trivy vede i pacchetti OS.
    if ids=$(trivy_ids "$ref" --pkg-types os); then
      n=$(count <<<"$ids")
      if ((n > 0)); then b="$n CVE OS con fix, Trivy (senza shell o package manager): $(short <<<"$ids")"; fi
    else
      b="errore Trivy (pacchetti OS)"
    fi
  else
    b="errore download DB Trivy"
  fi

  # c. Vulnerabilita' HIGH/CRITICAL con fix.
  if ! $db_ok; then
    c="errore download DB Trivy"
  elif ids=$(trivy_ids "$ref" --severity HIGH,CRITICAL); then
    n=$(count <<<"$ids")
    if ((n > 0)); then
      c="$n HIGH/CRITICAL con fix ($(short <<<"$ids"))"
      cause_c+=("$app")
    fi
  else
    c="errore Trivy"
  fi

  causes=()
  cells=()
  for k in a b c; do
    case $k in a) v=$a ;; b) v=$b ;; c) v=$c ;; esac
    if [[ "$v" == no ]]; then
      cells+=("✅ no")
    else
      causes+=("$k: $v")
      [[ "$v" == errore* || "$v" == *revision* ]] && cells+=("⚠️ $v") || cells+=("🔁 $v")
    fi
  done
  if ((${#causes[@]})); then
    joined=$(printf '%s; ' "${causes[@]}")
    reason[$app]=${joined%; }
  fi
  rows+=("| $app \`${ref##*@}\` | ${cells[0]} | ${cells[1]} | ${cells[2]} |")
done

skip=true
for app in "${APPS[@]}"; do
  if [[ -n "${reason[$app]:-}" ]]; then skip=false; fi
done

reasons=$(for app in "${APPS[@]}"; do
  printf '%s\t%s\n' "$app" "${reason[$app]:-nessuna (rebuild per le altre immagini)}"
done | jq -Rcn '[inputs | split("\t") | {(.[0]): .[1]}] | add')
cause_c_json=$(printf '%s\n' "${cause_c[@]}" | jq -Rcn '[inputs | select(length > 0)]')

{
  echo "skip=$skip"
  echo "reasons=$reasons"
  echo "cause_c=$cause_c_json"
} >>"$OUT"

{
  echo "## Rebuild di latest: controllo cause"
  echo
  echo "main: \`$(git rev-parse --short "$MAIN_REF")\`"
  echo
  echo "| Immagine (latest) | a. commit su main | b. patch di sistema | c. Trivy HIGH/CRITICAL con fix |"
  echo "|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
  echo
  if $skip; then
    echo "**Esito: skip** — nessuna causa, \`latest\` resta invariato."
  else
    echo "**Esito: rebuild** — cause per immagine (label \`comunicapa.rebuild.reason\`):"
    echo
    for app in "${APPS[@]}"; do
      echo "- $app: ${reason[$app]:-nessuna (rebuild per le altre immagini)}"
    done
  fi
} | tee -a "$SUMMARY"
