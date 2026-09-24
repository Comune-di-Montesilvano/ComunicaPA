# Verifica consegna POSTAL su tracking Poste Italiane — design

## Problema

GlobalCom a volte porta una raccomandata in stato terminale `NonConsegnato`
(es. `StatoConsegna: "Indirizzo errato o inesatto"`, `CodiceConsegna: "KO"`)
e smette di tracciarla. Poste Italiane però può fare un secondo passaggio
giorni o settimane dopo e consegnare davvero. Una volta terminale, né
GlobalCom né il nostro `PostalStatusSyncService` ripollano più: il dato di
consegna reale va perso e statistiche/report restano sbagliati.

Caso reale verificato dal vivo (2026-09-24, raccomandata estera,
`RaccomandataMarket4`): GlobalCom `NonConsegnato` al 12/08 "Indirizzo errato
o inesatto"; tracking Poste sullo stesso `IDAccettazione` → consegnata con
successo il 04/09.

## Obiettivo

Per ogni notifica POSTAL che GlobalCom dichiara `NonConsegnato` in modo
terminale, interrogare quotidianamente il tracking pubblico di Poste
Italiane fino a un esito finale (massimo 90 controlli). Se Poste dice
"consegnata", lo stato di consegna **effettivo** della notifica diventa
consegnato, mantenendo intatto lo storico GlobalCom e rendendo la
discrepanza sempre evidente in UI, filtri e report CSV.

## Fuori scope

- Nessuna modifica ai campi `postal_*` scritti dal sync GlobalCom.
- Nessuna transizione di `NotificationAttempt.status` / `Recipient.status`
  (stesso principio già in vigore: lo stato di consegna post-accettazione non
  si riflette mai su `status`).
- Stati GlobalCom diversi da `NonConsegnato` (`ConsegnaParziale`, `Errore`,
  `Eliminato`, stati transitori): non candidati.
- Canale SEND: fuori scope (ha il suo tracking via PN).
- API a pagamento di aggregatori (AfterShip, TrackingMore, 17TRACK...).

## Fonte dati: endpoint Poste

Nessuna API ufficiale gratuita di tracking per terzi. La pagina "Cerca
spedizioni" di poste.it usa un endpoint JSON pubblico, non documentato e
senza autenticazione:

```
POST https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice
Content-Type: application/json

{"tipoRichiedente":"WEB","codiceSpedizione":"<codice>","periodoRicerca":1}
```

Risposta osservata (valori anonimizzati):

```json
{
  "idTracciatura": "RN000000000IT",
  "tipoSpedizione": "C",
  "tipoProdotto": "RACC. DA/PER ESTERO",
  "esitoRicerca": "3",
  "stato": "5",
  "flagRitorno": false,
  "listaMovimenti": [
    { "dataOra": 1785393537000, "statoLavorazione": "a seguito di acquisto da poste.it", "luogo": "sito poste.it", "flagRitorno": false, "box": "2" },
    { "dataOra": 1786508340000, "statoLavorazione": "in data", "luogo": "SVIZZERA", "flagRitorno": false, "box": "3" },
    { "dataOra": 1788509160000, "statoLavorazione": "con successo in data", "luogo": "SVIZZERA", "flagRitorno": false, "box": "5" }
  ],
  "statoDaVerificare": false
}
```

Codice non trovato: `{"idTracciatura":"...","esitoRicerca":"1","stato":"1"}`.

Osservazioni verificate:

- Il codice da tracciare è `IDAccettazione` di GlobalCom, già salvato in
  `notification_attempts.postal_acceptance_id`. Nessuna chiamata GlobalCom
  aggiuntiva.
- Funziona su raccomandate estere (`RN...IT`) e Market nazionali (12 cifre).
  Un codice a 10 cifre presente nel DB dev torna `esitoRicerca: "1"` (non
  trovato): una quota di invii potrebbe non essere tracciabile.
- `statoLavorazione` è un frammento: l'etichetta completa la compone il
  frontend poste.it da `box`/`stato`. Solo `stato: "5"` = consegnata è
  verificato su un caso reale.
- `dataOra` è epoch in millisecondi.

Rischi: endpoint non documentato (può cambiare senza preavviso) e possibili
vincoli nei termini d'uso di poste.it. Mitigazioni: chiamate sequenziali con
throttle, solo sui candidati, kill-switch da Impostazioni, circuit breaker
sugli errori consecutivi.

