# Redesign Dashboard operatore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire i KPI "all-time" e il box "GIL Services Hub" finto nella dashboard operatore (`view === 'dashboard'`) con dati reali a finestra fissa 30 giorni, un grafico di trend giornaliero, stato motori reale, e un box di alert per problemi in corso.

**Architecture:** Riuso quasi totale di endpoint/state esistenti — `GET /admin/campaigns/stats/global?dateFrom&dateTo` (già supporta range) per KPI/trend, `GET /admin/engines` (già usato dalla tab Motori) per stato motori. Unica modifica backend: aggiungo `dailyTrend` (granularità giorno) a `GlobalStatsDto`, additiva, non tocca `monthlyTrend` esistente. Il resto è lavoro frontend in `App.tsx`: nuovo state dashboard-scoped disaccoppiato da quello della vista Statistiche, box Alert derivato (nessun fetch dedicato), riuso widget motori.

**Tech Stack:** NestJS/TypeORM (backend), React 19 + recharts (frontend), Jest.

## Global Constraints

- Finestra KPI/trend dashboard: fissa "ultimi 30 giorni", nessun selettore periodo (deciso in fase di design).
- Nessuna modifica alla vista Statistiche esistente — `dailyTrend` è additivo su `GlobalStatsDto`, `monthlyTrend`/`globalStats`/`statsDateFrom`/`statsDateTo` restano invariati e usati solo da quella vista.
- Box Alert visibile solo se ci sono problemi (nessun messaggio "tutto ok" quando vuoto).
- Soglia alert campagna: tasso di fallimento >10% E almeno 5 destinatari totali.
- Segui il pattern di test esistente in `campaigns.service.spec.ts` (`makeQb` mock helper, ordine `createQueryBuilder` tracciato in `esclude sempre le campagne isTest=true...`).
- Dopo modifiche a `apps/backend/src/`: `docker compose restart backend`, verificare `dist/` più recente di `src/` prima di lanciare i test.
- Jest sempre con `--maxWorkers=2`.
- Type-check frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).

---

## File Structure

- Modifica: `apps/backend/src/campaigns/dto/global-stats.dto.ts` — nuovo `DailyTrendPointDto`, campo `dailyTrend` su `GlobalStatsDto`.
- Modifica: `apps/backend/src/campaigns/campaigns.service.ts:1151-1290` (`getGlobalStats`) — nuova query `dailyTrendRows` + mapping nel return.
- Modifica: `apps/backend/src/campaigns/campaigns.service.spec.ts:1154-1310` (`describe('getGlobalStats', ...)`) — aggiornare i due test esistenti che tracciano ordine/conteggio `createQueryBuilder`, aggiungere test dedicato per `dailyTrend`.
- Modifica: `apps/frontend-admin/src/App.tsx` — nuovo state dashboard (righe vicino a 1457-1465), split degli `useEffect` di fetch (righe 1007-1012, 1510-1516), sezione JSX vista dashboard (righe 5382-5501).

---

### Task 1: Backend — `dailyTrend` in `GlobalStatsDto` + query + test

**Files:**
- Modify: `apps/backend/src/campaigns/dto/global-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:1151-1290`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts:1154-1310`

**Interfaces:**
- Produces: `DailyTrendPointDto { date: string; sent: number; failed: number }`, campo `dailyTrend: DailyTrendPointDto[]` su `GlobalStatsDto`, consumato dal frontend in Task 3/5 come `dashboardStats.dailyTrend`.

- [ ] **Step 1: Scrivi il test fallente per `dailyTrend`**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, dentro `describe('getGlobalStats', ...)`, modifica il primo test (`'assembla il DTO combinando tutte le query aggregate nell\'ordine atteso'`, riga ~1166) aggiungendo la nuova query mockata **subito dopo** `sentTrendRows` nella catena `mockCampaignRepo.createQueryBuilder`:

```ts
mockCampaignRepo.createQueryBuilder = jest
  .fn()
  .mockReturnValueOnce(makeQb({ rawOne: { totalRecipients: '100', totalSent: '90', totalFailed: '10' } }))
  .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', sent: '50' }, { month: '2026-07', sent: '40' }] }))
  .mockReturnValueOnce(makeQb({ rawMany: [{ date: '2026-07-05', sent: '12', failed: '2' }] }))
  .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', sent: '90' }] }))
  .mockReturnValueOnce(makeQb({ rawMany: [{ campaignId: 'c1', campaignName: 'Tari', totalRecipients: '100', downloadedCount: '60' }] }));
