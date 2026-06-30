Documento di Progetto Architetturale: ComunicaPA
1. Identità e Visione
ComunicaPA è un HUB di trasmissione asincrono, centralizzato e open-source, progettato per le Pubbliche Amministrazioni. Permette l'invio massivo e puntuale di comunicazioni (es. TARI, avvisi, sanzioni) su canali multipli (PEC, Mail, App IO, SEND, Postalizzazione). Sviluppato per essere rilasciato sul catalogo del riuso (AgID), è pensato per girare in modo eccellente su una singola istanza, ottimizzando le risorse hardware grazie a una gestione rigorosa della memoria e delle code di lavoro.

2. Architettura Monorepo e Stack Tecnologico
Il progetto utilizza un'architettura Monorepo basata su pnpm workspaces (o npm) per condividere nativamente le interfacce e i tipi TypeScript tra backend e frontend, riducendo gli errori e agevolando il "vibe coding" tramite IA.

Backend (Porta 8080): TypeScript + NestJS. Scelto per la sua struttura opinionated (moduli, controller, servizi) che costringe l'IA a scrivere codice ordinato e manutenibile.

Frontend Admin (Porta 3000): React + TypeScript + Vite. Dedicato agli operatori. Utilizzerà i fogli di stile e i componenti nativi di Bootstrap Italia per la coerenza visiva.

Frontend Cittadino (Porta 3001): React + TypeScript + Vite. Dedicato al pubblico per la consultazione dello storico tramite accesso SPID/CIE.

Layer Dati: PostgreSQL 16. Gestisce la relazionalità classica, sfruttando intensivamente i campi JSONB per salvare i log grezzi dei gateway esterni e le configurazioni dinamiche dei plugin.

Motore Code: Redis + BullMQ. Gestisce l'esecuzione asincrona dei job, essenziale per il rate limiting (es. PagoPA, PDND) e le politiche di retry.

3. Gestione Dati e Flusso Asincrono (Il Cuore dell'HUB)
Per evitare colli di bottiglia e saturazione della RAM durante flussi massivi (es. 30.000 record TARI):

Ingestione in Streaming: Il file CSV caricato dall'admin non viene mai allocato interamente in memoria. Il backend Node.js lo processa in streaming (riga per riga), applica il mapping configurato via UI e inserisce immediatamente i job nella coda di Redis.

Worker Asincroni: Il server web rimane sempre reattivo. I worker estraggono i job dalla coda, comunicano con le API di SEND/IO/Protocollo e salvano l'esito (successo/errore) nel DB.

4. Gestione Documentale (Stateless)
Il container applicativo rimarrà effimero.

Storage: I file PDF in ingresso e generati vengono salvati su un Volume Docker persistente. Il DB memorizza solo il percorso relativo e un UUID.

Manipolazione PDF (Solo se necessaria): Se il flusso prevede la protocollazione, il worker interroga il plugin del protocollo. Ricevuta la segnatura, utilizza pdf-lib (libreria TypeScript pura) per applicare il timbro direttamente in memoria, prima di salvare il file definitivo sullo storage locale.

Link Univoci: Il backend genera link per il download degli allegati, tracciando un contatore per verificare se il destinatario ha scaricato il documento (utile per canali extra-SEND).

5. Layer di Traduzione (Architettura a Plugin)
L'integrazione con fornitori diversi (protocollo informatico e postalizzazione) è gestita tramite uno Strategy Pattern implementato nel backend NestJS.

Esisteranno interfacce TypeScript rigorose (es. IProtocolProvider).

Ogni fornitore (es. Maggioli, Halley, Saga) sarà una classe TypeScript che implementa tale interfaccia.

A runtime, una Factory leggerà le credenziali e il nome del fornitore dal campo JSONB di PostgreSQL e istanzierà la classe corretta.

6. Sicurezza e Autenticazione Ibrida
Il backend protegge i frontend con due flussi separati:

Operatori (Active Directory/LDAP): Autenticazione tramite dominio Windows. Il backend verifica le credenziali, legge l'appartenenza ai gruppi (Admin per configurazioni/mapping, User per i soli invii) e stacca un token JWT interno per gestire la sessione sulla dashboard.

Cittadini (Delegation OIDC): Il frontend cittadino instrada l'utente verso il nodo pa-sso-proxy esistente. Ricevuto indietro il JWT firmato dall'IdP, il backend NestJS ne valida la firma ed estrae il Codice Fiscale, usandolo come chiave univoca e sicura per filtrare lo storico delle comunicazioni.

7. Infrastruttura e DevOps
CI/CD: Pipeline automatizzate con GitHub Actions per il linting, la build e il rilascio delle immagini su GHCR.

Deploy: Un singolo docker-compose.yml orchestrato per gestire NestJS, i due frontend serviti staticamente o via webserver leggero, PostgreSQL e Redis.

Bootstrap: L'infrastruttura richiede solo un file .env minimo (credenziali DB, chiavi cifratura, URI di Active Directory). Tutte le configurazioni di business (credenziali SEND, endpoint protocollo) si fanno via UI.

8. Roadmap di Sviluppo (Le 5 Fasi)
Fase 1 (Inizializzazione): Setup Monorepo (pnpm), configurazione ESLint/Prettier, inizializzazione NestJS, React+Vite, e creazione del docker-compose.yml di sviluppo (Postgres+Redis).

Fase 2 (Data Core & Auth): Setup TypeORM o Prisma, schema PostgreSQL (Focus su JSONB e Tabelle Code), e implementazione delle due Guard (LDAP per Admin, OIDC per Cittadino).

Fase 3 (Il Motore di Smistamento): Implementazione BullMQ, logica di parsing CSV in streaming da interfaccia e manipolazione base PDF con pdf-lib.

Fase 4 (Plugin & Esterni): Scrittura delle interfacce TypeScript (Strategy Pattern) e implementazione dei primi connettori (SEND, App IO, SMTP, Protocollo).

Fase 5 (Frontend UI/UX): Sviluppo dashboard React con Bootstrap Italia, mappatore visuale per i CSV e portale minimale per il cittadino.