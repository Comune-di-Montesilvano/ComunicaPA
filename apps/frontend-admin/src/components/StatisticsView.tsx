import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Users, Send, XCircle, Download, EyeOff, RefreshCw, Loader2, FileSpreadsheet, Euro, Mail, Printer,
  PiggyBank, Trophy, LineChart as LineChartIcon, PieChart as PieChartIcon, Wallet, Globe, Info, Hourglass,
} from 'lucide-react';
import { getChannelMeta } from '../data/channels';
import { CHART, channelColor, channelRank, formatMonth, fmt, pct, plural, iso, Kpi, BarRow, ChartTooltip } from './stats-ui';
import '../assets/css/statistics.css';

// ─── Tipi (specchio dei DTO backend: global-stats.dto.ts / cost-analytics.util.ts) ───

interface GlobalStats {
  totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number; totalCostCents: number; totalSavingCents: number };
  monthlyTrend: Array<{ month: string; sent: number; downloaded: number }>;
  channelTotals: Array<{ channel: string; sent: number }>;
  downloadChannelTotals: Array<{ channel: string; count: number }>;
  campaignLeaderboard: Array<{ campaignId: string; campaignName: string; totalRecipients: number; sentCount: number; downloadPercentage: number }>;
  neverDownloadedCount: number;
}

interface CostBucket { count: number; costCents: number }
interface CostByKey extends CostBucket { key: string }
interface CostAnalytics {
  totalCostCents: number;
  send: { totalCostCents: number; digital: CostBucket; analog: CostBucket & { baseFeeCents: number; analogCostCents: number }; byProduct: CostByKey[]; pendingCount: number };
  postal: { totalCostCents: number; count: number; avgCostCents: number; components: { stampaCents: number; postaleCents: number; arCents: number }; byProduct: CostByKey[]; domestic: CostBucket; foreign: CostBucket; pendingCount: number };
  monthly: Array<{ month: string; sendDigitalCents: number; sendAnalogCents: number; postalCents: number }>;
  topCampaigns: Array<{ campaignId: string; campaignName: string; channelType: string; costCents: number; costedCount: number; avgCostCents: number }>;
  savings: { sendCents: number; sendDigitalCount: number; sendNotEstimableCount: number; postalCents: number; postalDivertedCount: number; postalNotEstimableCount: number };
}

interface Props {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onOpenCampaign: (campaignId: string) => void;
  formatEuroCents: (cents: number) => string;
}

const SEND_PRODUCT_LABEL: Record<string, string> = {
  AR: 'Raccomandata A/R',
  '890': 'Atto giudiziario (890)',
  RS: 'Raccomandata semplice',
  RIR: 'Raccomandata internazionale A/R',
  RIS: 'Raccomandata internazionale',
};
// "RaccomandataMarket4" → "Raccomandata Market 4"
const humanizeProduct = (k: string) => k.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2');

// ─── Periodo ───
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return iso(d); };
const PRESETS: Array<{ id: string; label: string; from: () => string }> = [
  { id: '30d', label: '30 giorni', from: () => daysAgo(29) },
  { id: '90d', label: '90 giorni', from: () => daysAgo(89) },
  { id: '6m', label: '6 mesi', from: () => monthsAgo(6) },
  { id: 'ytd', label: 'Anno in corso', from: () => `${new Date().getFullYear()}-01-01` },
  { id: '12m', label: '12 mesi', from: () => monthsAgo(12) },
  { id: 'all', label: 'Tutto', from: () => '' },
];

const POLL_MS = 30_000;

