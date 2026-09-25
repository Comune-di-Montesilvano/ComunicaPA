import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { buildJourney, computeVerdict, sourceLabel, type JourneyDetail, type JourneyLabels, type JourneySource } from './journey';
import '../../assets/css/notification-detail.css';

function formatWhen(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
  };
}

/** Esito effettivo della notifica, con fonte e data: la prima cosa che si legge. */
export function NotificationVerdict({ detail, labels }: { detail: JourneyDetail; labels: JourneyLabels }): React.JSX.Element {
  const v = computeVerdict(detail, labels);
  const when = v.when ? new Date(v.when).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <section className={`nd-verdict nd-tone-${v.tone}`} aria-label="Esito della notifica">
      <p className="nd-verdict-headline">{v.headline}</p>
      {(when || v.source) && (
        <p className="nd-verdict-meta">
          {when && <>il {when}</>}
          {when && v.source && ' '}
          {v.source}
        </p>
      )}
      {v.note && (
        <p className={`nd-verdict-note${v.discrepancy ? ' nd-verdict-note-alert' : ''}`}>
          {v.discrepancy && <AlertTriangle size={14} aria-hidden="true" />}
          {v.discrepancy ? `Esiti diversi — ${v.note}` : v.note}
        </p>
      )}
    </section>
  );
}

const LEGEND_ORDER: JourneySource[] = ['invio', 'protocollo', 'globalcom', 'poste', 'send', 'appio', 'cittadino'];

/** Linea del tempo unica di tutte le fonti, dalla più vecchia alla più recente. */
export function NotificationTimeline({ detail, labels }: { detail: JourneyDetail; labels: JourneyLabels }): React.JSX.Element {
  const events = buildJourney(detail, labels);
  if (events.length === 0) return <p className="nd-empty">Nessun evento registrato per questa notifica.</p>;
  const present = LEGEND_ORDER.filter((s) => events.some((e) => e.source === s));
  return (
    <div className="nd-journey">
      <ol className="nd-timeline">
        {events.map((e, i) => {
          const { day, time } = formatWhen(e.at);
          const prevDay = i > 0 ? formatWhen(events[i - 1]!.at).day : null;
          return (
            <li key={`${e.at}-${i}`} className={`nd-event nd-src-${e.source} nd-tone-${e.tone}`}>
              <div className="nd-when">
                {day !== prevDay && <span className="nd-day">{day}</span>}
                <span className="nd-time">{time}</span>
              </div>
              <span className="nd-marker" aria-hidden="true" />
              <div className="nd-what">
                <span className="nd-title">{e.title}</span>
                {e.source !== 'invio' && <span className="nd-source">{sourceLabel(e.source)}</span>}
                {e.detail && <span className="nd-detail">{e.detail}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      {present.length > 1 && (
        <ul className="nd-legend" aria-label="Legenda fonti">
          {present.map((s) => (
            <li key={s} className={`nd-src-${s}`}><span className="nd-marker" aria-hidden="true" />{sourceLabel(s)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