```

Dopo l'`expect(result.monthlyTrend)...` esistente (riga ~1200-1203), aggiungi:

```ts
expect(result.dailyTrend).toEqual([
  { date: '2026-07-05', sent: 12, failed: 2 },
]);
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service.spec.ts -t "assembla il DTO" --maxWorkers=2`
Expected: FAIL — `result.dailyTrend` è `undefined` (il campo non esiste ancora), oppure la sequenza mock `mockReturnValueOnce` extra fa fallire un'altra asserzione (channelTotals/campaignLeaderboard letti dal QB sbagliato). Entrambi gli esiti confermano che manca l'implementazione.

- [ ] **Step 3: Aggiungi `DailyTrendPointDto` al DTO**

In `apps/backend/src/campaigns/dto/global-stats.dto.ts`, dopo `MonthlyTrendPointDto` (riga 15):

```ts
export interface DailyTrendPointDto {
  date: string;
  sent: number;
  failed: number;
}
```

E aggiungi il campo su `GlobalStatsDto` (dopo `monthlyTrend: MonthlyTrendPointDto[];`, riga 36):

```ts
  monthlyTrend: MonthlyTrendPointDto[];
  dailyTrend: DailyTrendPointDto[];
```

- [ ] **Step 4: Aggiungi la query e il mapping in `getGlobalStats`**

In `apps/backend/src/campaigns/campaigns.service.ts`, subito dopo il blocco `sentTrendRows` (righe 1171-1179), inserisci:

```ts
    const dailyTrendRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select("to_char(date_trunc('day', c.createdAt), 'YYYY-MM-DD')", 'date')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'failed')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy("date_trunc('day', c.createdAt)")
      .orderBy("date_trunc('day', c.createdAt)", 'ASC')
      .getRawMany<{ date: string; sent: string; failed: string }>();
```

Nel `return` finale (dopo `monthlyTrend: mergeMonthlyTrend(sentTrendRows, downloadedTrendRows),`, riga 1278), aggiungi:

```ts
      monthlyTrend: mergeMonthlyTrend(sentTrendRows, downloadedTrendRows),
      dailyTrend: dailyTrendRows.map((r) => ({ date: r.date, sent: Number(r.sent), failed: Number(r.failed) })),
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service.spec.ts -t "assembla il DTO" --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Aggiorna il secondo test esistente (totali a zero)**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, nel test `'ritorna totali a zero quando non ci sono campagne nel periodo'` (riga ~1212), la catena `mockCampaignRepo.createQueryBuilder` ha 4 `mockReturnValueOnce`; diventa 5 (aggiungi una riga identica alle altre subito dopo la seconda):

```ts
mockCampaignRepo.createQueryBuilder = jest
  .fn()
  .mockReturnValueOnce(makeQb({ rawOne: undefined }))
  .mockReturnValueOnce(makeQb({ rawMany: [] }))
  .mockReturnValueOnce(makeQb({ rawMany: [] }))
  .mockReturnValueOnce(makeQb({ rawMany: [] }))
  .mockReturnValueOnce(makeQb({ rawMany: [] }));
```

Dopo `expect(result.monthlyTrend).toEqual([]);` (riga ~1239), aggiungi:

```ts
expect(result.dailyTrend).toEqual([]);
```

- [ ] **Step 7: Aggiorna il terzo test esistente (ordine/isTest su 10 query)**

Nello stesso `describe`, test `'esclude sempre le campagne isTest=true da ognuna delle 10 query aggregate'` (riga ~1243):

- Cambia il commento/titolo del test da "10 query" a "11 query" (rinomina la stringa del test).
- Nella catena `mockCampaignRepo.createQueryBuilder` (righe ~1251-1256), inserisci una nuova `.mockImplementationOnce(...)` tra `sentTrendRows` e `channelRows`:

