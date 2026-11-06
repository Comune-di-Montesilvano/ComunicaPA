import React from 'react';
import type { SendPerfection } from './journey';

/** YYYY-MM-DD -> gg/mm (o gg/mm/aaaa). Niente `new Date`: il parse UTC sposta il giorno in alcuni fusi. */
function fmt(ymd: string | null, withYear = false): string {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  if (!y || !m || !d) return '—';
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

function dayNum(ymd: string | null): number | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * Posizione di "oggi" lungo la linea, in frazione 0..1 (da centro della prima
 * tappa a centro dell'ultima), interpolando fra le tappe con data. null se
 * nessuna tappa ha una data usabile.
 */
function todayFraction(data: SendPerfection): number | null {
  const n = data.steps.length;
  const today = dayNum(data.today);
  if (n < 2 || today === null) return null;
  const dated = data.steps
    .map((s, i) => ({ i, t: dayNum(s.date) }))
    .filter((x): x is { i: number; t: number } => x.t !== null);
  if (dated.length === 0) return null;
  const first = dated[0]!;
  const last = dated[dated.length - 1]!;
  let idx: number;
  if (today <= first.t) idx = 0;
  else if (today >= last.t) idx = last.i;
  else {
    idx = last.i;
    for (let k = 0; k < dated.length - 1; k++) {
      const a = dated[k]!;
      const b = dated[k + 1]!;
      if (today >= a.t && today <= b.t) {
        idx = b.t === a.t ? a.i : a.i + ((today - a.t) / (b.t - a.t)) * (b.i - a.i);
        break;
      }
    }
  }
  return idx / (n - 1);
}

function noteOf(data: SendPerfection): string {
  const d = fmt(data.finalDate, true);
  switch (data.finalSource) {
    case 'pn':
      return `Notificata per il destinatario il ${d} secondo SEND.`;
    case 'pn_scheduled':
      return `Prevista da SEND per il ${d}, prima se il destinatario apre la notifica.`;
    case 'estimate':
      return 'Data stimata (art. 26, comma 9, D.L. 76/2020): si conferma con l\'esito di SEND; prima se il destinatario apre la notifica.';
    default:
      return 'La data dipende dall\'esito del recapito: la indicherà SEND.';
  }
}

/** Timeline orizzontale delle tappe fino alla notifica per il destinatario. */
export function SendPerfectionTimeline({ data }: { data: SendPerfection }): React.JSX.Element {
  const n = data.steps.length;
  const frac = todayFraction(data);
  const pct = frac === null ? null : `${(frac * 100).toFixed(2)}%`;
  return (
    <div className="nd-perf">
      <ol className="nd-perf-steps" style={{ '--nd-perf-n': n } as React.CSSProperties}>
        {pct !== null && (
          <li className="nd-perf-track" aria-hidden="true">
            <span className="nd-perf-fill" style={{ width: pct }} />
            <span className="nd-perf-today" style={{ left: pct }}>oggi {fmt(data.today)}</span>
          </li>
        )}
        {data.steps.map((s) => {
          const isFinal = s.key === 'recipient';
          return (
            <li key={s.key} className={`nd-perf-step${isFinal ? ' nd-perf-goal' : ''}`}>
              <span className="nd-perf-date">{fmt(s.date)}</span>
              <span className={`nd-perf-dot ${s.state}`} aria-hidden="true" />
              <span className="nd-perf-label">
                {isFinal ? <strong>{s.label}</strong> : s.label}
                {s.state === 'expected' && s.date && ' (prevista)'}
                {s.offsetDays ? ` (+${s.offsetDays} gg)` : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="nd-perf-note">{noteOf(data)}</p>
    </div>
  );
}
