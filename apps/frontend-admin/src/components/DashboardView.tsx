import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import {
  Plus, Search, BarChart3, Users, Send, XCircle, Download, Euro, AlertTriangle, ChevronRight,
  Network, History, RefreshCw, Loader2, CalendarDays, PieChart as PieChartIcon,
} from 'lucide-react';
import { getChannelMeta, ENGINE_LABELS } from '../data/channels';
import { CHART, channelColor, channelRank, fmt, pct, plural, iso, formatDay, Kpi, BarRow, ChartTooltip, Sparkline } from './stats-ui';
import '../assets/css/statistics.css';

interface EngineInfo {
  channel: string;
  paused?: boolean;
  counts?: { waiting?: number; active?: number; delayed?: number; failed?: number; completed?: number };
  lastFailedAt?: string | null;
}

interface CampaignLite {
  id: string;
  name: string;
  isTest?: boolean;
  createdAt: string;
  totalRecipients: number;
  failedCount: number;
}

interface RecentCampaign {
  id: string;
  name: string;
  channelType: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  lastActivityAt: string;
}

interface DashStats {
  totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number };
  dailyTrend: Array<{ date: string; sent: number; failed: number }>;
  channelTotals: Array<{ channel: string; sent: number }>;
}

interface DashCosts {
  totalCostCents: number;
  savings: { sendCents: number; postalCents: number };
  send: { pendingCount: number };
  postal: { pendingCount: number };
}

interface Props {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  formatEuroCents: (cents: number) => string;
  userName: string;
  entityName: string;
  onlineCount: number | null;
  onlineUserNames: string[];
  engines: EngineInfo[];
  sendStageCounts: { protocollato: number; inviato: number; fallito: number } | null;
  campaigns: CampaignLite[];
  recent: RecentCampaign[];
  recentLoading: boolean;
  recentError: string | null;
  onRefreshRecent: () => void;
  onNewCampaign: () => void;
  onSearch: () => void;
  onOpenStatistics: () => void;
  onOpenCampaign: (id: string) => void;
  onOpenEngines: () => void;
  onSeeAllCampaigns: () => void;
}

const DAYS = 30;
const POLL_MS = 30_000;