export function StatisticsView({ apiFetch, onOpenCampaign, formatEuroCents }: Props) {
  const [preset, setPreset] = useState<string>('6m');
  const [dateFrom, setDateFrom] = useState(() => monthsAgo(6));
  const [dateTo, setDateTo] = useState(() => iso(new Date()));
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [costs, setCosts] = useState<CostAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [leaderboardTab, setLeaderboardTab] = useState<'best' | 'worst'>('best');

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    return p.toString();
  }, [dateFrom, dateTo]);

  // Il fetch dipende da `query`: il polling si ricrea a ogni cambio periodo,
  // mai più una closure ferma sulle date iniziali (bug reale: il poll
  // riportava i dati del periodo di default 5s dopo aver premuto "Applica").
  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const [g, c] = await Promise.all([
        apiFetch(`/campaigns/stats/global?${query}`),
        apiFetch(`/campaigns/stats/costs?${query}`),
      ]);
      if (g.ok) setStats(await g.json());
      if (c.ok) setCosts(await c.json());
      setUpdatedAt(new Date());
    } catch {
      // Sessione scaduta/rete: apiFetch gestisce già il logout, nessun crash qui.
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiFetch, query]);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
    // apiFetch cambia identità a ogni render di App: dipendiamo solo dal periodo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setDateFrom(p.from());
    setDateTo(iso(new Date()));
  };

  const exportNeverDownloaded = async () => {
    try {
      const res = await apiFetch(`/campaigns/stats/global/never-downloaded.csv?${query}`);
      if (!res.ok) { alert('Impossibile esportare il report.'); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mai_scaricato.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* gestito da apiFetch */ }
  };

  const channelRows = useMemo(() => (stats?.channelTotals ?? [])
    .filter((c) => c.sent > 0)
    .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || a.channel.localeCompare(b.channel)), [stats]);
  const downloadRows = useMemo(() => (stats?.downloadChannelTotals ?? [])
    .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || a.channel.localeCompare(b.channel)), [stats]);
  const monthly = useMemo(() => (stats?.monthlyTrend ?? []).map((m) => ({ ...m, label: formatMonth(m.month) })), [stats]);
  const costMonthly = useMemo(() => (costs?.monthly ?? []).map((m) => ({
    label: formatMonth(m.month),
    sendDigital: m.sendDigitalCents / 100,
    sendAnalog: m.sendAnalogCents / 100,
    postal: m.postalCents / 100,
  })), [costs]);

  if (!stats && loading) {
    return <div className="stx"><div className="stx-empty"><Loader2 className="stx-spin" size={18} /> Caricamento statistiche…</div></div>;
  }

  const t = stats?.totals;
  const leaderboard = stats?.campaignLeaderboard ?? [];
  const leaderboardRows = leaderboardTab === 'best'
    ? leaderboard.slice(0, 8)
    : [...leaderboard].reverse().slice(0, 8);
  const sendAnalog = costs?.send.analog;
  const sendDigital = costs?.send.digital;
  const sendCount = (sendDigital?.count ?? 0) + (sendAnalog?.count ?? 0);
  const pendingCosts = (costs?.send.pendingCount ?? 0) + (costs?.postal.pendingCount ?? 0);
  const totalSaving = (costs?.savings.sendCents ?? 0) + (costs?.savings.postalCents ?? 0);
  const comp = costs?.postal.components;
  const compTotal = comp ? comp.stampaCents + comp.postaleCents + comp.arCents : 0;
  const maxChannelSent = Math.max(1, ...channelRows.map((c) => c.sent));
  const channelSentTotal = channelRows.reduce((s, c) => s + c.sent, 0);
  const downloadTotal = downloadRows.reduce((s, c) => s + c.count, 0);
  const maxDownload = Math.max(1, ...downloadRows.map((c) => c.count));

  return (
    <div className="stx">
      {/* ── Periodo ── */}
      <div className="stx-toolbar">
        <div>
          <div className="stx-dates"><label>Periodo</label></div>
          <div className="stx-presets" role="group" aria-label="Periodo rapido">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className={`stx-chip ${preset === p.id ? 'is-active' : ''}`} onClick={() => applyPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="stx-dates">
          <div>
            <label htmlFor="stx-from">Dal</label>
            <input id="stx-from" type="date" className="form-control form-control-sm" value={dateFrom} max={dateTo || undefined}
              onChange={(e) => { setPreset('custom'); setDateFrom(e.target.value); }} />
          </div>
          <div>
            <label htmlFor="stx-to">Al</label>
            <input id="stx-to" type="date" className="form-control form-control-sm" value={dateTo} min={dateFrom || undefined}
              onChange={(e) => { setPreset('custom'); setDateTo(e.target.value); }} />
          </div>
        </div>
        <div className="stx-updated">
          {updatedAt && <span>Aggiornato alle {updatedAt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
          <button type="button" className="stx-icon-btn" onClick={() => load(false)} title="Aggiorna ora" aria-label="Aggiorna ora" disabled={loading}>
            {loading ? <Loader2 className="stx-spin" size={15} /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      {t && (
        <>
          {/* ── KPI ── */}
          <div className="stx-kpis">
            <Kpi icon={<Users size={14} />} label="Destinatari" value={fmt(t.totalRecipients)} sub="nel periodo, esclusi i test" accent />
            <Kpi icon={<Send size={14} />} label="Inviati" value={fmt(t.totalSent)} valueColor="var(--stx-good)"
              sub={<><strong>{pct(t.totalSent, t.totalRecipients)}%</strong> dei destinatari</>} />
            <Kpi icon={<XCircle size={14} />} label="Falliti" value={fmt(t.totalFailed)} valueColor={t.totalFailed > 0 ? 'var(--stx-bad)' : undefined}
              sub={<><strong>{pct(t.totalFailed, t.totalRecipients)}%</strong> dei destinatari</>} />
            <Kpi icon={<Download size={14} />} label="Scaricati" value={`${t.downloadPercentage}%`}
              sub={<><strong>{fmt(t.totalDownloaded)}</strong> su {fmt(t.totalSent)} inviati</>} />
            <Kpi icon={<EyeOff size={14} />} label="Mai scaricato" value={fmt(stats!.neverDownloadedCount)}
              sub={<button type="button" className="btn btn-link p-0" style={{ fontSize: '0.78rem' }} onClick={exportNeverDownloaded}>
                <FileSpreadsheet size={12} className="me-1" />Esporta elenco CSV
              </button>} />
          </div>

          {/* ── Trend + canali ── */}
          <div className="stx-grid">
            <div className="stx-card stx-span-8">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><LineChartIcon size={16} />Invii e download per mese</h3>
                <span className="stx-card-hint">destinatari per mese di creazione campagna</span>
              </div>
              <div className="stx-card-body">
                {monthly.length === 0 ? <div className="stx-empty">Nessun invio nel periodo selezionato.</div> : (
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={monthly} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="#edf1f6" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} tickFormatter={fmt} />
                      <Tooltip content={<ChartTooltip format={(v) => fmt(v)} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                      <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sent" name="Inviati" fill={CHART.blue} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                      <Line dataKey="downloaded" name="Scaricati" stroke={CHART.aqua} strokeWidth={2} dot={{ r: 4, fill: CHART.aqua, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="stx-card stx-span-4">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><PieChartIcon size={16} />Inviati per canale</h3>
                <span className="stx-card-hint">canale della campagna</span>
              </div>
              <div className="stx-card-body">
                {channelRows.length === 0 ? <div className="stx-empty">Nessun invio nel periodo.</div> : (
                  <div className="stx-bars">
                    {channelRows.map((c) => (
                      <BarRow key={c.channel} color={channelColor(c.channel)} label={getChannelMeta(c.channel).label}
                        value={fmt(c.sent)} share={pct(c.sent, channelSentTotal)} widthPct={(c.sent / maxChannelSent) * 100} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Costi ── */}
      {costs && (
        <>
          <h2 className="stx-section-title">
            <Wallet size={18} />Costi
            <small>importi al netto IVA · SEND e postalizzazione</small>
            {pendingCosts > 0 && (
              <span className="stx-pill-warn" title="Invii riusciti di cui il provider non ha ancora comunicato il costo definitivo: il totale crescerà">
                <Hourglass size={12} />{fmt(pendingCosts)} in attesa di costo
              </span>
            )}
          </h2>

          <div className="stx-kpis">
            <Kpi icon={<Euro size={14} />} label="Costo totale" value={formatEuroCents(costs.totalCostCents)} accent
              sub={<>{plural(sendCount + costs.postal.count, 'invio', 'invii')} con costo calcolato</>} />
            <Kpi icon={<Send size={14} />} label="SEND" value={formatEuroCents(costs.send.totalCostCents)}
              sub={<>{plural(sendCount, 'notifica', 'notifiche')} · media <strong>{formatEuroCents(sendCount ? Math.round(costs.send.totalCostCents / sendCount) : 0)}</strong></>} />
            <Kpi icon={<Printer size={14} />} label="Postalizzazione" value={formatEuroCents(costs.postal.totalCostCents)}
              sub={<>{plural(costs.postal.count, 'spedizione', 'spedizioni')} · media <strong>{formatEuroCents(costs.postal.avgCostCents)}</strong></>} />
            <Kpi icon={<PiggyBank size={14} />} label="Risparmio stimato" value={formatEuroCents(totalSaving)} valueColor="var(--stx-good)"
              title={'Spedizioni cartacee evitate, valorizzate al costo medio della stessa campagna (media del periodo se la campagna non ha riferimenti).\n'
                + `SEND: ${fmt(costs.savings.sendDigitalCount)} notifiche recapitate in digitale × spedizione cartacea media.\n`
                + `Postalizzazione: ${fmt(costs.savings.postalDivertedCount)} lettere dirottate su domicilio digitale × costo medio lettera.`}
              sub={<>SEND <strong>{formatEuroCents(costs.savings.sendCents)}</strong> · Posta <strong>{formatEuroCents(costs.savings.postalCents)}</strong></>} />
          </div>

          <div className="stx-grid">
            {/* SEND digitale vs cartaceo */}
            <div className="stx-card stx-span-6">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Send size={16} />SEND · digitale o cartaceo</h3>
                {costs.send.pendingCount > 0 && <span className="stx-card-hint">{fmt(costs.send.pendingCount)} in attesa di costo</span>}
              </div>
              <div className="stx-card-body">
                {sendCount === 0 ? <div className="stx-empty">Nessuna notifica SEND con costo nel periodo.</div> : (
                  <>
                    <StackBar parts={[
                      { label: 'Recapito digitale', value: sendDigital!.count, color: CHART.blue },
                      { label: 'Recapito cartaceo', value: sendAnalog!.count, color: CHART.orange },
                    ]} format={(v) => plural(v, 'notifica', 'notifiche')} />
                    <div className="stx-split">
                      <div className="stx-split-cell">
                        <h4><Mail size={13} style={{ color: CHART.blue }} />Digitale</h4>
                        <div className="stx-big">{formatEuroCents(sendDigital!.costCents)}</div>
                        <dl>
                          <dt>Notifiche</dt><dd>{fmt(sendDigital!.count)} ({pct(sendDigital!.count, sendCount)}%)</dd>
                          <dt>Costo medio</dt><dd>{formatEuroCents(sendDigital!.count ? Math.round(sendDigital!.costCents / sendDigital!.count) : 0)}</dd>
                        </dl>
                      </div>
                      <div className="stx-split-cell">
                        <h4><Printer size={13} style={{ color: CHART.orange }} />Cartaceo</h4>
                        <div className="stx-big">{formatEuroCents(sendAnalog!.costCents)}</div>
                        <dl>
                          <dt>Notifiche</dt><dd>{fmt(sendAnalog!.count)} ({pct(sendAnalog!.count, sendCount)}%)</dd>
                          <dt>Costo medio</dt><dd>{formatEuroCents(sendAnalog!.count ? Math.round(sendAnalog!.costCents / sendAnalog!.count) : 0)}</dd>
                          <dt>di cui spedizione</dt><dd>{formatEuroCents(sendAnalog!.analogCostCents)}</dd>
                          <dt>di cui notifica PN</dt><dd>{formatEuroCents(sendAnalog!.baseFeeCents)}</dd>
                        </dl>
                      </div>
                    </div>
                    {costs.send.byProduct.length > 0 && (
                      <>
                        <div className="stx-subhead">Spedizioni cartacee per prodotto</div>
                        <ProductBars rows={costs.send.byProduct} label={(k) => SEND_PRODUCT_LABEL[k] ?? k} formatEuroCents={formatEuroCents} color={CHART.orange} />
                      </>
                    )}
                    {sendDigital!.count > 0 && (
                      <p className="stx-note" style={{ marginTop: '0.9rem' }}>
                        <PiggyBank size={12} />
                        {costs.savings.sendNotEstimableCount === sendDigital!.count
                          ? <>Risparmio non stimabile: nessuna spedizione cartacea di riferimento nel periodo.</>
                          : <>{plural(sendDigital!.count, 'notifica recapitata in digitale ha', 'notifiche recapitate in digitale hanno')} evitato la spedizione cartacea: circa {formatEuroCents(costs.savings.sendCents)} risparmiati.</>}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Postalizzazione */}
            <div className="stx-card stx-span-6">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Printer size={16} />Postalizzazione · dove va la spesa</h3>
                {costs.postal.pendingCount > 0 && <span className="stx-card-hint">{fmt(costs.postal.pendingCount)} in attesa di costo</span>}
              </div>
              <div className="stx-card-body">
                {costs.postal.count === 0 ? <div className="stx-empty">Nessuna spedizione con costo nel periodo.</div> : (
                  <>
                    {compTotal > 0 && (
                      <StackBar parts={[
                        { label: 'Affrancatura', value: comp!.postaleCents, color: CHART.blue },
                        { label: 'Stampa e imbustamento', value: comp!.stampaCents, color: CHART.orange },
                        { label: 'Ricevuta di ritorno', value: comp!.arCents, color: CHART.aqua },
                      ]} format={formatEuroCents} />
                    )}
                    <div className="stx-split">
                      <div className="stx-split-cell">
                        <h4><Mail size={13} />Italia</h4>
                        <div className="stx-big">{formatEuroCents(costs.postal.domestic.costCents)}</div>
                        <dl>
                          <dt>Spedizioni</dt><dd>{fmt(costs.postal.domestic.count)}</dd>
                          <dt>Costo medio</dt><dd>{formatEuroCents(costs.postal.domestic.count ? Math.round(costs.postal.domestic.costCents / costs.postal.domestic.count) : 0)}</dd>
                        </dl>
                      </div>
                      <div className="stx-split-cell">
                        <h4><Globe size={13} />Estero</h4>
                        <div className="stx-big">{formatEuroCents(costs.postal.foreign.costCents)}</div>
                        <dl>
                          <dt>Spedizioni</dt><dd>{fmt(costs.postal.foreign.count)}</dd>
                          <dt>Costo medio</dt><dd>{formatEuroCents(costs.postal.foreign.count ? Math.round(costs.postal.foreign.costCents / costs.postal.foreign.count) : 0)}</dd>
                        </dl>
                      </div>
                    </div>
                    <div className="stx-subhead">Per tipologia di invio</div>
                    <ProductBars rows={costs.postal.byProduct} label={humanizeProduct} formatEuroCents={formatEuroCents} color={CHART.magenta} />
                    {costs.savings.postalDivertedCount > 0 && (
                      <p className="stx-note" style={{ marginTop: '0.9rem' }}>
                        <PiggyBank size={12} />
                        {plural(costs.savings.postalDivertedCount, 'lettera non stampata', 'lettere non stampate')} grazie al domicilio digitale (INAD): circa {formatEuroCents(costs.savings.postalCents)} risparmiati
                        {costs.savings.postalNotEstimableCount > 0 && <> ({fmt(costs.savings.postalNotEstimableCount)} non stimabili)</>}.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Trend costi */}
            <div className="stx-card stx-span-7">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Euro size={16} />Spesa per mese</h3>
                <span className="stx-card-hint">€ netto IVA</span>
              </div>
              <div className="stx-card-body">
                {costMonthly.length === 0 ? <div className="stx-empty">Nessun costo nel periodo.</div> : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={costMonthly} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="#edf1f6" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                      <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v: number) => `${fmt(v)} €`} />
                      <Tooltip content={<ChartTooltip format={(v) => formatEuroCents(Math.round(v * 100))} showTotal />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                      <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sendDigital" name="SEND digitale" stackId="c" fill={CHART.blue} maxBarSize={40} isAnimationActive={false} stroke="#fff" strokeWidth={1} />
                      <Bar dataKey="sendAnalog" name="SEND cartaceo" stackId="c" fill={CHART.orange} maxBarSize={40} isAnimationActive={false} stroke="#fff" strokeWidth={1} />
                      <Bar dataKey="postal" name="Postalizzazione" stackId="c" fill={CHART.magenta} maxBarSize={40} radius={[4, 4, 0, 0]} isAnimationActive={false} stroke="#fff" strokeWidth={1} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Campagne più costose */}
            <div className="stx-card stx-span-5">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Wallet size={16} />Campagne più costose</h3>
              </div>
              {costs.topCampaigns.length === 0 ? <div className="stx-card-body"><div className="stx-empty">Nessun costo nel periodo.</div></div> : (
                <table className="stx-table">
                  <thead><tr><th>Campagna</th><th className="num">Invii</th><th className="num">Media</th><th className="num">Totale</th></tr></thead>
                  <tbody>
                    {costs.topCampaigns.map((c) => (
                      <tr key={c.campaignId} className="is-link" onClick={() => onOpenCampaign(c.campaignId)} title="Apri dettaglio campagna">
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                            <span className="stx-dot" style={{ background: channelColor(c.channelType) }} title={getChannelMeta(c.channelType).label} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.campaignName}</span>
                          </div>
                        </td>
                        <td className="num">{fmt(c.costedCount)}</td>
                        <td className="num">{formatEuroCents(c.avgCostCents)}</td>
                        <td className="num"><strong>{formatEuroCents(c.costCents)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Download ── */}
      {stats && (
        <>
          <h2 className="stx-section-title"><Download size={18} />Download degli allegati<small>percentuali sui destinatari raggiunti con successo</small></h2>
          <div className="stx-grid">
            <div className="stx-card stx-span-8">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Trophy size={16} />Tasso di download per campagna<span className="stx-card-hint" style={{ fontWeight: 400 }}>· solo campagne con almeno 2 destinatari</span></h3>
                <div className="stx-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={leaderboardTab === 'best'} className={leaderboardTab === 'best' ? 'is-active' : ''} onClick={() => setLeaderboardTab('best')}>Migliori</button>
                  <button type="button" role="tab" aria-selected={leaderboardTab === 'worst'} className={leaderboardTab === 'worst' ? 'is-active' : ''} onClick={() => setLeaderboardTab('worst')}>Peggiori</button>
                </div>
              </div>
              {leaderboard.length === 0 ? <div className="stx-card-body"><div className="stx-empty">Nessuna campagna massiva nel periodo.</div></div> : (
                <table className="stx-table">
                  <thead><tr><th>Campagna</th><th className="num">Inviati</th><th className="num">Scaricati</th></tr></thead>
                  <tbody>
                    {leaderboardRows.map((c) => (
                      <tr key={c.campaignId} className="is-link" onClick={() => onOpenCampaign(c.campaignId)} title="Apri dettaglio campagna">
                        <td style={{ maxWidth: 0, width: '60%' }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.campaignName}</div>
                        </td>
                        <td className="num">{fmt(c.sentCount)}</td>
                        <td className="num">
                          <span className="stx-mini-track"><span style={{ width: `${c.downloadPercentage}%`, background: CHART.aqua }} /></span>
                          <strong className="stx-pct">{c.downloadPercentage}%</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="stx-card stx-span-4">
              <div className="stx-card-head">
                <h3 className="stx-card-title"><Download size={16} />Da dove scaricano</h3>
                <span className="stx-card-hint">destinatari distinti</span>
              </div>
              <div className="stx-card-body">
                {downloadRows.length === 0 ? <div className="stx-empty">Nessun download nel periodo.</div> : (
                  <div className="stx-bars">
                    {downloadRows.map((c) => (
                      <BarRow key={c.channel} color={channelColor(c.channel)} label={getChannelMeta(c.channel).label}
                        value={fmt(c.count)} share={pct(c.count, downloadTotal)} widthPct={(c.count / maxDownload) * 100} />
                    ))}
                    <p className="stx-note" style={{ marginTop: '0.25rem' }}>
                      <Info size={12} />Chi scarica da più canali è contato in ciascuno.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Sotto-componenti ───

function StackBar({ parts, format }: { parts: Array<{ label: string; value: number; color: string }>; format: (v: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="stx-stack" role="img" aria-label={parts.map((p) => `${p.label} ${format(p.value)}`).join(', ')}>
        {visible.map((p) => (
          <div key={p.label} style={{ flex: p.value, background: p.color }} title={`${p.label}: ${format(p.value)} (${pct(p.value, total)}%)`} />
        ))}
      </div>
      <div className="stx-legend">
        {parts.map((p) => (
          <span key={p.label}><span className="stx-dot" style={{ background: p.color }} />{p.label} <strong>{format(p.value)}</strong> ({pct(p.value, total)}%)</span>
        ))}
      </div>
    </div>
  );
}

function ProductBars({ rows, label, color, formatEuroCents }: {
  rows: CostByKey[]; label: (k: string) => string; color: string; formatEuroCents: (c: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.costCents));
  const total = rows.reduce((s, r) => s + r.costCents, 0);
  return (
    <div className="stx-bars">
      {rows.slice(0, 6).map((r) => (
        <BarRow key={r.key} color={color} label={`${label(r.key)} · ${fmt(r.count)}`}
          value={formatEuroCents(r.costCents)} share={pct(r.costCents, total)} widthPct={(r.costCents / max) * 100} />
      ))}
    </div>
  );
}
