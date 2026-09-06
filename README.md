# ComunicaPA

[![Test Integrati](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/tests.yml/badge.svg)](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/tests.yml)
[![publiccode.yml validation](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/publiccode-validate.yml/badge.svg)](https://github.com/Comune-di-Montesilvano/ComunicaPA/actions/workflows/publiccode-validate.yml)
[![Licenza EUPL-1.2](https://img.shields.io/badge/licenza-EUPL--1.2-blue.svg)](LICENSE)

**HUB open-source per la trasmissione asincrona di comunicazioni massive della Pubblica Amministrazione.**

ComunicaPA consente agli enti pubblici di inviare comunicazioni di massa (TARI, avvisi tributari, sanzioni, notifiche) su canali multipli in modo asincrono, scalabile e conforme alla normativa italiana ed europea. Un operatore carica un CSV di destinatari dal portale admin, sceglie canale e template, e il sistema gestisce invio, retry, tracciamento esiti e download degli allegati — senza intervento manuale per singolo destinatario.

## Indice

- [Perché ComunicaPA](#perché-comunicapa)
- [Canali supportati](#canali-supportati)
- [Altre funzionalità](#altre-funzionalità)
- [Componenti tecnologici](#componenti-tecnologici)
- [Requisiti](#requisiti)
- [Avvio rapido](#avvio-rapido)
- [Configurazione](#configurazione)
- [Sviluppo](#sviluppo)
- [Architettura](#architettura)
- [API esterna — caricamento puntuale](#api-esterna--caricamento-puntuale)
- [Riuso da parte di altre PA](#riuso-da-parte-di-altre-pa)
- [Contribuire](#contribuire)
- [Licenza](#licenza)

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

### Comportamenti per canale

| Canale primario | App IO co-consegna | Dirottamento INAD¹ | Protocollazione | Allegato |
|---|:---:|---|:---:|:---:|
| **PEC** | parallela / esclusiva | trova PEC più recente → aggiorna indirizzo, stesso canale | opzionale | opzionale |
| **Email** | parallela / esclusiva | trova domicilio digitale → dirotta a PEC | opzionale | opzionale |
| **Postalizzazione** | parallela / esclusiva | trova domicilio digitale → dirotta a PEC (niente stampa/spedizione) | opzionale | **obbligatorio** |
| **App IO** | — (è già il canale) | trova domicilio digitale → dirotta a PEC | opzionale | opzionale |
| **SEND** | — (pipeline propria, gestita da PN) | — (PN risolve da sé via ANPR/INAD) | **obbligatoria** | **obbligatorio** |

¹ INAD = Indice Nazionale dei Domicili Digitali. Se un destinatario ha una
co-consegna App IO **esclusiva** configurata e viene dirottato da INAD, la
co-consegna si declassa automaticamente a **parallela** per quel destinatario:
il canale legalmente valido (PEC) è sempre garantito.

Dettaglio completo delle combinazioni: [`docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`](docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md).

## Altre funzionalità

Oltre all'invio massivo, il portale operatori offre:

- **Invio Singolo**: invio a un solo destinatario senza caricare un CSV — stessa procedura guidata, stesse regole di validazione (formato codice fiscale/email, lunghezza minima testo) e stessi canali dell'invio massivo, per comunicazioni puntuali fuori campagna.
- **Verifica Anagrafica**: ricerca il domicilio digitale reale di un destinatario (ANPR, INAD, App IO, Registro Imprese per le partite IVA) prima di scegliere il canale, evitando dirottamenti a sorpresa. Le interrogazioni ad ANPR e INAD passano dalla **Piattaforma Digitale Nazionale Dati (PDND)**: autenticazione tramite voucher (client assertion firmata, non semplice chiave statica) verso i registri nazionali, con audit obbligatorio di ogni ricerca (operatore + codice fiscale cercato).
- **Arricchimento Tracciati**: converte un tracciato Maggioli (CSV + allegati PDF) in un CSV pronto per l'invio, estraendo automaticamente indirizzo postale e dati di pagamento pagoPA dai PDF (codice a barre/QR), con correzione manuale riga per riga in caso di dati mancanti.
- **Ricerca Notifiche**: consultazione trasversale di tutte le notifiche inviate, per destinatario o codice fiscale, con dettaglio esiti per canale.
- **Statistiche**: andamento invii, tasso di successo per canale, costi di postalizzazione nel tempo.
- **Motori**: pannello di controllo delle code di invio per canale — pausa/ripresa, elenco job falliti, log di dettaglio per singolo invio.
- **Registro Attività**: log di controllo per ogni ricerca su un registro anagrafico esterno (ANPR/INAD/App IO/Registro Imprese) — chi ha cercato quale codice fiscale e quando.

## Componenti tecnologici

- **Backend:** NestJS 12 (ESM) + TypeScript (porta 8080) — API REST + worker asincroni BullMQ
- **Frontend Admin:** React 19 + Vite 6 — portale operatori PA (porta 3000)
- **Frontend Cittadino:** React 19 + Vite 6 — portale accesso cittadini, SPID/CIE (porta 3001)
- **Database:** PostgreSQL 17
- **Coda:** Redis 7 + BullMQ
- **Monorepo:** pnpm workspaces (compilazione/test/controllo qualità interamente dentro Docker — nessuno strumento richiesto sull'host)

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

Il file `.env` contiene **solo** variabili di avvio (porte, credenziali PostgreSQL, secret, LDAP, URL pubblico) — vedi `.env.example` per l'elenco completo con documentazione inline. Tutto il resto (branding dell'ente, server SMTP/PEC, provider App IO/SEND/Postalizzazione, OIDC SPID/CIE, retention allegati) si configura dalla UI admin (menu **Impostazioni**) ed è persistito in database, con i secret cifrati.

In produzione sono obbligatori (il compose si rifiuta di partire senza): `JWT_SECRET`, `DOWNLOAD_LINK_SECRET` — generali con `openssl rand -hex 32`.

## Sviluppo

Tutto il ciclo di sviluppo avviene dentro Docker.

```bash
# Avvia stack di sviluppo con ricarica automatica (richiede COMPOSE_FILE in .env, vedi .env.example)
docker compose up -d

# Log in tempo reale
docker compose logs -f backend

# Ricompila dopo una modifica a package.json o Dockerfile
docker compose up -d --build backend

# Test backend (worker limitati a 2 in vitest.config.ts, non serve un flag)
docker compose exec backend node_modules/.bin/vitest run

# Controllo dei tipi
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit

# Ripristino completo (inclusi i volumi del database)
docker compose down -v
```

Ricarica automatica attiva: le modifiche ai file sorgente in `apps/*/src/` sono riflesse nei container tramite bind mount (il watch di NestJS a volte non le rileva su Windows — vedi `CLAUDE.md`).

Per il contesto architetturale completo (gotcha, pattern interni, integrazioni SEND/POSTAL/App IO, migration, CI/CD) vedi **[`CLAUDE.md`](CLAUDE.md)** — pensato sia per Claude Code sia come riferimento tecnico per chi contribuisce.

## Architettura

```
apps/
├── backend/          # API REST + worker asincroni BullMQ (Strategy Pattern per canale)
├── frontend-admin/   # Portale operatori PA — procedura guidata invio massivo, impostazioni, motori
└── frontend-citizen/ # Portale cittadini — login SPID/CIE, notifiche ricevute
packages/
└── shared-types/     # Interfacce TypeScript condivise (@comunicapa/shared-types)
services/
└── pdf-extractor/    # Microservizio Python (FastAPI) per estrazione dati da PDF/allegati
```

**Flusso:** caricamento CSV → elaborazione a flusso (nessun caricamento in memoria) → coda BullMQ (Redis) → worker asincroni → Strategy Pattern per canale (PEC/Email/App IO/SEND/Postal), con co-consegna opzionale su App IO in parallelo al canale primario.

**Autenticazione:** LDAP/Active Directory per operatori PA; OIDC (SPID/CIE, Authorization Code + PKCE) per cittadini.

## API esterna — caricamento puntuale

Oltre alla procedura guidata admin (invii massivi da CSV), un sistema PA esterno può lanciare **una notifica puntuale per chiamata** (qualunque canale: PEC/Email/App IO/SEND/Postalizzazione) via API REST autenticata con chiave API, senza passare dal portale operatore:

- `GET /external/v1/capabilities` — scopre canali e opzioni realmente configurati sull'istanza (nessun tentativo alla cieca)
- `POST /external/v1/domicilio/cerca` — verifica il domicilio digitale reale del destinatario (ANPR/INAD/App IO) prima di scegliere il canale, evitando dirottamenti a sorpresa
- `POST /external/v1/attachments/upload/{init,chunk,complete}` — caricamento allegato a blocchi (obbligatorio per SEND/Postalizzazione)
- `POST /external/v1/notifications` — crea e lancia la notifica (risposta asincrona, `campaignId` per l'interrogazione periodica dello stato)
- `GET /external/v1/notifications/{campaignId}` — stato della notifica

Tutte le risposte sono **sempre HTTP 200** (esito nel campo `success` del body — un proxy inverso di produzione sostituisce altrimenti il body delle risposte non-2xx con una pagina HTML). Gestione dei client (creazione/revoca chiave API) dalla UI admin, menu **Impostazioni → API Esterne**.

I percorsi sopra sono quelli interni al backend (`apps/backend/src/external-api/`); un chiamante esterno reale li raggiunge tramite qualunque percorso pubblico la propria infrastruttura instrada verso questo backend — nello stesso ambiente di riferimento di questo repository, tramite il prefisso `/api/` con rimozione del prefisso lato nginx (vedi `apps/backend/openapi/external-api.yaml`, `servers: /api/external/v1`), ma un'installazione diversa può esporlo diversamente.

Specifica completa: [`apps/backend/openapi/external-api.yaml`](apps/backend/openapi/external-api.yaml).

## Riuso da parte di altre PA

ComunicaPA è distribuito secondo le linee guida AgID per il riuso del software nella Pubblica Amministrazione (art. 69 CAD) e descritto tramite [`publiccode.yml`](publiccode.yml), validato automaticamente a ogni modifica (vedi badge in cima a questo file).

Per adottarlo in un altro ente:

1. **Fork o clone** di questo repository — nessuna dipendenza dall'infrastruttura del Comune di Montesilvano, tutto lo stack (incluso il database) gira in Docker autoconsistente.
2. **Configurazione di avvio** via `.env` (porte, secret, LDAP/AD dell'ente) — vedi [Configurazione](#configurazione).
3. **Branding e integrazioni specifiche dell'ente** (logo, provider SMTP/PEC, App IO, SEND, Postalizzazione, OIDC SPID/CIE) si configurano interamente dalla UI admin dopo il primo avvio, senza modificare codice.
4. **Immagini Docker pronte** pubblicate su `ghcr.io/comune-di-montesilvano/comunicapa-*` a ogni release (`docker-compose.yml` in produzione le usa direttamente, senza compilazione locale).

Per domande su un'adozione o per segnalare che il software è in uso presso un altro ente (campo `usedBy` di `publiccode.yml`), contattare l'ente titolare: **supporto@comune.montesilvano.pe.it**.

## Contribuire

Issue e pull request sono benvenute. Prima di aprire una PR:

1. Verifica che la suite test passi (`docker compose exec backend node_modules/.bin/vitest run`)
2. Verifica il controllo dei tipi di backend e frontend
3. Leggi `CLAUDE.md` per i pattern e i gotcha del progetto (evita di reintrodurre bug già risolti)

## Licenza

Distribuito sotto [European Union Public Licence v1.2 (EUPL-1.2)](LICENSE).

In conformità con le linee guida AgID per il riuso del software nella Pubblica Amministrazione (art. 69 CAD).