const CAMPAIGN_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Bozza', tone: 'is-idle' },
  checking_inad: { label: 'Verifica domicili', tone: 'is-run' },
  queued: { label: 'In coda', tone: 'is-run' },
  running: { label: 'In invio', tone: 'is-run' },
  completed: { label: 'Completata', tone: 'is-ok' },
  failed: { label: 'Fallita', tone: 'is-bad' },
  cancelled: { label: 'Annullata', tone: 'is-idle' },
};

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 13) return 'Buongiorno';
  if (h < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

function relativeTime(isoDate: string, now: Date): string {
  const diffMs = now.getTime() - new Date(isoDate).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? 'ora' : 'ore'} fa`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} ${d === 1 ? 'giorno' : 'giorni'} fa`;
  return new Date(isoDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export function DashboardView(props: Props) {
  const { apiFetch, formatEuroCents } = props;
  const [stats, setStats] = useState<DashStats | null>(null);
  const [costs, setCosts] = useState<DashCosts | null>(null);
  const [loading, setLoading] = useState(false);
  // "Adesso" come stato, aggiornato a ogni poll: saluto, "x min fa" e finestre
  // temporali restano freschi senza leggere l'orologio durante il render.
  const [now, setNow] = useState(() => new Date());

  // Finestra fissa ultimi 30 giorni, indipendente dal periodo scelto in Statistiche.
  const query = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - (DAYS - 1));
    return new URLSearchParams({ dateFrom: iso(from), dateTo: iso(new Date()) }).toString();
  }, []);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const [g, c] = await Promise.all([
        apiFetch(`/campaigns/stats/global?${query}`),
        apiFetch(`/campaigns/stats/costs?${query}`),
      ]);
      if (g.ok) setStats(await g.json());
      if (c.ok) setCosts(await c.json());
      setNow(new Date());
    } catch {
      // Sessione scaduta/rete: apiFetch gestisce già il logout.
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiFetch, query]);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
    // apiFetch cambia identità a ogni render di App: basta il montaggio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Asse continuo di 30 giorni: il backend restituisce solo i giorni con invii,
  // senza riempimento il grafico comprimeva i buchi e falsava l'andamento.
  const daily = useMemo(() => {
    const byDate = new Map((stats?.dailyTrend ?? []).map((d) => [d.date, d]));
    const out: Array<{ date: string; label: string; sent: number; failed: number }> = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = iso(d);
      const row = byDate.get(key);
      out.push({ date: key, label: formatDay(key), sent: row?.sent ?? 0, failed: row?.failed ?? 0 });
    }
    return out;
  }, [stats, now]);

  const alerts = useMemo(() => {
    const since = now.getTime() - 30 * 86_400_000;
    const weekAgo = now.getTime() - 7 * 86_400_000;
    const failing = props.campaigns
      .filter((c) => !c.isTest && new Date(c.createdAt).getTime() >= since && c.totalRecipients >= 5)
      // failedCount è un contatore per tentativo: può superare i destinatari, limitato al 100%.
      .map((c) => ({ c, rate: Math.min(1, c.failedCount / c.totalRecipients) }))
      .filter((x) => x.rate > 0.1)
      .sort((a, b) => b.rate - a.rate);
    const paused = props.engines.filter((e) => e.paused);
    const failingEngines = props.engines.filter(
      (e) => (e.counts?.failed ?? 0) > 0 && e.lastFailedAt && new Date(e.lastFailedAt).getTime() >= weekAgo,
    );
    return { failing, paused, failingEngines, total: failing.length + paused.length + failingEngines.length };
  }, [props.campaigns, props.engines, now]);

  const engines = useMemo(() => {
    const list = [...props.engines];
    // SEND non è un motore BullMQ: stato ricavato dai conteggi protocollazione/invio.
    if (!list.some((e) => (e.channel || '').toUpperCase() === 'SEND')) {
      list.push({
        channel: 'SEND',
        paused: false,
        counts: { waiting: props.sendStageCounts?.protocollato ?? 0, active: 0, delayed: 0, failed: props.sendStageCounts?.fallito ?? 0 },
      });
    }
    return list;
  }, [props.engines, props.sendStageCounts]);

  const t = stats?.totals;
  const closed = (t?.totalSent ?? 0) + (t?.totalFailed ?? 0);
  const successRate = closed > 0 ? Math.round(((t?.totalSent ?? 0) / closed) * 1000) / 10 : null;
  const channelRows = (stats?.channelTotals ?? [])
    .filter((c) => c.sent > 0)
    .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || a.channel.localeCompare(b.channel));
  const channelTotal = channelRows.reduce((s, c) => s + c.sent, 0);
  const channelMax = Math.max(1, ...channelRows.map((c) => c.sent));
  const pendingCosts = (costs?.send.pendingCount ?? 0) + (costs?.postal.pendingCount ?? 0);
  const saving = (costs?.savings.sendCents ?? 0) + (costs?.savings.postalCents ?? 0);
  const activeEngines = engines.filter((e) => !e.paused).length;

  return (
    <div className="stx">
      {/* ── Benvenuto ── */}
      <div className="stx-hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1>{greeting(now)}, {props.userName}</h1>
          <div className="stx-hero-meta">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <CalendarDays size={14} />
              {now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            <span>Hub comunicazioni · <strong>{props.entityName}</strong></span>
            {props.onlineCount !== null && (
              <span className="stx-online" title={props.onlineUserNames.length ? props.onlineUserNames.join(', ') : undefined}>
                {plural(props.onlineCount, 'operatore online', 'operatori online')}
              </span>
            )}
          </div>
        </div>
        <div className="stx-hero-actions">
          <button type="button" className="stx-hero-btn is-primary" onClick={props.onNewCampaign}><Plus size={16} />Nuova campagna</button>
          <button type="button" className="stx-hero-btn" onClick={props.onSearch}><Search size={16} />Cerca notifiche</button>
          <button type="button" className="stx-hero-btn" onClick={props.onOpenStatistics}><BarChart3 size={16} />Statistiche</button>
        </div>
      </div>

      {/* ── Da attenzionare ── */}
      {alerts.total > 0 && (
        <div className="stx-card stx-alerts">
          <div className="stx-card-head">
            <h3 className="stx-card-title"><AlertTriangle size={16} style={{ color: '#c98500' }} />Da attenzionare</h3>
            <span className="stx-status is-warn">{plural(alerts.total, 'avviso', 'avvisi')}</span>
          </div>
          {alerts.failing.map(({ c, rate }) => (
            <div key={c.id} className="stx-alert-row" onClick={() => props.onOpenCampaign(c.id)} role="button">
              <span className="stx-alert-main">
                <span className="stx-alert-kind">Campagna</span>
                <strong>{c.name}</strong>
                <span className="stx-status is-bad">{Math.round(rate * 100)}% falliti</span>
              </span>
              <span className="stx-alert-cta">Vedi<ChevronRight size={14} /></span>
            </div>
          ))}
          {alerts.paused.map((e) => (
            <div key={`p-${e.channel}`} className="stx-alert-row" onClick={props.onOpenEngines} role="button">
              <span className="stx-alert-main">
                <span className="stx-alert-kind">Motore</span>
                <strong>{ENGINE_LABELS[e.channel] ?? e.channel}</strong>
                <span className="stx-status is-warn">In pausa</span>
              </span>
              <span className="stx-alert-cta">Riattiva<ChevronRight size={14} /></span>
            </div>
          ))}
          {alerts.failingEngines.map((e) => (
            <div key={`f-${e.channel}`} className="stx-alert-row" onClick={props.onOpenEngines} role="button">
              <span className="stx-alert-main">
                <span className="stx-alert-kind">Motore</span>
                <strong>{ENGINE_LABELS[e.channel] ?? e.channel}</strong>
                <span className="stx-status is-bad">{plural(e.counts?.failed ?? 0, 'job fallito', 'job falliti')}</span>
              </span>
              <span className="stx-alert-cta">Risolvi<ChevronRight size={14} /></span>
            </div>
          ))}
        </div>
      )}

      {/* ── KPI ultimi 30 giorni ── */}
      <div className="stx-kpis">
        <Kpi icon={<Users size={14} />} label="Destinatari · 30 gg" accent
          value={t ? fmt(t.totalRecipients) : '…'} sub="campagne create negli ultimi 30 giorni" />
        <Kpi icon={<Send size={14} />} label="Inviati" value={t ? fmt(t.totalSent) : '…'} valueColor="var(--stx-good)"
          sub={successRate !== null ? <><strong>{successRate.toLocaleString('it-IT')}%</strong> di successo sugli esiti</> : 'nessun esito ancora'}>
          <Sparkline values={daily.map((d) => d.sent)} color={CHART.blue} />
        </Kpi>
        <Kpi icon={<XCircle size={14} />} label="Falliti" value={t ? fmt(t.totalFailed) : '…'}
          valueColor={t && t.totalFailed > 0 ? 'var(--stx-bad)' : undefined}
          sub={t ? <><strong>{pct(t.totalFailed, t.totalRecipients)}%</strong> dei destinatari</> : undefined}>
          <Sparkline values={daily.map((d) => d.failed)} color={CHART.critical} />
        </Kpi>
        <Kpi icon={<Download size={14} />} label="Scaricati" value={t ? `${t.downloadPercentage}%` : '…'}
          sub={t ? <><strong>{fmt(t.totalDownloaded)}</strong> su {fmt(t.totalSent)} inviati</> : undefined} />
        <Kpi icon={<Euro size={14} />} label="Spesa · 30 gg" value={costs ? formatEuroCents(costs.totalCostCents) : '…'}
          title={pendingCosts > 0 ? `${fmt(pendingCosts)} invii attendono ancora il costo definitivo dal provider` : undefined}
          sub={costs ? <>risparmio stimato <strong style={{ color: 'var(--stx-good)' }}>{formatEuroCents(saving)}</strong>{pendingCosts > 0 && <> · {fmt(pendingCosts)} in attesa</>}</> : undefined} />
      </div>

      {/* ── Andamento + motori ── */}
      <div className="stx-grid">
        <div className="stx-card stx-span-8">
          <div className="stx-card-head">
            <h3 className="stx-card-title"><BarChart3 size={16} />Ultimi 30 giorni</h3>
            <span className="stx-card-hint">destinatari per giorno di creazione campagna</span>
          </div>
          {/* Il grafico occupa tutta l'altezza della riga (la card Motori può essere più alta). */}
          <div className="stx-card-body" style={{ display: 'flex', flexDirection: 'column' }}>
            {loading && !stats ? (
              <div className="stx-empty"><Loader2 className="stx-spin" size={18} /></div>
            ) : daily.every((d) => d.sent === 0 && d.failed === 0) ? (
              <div className="stx-empty">Nessun invio negli ultimi 30 giorni.</div>
            ) : (
              <div style={{ flex: 1, minHeight: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap={3}>
                  <CartesianGrid vertical={false} stroke="#edf1f6" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={4} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} tickFormatter={fmt} />
                  <Tooltip content={<ChartTooltip format={fmt} showTotal />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                  <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sent" name="Inviati" stackId="d" fill={CHART.blue} isAnimationActive={false} stroke="#fff" strokeWidth={1} />
                  <Bar dataKey="failed" name="Falliti" stackId="d" fill={CHART.critical} radius={[3, 3, 0, 0]} isAnimationActive={false} stroke="#fff" strokeWidth={1} />
                </BarChart>
              </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>

        <div className="stx-card stx-span-4">
          <div className="stx-card-head">
            <h3 className="stx-card-title"><Network size={16} />Motori di invio</h3>
            <button type="button" className="btn btn-link p-0" style={{ fontSize: '0.8rem' }} onClick={props.onOpenEngines}>
              {activeEngines}/{engines.length} attivi · Gestisci
            </button>
          </div>
          <div className="stx-card-body" style={{ paddingTop: '0.3rem', paddingBottom: '0.3rem' }}>
            {engines.length === 0 ? <div className="stx-empty">Caricamento…</div> : engines.map((e) => {
              const queued = (e.counts?.waiting ?? 0) + (e.counts?.delayed ?? 0);
              const active = e.counts?.active ?? 0;
              const failed = e.counts?.failed ?? 0;
              const status = e.paused
                ? { label: 'In pausa', tone: 'is-warn' }
                : active > 0 ? { label: 'In lavorazione', tone: 'is-run' }
                  : queued > 0 ? { label: 'In coda', tone: 'is-run' }
                    : { label: 'Operativo', tone: 'is-ok' };
              return (
                <div key={e.channel} className="stx-engine">
                  <div style={{ minWidth: 0 }}>
                    <div className="stx-engine-name">{ENGINE_LABELS[e.channel] ?? e.channel}</div>
                    <div className="stx-engine-sub">
                      {queued > 0 || active > 0 ? <>{fmt(queued)} in coda · {fmt(active)} in corso</> : 'nessun job in attesa'}
                      {failed > 0 && <> · <span className="is-bad">{fmt(failed)} falliti</span></>}
                    </div>
                  </div>
                  <span className={`stx-status ${status.tone}`}>{status.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Campagne recenti + canali ── */}
      <div className="stx-grid">
        <div className="stx-card stx-span-8">
          <div className="stx-card-head">
            <h3 className="stx-card-title"><History size={16} />Campagne recenti<span className="stx-card-hint" style={{ fontWeight: 400 }}>· attività negli ultimi 7 giorni</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button type="button" className="stx-icon-btn" onClick={props.onRefreshRecent} title="Aggiorna" aria-label="Aggiorna campagne recenti">
                {props.recentLoading ? <Loader2 className="stx-spin" size={14} /> : <RefreshCw size={14} />}
              </button>
              <button type="button" className="btn btn-link p-0" style={{ fontSize: '0.8rem' }} onClick={props.onSeeAllCampaigns}>Vedi tutte</button>
            </div>
          </div>
          {props.recentError ? (
            <div className="stx-card-body"><div className="stx-empty" style={{ color: 'var(--stx-bad)' }}>{props.recentError}</div></div>
          ) : props.recent.length === 0 ? (
            <div className="stx-card-body"><div className="stx-empty">{props.recentLoading ? 'Caricamento…' : 'Nessuna campagna attiva o aggiornata negli ultimi 7 giorni.'}</div></div>
          ) : (
            <table className="stx-table">
              <thead><tr><th>Campagna</th><th>Stato</th><th>Avanzamento</th><th className="num">Aggiornata</th></tr></thead>
              <tbody>
                {props.recent.map((c) => {
                  const st = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'is-idle' };
                  const total = Math.max(c.totalRecipients, 1);
                  // Contatori per tentativo: limitati al totale per non sforare la barra.
                  const sent = Math.min(c.sentCount, c.totalRecipients);
                  const failed = Math.min(c.failedCount, Math.max(c.totalRecipients - sent, 0));
                  return (
                    <tr key={c.id} className="is-link" onClick={() => props.onOpenCampaign(c.id)} title="Apri dettaglio campagna">
                      <td style={{ maxWidth: 0, width: '44%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0 }}>
                          <span className="stx-dot" style={{ background: channelColor(c.channelType) }} title={getChannelMeta(c.channelType).label} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.name}</span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--stx-ink-3)', marginLeft: '1.1rem' }}>{getChannelMeta(c.channelType).label}</div>
                      </td>
                      <td><span className={`stx-status ${st.tone}`}>{st.label}</span></td>
                      <td>
                        <div className="stx-progress" title={`${fmt(sent)} inviati · ${fmt(failed)} falliti · ${fmt(c.totalRecipients)} destinatari`}>
                          <div className="stx-progress-track">
                            <span style={{ width: `${(sent / total) * 100}%`, background: CHART.blue }} />
                            <span style={{ width: `${(failed / total) * 100}%`, background: CHART.critical }} />
                          </div>
                          <small>{fmt(sent)}/{fmt(c.totalRecipients)}</small>
                        </div>
                      </td>
                      <td className="num" style={{ color: 'var(--stx-ink-3)', fontSize: '0.78rem' }} title={new Date(c.lastActivityAt).toLocaleString('it-IT')}>
                        {relativeTime(c.lastActivityAt, now)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="stx-card stx-span-4">
          <div className="stx-card-head">
            <h3 className="stx-card-title"><PieChartIcon size={16} />Canali · 30 gg</h3>
            <span className="stx-card-hint">inviati</span>
          </div>
          <div className="stx-card-body">
            {channelRows.length === 0 ? <div className="stx-empty">Nessun invio negli ultimi 30 giorni.</div> : (
              <div className="stx-bars">
                {channelRows.map((c) => (
                  <BarRow key={c.channel} color={channelColor(c.channel)} label={getChannelMeta(c.channel).label}
                    value={fmt(c.sent)} share={pct(c.sent, channelTotal)} widthPct={(c.sent / channelMax) * 100} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