## Mappatura esito (prudente)

| Risposta Poste | Esito riga | Finale? | Override |
|---|---|---|---|
| `esitoRicerca: "3"`, `stato: "5"`, `flagRitorno: false` | `delivered` | sì | sì — consegnato |
| `flagRitorno: true` (risposta o qualunque movimento) | `returned` | sì | no — resta non consegnata, confermata |
| `esitoRicerca: "1"` (non trovato) | resta `pending` | no | no |
| qualunque altro `stato` / `esitoRicerca` | resta `pending` | no | no |

Solo `delivered` produce l'override. Tutti i valori non riconosciuti restano
`pending` e la risposta grezza viene salvata: la mappatura si allarga in
seguito sui casi reali raccolti (giacenza, ritorno, ecc.), senza rischiare
override sbagliati. Data di consegna = `dataOra` del movimento con `box`
massimo (ultimo movimento) nella risposta `delivered`.

`flagRitorno: true` ha la precedenza su `stato: "5"` (una consegna "con
successo" al mittente dopo il ritorno non è una consegna al destinatario).

## Modello dati

Nuova tabella `postal_poste_tracking`, una riga per attempt:

| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `attempt_id` | uuid, UNIQUE, FK → `notification_attempts.id` ON DELETE CASCADE | |
| `tracking_code` | varchar(50) | copia di `postal_acceptance_id` al momento dell'ingresso |
| `status` | varchar(20) | `pending` / `delivered` / `returned` / `gave_up` |
| `check_count` | int, default 0 | controlli con risposta HTTP valida (errori di rete esclusi) |
| `next_check_at` | timestamptz, nullable | null quando la riga è finale |
| `last_checked_at` | timestamptz, nullable | aggiornato a OGNI tentativo, anche su errore (round-robin) |
| `last_error` | varchar(500), nullable | ultimo errore di rete/HTTP |
| `poste_stato` | varchar(10), nullable | `stato` grezzo dell'ultima risposta |
| `poste_esito_ricerca` | varchar(10), nullable | `esitoRicerca` grezzo |
| `poste_product` | varchar(100), nullable | `tipoProdotto` |
| `delivered_at` | timestamptz, nullable | data consegna secondo Poste (solo `delivered`) |
| `movements` | jsonb, nullable | `listaMovimenti` dell'ultima risposta, normalizzata (dataOra ISO, luogo, statoLavorazione, box, flagRitorno) |
| `last_response` | jsonb, nullable | risposta grezza completa dell'ultima chiamata riuscita |
| `created_at` / `updated_at` | timestamptz | |

Indici: UNIQUE `attempt_id`; `(status, next_check_at)` per il cron.

`NotificationAttempt` non riceve nuove colonne: relazione `OneToOne`
opzionale lato entity nuova (`PostalPosteTracking`), mai `eager`.

Costante `MAX_POSTE_CHECKS = 90`.

## Ciclo di vita

### Ingresso

Nessun hook nel sync GlobalCom (`PostalStatusSyncService` resta intatto):
l'ingresso è un **backfill idempotente**
(`INSERT ... SELECT ... ON CONFLICT (attempt_id) DO NOTHING`, `status='pending'`,
`next_check_at = now()`, mai reset di una riga esistente) sugli attempt
`channel_type='POSTAL' AND postal_status='NonConsegnato' AND
postal_acceptance_id` non vuoto, **solo ultimo attempt del destinatario**
(nessun attempt con `attempt_number` maggiore). Gira:

1. all'avvio di ogni giro del cron giornaliero (tutte le campagne) — copre
   anche lo storico già presente, nessuna migration dati separata;
2. all'avvio del run manuale di campagna (ristretto alla campagna);
3. nel controllo manuale per notifica, la riga si crea al volo se manca.

Il ritardo massimo di ingresso è quindi un giorno, irrilevante con un
controllo al giorno.

Se GlobalCom in seguito cambia lo stato dell'attempt (es. riaccodamento o
ricontrollo che esce da `NonConsegnato`), la riga resta ma il cron la
esclude (join su `postal_status = 'NonConsegnato'`) e l'override non si
applica: l'override vale solo mentre GlobalCom dice `NonConsegnato`.