```ts
mockCampaignRepo.createQueryBuilder = jest
  .fn()
  .mockImplementationOnce(() => trackedMakeQb({ rawOne: { totalRecipients: '0', totalSent: '0', totalFailed: '0' } })) // totalsRow
  .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // sentTrendRows
  .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // dailyTrendRows
  .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // channelRows
  .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })); // leaderboardRows
```

- Cambia `expect(createdQbs).toHaveLength(10);` (riga ~1275) in `expect(createdQbs).toHaveLength(11);`.
- Nell'array `names` (righe ~1276-1287), aggiungi la voce corrispondente nella stessa posizione (dopo `sentTrendRows`, prima di `downloadedTrendRows`):

```ts
const [
  totalsRowQb,
  totalDownloadedQb,
  sentTrendQb,
  dailyTrendQb,
  downloadedTrendQb,
  channelQb,
  downloadChannelQb,
  leaderboardQb,
  neverDownloadedQb,
  costRowQb,
  savingRowQb,
] = createdQbs;

const names = [
  ['totalsRow', totalsRowQb],
  ['totalDownloaded', totalDownloadedQb],
  ['sentTrendRows', sentTrendQb],
  ['dailyTrendRows', dailyTrendQb],
  ['downloadedTrendRows', downloadedTrendQb],
  ['channelRows', channelQb],
  ['downloadChannelRows', downloadChannelQb],
  ['leaderboardRows', leaderboardQb],
  ['neverDownloadedCount', neverDownloadedQb],
  ['costRow', costRowQb],
  ['savingRow', savingRowQb],
] as const;
```

**Attenzione all'ordine reale:** il codice del service (Step 4) inserisce `dailyTrendRows` come query su `campaignRepo` eseguita subito dopo `sentTrendRows` e prima di `downloadedTrendRows` (che è su `recipientRepo`) — la destrutturazione sopra deve rispettare l'ordine di esecuzione effettivo, non l'ordine dei mock per singolo repo. Se il test fallisce su un `andWhere` mismatch, stampa `createdQbs` con il rispettivo `name` derivato dalle chiamate `select`/`addSelect` per individuare quale query è in quale posizione, poi correggi l'ordine nell'array.

- [ ] **Step 8: Esegui l'intera suite `getGlobalStats` e verifica che tutti i test passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service.spec.ts -t "getGlobalStats" --maxWorkers=2`
Expected: PASS (3/3 test in questo `describe`)

- [ ] **Step 9: Esegui la suite completa backend (baseline check)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts` / `isLdapMock`), nessuna nuova regressione.

- [ ] **Step 10: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/campaigns/dto/global-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): aggiungi dailyTrend (invii/falliti giornalieri) a getGlobalStats"
```

---

### Task 2: Frontend — state dashboard dedicato + fetch a 30 giorni, disaccoppiato da Statistiche

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1457-1465` (dichiarazione `globalStats`/`globalStatsLoading`)
- Modify: `apps/frontend-admin/src/App.tsx:1007-1012` (fetch al cambio vista)
- Modify: `apps/frontend-admin/src/App.tsx:1510-1516` (polling)

**Interfaces:**
- Consumes: nessuna nuova dipendenza esterna — riusa `apiFetch`/`ApiAuthError` già presenti nel file (vedi `fetchGlobalStats` esistente, riga 4997).
- Produces: state `dashboardStats: { totals: {...}; dailyTrend: Array<{ date: string; sent: number; failed: number }> } | null`, `dashboardStatsLoading: boolean`, funzione `fetchDashboardStats(): Promise<void>` — consumati dai Task 4 (KPI) e 5 (grafico).

- [ ] **Step 1: Aggiungi lo state dashboard**

In `apps/frontend-admin/src/App.tsx`, subito dopo la dichiarazione di `globalStatsLoading` (riga 1465):

```ts
  const [globalStatsLoading, setGlobalStatsLoading] = useState(false);

  // Dashboard: KPI/trend a finestra fissa 30gg, disaccoppiati dallo state
  // statsDateFrom/statsDateTo della vista Statistiche (quello è modificabile
  // dall'operatore e non deve influenzare i numeri mostrati in dashboard).
  const [dashboardStats, setDashboardStats] = useState<{
    totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number; totalCostCents: number; totalSavingCents: number };
    dailyTrend: Array<{ date: string; sent: number; failed: number }>;
  } | null>(null);
  const [dashboardStatsLoading, setDashboardStatsLoading] = useState(false);
