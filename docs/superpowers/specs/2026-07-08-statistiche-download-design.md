# Statistiche download — dettaglio campagna e vista globale

Data: 2026-07-08

## Contesto

Lo scopo è sapere **chi ha scaricato cosa e su quale canale**, per capire dove
intervenire (follow-up telefonico/cartaceo su chi non ha mai scaricato,
confronto efficacia canali).

Punto di partenza:
- `DownloadEvent` (entity) registra ogni download reale: `recipientId`,
  `channel` (`EMAIL`|`PEC`|`APP_IO`|`SEND`|`POSTAL`|`CITIZEN_PORTAL`|`UNKNOWN`),
  `attachmentIndex`, `downloadedAt`.
- `CampaignsService.getStats/getChannelBreakdown/getDownloadChannelStats/getRecipientStats`
  già forniscono statistiche aggregate per singola campagna.
- `NotificationsSearchService.getDetail` già ritorna `downloads[]` nel
  `NotificationDetailDto`, e la modale di "Ricerca Notifiche" in
  `App.tsx` (stato `notifDetail`, funzione `openNotificationDetail`) già
  la mostra — **riuso diretto**, nessuna modifica alla modale.
- La vista "Statistiche" (`view === 'statistiche'` in `App.tsx`) è oggi
  interamente mock: KPI calcolati client-side su `campaigns` in memoria,
  grafici SVG con dati hardcoded.
- `frontend-admin` non ha libreria grafici: si aggiunge `recharts`.

## Ambito

Progetto unico, due zone che condividono dati/componenti:
1. Dettaglio campagna singola: grafico incrocio canali download + click
   destinatario → anteprima.
2. Vista Statistiche globale (multi-campagna, con filtro data) resa
   funzionante con dati reali + pannelli di analisi aggiuntivi.

## 1. Backend

### 1.1 Endpoint cross-channel per campagna

`GET admin/campaigns/:id/download-cross-channel-stats`

Nuovo metodo `CampaignsService.getDownloadCrossChannelStats(campaignId)`:

- Ritorna `null` se la campagna non ha co-consegna App IO configurata
  (`resolveSecondaryAppIoConfig(campaign.channelConfig)` falsy) — stessa
  regola di `getChannelBreakdown`, perché la metrica "solo primario / solo
  App IO / entrambi" non ha senso senza co-consegna.
- Altrimenti, query su `DownloadEvent` raggruppata per `recipientId`,
  calcola per ciascun destinatario il set di canali su cui ha scaricato.
  Classificazione:
  - contiene `APP_IO` **e** (contiene canale primario **o** `CITIZEN_PORTAL`)
    → `both`
  - contiene solo `APP_IO` → `appIoOnly`
  - contiene canale primario o `CITIZEN_PORTAL` (senza `APP_IO`) → `primaryOnly`
  - nessun download → `none`

  `CITIZEN_PORTAL` è trattato come equivalente al canale primario per
  questa metrica (è un download alternativo dello stesso documento, non
  un canale di invio terzo). Resta comunque visibile separatamente nel
  pannello esistente "Download per Canale" (`getDownloadChannelStats`,
  invariato).

- Ritorna `{ primaryOnly: number, appIoOnly: number, both: number, none: number }`.

### 1.2 Endpoint statistiche globali

`GET admin/campaigns/stats/global?dateFrom&dateTo` (date opzionali,
default lato frontend: ultimi 6 mesi; filtro su `recipient.createdAt`
per invii e su `downloadEvent.downloadedAt` per download, stesso pattern
di `notifications-search.service.ts`).

Nuovo metodo `CampaignsService.getGlobalStats(dateFrom?, dateTo?)`,
nuovo DTO `GlobalStatsDto`:

```ts
interface GlobalStatsDto {
  totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number };
  monthlyTrend: Array<{ month: string /* YYYY-MM */; sent: number; downloaded: number }>;
  channelTotals: Array<{ channel: string; sent: number }>;      // per canale di invio campagna
  downloadChannelTotals: Array<{ channel: string; count: number }>; // per canale di download (DownloadEvent)
  campaignLeaderboard: Array<{ campaignId: string; campaignName: string; totalRecipients: number; downloadPercentage: number }>; // ordinata desc, frontend slice top/bottom 5
  neverDownloadedCount: number;
}
```

Query aggregate via `createQueryBuilder`, raggruppamento mensile con
`date_trunc('month', ...)` (Postgres). `campaignLeaderboard` esclude
campagne con `totalRecipients === 0`.

### 1.3 Export "mai scaricato"

`GET admin/campaigns/stats/global/never-downloaded.csv?dateFrom&dateTo`

