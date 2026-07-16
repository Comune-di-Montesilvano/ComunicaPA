# ComunicaPA

[![Test Integrati](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/tests.yml/badge.svg)](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/tests.yml)
[![Licenza EUPL-1.2](https://img.shields.io/badge/licenza-EUPL--1.2-blue.svg)](LICENSE)

**HUB open-source per la trasmissione asincrona di comunicazioni massive della Pubblica Amministrazione.**

ComunicaPA consente agli enti pubblici di inviare comunicazioni di massa (TARI, avvisi tributari, sanzioni, notifiche) su canali multipli in modo asincrono, scalabile e conforme alla normativa italiana ed europea. Un operatore carica un CSV di destinatari dal portale admin, sceglie canale e template, e il sistema gestisce invio, retry, tracciamento esiti e download degli allegati — senza intervento manuale per singolo destinatario.

## Perché ComunicaPA

- **Multicanale reale**: un'unica campagna può usare un canale primario (PEC, Email, SEND, Postalizzazione) e **co-consegnare** su App IO in parallelo o in esclusiva, con contenuto differenziato per canale.
- **Asincrono e resiliente**: coda BullMQ/Redis con retry automatico, motori pausabili/riprendibili dalla UI, log per singolo job — nessuna richiesta HTTP bloccante per migliaia di destinatari.
- **Conforme**: SEND (Servizio Notifiche Digitali, D.Lgs. 82/2005) con protocollazione preventiva obbligatoria, autenticazione SPID/CIE per i cittadini, allegati con retention configurabile e link di download firmati/scadenti.
- **Autoconsistente**: intero stack in Docker, nessuna dipendenza da servizi cloud esterni oltre ai provider dei singoli canali (PEC/SMTP, PagoPA App IO, PN, operatore postale).

## Canali supportati

| Canale | Descrizione | Note |
|--------|-------------|------|
| **PEC** | Posta Elettronica Certificata | Ricevute di consegna tracciate |
| **Email** | Posta elettronica ordinaria | SMTP configurabile da UI |
| **App IO** | Piattaforma nazionale IO (PagoPA) | Canale primario o co-consegna su altro canale |
| **SEND** | Servizio Notifiche Digitali (D.Lgs. 82/2005) | Autenticazione PDND + protocollazione preventiva |
| **Postalizzazione** | Invio cartaceo tramite GlobalCom (Poste/Postel/Irideos) | Lettera, raccomandata, raccomandata A/R |

Ogni canale integra opzionalmente **pagoPA** (avvisi di pagamento) e la **protocollazione** automatica delle comunicazioni inviate.

## Stack tecnologico

- **Backend:** NestJS 10 + TypeScript (porta 8080) — API REST + worker asincroni BullMQ
- **Frontend Admin:** React 19 + Vite 6 — portale operatori PA (porta 3000)
- **Frontend Cittadino:** React 19 + Vite 6 — portale accesso cittadini, SPID/CIE (porta 3001)
- **Database:** PostgreSQL 17
- **Code Engine:** Redis 7 + BullMQ
- **Monorepo:** pnpm workspaces (build/test/lint interamente dentro Docker — nessun tool richiesto sull'host)

## Requisiti

- Docker Engine + Docker Compose v2
- Nessuna altra dipendenza sull'host (Node.js/pnpm non richiesti: tutto il ciclo di sviluppo gira in container)

## Avvio rapido

```bash
git clone https://github.com/Comune-di-Montesilvano/ComunicaPA.git
cd ComunicaPA
cp .env.example .env
docker compose build
docker compose up -d
```

| Servizio | URL |
|----------|-----|
| Backend API | http://localhost:8080 |
| Portale Admin | http://localhost:3000 |
| Portale Cittadino | http://localhost:3001 |

**Dev locale senza Active Directory/LDAP reale:** imposta `LDAP_HOST=mock` in `.env` per abilitare le credenziali simulate `admin`/`admin` (ruolo admin) e `operator`/`operator` (ruolo operatore), più un simulatore di login cittadino SPID/CIE — **mai in produzione**.

## Configurazione

Il file `.env` contiene **solo** variabili di bootstrap (porte, credenziali PostgreSQL, secret, LDAP, URL pubblico) — vedi `.env.example` per l'elenco completo con documentazione inline. Tutto il resto (branding dell'ente, server SMTP/PEC, provider App IO/SEND/Postalizzazione, OIDC SPID/CIE, retention allegati) si configura dalla UI admin (menu **Impostazioni**) ed è persistito in database, con i secret cifrati.

In produzione sono obbligatori (il compose si rifiuta di partire senza): `JWT_SECRET`, `DOWNLOAD_LINK_SECRET` — generali con `openssl rand -hex 32`.

## Sviluppo

Tutto il ciclo di sviluppo avviene dentro Docker.

```bash
# Avvia stack di sviluppo con hot-reload (richiede COMPOSE_FILE in .env, vedi .env.example)
docker compose up -d

# Log in tempo reale
docker compose logs -f backend

# Rebuild dopo modifica a package.json o Dockerfile
docker compose up -d --build backend

# Test backend (sempre --maxWorkers=2)
docker compose exec backend node_modules/.bin/jest --maxWorkers=2

# Type-check
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit

# Reset completo (inclusi volumi DB)
docker compose down -v
```

Hot-reload attivo: le modifiche ai file sorgente in `apps/*/src/` sono riflesse nei container tramite bind mount (il watch di NestJS a volte non le rileva su Windows — vedi `CLAUDE.md`).

Per il contesto architetturale completo (gotcha, pattern interni, integrazioni SEND/POSTAL/App IO, migration, CI/CD) vedi **[`CLAUDE.md`](CLAUDE.md)** — pensato sia per Claude Code sia come riferimento tecnico per chi contribuisce.

## Architettura

```
apps/
├── backend/          # API REST + worker asincroni BullMQ (Strategy Pattern per canale)
├── frontend-admin/   # Portale operatori PA — wizard invio massivo, impostazioni, motori
└── frontend-citizen/ # Portale cittadini — login SPID/CIE, notifiche ricevute
packages/
└── shared-types/     # Interfacce TypeScript condivise (@comunicapa/shared-types)
```

**Flusso:** CSV upload → stream processing (nessun caricamento in memoria) → coda BullMQ (Redis) → worker asincroni → Strategy Pattern per canale (PEC/Email/App IO/SEND/Postal), con co-consegna opzionale su App IO in parallelo al canale primario.

**Autenticazione:** LDAP/Active Directory per operatori PA; OIDC (SPID/CIE, Authorization Code + PKCE) per cittadini.

## Contribuire

Issue e pull request sono benvenute. Prima di aprire una PR:

1. Verifica che la suite test passi (`docker compose exec backend node_modules/.bin/jest --maxWorkers=2`)
2. Verifica il type-check di backend e frontend
3. Leggi `CLAUDE.md` per i pattern e i gotcha del progetto (evita di reintrodurre bug già risolti)

## Licenza

Distribuito sotto [European Union Public Licence v1.2 (EUPL-1.2)](LICENSE).

In conformità con le linee guida AgID per il riuso del software nella Pubblica Amministrazione (art. 69 CAD).
