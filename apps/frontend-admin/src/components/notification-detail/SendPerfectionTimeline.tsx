import React from 'react';
import { GUIDA_DATE_TERMINI } from '../../guida';
import { DatePopover } from './DatePopover';
import type { SendPerfection, SendPerfectionStep } from './journey';

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
  if (today < first.t) return 0;
  // Ultima tappa già raggiunta (data <= oggi): oggi è lì se coincide,
  // altrimenti fra lei e la tappa successiva.
  const reached = dated.filter((x) => x.t <= today);
  const a = reached[reached.length - 1]!;
  let idx: number;
  if (a.t === today) idx = a.i;
  else {
    const b = dated.find((x) => x.i > a.i && x.t > today);
    if (b) idx = a.i + ((today - a.t) / (b.t - a.t)) * (b.i - a.i);
    // Tappa successiva senza data (es. "Notificata per il destinatario" ancora
    // ignota): a metà strada, mai sopra la data dell'ultima tappa raggiunta.
    else idx = a.i < n - 1 ? a.i + 0.5 : a.i;
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
      return `Data stimata (art. 26, comma ${data.steps.some((s) => s.key === 'deposited') ? 7 : 9}, D.L. 76/2020): si conferma con l'esito di SEND; prima se il destinatario apre la notifica.`;
    default:
      return 'La data dipende dall\'esito del recapito: la indicherà SEND.';
  }
}

const ART26 = 'D.L. 76/2020';

/** Spiegazione con riferimenti di legge della data di una tappa. */
function explanationOf(step: SendPerfectionStep, data: SendPerfection): string {
  const d = fmt(step.date, true);
  switch (step.key) {
    case 'entity':
      return `Notificata per l'ente il ${d}: messa a disposizione su SEND. Impedisce le decadenze e interrompe la prescrizione (art. 26, c. 9 lett. a e c. 10, ${ART26}). I termini del destinatario decorrono dalla data in cui è notificata per lui.`;
    case 'deposited':
      return `Avviso di avvenuta ricezione depositato su SEND il ${d}: il destinatario è risultato irreperibile. La notifica per il destinatario si perfeziona il decimo giorno successivo al deposito (art. 26, c. 7, ${ART26}).`;
    case 'digital_delivered':
      return `Consegnata al domicilio digitale il ${d}. Per il destinatario si perfeziona il settimo giorno successivo; se consegnata dopo le 21:00, si conta dal giorno dopo (art. 26, c. 9 lett. b n. 1, ${ART26}).`;
    case 'digital_failure':
      return `Avviso di mancato recapito depositato il ${d} (casella piena, non valida o non attiva): per il destinatario si perfeziona il quindicesimo giorno successivo (art. 26, c. 9 lett. b n. 1, ${ART26}).`;
    case 'analog_delivered':
      return `Avviso cartaceo consegnato il ${d}. Per il destinatario si perfeziona il decimo giorno dopo il perfezionamento dell'avviso cartaceo (art. 26, c. 9 lett. b n. 2, ${ART26}): la data la indica SEND.`;
    case 'delivering':
      return step.state === 'expected'
        ? `Recapito cartaceo previsto da SEND dal ${d}: senza domicilio digitale, SEND attende 5 giorni dall'avviso di cortesia e poi invia la raccomandata, se il destinatario non ha aperto prima la notifica.`
        : `In consegna dal ${d}.`;
    case 'viewed':
      return `Il destinatario ha aperto la notifica su SEND il ${d}: se anteriore, è questa la data di notifica per lui (art. 26, c. 9 lett. b n. 3, ${ART26}).`;
    case 'recipient':
      return noteOf(data);
    default:
      return `${step.label}: ${d}.`;
  }
}

/** Timeline orizzontale delle tappe fino alla notifica per il destinatario. */
export function SendPerfectionTimeline({ data, onOpenGuida }: { data: SendPerfection; onOpenGuida?: (anchor: string) => void }): React.JSX.Element {
  const n = data.steps.length;
  // Data per il destinatario già confermata da SEND: percorso concluso, linea piena
  // e niente "oggi" (non dice nulla); altrimenti la linea si riempie fino a oggi.
  const done = data.finalSource === 'pn' && n >= 2;
  const frac = done ? 1 : todayFraction(data);
  const pct = frac === null ? null : `${(frac * 100).toFixed(2)}%`;
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  // Chiude solo se è ancora aperto QUELLO: il timer di A non deve chiudere B appena aperto.
  const closeKey = React.useCallback((key: string) => setOpenKey((k) => (k === key ? null : k)), []);
  const baseId = React.useId();
  return (
    <div className="nd-perf">
      <ol className="nd-perf-steps" style={{ '--nd-perf-n': n } as React.CSSProperties}>
        {pct !== null && (
          <li className="nd-perf-track" aria-hidden="true">
            <span className="nd-perf-fill" style={{ width: pct }} />
            {!done && <span className="nd-perf-today" style={{ left: pct }}>oggi {fmt(data.today)}</span>}
          </li>
        )}
        {data.steps.map((s, i) => {
          const isFinal = s.key === 'recipient';
          const open = openKey === s.key;
          const place = i === 0 ? ' nd-perf-pop-first' : i === n - 1 ? ' nd-perf-pop-last' : '';
          return (
            <li key={s.key} className={`nd-perf-step${isFinal ? ' nd-perf-goal' : ''}${open ? ' nd-perf-step-open' : ''}${place}`}>
              <span className="nd-perf-date">
                {s.date || isFinal ? (
                  <DatePopover
                    id={`${baseId}-${s.key}`}
                    label={s.label}
                    text={fmt(s.date)}
                    open={open}
                    onOpen={() => setOpenKey(s.key)}
                    onToggle={() => setOpenKey(open ? null : s.key)}
                    onClose={() => closeKey(s.key)}
                  >
                    {explanationOf(s, data)}
                    {(s.key === 'entity' || isFinal) && onOpenGuida && (
                      <button type="button" className="btn btn-link btn-sm p-0 ms-1 align-baseline" onClick={() => { closeKey(s.key); onOpenGuida(GUIDA_DATE_TERMINI); }}>
                        Come si contano i termini
                      </button>
                    )}
                  </DatePopover>
                ) : '—'}
              </span>
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
      <p className="nd-perf-hint">Passa sopra o tocca una data per i riferimenti di legge.</p>
    </div>
  );
}
