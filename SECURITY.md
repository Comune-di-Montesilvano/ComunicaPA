# Security Policy

## Segnalazione di una vulnerabilità

Se scopri una vulnerabilità di sicurezza in ComunicaPA, **non aprire una issue pubblica**.

Segnala privatamente con **Report a vulnerability** nella tab [Security](https://github.com/Comune-di-Montesilvano/ComunicaPA/security/advisories/new) (segnalazione privata di GitHub) — visibile solo ai maintainer finché non viene risolta e pubblicata.

In alternativa, contatta l'amministrazione del Comune di Montesilvano tramite i canali istituzionali indicati su [comune.montesilvano.pe.it](https://www.comune.montesilvano.pe.it).

## Versioni supportate

Solo l'ultima versione taggata (`vX.Y.Z`) riceve fix di sicurezza. Nessun supporto a versioni precedenti.

## Cosa aspettarsi

- Conferma di ricezione entro qualche giorno lavorativo.
- Nessun bug bounty: il progetto è software libero per la PA, non un prodotto commerciale.
- Le immagini Docker pubblicate sono firmate (cosign keyless) e hanno provenance SLSA e SBOM attestati: `scripts/verify-images.sh <tag>` li verifica prima del deploy; con `VERIFY_IMAGES=true` nel compose la verifica della firma avviene a ogni deploy e i servizi non partono se fallisce.
- Le vulnerabilità nelle dipendenze sono già monitorate automaticamente (Dependabot security updates + Trivy sulle immagini Docker ad ogni release, risultati nella tab [Security](https://github.com/Comune-di-Montesilvano/ComunicaPA/security)).
