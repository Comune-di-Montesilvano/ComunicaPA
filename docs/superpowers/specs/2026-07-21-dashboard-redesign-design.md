# Redesign Dashboard operatore — design

## Contesto

Vista `dashboard` in `apps/frontend-admin/src/App.tsx` (righe ~5382-5501) oggi mostra:
- 4 KPI card **all-time** (Campagne Create, Messaggi Inviati, Spedizioni Fallite, Costo Totale) calcolate con `campaigns.reduce(...)` su TUTTA la storia — una campagna fallita vecchia sfalsa per sempre i numeri, senza contesto temporale.
- "Attività Recenti" — ultime 5 campagne non-test, nessun link a lista completa.
- "GIL Services Hub" — box con badge "ATTIVO" **hardcoded**, non riflette stato reale dei motori.

Problema riportato dall'utente: i KPI aggregati su tutta la vita del sistema perdono di senso — una campagna fallita mesi fa continua a pesare per sempre sul totale "Fallite".

## Obiettivo

Riprogettare la dashboard con dati **temporali (finestra fissa 30 giorni)**, stato motori reale, un grafico di trend, e un box di alert per problemi in corso. Confermato via mockup visuale (companion browser) con l'utente.

## Design approvato (da mockup)

Ordine sezioni dall'alto:

1. **Welcome banner** — invariato.
2. **Box Alert** — visibile SOLO se ci sono problemi da segnalare (nascosto se tutto ok, niente "nessun problema" rumoroso). Contenuto:
   - Campagne (ultimi 30gg) con tasso di fallimento sopra soglia (es. >10% e almeno 5 destinatari, per evitare falsi allarmi su campagne piccolissime).
   - Motori in pausa (`paused: true` da `/admin/engines`).
   - Motori con job falliti (`counts.failed > 0`).
   Ogni riga cliccabile → naviga al dettaglio pertinente (campagna o vista Motori).
3. **Riga KPI** — 4 card, stessa grafica attuale ma:
   - Etichette con suffisso "(ultimi 30gg)".
   - Valori ricalcolati da un fetch dedicato a finestra fissa 30 giorni, **non** condiviso con lo state `statsDateFrom/statsDateTo` della vista Statistiche (bug di accoppiamento esistente: oggi la dashboard chiama `fetchGlobalStats()` che usa quello stesso state, quindi cambiare il filtro in Statistiche sporca silenziosamente anche la dashboard alla prossima visita).
   - Card "Spedizioni Fallite" con evidenza visiva (bordo/testo rosso) quando >0.
4. **Riga Grafico + spazio libero** — grafico linea (recharts, stesso stile della vista Statistiche) con andamento giornaliero invii/falliti negli ultimi 30gg.
5. **Riga Attività Recenti + Stato Motori** — stessa disposizione 8/4 di oggi:
   - Attività Recenti: invariata, + link "Vedi tutte" verso vista `invio-massivo`.
   - Stato Motori: sostituisce "GIL Services Hub" — elenco reale da `/admin/engines` (nome motore, pausa/attivo, conteggio job falliti), niente più badge finti.

## Componenti coinvolti

### Backend — nessun nuovo endpoint per KPI/alert/motori

- `GET /admin/campaigns/stats/global?dateFrom&dateTo` (`campaigns.controller.ts` → `getGlobalStats()`, `campaigns.service.ts:1151`) già supporta range di date e già ritorna `totals.totalFailed`/`totalSent`/`totalCostCents` filtrati per range — riuso diretto per i KPI, chiamata con `dateFrom = oggi-30gg`.
- `GET /admin/engines` (`engines.controller.ts`) già ritorna `{ engines: [{ channel, paused, counts }] }` — riuso diretto per box Stato Motori e per la condizione "motore in pausa/con falliti" nel box Alert.
- Elenco campagne (`campaigns` state già in memoria nel frontend, da `fetchCampaigns()`) — riuso per soglia fallimento campagna nel box Alert, filtrando per `createdAt` negli ultimi 30gg lato frontend (nessuna nuova query, i dati sono già scaricati per "Attività Recenti"/vista Campagne).

### Backend — una modifica: trend giornaliero

`GlobalStatsDto.monthlyTrend` (`global-stats.dto.ts`) è granularità mensile (bucket `date_trunc('month', c.createdAt)`) — su una finestra di 30gg produce ~1 punto, inutile per un grafico. Aggiungo:

```ts
export interface DailyTrendPointDto {
  date: string;   // YYYY-MM-DD
  sent: number;
  failed: number;
}
```

nuovo campo `dailyTrend: DailyTrendPointDto[]` su `GlobalStatsDto`, calcolato in `getGlobalStats()` con una query gemella a `sentTrendRows` esistente ma bucket `date_trunc('day', c.createdAt)` e aggiungendo `SUM(c.failedCount)`. Stessa convenzione già in uso nel file (bucket per data di creazione campagna, non per data di invio reale del singolo destinatario — limite già accettato per `monthlyTrend`, coerenza mantenuta). Nessun impatto su `monthlyTrend`/vista Statistiche esistente, solo aggiunta additiva.

### Frontend — `App.tsx`

- Nuovo state dedicato dashboard (es. `dashboardStats: GlobalStatsDto | null`, `dashboardStatsLoading`) e nuova funzione `fetchDashboardStats()` che chiama l'endpoint con `dateFrom` fisso = oggi-30gg, `dateTo` = oggi — **non tocca** `statsDateFrom`/`statsDateTo`/`globalStats` usati dalla vista Statistiche.
- Nuovo state `enginesStatus` (riuso se già presente per vista Motori — verificare `App.tsx` per uno state esistente prima di duplicarlo) + fetch da `/admin/engines`.
- Polling: la dashboard già ha un `useEffect` con refresh periodico per `campaigns`/`globalStats` quando `view === 'dashboard'` (righe ~1494-1513, vedi gotcha "Liste e pannelli con stato lato server" in CLAUDE.md) — estendere lo stesso intervallo a `fetchDashboardStats()` ed `enginesStatus`, non un `useEffect` separato scollegato.
- Box Alert: componente inline, calcolato da `campaigns` (già in state) + `dashboardStats.totals` + `enginesStatus` — nessun fetch dedicato, puro derived state. Soglia fallimento: >10% E almeno 5 destinatari totali per la campagna.
- Grafico: `<LineChart>` recharts con due serie (`sent` verde, `failed` rosso), asse X = `dailyTrend[].date`, stesso pattern import già presente in cima al file.
- Box Stato Motori: lista semplice (non tabella), un badge per motore: verde "Attivo" / giallo "In pausa", + contatore rosso se `counts.failed > 0`.

## Fuori scope

- Nessun filtro periodo configurabile in dashboard (deciso: fisso 30gg, vedi risposta utente).
- Nessuna modifica alla vista Statistiche esistente (il nuovo `dailyTrend` è additivo, non sostituisce `monthlyTrend`).
- Nessun meccanismo push (SSE/websocket) — resta polling `setInterval`, coerente con gotcha "nessun refresh automatico globale" già documentato in CLAUDE.md.

## Test

- Unit test `campaigns.service.spec.ts`: `getGlobalStats()` ritorna `dailyTrend` corretto per un range di pochi giorni con campagne a `sentCount`/`failedCount` noti.
- Verifica manuale UI (dev, LDAP mock): dashboard mostra KPI 30gg, box Alert compare/scompare a seconda di dati, grafico popolato, stato motori riflette pausa/ripresa da vista Motori.
