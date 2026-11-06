import type { SendTimelineEvent } from '../channels/send/send-status-history.util.js';
import { sendEntityLegalDateOf, sendLegalDateOf } from './send-legal-date.util.js';

export type PerfectionStepState = 'done' | 'ko' | 'expected';
export interface PerfectionStep {
  key:
    | 'entity'
    | 'delivering'
    | 'digital_delivered'
    | 'digital_failure'
    | 'analog_delivered'
    | 'deposited'
    | 'aar_refined'
    | 'viewed'
    | 'recipient';
  label: string;
  /** YYYY-MM-DD, Europe/Rome; null = data non ancora nota. */
  date: string | null;
  state: PerfectionStepState;
  /** Giorni dalla tappa precedente quando la data è calcolata per legge (7, 10, 15). */
  offsetDays?: number;
}
export type PerfectionFinalSource = 'pn' | 'pn_scheduled' | 'estimate' | 'none';
export interface SendPerfection {
  steps: PerfectionStep[];
  finalSource: PerfectionFinalSource;
  /** = steps[last].date */
  finalDate: string | null;
  /** YYYY-MM-DD Europe/Rome di `now`, per il marcatore "oggi". */
  today: string;
}

const LABELS: Record<PerfectionStep['key'], string> = {
  entity: "Notificata per l'ente",
  delivering: 'In consegna',
  digital_delivered: 'Consegnata al domicilio digitale',
  digital_failure: 'Avviso di mancato recapito depositato',
  analog_delivered: 'Avviso cartaceo consegnato',
  deposited: 'Avviso depositato su SEND',
  aar_refined: 'Avviso perfezionato',
  viewed: 'Visualizzata su SEND',
  recipient: 'Notificata per il destinatario',
};

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function validDate(iso: unknown): Date | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Data di calendario Europe/Rome (YYYY-MM-DD) di un timestamp ISO; null se non valido. */
function romeDate(iso: unknown): string | null {
  const d = validDate(iso);
  return d ? dateFmt.format(d) : null;
}

/** true se l'ora di Roma è oltre le 21:00:00 (soglia esclusiva). */
function pastNinePmRome(iso: string): boolean {
  const d = validDate(iso);
  if (!d) return false;
  const p = Object.fromEntries(timeFmt.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return p['hour']! > 21 || (p['hour'] === 21 && (p['minute']! > 0 || p['second']! > 0));
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function mk(key: PerfectionStep['key'], date: string | null, state: PerfectionStepState, offsetDays?: number): PerfectionStep {
  const s: PerfectionStep = { key, label: LABELS[key], date, state };
  if (offsetDays !== undefined) s.offsetDays = offsetDays;
  return s;
}

/**
 * Tappe di una notifica SEND fino alla data di notifica per il destinatario
 * (art. 26 D.L. 76/2020), per la timeline orizzontale del dettaglio.
 */
export function buildSendPerfection(
  sendStatus: string | null,
  history: Array<{ status: string; activeFrom: string }> | null | undefined,
  timeline: SendTimelineEvent[] | null | undefined,
  now: Date,
): SendPerfection | null {
  const hist = (history ?? []).filter((h) => h && typeof h.status === 'string');
  if (sendStatus === 'CANCELLED' || hist.some((h) => h.status === 'CANCELLED')) return null;
  // Solo eventi con timestamp valido, in ordine cronologico.
  const events = (timeline ?? [])
    .filter((e) => e && validDate(e.at))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const first = (pred: (e: SendTimelineEvent) => boolean) => events.find(pred);
  const histEntry = (status: string) => hist.find((h) => h.status === status);

  const today = dateFmt.format(now);
  const entityDate = romeDate(sendEntityLegalDateOf(hist));
  const steps: PerfectionStep[] = [mk('entity', entityDate, entityDate ? 'done' : 'expected')];

  // Percorso (primo che combacia) e stima nostra della data finale.
  let estimate: string | null = null;
  let estimateOffset: number | undefined;
  let lawStepIndex = -1;

  const unreachableHist = histEntry('UNREACHABLE');
  const unreachableEv = first((e) => e.category === 'COMPLETELY_UNREACHABLE');
  const analogOk = first(
    (e) => (e.category === 'SEND_ANALOG_FEEDBACK' && e.responseStatus === 'OK') || e.category === 'ANALOG_SUCCESS_WORKFLOW',
  );
  const digitalFailure = first((e) => e.category === 'DIGITAL_FAILURE_WORKFLOW');
  const digitalOk = first(
    (e) => (e.category === 'SEND_DIGITAL_FEEDBACK' && e.responseStatus !== 'KO') || e.category === 'DIGITAL_SUCCESS_WORKFLOW',
  );

  if (unreachableHist || unreachableEv) {
    const deposit = romeDate(unreachableHist?.activeFrom) ?? romeDate(unreachableEv?.at);
    steps.push(mk('deposited', deposit, 'ko'));
    const refined = deposit ? addDays(deposit, 10) : null;
    lawStepIndex = steps.length;
    steps.push(mk('aar_refined', refined, 'expected', refined ? 10 : undefined));
    estimate = refined ? addDays(refined, 10) : null;
    estimateOffset = 10;
  } else if (analogOk) {
    steps.push(mk('analog_delivered', romeDate(analogOk.at), 'done'));
  } else if (digitalFailure) {
    const d = romeDate(digitalFailure.at);
    steps.push(mk('digital_failure', d, 'done'));
    estimate = d ? addDays(d, 15) : null;
    estimateOffset = 15;
  } else if (digitalOk) {
    const d = romeDate(digitalOk.at);
    steps.push(mk('digital_delivered', d, 'done'));
    estimate = d ? addDays(d, pastNinePmRome(digitalOk.at) ? 8 : 7) : null;
    estimateOffset = 7;
  } else {
    const d = romeDate(histEntry('DELIVERING')?.activeFrom);
    steps.push(mk('delivering', d, d ? 'done' : 'expected'));
  }

  const viewed = histEntry('VIEWED');
  if (viewed) steps.push(mk('viewed', romeDate(viewed.activeFrom), 'done'));

  // Data finale: PN effettiva > PN programmata > stima > nessuna.
  let finalSource: PerfectionFinalSource;
  let finalDate: string | null;
  const pnDate = romeDate(sendLegalDateOf(hist)) ?? romeDate(first((e) => e.category === 'REFINEMENT')?.at);
  const scheduled = [...events]
    .reverse()
    .filter((e) => e.category === 'SCHEDULE_REFINEMENT')
    .map((e) => romeDate(e.details?.['schedulingDate']))
    .find((d) => d !== null);
  if (pnDate) {
    finalSource = 'pn';
    finalDate = pnDate;
  } else if (scheduled) {
    finalSource = 'pn_scheduled';
    finalDate = scheduled;
  } else if (estimate) {
    finalSource = 'estimate';
    finalDate = estimate;
  } else {
    finalSource = 'none';
    finalDate = null;
  }

  if (lawStepIndex >= 0 && finalSource === 'pn') {
    const aar = steps[lawStepIndex]!;
    // Perfezionata prima della data calcolata (es. presa visione): la tappa non ha più senso.
    if (aar.date && finalDate && aar.date > finalDate) steps.splice(lawStepIndex, 1);
    else aar.state = 'done';
  }
  steps.push(
    mk('recipient', finalDate, finalSource === 'pn' ? 'done' : 'expected', finalSource === 'estimate' ? estimateOffset : undefined),
  );

  return { steps, finalSource, finalDate, today };
}
