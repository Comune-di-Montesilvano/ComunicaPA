// Fatti della timeline SEND (PN) tradotti per il percorso della notifica.
// Gli stati (Accettata, In consegna, Consegnata...) arrivano a parte dallo
// storico stati: qui solo ciò che accade dentro uno stato.

export interface SendTimelineEvent {
  category: string;
  at: string;
  code?: string;
  responseStatus?: string;
  productType?: string;
  channel?: string;
  deliveryFailureCause?: string;
  attempt?: number;
  raddType?: string;
  registeredLetterCode?: string;
  details?: Record<string, unknown>;
}

export type SendTimelineTone = 'neutral' | 'ok' | 'ko' | 'warn';

// deliveryDetailCode del recapitista: descrizioni dal catalogo ufficiale
// PagoPA (pn-helpdesk-fe, src/model/notification.ts), senza la fase
// "Fascicolo Chiuso" (l'esito finale è comunque quello). I codici A/B
// (pre-esito, dematerializzazione) sono passaggi intermedi dello stesso
// esito e non si mostrano: l'esito arriva con SEND_ANALOG_FEEDBACK.
const DELIVERY_CODES: Record<string, { title: string; tone: SendTimelineTone }> = {
  CON080: { title: 'Stampata e imbustata', tone: 'neutral' },
  // "Affido conservato": archiviata la copia conforme dell'avviso. Può
  // arrivare anche dopo l'esito (visto dal vivo), mai un passo del viaggio.
  CON020: { title: "Copia conforme dell'avviso archiviata", tone: 'neutral' },
  CON018: { title: 'Accettata dal recapitista', tone: 'neutral' },
  CON09A: { title: 'Pronta per la spedizione', tone: 'neutral' },
  CON991: { title: 'Non accettata dal recapitista', tone: 'ko' },
  CON993: { title: 'Errore di stampa', tone: 'ko' },
  CON995: { title: 'Errore di stampa', tone: 'ko' },
  CON996: { title: 'Scartata: PDF non valido', tone: 'ko' },
  CON997: { title: 'Scartata: CAP o indirizzo estero non valido', tone: 'ko' },
  CON998: { title: 'Scartata: documento non recuperabile', tone: 'ko' },
  // Raccomandata A/R (RN), semplice (RS), 890 (AG), internazionale (RI/RSI)
  RECRN010: { title: 'Destinatario assente: avviso di giacenza', tone: 'warn' },
  RECRS010: { title: 'Destinatario assente: avviso di giacenza', tone: 'warn' },
  RECAG010: { title: 'Destinatario assente: avviso di giacenza', tone: 'warn' },
  RECRN011: { title: 'In giacenza', tone: 'warn' },
  RECRS011: { title: 'In giacenza', tone: 'warn' },
  RECAG011A: { title: 'In giacenza', tone: 'warn' },
  RECRN001C: { title: 'Consegnata', tone: 'ok' },
  RECRS001C: { title: 'Consegnata', tone: 'ok' },
  RECAG001C: { title: 'Consegnata', tone: 'ok' },
  RECAG002C: { title: 'Consegnata a persona abilitata', tone: 'ok' },
  RECRN002C: { title: 'Mancata consegna', tone: 'ko' },
  RECRS002C: { title: 'Mancata consegna', tone: 'ko' },
  RECAG003C: { title: 'Mancata consegna', tone: 'ko' },
  RECRN002F: { title: 'Irreperibilità assoluta', tone: 'ko' },
  RECRS002F: { title: 'Irreperibilità assoluta', tone: 'ko' },
  RECAG003F: { title: 'Irreperibilità assoluta', tone: 'ko' },
  RECRN003C: { title: 'Ritirata in giacenza', tone: 'ok' },
  RECRS003C: { title: 'Ritirata in giacenza', tone: 'ok' },
  RECAG005C: { title: 'Ritirata in giacenza', tone: 'ok' },
  RECAG006C: { title: 'Ritirata in giacenza da persona abilitata', tone: 'ok' },
  RECRN004C: { title: 'Mancato ritiro in giacenza', tone: 'ko' },
  RECRS004C: { title: 'Mancato ritiro in giacenza', tone: 'ko' },
  RECAG007C: { title: 'Mancato ritiro in giacenza', tone: 'ko' },
  RECRN005C: { title: 'Compiuta giacenza', tone: 'warn' },
  RECRS005C: { title: 'Compiuta giacenza', tone: 'warn' },
  RECAG008C: { title: 'Compiuta giacenza', tone: 'warn' },
  RECRN006: { title: 'Furto, smarrimento o deterioramento', tone: 'ko' },
  RECRS006: { title: 'Furto, smarrimento o deterioramento', tone: 'ko' },
  RECAG004: { title: 'Furto, smarrimento o deterioramento', tone: 'ko' },
  RECRI005: { title: 'Furto, smarrimento o deterioramento', tone: 'ko' },
  RECRSI005: { title: 'Furto, smarrimento o deterioramento', tone: 'ko' },
  RECRN013: { title: 'Esito non rendicontabile', tone: 'warn' },
  RECRS013: { title: 'Esito non rendicontabile', tone: 'warn' },
  RECAG013: { title: 'Esito non rendicontabile', tone: 'warn' },
  RECRN015: { title: 'Ritardo per causa di forza maggiore', tone: 'warn' },
  RECRS015: { title: 'Ritardo per causa di forza maggiore', tone: 'warn' },
  RECAG015: { title: 'Ritardo per causa di forza maggiore', tone: 'warn' },
  // Esiti generati da PN, non dal recapitista (pn-paper-channel MetaDematUtils):
  // dopo 10 giorni di giacenza la notifica si perfeziona d'ufficio.
  PNRN012: { title: "Perfezionata d'ufficio dopo 10 giorni di giacenza", tone: 'ok' },
  PNAG012: { title: "Perfezionata d'ufficio dopo 10 giorni di giacenza", tone: 'ok' },
  RECAG012: { title: 'Perfezionata per compiuta giacenza (art. 8 L. 890/1982)', tone: 'neutral' },
  RECRSI001: { title: 'Avviata all\'estero', tone: 'neutral' },
  RECRI002: { title: 'Arrivata nel paese estero', tone: 'neutral' },
  RECRSI002: { title: 'Arrivata nel paese estero', tone: 'neutral' },
  RECRI003C: { title: 'Consegnata', tone: 'ok' },
  RECRSI003C: { title: 'Consegnata', tone: 'ok' },
  RECRI004C: { title: 'Non consegnata', tone: 'ko' },
  RECRSI004C: { title: 'Non consegnata', tone: 'ko' },
};