### Cron giornaliero — `PostePostalTrackingService`

- `@Cron` giornaliero (04:00 Europe/Rome), stesso modello `@Cron` di
  `PostalStatusSyncService` (niente motore BullMQ: nessun invio, solo
  lettura esterna idempotente).
- Guard di non-rientranza (flag in memoria): se un giro è ancora in corso,
  il successivo salta.
- Se `postalPosteTracking.enabled` è `false` → esce subito.
- Candidati: `status='pending' AND next_check_at <= now()` con attempt
  ancora `NonConsegnato`, `ORDER BY COALESCE(last_checked_at, created_at)
  ASC` (round-robin, vedi `docs/claude/bullmq-jobs.md`), nessun LIMIT
  artificiale ma ciclo sequenziale con pausa di 2 s tra le chiamate.
- Per ogni riga: `checkOne(row)`.

### `checkOne(row)` (usato da cron e manuale)

1. Chiamata HTTP con timeout 15 s, `User-Agent` esplicito.
2. **Errore di rete / timeout / HTTP ≥ 500 / body non JSON**:
   `last_checked_at = now`, `last_error` valorizzato, `check_count`
   **invariato**, `next_check_at = now + 1 giorno`. Il contatore degli
   errori consecutivi del giro cresce.
3. **Risposta valida**: `check_count++`, salvataggio `poste_*`,
   `movements`, `last_response`, `last_error = null`, poi mappatura:
   - `delivered` / `returned` → `status` finale, `next_check_at = null`;
   - altrimenti, se `check_count >= 90` → `gave_up`, `next_check_at = null`;
   - altrimenti `next_check_at = now + 1 giorno`.
4. Contatore errori consecutivi azzerato su ogni risposta valida.

**Circuit breaker**: 5 errori consecutivi nello stesso giro → il giro si
interrompe con un `logger.warn` (endpoint probabilmente cambiato o
irraggiungibile); le righe non toccate restano `pending` e ripartono al giro
dopo. Nessuna riga marcata finale per errori.

### Verifica manuale

- **Per notifica**: `POST admin/campaigns/:id/recipients/:recipientId/postal/poste-check` (accanto a `postal/refresh-status`).
  Controlla l'ultimo attempt POSTAL del destinatario. Se non esiste la riga
  ma l'attempt è `NonConsegnato` con codice → la crea e controlla subito.
  Funziona anche su righe `gave_up` (controllo "fuori quota"): se l'esito è
  `delivered`/`returned` la riga diventa finale, altrimenti resta `gave_up`
  (nessun riavvio automatico dei 90 controlli). Righe già `delivered`/
  `returned`: ricontrollo eseguito, esito aggiornato solo se cambia.
  Risponde con lo stato aggiornato della riga.
- **Per campagna — tasto "Verifica su Poste"**: `POST admin/campaigns/:id/postal/poste-check`.
  Lanciabile **a qualsiasi ora**, indipendente dal cron e da
  `next_check_at` (ignorato: si controllano subito tutte le righe
  candidate, anche quelle già controllate oggi dal cron). Esegue il
  backfill ristretto alla campagna, poi `checkOne` sequenziale (stessa
  pausa 2 s) su tutte le righe `pending`/`gave_up` della campagna, in
  background (la richiesta risponde subito `202` con il numero di
  candidati). Un secondo avvio mentre ne gira uno sulla stessa campagna →
  `409`. Stato del run in memoria per campagna
  (`GET admin/campaigns/:id/postal/poste-check` → `running`, `total`,
  `done`, `delivered`, `returned`, `errors`, `startedAt`, `finishedAt`),
  letto dalla UI col pattern di polling esistente per mostrare
  avanzamento ed esito finale.
- **Controlli manuali e quota dei 90**: un controllo manuale (notifica o
  campagna) aggiorna esito/movimenti/`last_checked_at` ma **non**
  incrementa `check_count` e non sposta `next_check_at` — la quota dei 90
  misura solo i giorni di cron, così premere il tasto più volte non
  accorcia la finestra di verifica automatica.
- Permessi: tutti gli operatori (è sola lettura esterna, stesso principio
  di "Ricontrolla stato").
- Con `postalPosteTracking.enabled = false` gli endpoint manuali
  rispondono `409` con messaggio esplicito.

