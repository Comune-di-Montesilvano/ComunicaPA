# ComunicaPA

**HUB open-source per la trasmissione asincrona di comunicazioni massive della Pubblica Amministrazione.**

ComunicaPA consente agli enti pubblici di inviare comunicazioni di massa (TARI, avvisi tributari, sanzioni, notifiche) su canali multipli in modo asincrono, scalabile e conforme alla normativa italiana ed europea.

## Canali supportati

| Canale | Descrizione |
|--------|-------------|
| **PEC** | Posta Elettronica Certificata |
| **Email** | Posta elettronica ordinaria |
| **App IO** | Piattaforma nazionale IO (pagoPA) |
| **SEND** | Servizio Notifiche Digitali (D.Lgs. 82/2005) |
| **Postalizzazione** | Invio cartaceo tramite operatori postali |

## Stack tecnologico

- **Backend:** NestJS 10 + TypeScript (porta 8080)
- **Frontend Admin:** React 19 + Vite 6 — portale operatori PA (porta 3000)
- **Frontend Cittadino:** React 19 + Vite 6 — portale accesso cittadini (porta 3001)
- **Database:** PostgreSQL 17
- **Code Engine:** Redis 7 + BullMQ
- **Monorepo:** pnpm workspaces

## Avvio rapido

**Prerequisiti:** Docker e Docker Compose installati.

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

## Sviluppo

Tutto il ciclo di sviluppo avviene dentro Docker — non è necessario installare Node.js o pnpm in locale.

```bash
# Avvia stack di sviluppo con hot-reload
docker compose up -d

# Log in tempo reale
docker compose logs -f backend

# Rebuild dopo modifica a package.json o Dockerfile
docker compose up -d --build backend

# Reset completo (inclusi volumi DB)
docker compose down -v
```

Hot-reload attivo: le modifiche ai file sorgente in `apps/*/src/` sono riflesse immediatamente nei container tramite volume bind.

## Architettura

```
apps/
├── backend/          # API REST + worker asincroni BullMQ
├── frontend-admin/   # Portale operatori PA
└── frontend-citizen/ # Portale cittadini (SPID/CIE)
packages/
└── shared-types/     # Interfacce TypeScript condivise (@comunicapa/shared-types)
```

**Flusso:** CSV upload → stream processing → BullMQ queue → worker asincroni → Strategy Pattern per canale.

**Autenticazione:** LDAP/Active Directory per operatori; OIDC (SPID/CIE) per cittadini.

## Licenza

Distribuito sotto [European Union Public Licence v1.2 (EUPL-1.2)](LICENSE).

In conformità con le linee guida AgID per il riuso del software nella Pubblica Amministrazione (art. 69 CAD).
