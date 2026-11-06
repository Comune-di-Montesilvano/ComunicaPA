import React from 'react';
import { GUIDA_DATE_TERMINI, GUIDA_IRREPERIBILE } from '../../guida';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { SendPerfectionTimeline } from './SendPerfectionTimeline';
import { getChannelMeta } from '../../data/channels';
import { buildJourney, computeVerdict, latestAttempt, sourceLabel, type JourneyDetail, type JourneyLabels, type JourneySource } from './journey';
import '../../assets/css/notification-detail.css';

function formatWhen(iso: string, dateOnly = false): { day: string; time: string } {
  const d = new Date(iso);
  // Data senza ora (esito GlobalCom): giorno in fuso italiano, nessun falso "00:00".
  if (dateOnly) return { day: d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }), time: '' };
  return {
    day: d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
  };
}

/** Esito effettivo della notifica, con fonte e data: la prima cosa che si legge. */
function GuidaButton({ onOpen, children }: { onOpen: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" className="btn btn-link btn-sm p-0 ms-1 align-baseline nd-verdict-guida" onClick={onOpen}>
      {children}
    </button>
  );
}

/**
 * onOpenGuida: apre la guida all'ancora data (chiude il dettaglio). Link solo
 * dove l'operatore deve decidere qualcosa: come contare i termini dalle date
 * legali, cosa fare se la notifica non è stata consegnata.
 */
export function NotificationVerdict({ detail, labels, onOpenGuida }: { detail: JourneyDetail; labels: JourneyLabels; onOpenGuida?: (anchor: string) => void }): React.JSX.Element {
  const v = computeVerdict(detail, labels);
  const when = v.when
    ? v.dateOnly
      ? new Date(v.when).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' })
      : new Date(v.when).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const perfection = latestAttempt(detail)?.sendPerfection ?? null;
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
      {perfection && <SendPerfectionTimeline data={perfection} onOpenGuida={onOpenGuida} />}
      {v.entityLegalAt && !perfection && (
        <p className="nd-verdict-legal">
          <strong>Notificata per l'ente il {new Date(v.entityLegalAt).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' })}</strong>
          {' '}· messa a disposizione su SEND: impedisce le decadenze e interrompe la prescrizione (art. 26, c. 9 lett. a e c. 10, D.L. 76/2020). I termini del destinatario decorrono dalla data in cui è notificata per lui
          {onOpenGuida && <GuidaButton onOpen={() => onOpenGuida(GUIDA_DATE_TERMINI)}>Come si contano i termini</GuidaButton>}
        </p>
      )}
      {!v.entityLegalAt && v.dateOnly && onOpenGuida && (
        <p className="nd-verdict-legal">
          Da questa data decorrono i termini del destinatario (pagamento, ricorso, adempimento).
          <GuidaButton onOpen={() => onOpenGuida(GUIDA_DATE_TERMINI)}>Come si contano i termini</GuidaButton>
        </p>
      )}
      {v.note && (
        <p className={`nd-verdict-note${v.discrepancy ? ' nd-verdict-note-alert' : ''}`}>
          {v.discrepancy && <AlertTriangle size={14} aria-hidden="true" />}
          {v.discrepancy ? `Esiti diversi — ${v.note}` : v.note}
        </p>
      )}
      {v.undelivered && onOpenGuida && (
        <p className="nd-verdict-legal">
          Nessuna consegna al destinatario.
          <GuidaButton onOpen={() => onOpenGuida(GUIDA_IRREPERIBILE)}>Cosa fare</GuidaButton>
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
          const { day, time } = formatWhen(e.at, e.dateOnly);
          // Nuovo blocco (tentativo di recapito SEND, esito): separatore e data ripetuta.
          const newGroup = !!e.groupLabel && e.groupLabel !== events[i - 1]?.groupLabel;
          const prevDay = i > 0 && !newGroup ? formatWhen(events[i - 1]!.at, events[i - 1]!.dateOnly).day : null;
          return (
            <React.Fragment key={`${e.at}-${i}`}>
            {newGroup && (
              <li className="nd-group">
                <span className="nd-group-label">{e.groupLabel}</span>
              </li>
            )}
            <li className={`nd-event nd-src-${e.source} nd-tone-${e.tone}`}>
              <div className="nd-when">
                {day !== prevDay && <span className="nd-day">{day}</span>}
                {time && <span className="nd-time">{time}</span>}
              </div>
              <span className="nd-marker" aria-hidden="true" />
              <div className="nd-what">
                <span className="nd-title">
                  {e.title}
                  {e.logo && (() => {
                    const meta = getChannelMeta(e.logo);
                    return meta.logoUrl ? <> <img className="nd-title-logo" src={meta.logoUrl} alt={meta.label} /></> : ` ${meta.label}`;
                  })()}
                </span>
                {e.source !== 'invio' && <span className="nd-source">{sourceLabel(e.source)}</span>}
                {e.detail && <span className="nd-detail">{e.detail}</span>}
                {e.link && (
                  <a className="nd-detail nd-link" href={e.link.href} target="_blank" rel="noopener noreferrer">
                    {e.link.label} <ExternalLink size={11} aria-hidden="true" />
                  </a>
                )}
              </div>
            </li>
            </React.Fragment>
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