## Stato effettivo e discrepanza

Nuovo bucket sintetico di stato consegna **`ConsegnatoVerificaPoste`**
(etichetta "Consegnato (verifica Poste)"), stesso pattern dei bucket
sintetici esistenti `NonTracciato` / `AppIoSostituito` / `DirottatoAPec`.

Regola unica: un attempt POSTAL è `ConsegnatoVerificaPoste` se e solo se
`postal_status = 'NonConsegnato'` **e** esiste la sua riga
`postal_poste_tracking` con `status = 'delivered'`. In tutti gli altri casi
il bucket resta quello calcolato oggi da `postal_delivery_status`.

Implementazione in un unico helper (`poste-tracking-effective.util.ts`):
predicato in memoria + frammento SQL (`EXISTS` su `postal_poste_tracking`)
riusati da tutti i punti sotto, per non avere drift tra breakdown, filtri e
CSV.

**Discrepanza** = attempt in `ConsegnatoVerificaPoste` (per costruzione
GlobalCom dice `NonConsegnato`, Poste dice consegnato).

### Punti toccati

- **Breakdown recapito Poste** (`getPostalDeliveryStatusBreakdown`,
  `campaigns.service.ts`): il bucket `ConsegnatoVerificaPoste` precede
  `postal_delivery_status` nel calcolo della chiave.
