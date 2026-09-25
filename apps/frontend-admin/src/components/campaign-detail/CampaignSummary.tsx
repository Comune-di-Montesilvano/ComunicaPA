import React from 'react';
import '../../assets/css/campaign-detail.css';

export type OutcomeTone = 'ok' | 'ko' | 'warn' | 'progress' | 'alt' | 'muted';

export interface OutcomeSegment {
  key: string;
  label: string;
  count: number;
  tone: OutcomeTone;
  /** Colore specifico (dai registri stato esistenti); altrimenti dal tono. */
  color?: string;
  /** Segmento attualmente usato come filtro della tabella destinatari. */
  active?: boolean;
  onSelect?: () => void;
}

export interface KeyFigure {
  label: string;
  value: string;
  hint?: string | null;
}

interface Props {
  title: React.ReactNode;
  meta: React.ReactNode;
  total: number;
  totalLabel: string;
  segments: OutcomeSegment[];
  note?: React.ReactNode;
  figures: KeyFigure[];
}

function pct(n: number, total: number): string {
  if (total <= 0) return '0%';
  const p = (n / total) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/**
 * Testata del dettaglio campagna: chi/cosa/quando, poi l'esito in una sola
 * barra. Ogni segmento è un filtro della tabella destinatari (click =
 * applica, di nuovo = toglie), così il riepilogo porta dritto ai casi.
 */
export function CampaignSummary({ title, meta, total, totalLabel, segments, note, figures }: Props): React.JSX.Element {
  const visible = segments.filter((s) => s.count > 0);
  return (
    <section className="cd-summary" aria-label="Riepilogo campagna">
      <header className="cd-head">
        <h2 className="cd-title">{title}</h2>
        <div className="cd-meta">{meta}</div>
      </header>

      <div className="cd-outcome">
        <p className="cd-total">
          <span className="cd-total-n">{total.toLocaleString('it-IT')}</span> {totalLabel}
        </p>
        {visible.length > 0 && (
          <>
            <div className="cd-bar" role="group" aria-label="Esito per stato, clic per filtrare i destinatari">
              {visible.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`cd-seg cd-tone-${s.tone}${s.active ? ' is-active' : ''}`}
                  style={{ flexGrow: s.count, ...(s.color ? { ['--cd-seg' as string]: s.color } : {}) }}
                  aria-pressed={!!s.active}
                  title={`${s.label}: ${s.count.toLocaleString('it-IT')} (${pct(s.count, total)}) — clic per filtrare`}
                  onClick={s.onSelect}
                  disabled={!s.onSelect}
                />
              ))}
            </div>
            <ul className="cd-legend">
              {visible.map((s) => (
                <li key={s.key}>
                  <button
                    type="button"
                    className={`cd-legend-item cd-tone-${s.tone}${s.active ? ' is-active' : ''}`}
                    style={s.color ? { ['--cd-seg' as string]: s.color } : undefined}
                    aria-pressed={!!s.active}
                    onClick={s.onSelect}
                    disabled={!s.onSelect}
                  >
                    <span className="cd-swatch" aria-hidden="true" />
                    <span className="cd-legend-label">{s.label}</span>
                    <span className="cd-legend-n">{s.count.toLocaleString('it-IT')}</span>
                    <span className="cd-legend-pct">{pct(s.count, total)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {note && <div className="cd-note">{note}</div>}
      </div>

      {figures.length > 0 && (
        <dl className="cd-figures">
          {figures.map((f) => (
            <div key={f.label} className="cd-figure">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
              {f.hint && <dd className="cd-figure-hint">{f.hint}</dd>}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
