import React from 'react';

// Mattoncini condivisi tra Statistiche e Dashboard (CSS .stx-* in statistics.css).

// ─── Palette grafici: fissa per entità, mai per posizione (validata dataviz) ───
// I colori del registro canali (loghi/badge) sono troppo vicini tra loro per
// un grafico (PEC e App IO sono due blu quasi identici): qui serve una
// palette categorica distinguibile anche con daltonismo.
export const CHART = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  green: '#008300',
  grey: '#94a3b8',
  /** Stato "critico" riservato ai fallimenti, mai usato come colore di serie. */
  critical: '#c0352b',
};
const CHANNEL_ORDER = ['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL', 'CITIZEN_PORTAL'];
const CHANNEL_COLOR: Record<string, string> = {
  EMAIL: CHART.blue,
  PEC: CHART.orange,
  APP_IO: CHART.aqua,
  SEND: CHART.yellow,
  POSTAL: CHART.magenta,
  CITIZEN_PORTAL: CHART.green,
};
export const channelColor = (c: string) => CHANNEL_COLOR[(c || '').toUpperCase()] ?? CHART.grey;
export const channelRank = (c: string) => {
  const i = CHANNEL_ORDER.indexOf((c || '').toUpperCase());
  return i === -1 ? CHANNEL_ORDER.length : i;
};

// ─── Formattazione ───
const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
/** "2026-09" → "set 26" */
export const formatMonth = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS_IT[Number(m) - 1] ?? m} ${y?.slice(2)}`;
};
/** "2026-09-24" → "24 set" */
export const formatDay = (ymd: string) => {
  const [, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS_IT[Number(m) - 1] ?? m}`;
};
const nf = new Intl.NumberFormat('it-IT', { useGrouping: true });
export const fmt = (n: number) => nf.format(n);
export const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);
export const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
export const iso = (d: Date) => d.toISOString().slice(0, 10);

// ─── Componenti ───

export function Kpi({ icon, label, value, sub, valueColor, accent, title, children }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; valueColor?: string; accent?: boolean; title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`stx-kpi ${accent ? 'is-accent' : ''}`} title={title}>
      <span className="stx-kpi-label">{icon}{label}</span>
      <span className="stx-kpi-value" style={valueColor ? { color: valueColor } : undefined}>{value}</span>
      {sub && <span className="stx-kpi-sub">{sub}</span>}
      {children}
    </div>
  );
}

export function BarRow({ color, label, value, share, widthPct }: { color: string; label: string; value: string; share: number; widthPct: number }) {
  return (
    <div className="stx-bar-row" title={`${label}: ${value} (${share}%)`}>
      <span className="stx-bar-label"><span className="stx-dot" style={{ background: color }} /><span className="stx-truncate">{label}</span></span>
      <span className="stx-bar-value">{value}<small>{share}%</small></span>
      <div className="stx-bar-track"><div className="stx-bar-fill" style={{ width: `${Math.max(widthPct, 1.5)}%`, background: color }} /></div>
    </div>
  );
}

export function ChartTooltip({ active, payload, label, format, showTotal }: {
  active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string; format: (v: number) => string; showTotal?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div className="stx-tooltip">
      <div className="stx-tooltip-title">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="stx-tooltip-row">
          <span><span className="stx-dot" style={{ background: p.color }} />{p.name}</span>
          <strong>{format(Number(p.value) || 0)}</strong>
        </div>
      ))}
      {showTotal && payload.length > 1 && (
        <div className="stx-tooltip-row" style={{ borderTop: '1px solid var(--stx-border)', marginTop: '0.3rem', paddingTop: '0.3rem' }}>
          <span>Totale</span><strong>{format(total)}</strong>
        </div>
      )}
    </div>
  );
}

/** Mini-andamento SVG per i KPI (nessun asse: il valore esatto sta nel KPI). */
export function Sparkline({ values, color, height = 28 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) return null;
  const w = 100;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${w},${height} L0,${height} Z`;
  return (
    <svg className="stx-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
