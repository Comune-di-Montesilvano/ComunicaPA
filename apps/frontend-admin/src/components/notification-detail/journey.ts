// Dettaglio notifica come "percorso": un'unica linea del tempo che unisce
// tutte le fonti (invii, protocollo, GlobalCom, Poste, SEND, App IO, download
// del cittadino), più un verdetto con l'esito effettivo. I canali cambiano
// gli eventi, non la struttura: nessuna colonna specifica per canale.

export interface JourneyMovement { at: string; luogo: string; statoLavorazione: string; box: string; flagRitorno: boolean }

export interface JourneyPosteVerification {
  status: 'pending' | 'delivered' | 'returned' | 'gave_up';
  trackingCode: string;
  trackingUntil?: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
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
}

export interface Verdict {
  headline: string;
  tone: JourneyTone;
  when: string | null;
  source: string | null;
  note: string | null;
  /** Le fonti non concordano (es. Poste consegnata, GlobalCom no). */
  discrepancy: boolean;
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
    for (const h of a.postalStatusHistory ?? []) {
      const failed = h.stato === 'NonConsegnato' || h.stato === 'Errore' || (!!h.codiceErrore && h.codiceErrore !== '0');
      events.push({
        at: h.rilevatoIl,
        source: 'globalcom',
        title: labels.postalStatus(h.stato),
        detail: [h.statoConsegna, h.codiceErrore && h.codiceErrore !== '0' ? h.descrizione : null].filter(Boolean).join(' · ') || null,
        tone: h.stato === 'Consegnato' ? 'ok' : failed ? 'ko' : 'neutral',
      });
    }
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
    if (a.sendStatus && validDate(a.sendStatusUpdatedAt ?? a.createdAt)) {
      events.push({ at: (a.sendStatusUpdatedAt ?? a.createdAt)!, source: 'send', title: labels.sendStatus(a.sendStatus), tone: 'neutral' });
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
  if (!last) return base;
  if (last.status === 'failed') {
    return { ...base, headline: 'Invio non riuscito', tone: 'ko', when: last.createdAt, source: `su ${labels.channel(last.channelType)}`, note: last.errorMessage };
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
      return { headline: 'Restituita al mittente', tone: 'warn', when: pv.outcomeAt ?? null, source: 'secondo Poste Italiane', note: gcNote, discrepancy: last.postalStatus === 'Consegnato' };
    }
    if (last.postalStatus === 'Consegnato') {
      return { headline: 'Consegnata', tone: 'ok', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: last.postalDeliveryStatus ?? null, discrepancy: false };
    }
    const posteNote = pv?.status === 'pending'
      ? `Verifica su Poste in corso${pv.trackingUntil ? ` fino al ${new Date(pv.trackingUntil).toLocaleDateString('it-IT')}` : ''}${pv.summary ? `: ${pv.summary}` : ''}`
      : pv?.summary ? `Poste: ${pv.summary}` : null;
    if (last.postalStatus === 'NonConsegnato') {
      return { headline: 'Non consegnata', tone: 'ko', when: last.postalDeliveryDate ?? null, source: 'secondo GlobalCom', note: [last.postalDeliveryStatus, posteNote].filter(Boolean).join(' — ') || null, discrepancy: false };
    }
    return { headline: 'In lavorazione', tone: 'neutral', when: null, source: 'secondo GlobalCom', note: [gc && last.postalDeliveryStatus ? `${gc} (${last.postalDeliveryStatus})` : gc, posteNote].filter(Boolean).join(' — ') || null, discrepancy: false };
  }

  if (d.campaign.channelType === 'SEND' && last.sendStatus) {
    return { ...base, headline: labels.sendStatus(last.sendStatus), when: last.sendStatusUpdatedAt ?? null, source: 'secondo SEND', tone: 'neutral' };
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