const PRODUCT_LABELS: Record<string, string> = {
  AR: 'raccomandata A/R',
  '890': 'raccomandata 890 (atti giudiziari)',
  RS: 'raccomandata semplice',
  RIR: 'raccomandata internazionale A/R',
  RIS: 'raccomandata internazionale semplice',
};

// deliveryFailureCause del recapitista (pagopa/pn-ec, PaperElem.java).
const FAILURE_CAUSES: Record<string, string> = {
  M01: 'destinatario irreperibile',
  M02: 'destinatario deceduto',
  M03: 'destinatario sconosciuto',
  M04: 'destinatario trasferito',
  M05: 'invio rifiutato',
  M06: 'indirizzo inesatto',
  M07: 'indirizzo inesistente',
  M08: 'indirizzo insufficiente',
  M09: 'altre motivazioni',
  M10: 'indirizzo non leggibile',
  F01: 'furto',
  F02: 'smarrimento',
  F03: 'deterioramento',
  F04: 'rapina',
  C01: 'incendio',
  C02: 'strada chiusa per lavori o frana',
  C03: 'strada chiusa dalle autorità',
  C04: 'maltempo',
  C05: 'terremoto',
  C06: 'eruzione vulcanica',
};

const CHANNEL_LABELS: Record<string, string> = {
  PEC: 'PEC',
  EMAIL: 'email',
  SMS: 'SMS',
  APPIO: 'App IO',
  SERCQ: 'domicilio digitale SERCQ',
};

/** Codice intermedio (pre-esito "A" / dematerializzazione "B") di un esito: non mostrato. */
function isIntermediateOutcome(code: string): boolean {
  return /^REC[A-Z]+\d{3}[ABDE]$/.test(code);
}

