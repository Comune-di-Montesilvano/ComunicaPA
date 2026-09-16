# Redesign dashboard operatore — design

Data: 2026-09-16

## Problema

Il box "Da attenzionare" della dashboard mostra i motori con job BullMQ
falliti (`counts.failed > 0`) senza alcuna finestra temporale — un
fallimento mai ripulito da un operatore in Motori resta visibile in rosso
per sempre, a differenza dell'alert sulle campagne fallite (già finestrato
a 30gg per data creazione campagna). Risultato: il box perde significato,
resta perennemente in stato "ci sono problemi" anche a sistema sano.

Oltre a questo, la dashboard attuale non mostra: la coda di Arricchimento
Tracciati (motore separato, non passa dal ciclo `EnginesController`),
quanti operatori sono online in questo momento, e non distingue le
campagne davvero attive/con aggiornamenti di consegna recenti dalle
ultime create (il widget "Attività Recenti" mostra solo le ultime 5
create, nessun filtro su aggiornamento).

## Decisioni

- Finestra alert motori: **7 giorni** (basata su `lastFailedAt`, non più
  sul count cumulativo).
- Widget arricchimento: stesso stile lettura degli altri motori
  (waiting/active/failed), nessuna azione pausa/riprendi (non supportato
  lato backend per questa coda).
- Utenti online: **heartbeat leggero** — nessuna infrastruttura di sessione
  esiste oggi (JWT stateless, nessuna tabella sessioni), quindi serve un
  minimo di stato server-side. Scartata l'opzione "conta JWT attivi":
  infeasibile, il backend non ha visibilità sui token emessi.
- Widget "Attività Recenti" → **sostituito** da "Campagne recenti" basato
  su attività reale (status attivo O aggiornamento consegna SEND/POSTAL
  negli ultimi 7 giorni), non più "ultime create".
- Presence specificata **dentro questa spec** (non a parte): l'infrastruttura
  è minima (endpoint + mappa in RAM), non giustifica un documento dedicato.
- Struttura dati backend: **endpoint granulari**, non un endpoint aggregato
  unico — coerente col pattern già in uso (`fetchDashboardStats`,
  `fetchEngines` come fetch indipendenti pollabili a cadenza propria).

## Backend

### 1. `GET /admin/engines` — esteso

Per ogni motore (incluso una entry sintetica `enrichment` per
`ENRICHMENT_QUEUE`), aggiungere `lastFailedAt: string | null`:

```ts
const [lastFailedJob] = await queue.getFailed(0, 0); // asc=false internamente: indice 0 = più recente
const lastFailedAt = lastFailedJob?.finishedOn ? new Date(lastFailedJob.finishedOn).toISOString() : null;
```

Verificato: `Queue.getFailed(start, end)` in bullmq@5.81.5 chiama
`getJobs(['failed'], start, end, false)` — `asc=false` ordina per
timestamp decrescente, quindi `getFailed(0, 0)` ritorna il fallimento più
recente, non il più vecchio.

L'entry `enrichment` ha la stessa shape (`waiting`, `active`, `failed`,
`lastFailedAt`) letta da `ENRICHMENT_QUEUE` — nessun campo `paused`
(sempre `false`/assente, il frontend la esclude dai controlli
pausa/riprendi già esistenti).

### 2. Presence — nuovo `PresenceService`

Provider singleton, stato in RAM (`Map<string, number>`, username →
timestamp ultimo heartbeat in ms) — nessuna persistenza, nessun Redis
(backend single-instance, come da CLAUDE.md).

- `POST /admin/presence/heartbeat` (auth operatore): aggiorna
  `map.set(username, Date.now())`. Risposta 200 vuota.
- `GET /admin/presence/online`: conta le entry con
  `Date.now() - lastSeen <= 90_000` (soglia 90s, margine su intervallo
  heartbeat 60s per tollerare un ciclo perso). Ritorna `{ count: number }`.
  Pulizia lazy delle entry scadute alla lettura (no timer dedicato).

### 3. `GET /admin/campaigns/recent-activity` — nuovo

Sostituisce la query "ultime 5 create" usata oggi lato frontend
(`campaigns.filter(...).slice(0,5)`). Criterio:

