#!/usr/bin/env sh
# Verifica, prima del deploy, che le 4 immagini di un tag siano quelle prodotte da
# release.yml di questo repo: firma cosign keyless e, se `gh` e' disponibile, attestazioni
# GitHub (provenance SLSA e SBOM). Stampa i digest verificati.
#
#   scripts/verify-images.sh v1.11.11          # tag da deployare (IMAGE_TAG)
#   CONTAINER_CLI=podman scripts/verify-images.sh v1.11.11
#
# Non serve cosign installato: gira nell'immagine ufficiale, fissata per digest.
# Esce con errore alla prima immagine che non passa: in quel caso NON aggiornare lo stack.
set -eu

TAG="${1:?uso: $0 <tag immagine, es. v1.11.11>}"
CLI="${CONTAINER_CLI:-docker}"
REPO="Comune-di-Montesilvano/ComunicaPA"
REGISTRY="ghcr.io/comune-di-montesilvano"
COSIGN="ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d"
# Solo firme fatte da release.yml di questo repo, su un tag v* o sul rebuild di main.
IDENTITY="^https://github.com/${REPO}/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$"
ISSUER="https://token.actions.githubusercontent.com"

if command -v gh >/dev/null 2>&1; then
  have_gh=true
else
  have_gh=false
  echo "AVVISO: gh non trovato, verifico solo la firma cosign (niente provenance/SBOM)." >&2
fi

for app in backend frontend-admin frontend-citizen pdf-extractor; do
  ref="${REGISTRY}/comunicapa-${app}:${TAG}"
  # La verifica risolve il tag in digest e verifica quello: il digest stampato e' quello firmato.
  out=$("$CLI" run --rm "$COSIGN" verify \
    --certificate-identity-regexp "$IDENTITY" \
    --certificate-oidc-issuer "$ISSUER" \
    --output json "$ref" 2>/dev/null) || {
    echo "ERRORE: firma non valida o assente per $ref" >&2
    exit 1
  }
  digest=$(printf '%s' "$out" | grep -oE '"docker-manifest-digest":"sha256:[0-9a-f]{64}"' | head -n1 | cut -d'"' -f4)
  [ -n "$digest" ] || { echo "ERRORE: digest non ricavato per $ref" >&2; exit 1; }

  if [ "$have_gh" = true ]; then
    for type in https://slsa.dev/provenance/v1 https://cyclonedx.org/bom; do
      gh attestation verify "oci://${REGISTRY}/comunicapa-${app}@${digest}" -R "$REPO" \
        --signer-workflow "${REPO}/.github/workflows/release.yml" \
        --predicate-type "$type" >/dev/null || {
        echo "ERRORE: attestazione $type assente o non valida per $ref@$digest" >&2
        exit 1
      }
    done
  fi
  echo "OK  ${ref}@${digest}"
done
echo "Tutte le immagini di $TAG sono firmate da release.yml di $REPO."
