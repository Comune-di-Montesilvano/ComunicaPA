# Nota tecnica — blocco path su revprx01

**Per:** Ufficio Innovazione Tecnologica (gestione `revprx01.comune.montesilvano.pe.it`)
**Da:** ComunicaPA — supporto applicativo
**Data:** 2026-07-04

## Problema

Il reverse proxy pubblico `revprx01.comune.montesilvano.pe.it`, davanti al dominio
`https://comunicapa.comune.montesilvano.pe.it`, blocca con **401 Unauthorized** le
richieste al path:

```
/api/citizen/notifications
```

(e relativi sotto-path, es. `/api/citizen/notifications/<id>`).

Il blocco avviene **prima** di raggiungere l'applicazione: la risposta 401 è una
pagina HTML generata da `revprx01` stesso (footer: "Generato da:
revprx01.comune.montesilvano.pe.it"), non dal backend applicativo, che non riceve
mai la richiesta (nessuna traccia nei log applicativi).

## Evidenza raccolta

Test diretti dal browser sul dominio pubblico:

| Path richiesto | Risultato |
|---|---|
| `GET /api/citizen/notifications` (con token valido) | 401, `content-type: text/html`, `server: nginx` |
| `GET /api/citizen/notifications` (**senza** alcun header Authorization) | 401 identico — il blocco non dipende dal token |
| `GET /api/citizen/notifications/` (con slash finale) | 401 identico |
| `GET /api/citizen/notifications/abc` (sotto-path) | 401 identico |
| `GET /api/citizen/notification` (singolare, un carattere diverso) | 404 — raggiunge regolarmente l'applicazione |
| `GET /api/citizen/notifications-test` | 404 — raggiunge regolarmente l'applicazione |
| `GET /api/auth/citizen/config` | 200 JSON regolare |
| `GET /api/version` | 200 JSON regolare |
| `GET /api/branding` | 200 JSON regolare |

Il blocco è quindi legato **esattamente e solo** alla stringa di path
`/citizen/notifications` (con eventuali sotto-path), non a un blocco generico su
`/api/citizen/*` né a un problema di autenticazione/token.

## Impatto

Il portale cittadino ComunicaPA (`comunicapa.comune.montesilvano.pe.it`) non può
mostrare l'elenco delle comunicazioni ricevute al cittadino dopo il login
SPID/CIE: il login OIDC funziona correttamente (redirect, callback, scambio
codice — tutto verificato lato applicativo), ma la chiamata successiva per
recuperare le notifiche viene rigettata dal proxy.

## Richiesta

Verificare la configurazione di `revprx01` (regole WAF/ACL o vhost) per il
dominio `comunicapa.comune.montesilvano.pe.it` e rimuovere/correggere qualunque
regola che blocchi il path `/api/citizen/notifications` (e sotto-path),
permettendo l'inoltro regolare verso il backend applicativo come già avviene
per gli altri path `/api/*` di questa stessa applicazione.