Streaming CSV generato **lato backend** (non client-side come
`handleExportDownloadReport`, che opera su una singola campagna già in
memoria): la lista globale filtrata per data può contenere molte
migliaia di righe cross-campagna. Colonne: Codice Fiscale, Nominativo,
Campagna, Canale, Stato, Data invio. Usa `res.setHeader` +
stream/write incrementale, stesso approccio di eventuali export CSV
già presenti nel backend (verificare pattern in `public-download` o
introdurre helper minimale se non esiste).

### 1.4 Routing

Tutti i nuovi endpoint su `admin/campaigns` (stesso controller). Nessun
conflitto di path: `stats/global` è a 2 segmenti, non collide con
`@Get(':id')` (1 segmento).

## 2. Frontend — Dettaglio campagna

### 2.1 Click destinatario → anteprima

Riga `<tr>` della tabella "Destinatari Caricati" (App.tsx ~5631):
aggiungere `onClick={() => openNotificationDetail(r.id)}` e
`style={{ cursor: 'pointer' }}`. Nessuna modifica alla modale
`notifDetail` (già mostra `downloads[]` con canale/data/ora, App.tsx
~4286-4304).

### 2.2 Grafico incrocio canali

Nuova card "Grafici Download" nella colonna destra (col-lg-8), sotto la
card "Destinatari Caricati" — posizione indicata nello sketch. Gated su
`downloadCrossChannelStats !== null` (fetch parallelo a
`channelBreakdown` in `fetchCampaignDetail`).

Bar chart Recharts (`BarChart`/`Bar` orizzontale o verticale, coerente
palette esistente `--bi-primary`/`--ms-*`), 4 categorie: Solo primario,
Solo App IO, Entrambi, Nessuno. Sotto il grafico, tabella numerica con
valore assoluto + percentuale su totale destinatari con esito
(coerente allo stile del pannello "Dettaglio Consegna Multicanale"
sopra).

## 3. Frontend — Vista Statistiche globale

Sostituzione completa del contenuto mock in `view === 'statistiche'`
(App.tsx 4051-4163).

- **Filtro data**: due input `type="date"` (da/a) in alto, default
  ultimi 6 mesi calcolato client-side all'ingresso nella vista;
  ricarica `stats/global` al cambio (con debounce o bottone "Applica",
  coerente al pattern già usato in "Ricerca Notifiche").
- **KPI cards**: stessi 4 box esistenti (Notifiche Totali, Successo,
  Fallimenti, % Successo) ma da `totals` reale, + nuovo box "% Download"
  da `totals.downloadPercentage`.
- **Trend mensile**: `LineChart`/`AreaChart` Recharts con due serie
  (Invii, Download) da `monthlyTrend`, sostituisce il bar chart SVG
  finto.
- **Ripartizione canali**: `PieChart` Recharts da `channelTotals` (invio)
  — sostituisce il donut SVG finto con percentuali hardcoded.
- **Nuovo — Classifica campagne per tasso download**: tabella con
  migliori 5 e peggiori 5 campagne per `downloadPercentage` (da
  `campaignLeaderboard`), click su riga → naviga al dettaglio campagna
  (riuso `setView('campaign-detail')` + `fetchCampaignDetail`, stesso
  pattern già usato altrove in App.tsx).
- **Nuovo — Mai scaricato**: card con conteggio (`neverDownloadedCount`)
  e bottone "Esporta CSV" che scarica
  `stats/global/never-downloaded.csv?dateFrom&dateTo` (link diretto con
  token in query o fetch+blob, coerente al pattern di download già
  usato per allegati firmati).

## 4. Dipendenza recharts

`frontend-admin/package.json`: aggiungere `"recharts": "^2.x"`.
Rituale pnpm v11 obbligatorio (CLAUDE.md):

```bash
docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
docker compose build frontend-admin
docker compose rm -sf frontend-admin && docker volume rm comunicapa_admin_node_modules && docker compose up -d frontend-admin
```

Verificare nome volume reale con `docker volume ls | grep node_modules`
prima di rimuoverlo.

## Fuori ambito

- Nessuna modifica alla modale di anteprima notifica oltre al riuso
  (già mostra i download).
- Nessun nuovo importer/creator di campagne (resta il wizard unico,
  vedi CLAUDE.md).
- Nessuna modifica al frontend cittadino.
- Nessun filtro data per canale sui grafici della campagna singola
  (solo per la vista globale).

## Testing

- Backend: unit test nuovi metodi service (`getDownloadCrossChannelStats`,
  `getGlobalStats`) con `campaigns.service.spec.ts`, casi: campagna senza
  App IO (→ null), destinatario con download solo primario/solo
  App IO/entrambi/nessuno, `CITIZEN_PORTAL` classificato come primario.
  Test controller per routing (`stats/global` non collide con `:id`).
- Frontend: verifica manuale in browser (dev server) — click riga
  destinatario apre modale con downloads, grafico cross-channel visibile
  solo su campagne con App IO, vista Statistiche carica dati reali e
  filtro data funziona, export CSV scarica file non vuoto.
