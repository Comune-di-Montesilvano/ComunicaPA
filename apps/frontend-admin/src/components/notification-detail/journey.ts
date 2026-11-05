// Dettaglio notifica come "percorso": un'unica linea del tempo che unisce
// tutte le fonti (invii, protocollo, GlobalCom, Poste, SEND, App IO, download
// del cittadino), più un verdetto con l'esito effettivo. I canali cambiano
// gli eventi, non la struttura: nessuna colonna specifica per canale.

import { describeSendTimelineEvent, type SendTimelineEvent } from './send-timeline';

export interface JourneyMovement { at: string; luogo: string; statoLavorazione: string; box: string; flagRitorno: boolean }

export interface JourneyPosteVerification {
  status: 'pending' | 'delivered' | 'returned' | 'gave_up';
  trackingCode: string;
  trackingUntil?: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  /** Ultimo controllo fallito o bloccato: nessuna conclusione sul vettore. */
  lastError?: string | null;
  deliveredAt: string | null;
  outcomeAt?: string | null;
  summary?: string | null;
  movements: JourneyMovement[];
}

export interface JourneyAttempt {
  attemptNumber: number;
  status: string;
  channelType: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null; messageId?: string | null };
  sendStatus?: string | null;
  sendStatusUpdatedAt?: string | null;
  sendStatusHistory?: Array<{ status: string; activeFrom: string }> | null;
  sendTimeline?: SendTimelineEvent[] | null;
  postalStatus?: string | null;
  postalDeliveryStatus?: string | null;
  postalDeliveryDate?: string | null;
  postalStatusHistory?: Array<{ stato: string; rilevatoIl: string; codiceErrore?: string; descrizione?: string; statoConsegna?: string }> | null;
  posteVerification?: JourneyPosteVerification | null;
  protocolNumber?: number | null;
  protocolYear?: number | null;
  protocolledAt?: string | null;
}

export interface JourneyDetail {
  recipient?: { status: string };
  /** Solo POSTAL: esito legale calcolato dal backend. */
  legalOutcome?: { outcome: string; reason: string | null; at: string | null } | null;
  campaign: { channelType: string };
  attempts: JourneyAttempt[];
  downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
}

export interface JourneyLabels {
  channel: (c: string) => string;
  postalStatus: (s: string) => string;
  sendStatus: (s: string) => string;
}

export type JourneySource = 'invio' | 'protocollo' | 'globalcom' | 'poste' | 'send' | 'appio' | 'cittadino';
export type JourneyTone = 'neutral' | 'ok' | 'ko' | 'warn';

export interface JourneyEvent {
  at: string;
  source: JourneySource;
  title: string;
  detail?: string | null;
  tone: JourneyTone;
  /** Data senza ora significativa (esito GlobalCom): mostrare solo il giorno. */
  dateOnly?: boolean;
  /** Link esterno (es. tracking su poste.it). */
  link?: { href: string; label: string };
}

export interface Verdict {
  headline: string;
  tone: JourneyTone;
  when: string | null;
  source: string | null;
  note: string | null;
  /** Le fonti non concordano (es. Poste consegnata, GlobalCom no). */
  discrepancy: boolean;
  /** Data legale: mostrare solo il giorno, mai l'ora. */
  dateOnly?: boolean;
  /** SEND: data legale di notifica per l'ente (messa a disposizione, art. 26 c. 9 lett. a). */
  entityLegalAt?: string | null;
  /** Nessuna consegna (irreperibile, restituita, non consegnata): la UI rimanda alla guida su come procedere. */
  undelivered?: boolean;
}

const SOURCE_LABELS: Record<JourneySource, string> = {
  invio: 'Invio',
  protocollo: 'Protocollo',
  globalcom: 'GlobalCom',
  poste: 'Poste Italiane',
  send: 'SEND',
  appio: 'App IO',
  cittadino: 'Cittadino',
};

export function sourceLabel(s: JourneySource): string {
  return SOURCE_LABELS[s];
}

export function latestAttempt(d: JourneyDetail): JourneyAttempt | null {
  return d.attempts.reduce<JourneyAttempt | null>((best, a) => (!best || a.attemptNumber > best.attemptNumber ? a : best), null);
}