```sql
campaign.status IN ('queued', 'running')
OR EXISTS (
  SELECT 1 FROM notification_attempts a
  WHERE a.recipient_id IN (SELECT id FROM recipients WHERE campaign_id = campaign.id)
    AND (a.send_status_updated_at >= now() - interval '7 days'
         OR a.postal_status_updated_at >= now() - interval '7 days')
)
```

Esclude sempre `isTest = true` (stesso filtro già applicato lato
frontend oggi). Ordina per "ultimo aggiornamento" calcolato
(`GREATEST(campaign.updatedAt, MAX(attempt.sendStatusUpdatedAt),
MAX(attempt.postalStatusUpdatedAt))`) decrescente. Cap risultati a 15
(era 5, "Vedi tutte" invariato per l'elenco completo).

Nota: `campaign.updatedAt` NON viene mai toccato dai demoni di sync
SEND/POSTAL (verificato: `SendStatusSyncService`/
`PostalStatusSyncService` scrivono solo su `NotificationAttempt`) — da
qui la necessità di questo endpoint dedicato invece di derivare il dato
client-side dalla lista campagne già caricata.

Attenzione al gotcha TypeORM già noto in questo repo
(`leftJoinAndSelect` + `orderBy` + `take` su relazioni per-stringa rompe
con un errore interno) — se necessario, applicare lo stesso workaround a
due query separate (id via subquery/aggregate, poi `find` con
`relations` senza `orderBy`/`take`).

## Frontend

### Layout dashboard (dall'alto)

1. **Header saluto**: badge "Operativo" statico sostituito da badge
   presence dinamico — "N operatori online" (pill, stesso stile
   `badge bg-success-subtle`). Fallback a nessun numero (pill nascosta o
   testo neutro) se `GET presence/online` fallisce — non deve mai
   apparire come errore.
2. **KPI rapidi**: "Stato Connettori" (`X su Y motori attivi`) include
   ora anche l'entry `enrichment` nel conteggio Y.
3. **Da attenzionare**: invariato per campagne fallite (già finestrato
   30gg) e motori in pausa. Motori con job falliti: filtro aggiunto,
   mostra solo se `lastFailedAt` è entro 7 giorni — include `enrichment`
   come possibile voce.
4. **KPI cards 30gg**: invariate.
5. **Grafico andamento 30gg**: invariato.
6. **Campagne recenti** (ex "Attività Recenti"): alimentato da
   `recent-activity`, nuova colonna "Ultimo aggiornamento", cap 15,
   "Vedi tutte" invariato.

### Heartbeat

`useEffect` a livello App (non solo view dashboard): parte quando
`token` è valorizzato, `setInterval` 60s su
`POST /admin/presence/heartbeat` (fire-and-forget, errori ignorati),
cleanup su logout/unmount. Girare globalmente (non solo su
`view==='dashboard'`) perché la presence deve restare accurata anche
navigando altre viste.

## Error handling

- Heartbeat fallito: silenzioso, nessun impatto UI (stesso pattern già
  in uso per `fetchPostalQueueHealth`).
- `presence/online` fallito: badge header senza numero, mai stato di
  errore visibile.
- `engines` fallito: invariato (`enginesError` esistente), box "Da
  attenzionare" semplicemente senza dati motori quel giro (fail open).
- `recent-activity` fallito: card mostra stato errore inline + retry
  (riusa bottone `RefreshCw` già presente nell'header della card).
- Backend interamente giù: già gestito da `backendStatus` (lavoro
  sessione precedente) — nessuna gestione aggiuntiva richiesta qui.

## Testing

Backend (vitest):
- `PresenceService`: heartbeat aggiorna la mappa; `online` conta solo
  entro soglia 90s; entry scadute non contate (pulizia lazy).
- `EnginesController`: mock `queue.getFailed` → `lastFailedAt` mappato
  correttamente; entry `enrichment` presente nella risposta.
- Query `recent-activity`: campagna con status attivo inclusa anche
  senza attempt recenti; campagna con attempt aggiornato entro 7gg
  inclusa anche se status terminale; esclude `isTest`; esclude campagne
  oltre la finestra senza status attivo.

Frontend: nessuna suite automatica esiste su questa vista — verifica
manuale in browser (docker compose) su golden path (dati normali) ed
edge case (zero campagne, zero utenti online, backend che torna offline
a metà polling).