- **Opzioni filtro "Stato consegna"** (`getRecipientFilterOptions`
  → `postalDeliveryStatuses`): bucket `ConsegnatoVerificaPoste` con conteggio
  (solo se > 0); il conteggio del valore GlobalCom originale (es. "Indirizzo
  errato o inesatto") esclude gli attempt passati nel bucket nuovo.
- **Filtro lista destinatari** (`postalDeliveryStatus` in
  `getRecipientStats`): ramo dedicato per `ConsegnatoVerificaPoste`; il ramo
  generico su `na.postal_delivery_status = :value` esclude gli attempt con
  override.
- **Ricerca globale notifiche** (`notifications-search`): nuovo query param
  `posteVerification` con valori `delivered` (discrepanza: consegnato
  secondo Poste), `returned`, `pending`, `gave_up`, `any` (qualunque riga
  presente). Filtra via `EXISTS` sull'ultimo attempt POSTAL del
  destinatario. Aggiunto il campo `posteVerification` (stato riga + data
  consegna) negli item della lista risultati.
- **Report CSV postale** (`postal-report-csv.util.ts`, attuale e storico, righe da `getPostalReportRows`):
  colonne in coda, dopo quelle GlobalCom invariate e prima di `Esito App IO`/
  `External ID`:
  - `Verifica Poste` — `Consegnato` / `Restituito al mittente` /
    `In verifica (n/90)` / `Verifica esaurita` / vuoto se nessuna riga;
  - `Data Consegna (Poste)` — `delivered_at` formattata come le altre date;
  - `Ultimo Movimento Poste` — `<luogo> <data>` dell'ultimo movimento;
  - `Discrepanza GlobalCom/Poste` — `SI` per `ConsegnatoVerificaPoste`,
    vuoto altrimenti.
  `PostalReportRowDto` estesa con i campi corrispondenti.
- **Dettaglio notifica** (`notification-detail.dto.ts`, sia da campagna sia
  da ricerca globale): blocco `posteVerification` sull'attempt POSTAL
  (`status`, `checkCount`, `maxChecks`, `nextCheckAt`, `lastCheckedAt`,
  `lastError`, `deliveredAt`, `movements`, `trackingCode`).

### UI admin (`frontend-admin`)

- Tabella destinatari campagna: badge "Consegnato (verifica Poste)" nella
  colonna recapito Poste, tooltip con lo stato GlobalCom originale
  (`postal_delivery_status` + data).
- Filtro "Stato consegna": nuova opzione dal backend, nessuna lista
  hardcoded.
- Dettaglio notifica: riquadro "Verifica Poste" — stato, `n/90` controlli,
  prossimo controllo, ultimo errore, lista movimenti (data, luogo, fase),
  codice tracking, bottone "Verifica ora".
- Pagina campagna POSTAL: bottone "Verifica su Poste" accanto a "Ricontrolla
  stato", sempre cliccabile (a qualsiasi ora) quando la campagna ha attempt
  `NonConsegnato`; disabilitato con spinner mentre il run è in corso;
  mostra avanzamento `done/total` e a fine run un riepilogo ("N consegnate
  secondo Poste, M restituite, K errori"), poi ricarica breakdown e lista
  destinatari. Polling sul `GET` di stato secondo il pattern esistente
  (`docs/claude/frontend-ui.md`).
- Ricerca globale: select "Verifica Poste" con le voci del query param
  `posteVerification`; colonna/badge nella lista risultati.
- Impostazioni → Postalizzazione: toggle "Verifica consegna su tracking
  Poste Italiane".

## Configurazione

Nuova chiave registry `postalPosteTracking.enabled` (boolean, default
`true`, nessun fallback env) in `settings.registry.ts`, esposta nella
sezione Postalizzazione delle Impostazioni. URL endpoint, pausa tra
chiamate, timeout, soglia circuit breaker e `MAX_POSTE_CHECKS` restano
costanti nel codice (YAGNI).

## Componenti

Modulo nuovo `channels/postal/poste-tracking/` (`PosteTrackingModule`,
registrato in `app.module.ts`), autonomo: nessuna nuova dipendenza nel
costruttore di `CampaignsService`/`CampaignsController` (evita di toccare
la decina di spec che li istanziano).

- `poste-tracking-mapping.util.ts` — funzioni pure: parsing risposta
  (`parsePosteResponse`), esito (`mapPosteOutcome`), ultimo movimento,
  `PosteTrackingError`.
- `poste-tracking-client.service.ts` — solo HTTP verso Poste. Nessun
  accesso DB.
- `poste-postal-tracking.service.ts` — backfill, cron, `checkOne`, run per
  campagna, circuit breaker, controllo per notifica.
- `poste-tracking.controller.ts` — endpoint manuali sotto `admin/campaigns`.
- `poste-tracking-effective.util.ts` — bucket sintetico, predicato/SQL
  dello stato effettivo, etichette, DTO `PosteVerificationDto`.
- `entities/postal-poste-tracking.entity.ts` + migration
  `CreatePostalPosteTracking`.
- Letture in `CampaignsService` e `NotificationsSearchService` tramite
  repository `PostalPosteTracking` iniettato con `@Optional()`: senza repo
  (spec esistenti) le letture tornano vuote.
- Modifiche: `campaigns.service.ts`, `postal-report-csv.util.ts`,
  `dto/campaign-stats.dto.ts`, `notifications-search/*`,
  `settings.registry.ts`, `database.module.ts`/`data-source.ts`,
  `frontend-admin`, `docs/claude/postal-globalcom.md` (nota sull'endpoint
  Poste e sui suoi gotcha).

## Test

- `poste-tracking-mapping.util.spec.ts`: `stato 5` → delivered con data
  dell'ultimo movimento; `flagRitorno` true (in testa o su un movimento) →
  returned anche con `stato 5`; `esitoRicerca 1` → pending; stato sconosciuto
  → pending.
- `poste-tracking-client.service.spec.ts`: parsing risposta, timeout, 5xx,
  body non JSON → errore tipizzato.
- `poste-postal-tracking.service.spec.ts`: upsert idempotente; errore rete
  non incrementa `check_count` ma aggiorna `last_checked_at`; 90° controllo
  senza esito → `gave_up`; circuit breaker a 5 errori consecutivi; kill-switch;
  manuale su `gave_up` resta `gave_up` senza esito finale; esclusione attempt
  non più `NonConsegnato`; run manuale di campagna ignora `next_check_at`,
  non incrementa `check_count`, `409` su run già in corso, stato run
  (`done/total`, conteggi esiti) aggiornato.
- `campaigns.service.spec.ts`: breakdown e opzioni filtro con bucket
  `ConsegnatoVerificaPoste` e decremento del bucket GlobalCom originale;
  filtro lista su bucket nuovo e su valore GlobalCom originale.
- `postal-report-csv.util.spec.ts`: nuove colonne, `Discrepanza` `SI` solo
  per `delivered`.
- `notifications-search.service.spec.ts`: filtro `posteVerification`.
- Verifica dal vivo in dev contro l'endpoint reale con un codice fornito
  dall'utente (mai salvato in fixture: fixture con codici fittizi).
