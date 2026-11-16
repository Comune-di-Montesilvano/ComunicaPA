import React from 'react';

// Mattoncini condivisi tra Statistiche e Dashboard (CSS .stx-* in statistics.css).

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