// Fasi del tracking Poste (campo `box`): nomi derivati dai casi reali
// osservati (2 accettazione, 3 lavorazione/transito, 4 ufficio di
// recapito, 5 esito), con il ritorno al mittente che ha la precedenza.
function posteMovementTitle(m: JourneyMovement, isLastDelivered: boolean): string {
  if (m.flagRitorno) return m.box === '5' ? 'Restituita al mittente' : 'In restituzione al mittente';
  switch (m.box) {
    case '2': return 'Presa in carico';
    case '3': return 'In lavorazione';
    case '4': return 'In consegna';
    case '5': return isLastDelivered ? 'Consegnata' : 'Esito finale';
    default: return m.statoLavorazione || 'Aggiornamento';
  }
}

function validDate(s: string | null | undefined): s is string {
  return !!s && !Number.isNaN(new Date(s).getTime());
}

const SEND_STATUS_TONES: Record<string, JourneyTone> = {
  DELIVERED: 'ok',
  VIEWED: 'ok',
  EFFECTIVE_DATE: 'ok',
  UNREACHABLE: 'ko',
  REFUSED: 'ko',
  CANCELLED: 'warn',
  RETURNED_TO_SENDER: 'warn',
};

/**
 * PN non dichiara il recapitista: Poste Italiane se il tracking Poste
 * riconosce il codice della raccomandata, altrimenti un altro vettore.
 * Prima del primo controllo non si dice nulla.
 */
function sendCarrierOf(pv: JourneyPosteVerification | null | undefined, letter: string): string | null {
  if (!isPosteLetterCode(letter)) return 'recapitista diverso da Poste Italiane';
  if (!pv || pv.trackingCode !== letter || !pv.lastCheckedAt || pv.lastError) return null;
  return pv.movements.length > 0 ? 'recapitista Poste Italiane' : 'recapitista non tracciato su poste.it';
}

/**
 * Formato dei codici Poste: 12 cifre (raccomandate nazionali, visti dal vivo
 * 698139…/698140…) o S10 internazionale (RR123456789IT). Altri vettori SEND
 * hanno formati propri (visto: PSTAQ… di 20 caratteri, ignoto a poste.it).
 */
export function isPosteLetterCode(code: string): boolean {
  return /^\d{12}$/.test(code) || /^[A-Z]{2}\d{9}IT$/.test(code);
}

/** Ultima raccomandata in formato Poste della timeline SEND (stessa regola del backend). */
export function latestSendPosteLetter(timeline: SendTimelineEvent[] | null | undefined): string | null {
  let best: SendTimelineEvent | null = null;
  for (const e of timeline ?? []) {
    if (e.registeredLetterCode && isPosteLetterCode(e.registeredLetterCode) && (!best || e.at > best.at)) best = e;
  }
  return best?.registeredLetterCode ?? null;
}

export function posteTrackingUrl(code: string): string {
  return `https://www.poste.it/cerca/#/risultati-spedizioni/${encodeURIComponent(code)}`;
}