function attemptSuffix(e: SendTimelineEvent): string {
  return typeof e.attempt === 'number' && e.attempt > 0 ? ' (secondo tentativo)' : '';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Indirizzo postale su una riga ("via, zip comune (prov), stato estero") da un physicalAddress di PN. */
function formatPhysicalAddress(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  const street = str(a['address']);
  if (!street) return null;
  const place = [str(a['zip']), str(a['municipality'])].filter(Boolean).join(' ');
  const province = str(a['province']);
  const foreign = str(a['foreignState']);
  return [
    [street, str(a['addressDetails'])].filter(Boolean).join(' '),
    place && province ? `${place} (${province})` : place || (province ? `(${province})` : ''),
    foreign && foreign.toLowerCase() !== 'italia' ? foreign : '',
  ].filter(Boolean).join(', ');
}

/**
 * Indirizzo a cui è stata spedita la carta: quello dell'evento di spedizione, o, se PN lo
 * riporta solo nella preparazione (PREPARE_ANALOG_DOMICILE), quello dello stesso tentativo.
 */
function shipmentAddress(e: SendTimelineEvent, timeline: readonly SendTimelineEvent[]): string | null {
  const own = formatPhysicalAddress(e.details?.['physicalAddress']);
  if (own) return own;
  if (e.category !== 'SEND_ANALOG_DOMICILE') return null;
  for (const x of timeline) {
    if (x.category !== 'PREPARE_ANALOG_DOMICILE' || (x.attempt ?? 0) !== (e.attempt ?? 0)) continue;
    const addr = formatPhysicalAddress(x.details?.['physicalAddress']);
    if (addr) return addr;
  }
  return null;
}

function sentTo(e: SendTimelineEvent, timeline: readonly SendTimelineEvent[]): string | null {
  const addr = shipmentAddress(e, timeline);
  return addr ? `Inviata a: ${addr}` : null;
}

/** Esito dell'avviso di cortesia su App IO (`ioSendMessageResult` di PN). */
const IO_RESULTS: Record<string, string> = {
  SENT_COURTESY: 'messaggio recapitato in App IO',
  SENT_OPTIN: 'inviata in App IO la richiesta di attivare il servizio',
  NOT_SENT_OPTIN_ALREADY_SENT: 'non inviato: richiesta di attivazione già inviata',
  NOT_SENT_APPIO_UNAVAILABLE: 'non inviato: App IO non disponibile',
  ERROR_USER_STATUS: 'non inviato: errore nel controllo dello stato in App IO',
  ERROR_COURTESY: 'invio in App IO non riuscito',
  ERROR_OPTIN: 'richiesta di attivazione in App IO non riuscita',
};

/** Indirizzo digitale ({type, address}) riportato da PN nei dettagli dell'evento. */
function digitalAddressOf(e: SendTimelineEvent): { type: string | null; address: string | null } {
  const v = e.details?.['digitalAddress'];
  if (!v || typeof v !== 'object') return { type: null, address: null };
  const a = v as Record<string, unknown>;
  return { type: str(a['type']), address: str(a['address']) };
}

/** Titolo, dettaglio e tono di un fatto SEND, o null se non va mostrato. `logo`: canale da mostrare col logo ufficiale in coda al titolo. */
export function describeSendTimelineEvent(e: SendTimelineEvent, timeline: readonly SendTimelineEvent[] = []): { title: string; detail: string | null; tone: SendTimelineTone; logo?: string } | null {
  switch (e.category) {
    case 'SEND_DIGITAL_DOMICILE': {
      const da = digitalAddressOf(e);
      // SERCQ: domicilio digitale attivato dal destinatario su SEND stesso; l'indirizzo
      // è un URI interno di PN (x-pagopa-pn-sercq:...), non un recapito da mostrare.
      if ((e.channel ?? da.type) === 'SERCQ') {
        return { title: `Inviata al domicilio digitale SEND${attemptSuffix(e)}`, detail: "Domicilio digitale attivato dal destinatario su SEND: la notifica gli è recapitata nella sua area personale", tone: 'neutral' };
      }
      return { title: `Inviata al domicilio digitale${e.channel ? ` (${CHANNEL_LABELS[e.channel] ?? e.channel})` : ''}${attemptSuffix(e)}`, detail: da.address ? `Inviata a: ${da.address}` : null, tone: 'neutral' };
    }
    case 'SEND_DIGITAL_FEEDBACK':
      return e.responseStatus === 'KO'
        ? { title: 'Mancata consegna al domicilio digitale', detail: null, tone: 'ko' }
        : { title: 'Consegnata al domicilio digitale', detail: null, tone: 'ok' };
    case 'DIGITAL_FAILURE_WORKFLOW':
      return { title: 'Domicilio digitale non raggiungibile: si passa al cartaceo', detail: null, tone: 'warn' };
    case 'SEND_COURTESY_MESSAGE': {
      const da = digitalAddressOf(e);
      const ch = e.channel ?? da.type;
      // App IO: logo ufficiale al posto del nome; PN riporta solo "ENABLED", nessun recapito.
      if (ch === 'APPIO') {
        const result = str(e.details?.['ioSendMessageResult']);
        const status = da.address === 'ENABLED' ? 'App IO attiva per il destinatario' : null;
        const detail = [status, result ? (IO_RESULTS[result] ?? result) : null].filter(Boolean).join(' · ');
        return { title: 'Avviso di cortesia inviato via', detail: detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : null, tone: 'neutral', logo: 'APP_IO' };
      }
      return { title: `Avviso di cortesia inviato${ch ? ` via ${CHANNEL_LABELS[ch] ?? ch}` : ''}`, detail: da.address ? `Inviato a: ${da.address}` : null, tone: 'neutral' };
    }
    case 'PROBABLE_SCHEDULING_ANALOG_DATE': {
      // Data in cui PN avvierà il cartaceo se il destinatario non apre la notifica.
      // Superata dai fatti appena il cartaceo parte o la notifica è aperta/annullata.
      const superseded = ['PREPARE_ANALOG_DOMICILE', 'SEND_ANALOG_DOMICILE', 'NOTIFICATION_VIEWED', 'NOTIFICATION_CANCELLED'];
      if (timeline.some((x) => superseded.includes(x.category))) return null;
      const when = new Date(str(e.details?.['schedulingAnalogDate']) ?? '');
      // Data uguale all'evento: nessuna attesa (niente avviso di cortesia), il cartaceo parte subito.
      if (Number.isNaN(when.getTime()) || when.getTime() - new Date(e.at).getTime() < 3_600_000) return null;
      const day = when.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
      return {
        title: `Raccomandata prevista dal ${day}`,
        detail: "Se il destinatario non apre la notifica entro 5 giorni dall'avviso di cortesia, SEND invia la raccomandata",
        tone: 'neutral',
      };
    }
    case 'PREPARE_ANALOG_DOMICILE_FAILURE':
      return { title: 'Indirizzo fisico non trovato', detail: null, tone: 'ko' };
    case 'SEND_ANALOG_DOMICILE':
      return { title: `Affidata al recapitista${e.productType ? `: ${PRODUCT_LABELS[e.productType] ?? e.productType}` : ''}${attemptSuffix(e)}`, detail: sentTo(e, timeline), tone: 'neutral' };
    case 'SEND_SIMPLE_REGISTERED_LETTER':
      return { title: 'Raccomandata semplice di avviso affidata al recapitista', detail: sentTo(e, timeline), tone: 'neutral' };
    case 'SEND_ANALOG_PROGRESS': {
      if (!e.code || isIntermediateOutcome(e.code)) return null;
      const known = DELIVERY_CODES[e.code];
      return known
        ? { title: known.title, detail: `Codice evento ${e.code}`, tone: known.tone }
        : { title: 'Aggiornamento del recapitista', detail: e.code, tone: 'neutral' };
    }
    case 'SEND_ANALOG_FEEDBACK': {
      const known = e.code ? DELIVERY_CODES[e.code] : undefined;
      const ko = e.responseStatus === 'KO';
      return {
        title: `Esito recapito: ${known ? known.title.charAt(0).toLowerCase() + known.title.slice(1) : ko ? 'non consegnata' : 'consegnata'}`,
        detail: [e.deliveryFailureCause ? (FAILURE_CAUSES[e.deliveryFailureCause] ?? e.deliveryFailureCause) : null, e.code].filter(Boolean).join(' · ') || null,
        tone: ko ? 'ko' : 'ok',
      };
    }
    case 'ANALOG_FAILURE_WORKFLOW':
      return { title: 'Recapito cartaceo non riuscito', detail: null, tone: 'ko' };
    case 'NOTIFICATION_RADD_RETRIEVED':
      return { title: 'Ritirata dal destinatario presso un punto di ritiro SEND', detail: null, tone: 'ok' };
    default:
      return null;
  }
}