```

- [ ] **Step 2: Aggiungi `fetchDashboardStats`**

Subito dopo la funzione `fetchGlobalStats` esistente (dopo la sua chiusura, riga 5010):

```ts
  const fetchDashboardStats = async () => {
    setDashboardStatsLoading(true);
    try {
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - 30);
      const params = new URLSearchParams();
      params.set('dateFrom', dateFrom.toISOString().slice(0, 10));
      params.set('dateTo', new Date().toISOString().slice(0, 10));
      const res = await apiFetch(`/campaigns/stats/global?${params.toString()}`);
      if (res.ok) setDashboardStats(await res.json());
    } catch (err) {
      if (!(err instanceof ApiAuthError)) throw err;
    } finally {
      setDashboardStatsLoading(false);
    }
  };
```

- [ ] **Step 3: Separa il fetch al cambio vista (dashboard vs statistiche)**

Sostituisci il blocco a riga 1007-1012:

```ts
  useEffect(() => {
    if ((view === 'statistiche' || view === 'dashboard') && token) {
      fetchGlobalStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
```

con:

```ts
  useEffect(() => {
    if (view === 'statistiche' && token) {
      fetchGlobalStats();
    }
    if (view === 'dashboard' && token) {
      fetchDashboardStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
```

- [ ] **Step 4: Separa il polling (dashboard vs statistiche)**

Sostituisci il blocco a riga 1510-1516:

```ts
  useEffect(() => {
    if (!token || (view !== 'statistiche' && view !== 'dashboard')) return;
    const timer = setInterval(() => {
      fetchGlobalStats();
    }, 5000);
    return () => clearInterval(timer);
  }, [token, view]);
```

con:

```ts
  useEffect(() => {
    if (!token || view !== 'statistiche') return;
    const timer = setInterval(() => {
      fetchGlobalStats();
    }, 5000);
    return () => clearInterval(timer);
  }, [token, view]);

  useEffect(() => {
    if (!token || view !== 'dashboard') return;
    const timer = setInterval(() => {
      fetchDashboardStats();
      fetchEngines();
    }, 5000);
    return () => clearInterval(timer);
  }, [token, view]);
```

(Il secondo `useEffect` include già `fetchEngines()` — anticipa il Task 3, evita un terzo `useEffect` ridondante per lo stesso `view === 'dashboard'`.)

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (se `fetchEngines` non è ancora dichiarata sopra questo punto nel file, TypeScript con `function`/`const` in closure di componente funziona comunque per riferimenti a state/funzioni dichiarate più sotto nello stesso corpo — se l'ordine di dichiarazione causa un errore "used before declaration", sposta la dichiarazione di `fetchEngines` sopra questo blocco, oppure lascia la chiamata: React aggiorna le closure ad ogni render quindi l'ordine testuale nel corpo del componente non causa problemi runtime, ma verifica comunque che `tsc` non segnali nulla).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): stato dashboard dedicato a 30gg, disaccoppiato da vista Statistiche"
```

---

### Task 3: Frontend — riscrivi la sezione JSX della dashboard (KPI 30gg, grafico, alert, motori)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:5382-5501` (blocco `{view === 'dashboard' && (...)}`)

**Interfaces:**
- Consumes: `dashboardStats` (Task 2), `engines`/`loadingEngines`/`fetchEngines` (già esistenti, righe 1415/2519), `campaigns` (già esistente), `handleCampaignClick(id: string)` (riga 4838), `setView`, `setActiveSettingsTab`.
- Produces: nessuna nuova interfaccia esterna — è la vista finale.

- [ ] **Step 1: Sostituisci l'intero blocco dashboard**

Sostituisci il blocco `{view === 'dashboard' && (...)}` (righe 5382-5501) con:

```tsx
          {view === 'dashboard' && (
            <div>
              <div className="bo-home-welcome mb-4 p-4 rounded shadow-sm" style={{ background: 'linear-gradient(135deg, var(--ms-purple-900), var(--ms-purple-600))', color: '#fff' }}>
                <h1 className="h4 text-white mb-2">Ciao, {username}! 👋</h1>
                <p className="mb-0 text-white-50 small">
                  Benvenuto nell'hub ComunicaPA del <strong>{settEntityName}</strong>. Qui puoi gestire gli invii e le impostazioni dei connettori.
                </p>
              </div>

              {(() => {
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                const failingCampaigns = campaigns.filter((c) => {
                  if (c.isTest) return false;
                  if (new Date(c.createdAt) < thirtyDaysAgo) return false;
                  if (c.totalRecipients < 5) return false;
                  return c.failedCount / c.totalRecipients > 0.1;
                });
                const pausedEngines = engines.filter((e) => e.paused);
                const failingEngines = engines.filter((e) => (e.counts?.failed ?? 0) > 0);
                const hasAlerts = failingCampaigns.length > 0 || pausedEngines.length > 0 || failingEngines.length > 0;
                if (!hasAlerts) return null;

                const engineLabel: Record<string, string> = {
                  EMAIL: 'Mail (SMTP)', PEC: 'PEC', APP_IO: 'App IO', SEND: 'SEND', POSTAL: 'Postale', PROTOCOLLAZIONE: 'Protocollazione',
                };

                return (
                  <div className="card shadow-sm mb-4 border-warning">
                    <div className="card-header bg-white py-3 border-bottom d-flex align-items-center gap-2">
                      <AlertTriangle className="text-warning" />
                      <h3 className="h6 mb-0 fw-bold text-dark">Da attenzionare</h3>
                    </div>
                    <div className="card-body p-0">
                      <ul className="list-group list-group-flush">
                        {failingCampaigns.map((c) => (
                          <li key={c.id} className="list-group-item d-flex justify-content-between align-items-center" style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                            <span>Campagna <strong className="text-primary">{c.name}</strong> — {Math.round((c.failedCount / c.totalRecipients) * 100)}% falliti</span>
                            <ArrowRight size={16} className="text-muted" />
                          </li>
                        ))}
                        {pausedEngines.map((e) => (
                          <li key={`paused-${e.channel}`} className="list-group-item d-flex justify-content-between align-items-center" style={{ cursor: 'pointer' }} onClick={() => { setView('impostazioni'); setActiveSettingsTab('motori'); fetchEngines(); }}>
                            <span>Motore <strong>{engineLabel[e.channel] ?? e.channel}</strong> in pausa</span>
                            <ArrowRight size={16} className="text-muted" />
                          </li>
                        ))}
                        {failingEngines.map((e) => (
                          <li key={`failed-${e.channel}`} className="list-group-item d-flex justify-content-between align-items-center" style={{ cursor: 'pointer' }} onClick={() => { setView('impostazioni'); setActiveSettingsTab('motori'); fetchEngines(); }}>
                            <span>Motore <strong>{engineLabel[e.channel] ?? e.channel}</strong> — {e.counts?.failed} job falliti</span>
                            <ArrowRight size={16} className="text-muted" />
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                );
              })()}

              <div className="row g-3 mb-4">
                <div className="col-md-3">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--bi-primary)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-primary rounded p-3" style={{ fontSize: '1.4rem' }}><Megaphone /></div>
                      <div>
                        <span className="text-muted small block">Messaggi Inviati (30gg)</span>
                        <div className="h4 mb-0 fw-bold">{dashboardStats ? dashboardStats.totals.totalSent : '…'}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--ms-green-600)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-success rounded p-3" style={{ fontSize: '1.4rem' }}><CheckCircle2 /></div>
                      <div>
                        <span className="text-muted small block">Destinatari (30gg)</span>
                        <div className="h4 mb-0 fw-bold">{dashboardStats ? dashboardStats.totals.totalRecipients : '…'}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3">
                  <div className={`card shadow-sm h-100 ${dashboardStats && dashboardStats.totals.totalFailed > 0 ? 'border-danger' : ''}`} style={{ borderLeft: '4px solid var(--it-red)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-danger rounded p-3" style={{ fontSize: '1.4rem' }}><XCircle /></div>
                      <div>
                        <span className="text-muted small block">Spedizioni Fallite (30gg)</span>
                        <div className={`h4 mb-0 fw-bold ${dashboardStats && dashboardStats.totals.totalFailed > 0 ? 'text-danger' : ''}`}>{dashboardStats ? dashboardStats.totals.totalFailed : '…'}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--ms-purple-600)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-primary rounded p-3" style={{ fontSize: '1.4rem' }}><Euro /></div>
                      <div>
                        <span className="text-muted small block">Costo Totale (30gg)</span>
                        <div className="h4 mb-0 fw-bold">{dashboardStats ? `${(dashboardStats.totals.totalCostCents / 100).toFixed(2)} €` : '…'}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="row g-3 mb-4">
                <div className="col-12">
                  <div className="card shadow-sm">
                    <div className="card-header bg-white py-3 border-bottom">
                      <h3 className="h6 mb-0 fw-bold text-dark"><LineChartIcon className="me-2 text-primary" size={16} />Andamento invii/falliti (ultimi 30gg)</h3>
                    </div>
                    <div className="card-body">
                      {dashboardStatsLoading && !dashboardStats ? (
                        <div className="text-center py-5 text-muted"><Loader2 className="icon-spin mb-3" size={24} /></div>
                      ) : dashboardStats && dashboardStats.dailyTrend.length === 0 ? (
                        <div className="text-center py-5 text-muted">Nessun invio negli ultimi 30 giorni.</div>
                      ) : (
                        <ResponsiveContainer width="100%" height={220}>
                          <LineChart data={dashboardStats?.dailyTrend ?? []}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="date" fontSize={11} />
                            <YAxis allowDecimals={false} />
                            <Tooltip />
                            <Legend />
                            <Line type="monotone" dataKey="sent" name="Invii" stroke="var(--bi-primary)" strokeWidth={2} />
                            <Line type="monotone" dataKey="failed" name="Falliti" stroke="var(--it-red)" strokeWidth={2} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="row g-3">
                <div className="col-lg-8">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h3 className="h6 mb-0 fw-bold text-dark"><History className="me-2 text-primary" />Attività Recenti</h3>
                      <div className="d-flex align-items-center gap-2">
                        <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchCampaigns}><RefreshCw /></button>
                        <button className="btn btn-link btn-sm" onClick={() => setView('invio-massivo')}>Vedi tutte</button>
                      </div>
                    </div>
                    <div className="card-body p-0">
                      {campaigns.length === 0 ? (
                        <div className="text-center py-5 text-muted">Nessuna attività registrata.</div>
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-hover align-middle mb-0" style={{ fontSize: '0.84rem' }}>
                            <thead className="table-light">
                              <tr>
                                <th>Nome Campagna</th>
                                <th>Canale</th>
                                <th>Stato</th>
                                <th className="text-end">Successi</th>
                              </tr>
                            </thead>
                            <tbody>
                              {campaigns.filter(c => !c.isTest).slice(0, 5).map((c) => (
                                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                                  <td className="fw-bold text-primary">{c.name}</td>
                                  <td><ChannelBadge channel={c.channelType} /></td>
                                  <td><StatusBadge status={c.status} /></td>
                                  <td className="text-end fw-bold">{c.sentCount} / {c.totalRecipients}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="col-lg-4">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h3 className="h6 mb-0 fw-bold text-dark"><Network className="me-2 text-primary" />Stato Motori</h3>
                      <button className="btn btn-link btn-sm" onClick={() => { setView('impostazioni'); setActiveSettingsTab('motori'); fetchEngines(); }}>Dettaglio</button>
                    </div>
                    <div className="card-body">
                      {engines.length === 0 ? (
                        <div className="text-center py-3 text-muted small">Caricamento...</div>
                      ) : (
                        engines.map((eng) => {
                          const engineLabel: Record<string, string> = {
                            EMAIL: 'Mail (SMTP)', PEC: 'PEC', APP_IO: 'App IO', SEND: 'SEND', POSTAL: 'Postale', PROTOCOLLAZIONE: 'Protocollazione',
                          };
                          const failed = eng.counts?.failed ?? 0;
                          return (
                            <div key={eng.channel} className="d-flex align-items-center justify-content-between mb-2 pb-2 border-bottom">
                              <span className="small fw-bold">{engineLabel[eng.channel] ?? eng.channel}</span>
                              {eng.paused ? (
                                <span className="badge bg-warning text-dark">IN PAUSA</span>
                              ) : failed > 0 ? (
                                <span className="badge bg-danger">{failed} FALLITI</span>
                              ) : (
                                <span className="badge bg-success">ATTIVO</span>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 2: Assicura che `fetchEngines()` venga chiamato all'ingresso in dashboard**

Nel blocco aggiunto al Task 2 Step 3 (fetch al cambio vista), aggiungi la chiamata anche lì per popolare subito `engines` al primo ingresso (oggi viene fetchato solo al click sulla tab Motori):

```ts
  useEffect(() => {
    if (view === 'statistiche' && token) {
      fetchGlobalStats();
    }
    if (view === 'dashboard' && token) {
      fetchDashboardStats();
      fetchEngines();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): redesign dashboard — KPI 30gg, trend giornaliero, alert, motori reali"
```

---

### Task 4: Verifica manuale in browser

**Files:** nessuno (verifica, non modifica).

- [ ] **Step 1: Avvia/riavvia lo stack dev**

Run: `docker compose up -d --build backend frontend-admin`

- [ ] **Step 2: Verifica dashboard senza alert**

Login come `admin`/`admin` (LDAP mock). Vai su Dashboard. Verifica:
- 4 KPI card mostrano "(30gg)" nell'etichetta e un numero (non `…` dopo il caricamento).
- Nessun box "Da attenzionare" se non ci sono campagne fallite/motori in pausa (verificare con dati esistenti — se lo stack ha dati storici con fallimenti recenti, il box deve apparire).
- Grafico linea presente, o messaggio "Nessun invio negli ultimi 30 giorni" se non ci sono dati recenti.
- Box "Stato Motori" mostra badge ATTIVO/IN PAUSA/N FALLITI per ogni motore, non più "GIL Services Hub" con badge finti.
- "Attività Recenti" invariata, bottone "Vedi tutte" naviga a `invio-massivo`.

- [ ] **Step 3: Verifica box Alert (forzando un caso reale)**

Dalla tab Impostazioni → Motori, metti in pausa un motore (es. EMAIL). Torna in Dashboard: il box "Da attenzionare" deve apparire con la riga "Motore Mail (SMTP) in pausa", cliccabile → torna alla tab Motori. Riprendi il motore al termine del test.

- [ ] **Step 4: Verifica che la vista Statistiche non sia stata alterata**

Vai su Statistiche, cambia il filtro data, verifica che il grafico "Andamento Invii e Download" (mensile, invariato) risponda al filtro come prima. Torna in Dashboard e verifica che i KPI dashboard siano rimasti sugli ultimi 30gg (non sporcati dal filtro di Statistiche) — conferma la fix del disaccoppiamento del Task 2.

---

## Note per l'implementatore

- Nessuna migration DB necessaria — `dailyTrend` è calcolato da colonne già esistenti (`sentCount`, `failedCount`, `createdAt` su `Campaign`).
- Nessun nuovo endpoint — solo un campo aggiuntivo su una response esistente e un widget frontend che riusa fetch già presenti (`fetchEngines`) o quasi identici (`fetchDashboardStats` è una copia parametrizzata di `fetchGlobalStats`).
- Se in futuro serve un periodo configurabile in dashboard (oggi esplicitamente fuori scope), il punto di estensione è `fetchDashboardStats`: basta aggiungere uno state per il numero di giorni e sostituire il `30` hardcoded.