export function buildJourney(d: JourneyDetail, labels: JourneyLabels): JourneyEvent[] {
  const events: JourneyEvent[] = [];
  for (const a of d.attempts) {
    events.push({
      at: a.createdAt,
      source: 'invio',
      title: `${d.attempts.length > 1 ? `Invio #${a.attemptNumber}` : 'Invio'} su ${labels.channel(a.channelType)}`,
      detail: a.status === 'failed' ? a.errorMessage : null,
      tone: a.status === 'failed' ? 'ko' : 'neutral',
    });
    if (validDate(a.protocolledAt) && a.protocolNumber) {
      events.push({ at: a.protocolledAt, source: 'protocollo', title: `Protocollata n. ${a.protocolNumber}/${a.protocolYear ?? ''}`, tone: 'neutral' });
    }
    const history = a.postalStatusHistory ?? [];
    history.forEach((h, i) => {
      const failed = h.stato === 'NonConsegnato' || h.stato === 'Errore' || (!!h.codiceErrore && h.codiceErrore !== '0');
      // rilevatoIl è quando il sync ha visto lo stato (anche giorni dopo): per
      // l'esito finale GlobalCom dà la data vera, la stessa del verdetto.
      const isFinalOutcome = i === history.length - 1 && h.stato === a.postalStatus
        && (h.stato === 'Consegnato' || h.stato === 'NonConsegnato') && validDate(a.postalDeliveryDate);
      const detected = isFinalOutcome
        ? `rilevato il ${new Date(h.rilevatoIl).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' })}`
        : null;
      events.push({
        at: isFinalOutcome ? a.postalDeliveryDate! : h.rilevatoIl,
        source: 'globalcom',
        title: labels.postalStatus(h.stato),
        detail: [h.statoConsegna, h.codiceErrore && h.codiceErrore !== '0' ? h.descrizione : null, detected].filter(Boolean).join(' · ') || null,
        tone: h.stato === 'Consegnato' ? 'ok' : failed ? 'ko' : 'neutral',
        ...(isFinalOutcome ? { dateOnly: true } : {}),
      });
    });
    const pv = a.posteVerification;
    if (pv) {
      const lastMovementIndex = pv.movements.reduce((best, m, i) => (best < 0 || (Number(m.box) || 0) >= (Number(pv.movements[best]!.box) || 0) ? i : best), -1);
      pv.movements.forEach((m, i) => {
        if (!validDate(m.at)) return;
        const isLast = i === lastMovementIndex;
        events.push({
          at: m.at,
          source: 'poste',
          title: posteMovementTitle(m, isLast && pv.status === 'delivered'),
          detail: m.luogo || null,
          tone: m.flagRitorno ? 'warn' : isLast && pv.status === 'delivered' ? 'ok' : 'neutral',
        });
      });
    }
    // SEND: ogni stato con la data in cui PN l'ha assunto, più i fatti della
    // timeline (spedizione, recapitista, ritiro RADD). Senza storico (attempt
    // non ancora ripollato) resta il solo stato corrente.
    const sendHistory = (a.sendStatusHistory ?? []).filter((h) => h.status && validDate(h.activeFrom));
    if (sendHistory.length > 0) {
      for (const h of sendHistory) {
        events.push({ at: h.activeFrom, source: 'send', title: labels.sendStatus(h.status), tone: SEND_STATUS_TONES[h.status] ?? 'neutral' });
      }
    } else if (a.sendStatus && validDate(a.sendStatusUpdatedAt ?? a.createdAt)) {
      events.push({ at: (a.sendStatusUpdatedAt ?? a.createdAt)!, source: 'send', title: labels.sendStatus(a.sendStatus), tone: 'neutral' });
    }
    const sendTimeline = a.sendTimeline ?? [];
    for (const t of sendTimeline) {
      const described = describeSendTimelineEvent(t);
      if (!described || !validDate(t.at)) continue;
      // Numero della raccomandata (arriva dagli avanzamenti dello stesso
      // tentativo): è quello da cercare su poste.it o da dare al cittadino.
      const letter = t.category === 'SEND_ANALOG_DOMICILE'
        ? sendTimeline.find((x) => x.registeredLetterCode && (x.attempt ?? 0) === (t.attempt ?? 0) && x.category === 'SEND_ANALOG_FEEDBACK')?.registeredLetterCode
          ?? sendTimeline.find((x) => x.registeredLetterCode && new Date(x.at).getTime() >= new Date(t.at).getTime())?.registeredLetterCode
        : undefined;
      events.push({
        at: t.at,
        source: 'send',
        ...described,
        ...(letter ? { detail: [`Raccomandata n. ${letter}`, sendCarrierOf(a.posteVerification, letter)].filter(Boolean).join(' · ') } : {}),
        ...(letter && isPosteLetterCode(letter) ? { link: { href: posteTrackingUrl(letter), label: 'Traccia su poste.it' } } : {}),
      });
    }
    if (a.appIo.attempted && a.channelType !== 'APP_IO') {
      events.push({
        at: a.sentAt ?? a.createdAt,
        source: 'appio',
        title: a.appIo.success ? 'Messaggio consegnato su App IO' : 'Messaggio App IO non consegnato',
        detail: a.appIo.success ? null : a.appIo.error,
        tone: a.appIo.success ? 'ok' : 'ko',
      });
    }
  }
  for (const dl of d.downloads) {
    events.push({ at: dl.downloadedAt, source: 'cittadino', title: 'Documento scaricato', detail: labels.channel(dl.channel), tone: 'ok' });
  }
  // Lo stesso protocollo è riportato su più tentativi (fallback dal primo
  // protocollato): eventi identici per fonte, titolo e minuto contano una volta.
  const seen = new Set<string>();
  return events
    .filter((e) => validDate(e.at))
    .filter((e) => {
      const key = `${e.source}|${e.title}|${e.detail ?? ''}|${new Date(e.at).toISOString().slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
}

export function computeVerdict(d: JourneyDetail, labels: JourneyLabels): Verdict {
  const last = latestAttempt(d);
  const base: Verdict = { headline: 'Non ancora inviata', tone: 'neutral', when: null, source: null, note: null, discrepancy: false };
  // Nessun tentativo registrato: ci si affida allo stato del destinatario
  // (es. notifica creata senza passare dal motore di invio).
  if (!last) return d.recipient?.status === 'sent' ? { ...base, headline: 'Inviata' } : base;
  if (last.status === 'failed') {
    return { ...base, headline: 'Invio non riuscito', tone: 'ko', when: last.createdAt, source: `su ${labels.channel(last.channelType)}`, note: last.errorMessage };
  }

  // POSTAL: il verdetto segue l'esito legale calcolato dal backend (compiuta
  // giacenza e rifiuto valgono consegna, via PEC idem). In corso / non
  // classificato ricadono sulla logica GlobalCom/Poste sotto.
  const lo = d.campaign.channelType === 'POSTAL' ? d.legalOutcome : null;
  if (lo?.outcome === 'delivered') {
    const source = lo.reason === 'Verifica Poste' ? 'secondo Poste Italiane' : lo.reason === 'Via PEC' ? 'via PEC (domicilio digitale)' : 'secondo GlobalCom';
    const discrepancy = lo.reason === 'Verifica Poste' && last.postalStatus !== 'Consegnato';
    // Discrepanza: lo stato GlobalCom resta visibile accanto alla consegna Poste.
    const gcNote = last.postalStatus ? `GlobalCom: ${labels.postalStatus(last.postalStatus)}${last.postalDeliveryStatus ? ` (${last.postalDeliveryStatus})` : ''}` : null;
    const note = discrepancy ? gcNote : lo.reason === 'Verifica Poste' || lo.reason === 'Via PEC' ? null : lo.reason;
    return { headline: 'Consegnata', tone: 'ok', when: lo.at, source, note, discrepancy, dateOnly: true };
  }
  if (lo?.outcome === 'not_delivered') {
    return { headline: 'Non consegnata', tone: 'ko', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: lo.reason, discrepancy: false, undelivered: true };
  }
  if (lo?.outcome === 'no_legal_value') {
    return { headline: 'Solo App IO', tone: 'warn', when: last.sentAt ?? last.createdAt, source: 'senza valore legale', note: null, discrepancy: false };
  }
  if (lo?.outcome === 'no_ar') {
    return { headline: 'Inviata senza AR', tone: 'neutral', when: last.sentAt ?? last.createdAt, source: 'nessun esito di consegna', note: null, discrepancy: false };
  }
  if (lo?.outcome === 'in_progress' || lo?.outcome === 'unclassified') {
    // Stesso esito della tabella: mai "Non consegnata" per un valore GlobalCom
    // non (ancora) classificato. Stato GlobalCom e Poste restano in nota.
    const pv = last.posteVerification;
    const gc = last.postalStatus ? `GlobalCom: ${labels.postalStatus(last.postalStatus)}${last.postalDeliveryStatus ? ` (${last.postalDeliveryStatus})` : ''}` : null;
    const posteNote = pv?.status === 'pending'
      ? `Verifica su Poste in corso${pv.trackingUntil ? ` fino al ${new Date(pv.trackingUntil).toLocaleDateString('it-IT')}` : ''}${pv.summary ? `: ${pv.summary}` : ''}`
      : pv?.summary ? `Poste: ${pv.summary}` : null;
    return { headline: lo.outcome === 'in_progress' ? 'In corso' : 'Non classificata', tone: 'neutral', when: null, source: null, note: [gc, posteNote].filter(Boolean).join(' — ') || null, discrepancy: false };
  }

  if (d.campaign.channelType === 'POSTAL' && last.channelType === 'POSTAL') {
    const pv = last.posteVerification;
    const gc = last.postalStatus ? labels.postalStatus(last.postalStatus) : null;
    const gcNote = gc ? `GlobalCom: ${gc}${last.postalDeliveryStatus ? ` (${last.postalDeliveryStatus})` : ''}` : null;
    if (pv?.status === 'delivered') {
      const discrepancy = last.postalStatus !== 'Consegnato';
      return { headline: 'Consegnata', tone: 'ok', when: pv.outcomeAt ?? pv.deliveredAt, source: 'secondo Poste Italiane', note: discrepancy ? gcNote : null, discrepancy };
    }
    if (pv?.status === 'returned') {
      return { headline: 'Restituita al mittente', tone: 'warn', when: pv.outcomeAt ?? null, source: 'secondo Poste Italiane', note: gcNote, discrepancy: last.postalStatus === 'Consegnato', undelivered: true };
    }
    if (last.postalStatus === 'Consegnato') {
      return { headline: 'Consegnata', tone: 'ok', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: last.postalDeliveryStatus ?? null, discrepancy: false };
    }
    const posteNote = pv?.status === 'pending'
      ? `Verifica su Poste in corso${pv.trackingUntil ? ` fino al ${new Date(pv.trackingUntil).toLocaleDateString('it-IT')}` : ''}${pv.summary ? `: ${pv.summary}` : ''}`
      : pv?.summary ? `Poste: ${pv.summary}` : null;
    if (last.postalStatus === 'NonConsegnato') {
      return { headline: 'Non consegnata', tone: 'ko', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: [last.postalDeliveryStatus, posteNote].filter(Boolean).join(' — ') || null, discrepancy: false, undelivered: true };
    }
    return { headline: 'In lavorazione', tone: 'neutral', when: null, source: 'secondo GlobalCom', note: [gc && last.postalDeliveryStatus ? `${gc} (${last.postalDeliveryStatus})` : gc, posteNote].filter(Boolean).join(' — ') || null, discrepancy: false };
  }

  if (d.campaign.channelType === 'SEND' && last.sendStatus) {
    // Poste ha già un esito ma PN no: il recapitista non ha trasmesso a PN
    // l'esito (visto dal vivo: RECRN010 e poi più nulla per 45 giorni, Poste
    // consegnata lo stesso giorno). L'esito legale resta quello di SEND.
    const pv = last.posteVerification;
    const pnOpen = last.sendStatus === 'DELIVERING' || last.sendStatus === 'ACCEPTED';
    const posteOutcome = pnOpen && pv && (pv.status === 'delivered' || pv.status === 'returned') ? pv : null;
    const posteWhen = posteOutcome?.outcomeAt ?? posteOutcome?.deliveredAt ?? null;
    // Irreperibilità totale: PN deposita l'avviso sulla piattaforma e la
    // notifica si perfeziona 10 giorni dopo, con valore legale, ma senza
    // consegna al destinatario: l'operatore deve vederlo.
    const viaUnreachable = last.sendStatus === 'EFFECTIVE_DATE' && (last.sendStatusHistory ?? []).some((h) => h.status === 'UNREACHABLE');
    const note = posteOutcome
      // "returned" scatta al primo movimento con flagRitorno: per SEND il plico
      // torna al recapitista, la restituzione è avviata, non conclusa.
      ? `Poste: ${posteOutcome.status === 'delivered' ? 'consegnata' : 'restituzione al mittente avviata'}${posteWhen ? ` il ${new Date(posteWhen).toLocaleDateString('it-IT')}` : ''}; SEND non ha ancora ricevuto l'esito dal recapitista`
      : viaUnreachable
      ? "Destinatario irreperibile: nessuna consegna, la notifica si è perfezionata 10 giorni dopo il deposito dell'avviso su SEND (art. 26, comma 7, D.L. 76/2020)"
      : null;
    // Data dello stato secondo PN (storico), non dell'ultimo sync: un
    // ri-sync (backfill) spostava "Perfezionata" alla data del ri-sync.
    const pnSince = [...(last.sendStatusHistory ?? [])].reverse().find((h) => h.status === last.sendStatus && validDate(h.activeFrom))?.activeFrom;
    const history = last.sendStatusHistory ?? [];
    const entityLegalAt = history.some((h) => h.status === 'CANCELLED') ? null : (history.find((h) => h.status === 'ACCEPTED' && validDate(h.activeFrom))?.activeFrom ?? null);
    const sendUndelivered = viaUnreachable || ['UNREACHABLE', 'RETURNED_TO_SENDER', 'REFUSED', 'CANCELLED'].includes(last.sendStatus ?? '');
    return { ...base, headline: labels.sendStatus(last.sendStatus), when: pnSince ?? last.sendStatusUpdatedAt ?? null, source: 'secondo SEND', tone: 'neutral', note, discrepancy: !!posteOutcome, entityLegalAt, undelivered: sendUndelivered };
  }

  const firstDownload = [...d.downloads].sort((x, y) => new Date(x.downloadedAt).getTime() - new Date(y.downloadedAt).getTime())[0];
  return {
    ...base,
    headline: firstDownload ? 'Inviata e letta' : 'Inviata',
    tone: firstDownload ? 'ok' : 'neutral',
    when: last.sentAt ?? last.createdAt,
    source: `su ${labels.channel(last.channelType)}`,
    note: firstDownload ? `Documento scaricato dal cittadino il ${new Date(firstDownload.downloadedAt).toLocaleString('it-IT')}` : null,
  };
}
