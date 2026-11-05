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

/** Titolo, dettaglio e tono di un fatto SEND, o null se non va mostrato. */
export function describeSendTimelineEvent(e: SendTimelineEvent): { title: string; detail: string | null; tone: SendTimelineTone } | null {
  switch (e.category) {
    case 'SEND_DIGITAL_DOMICILE':
      return { title: `Inviata al domicilio digitale${e.channel ? ` (${CHANNEL_LABELS[e.channel] ?? e.channel})` : ''}${attemptSuffix(e)}`, detail: null, tone: 'neutral' };
    case 'SEND_DIGITAL_FEEDBACK':
      return e.responseStatus === 'KO'
        ? { title: 'Mancata consegna al domicilio digitale', detail: null, tone: 'ko' }
        : { title: 'Consegnata al domicilio digitale', detail: null, tone: 'ok' };
    case 'DIGITAL_FAILURE_WORKFLOW':
      return { title: 'Domicilio digitale non raggiungibile: si passa al cartaceo', detail: null, tone: 'warn' };
    case 'SEND_COURTESY_MESSAGE':
      return { title: `Avviso di cortesia inviato${e.channel ? ` via ${CHANNEL_LABELS[e.channel] ?? e.channel}` : ''}`, detail: null, tone: 'neutral' };
    case 'PREPARE_ANALOG_DOMICILE_FAILURE':
      return { title: 'Indirizzo fisico non trovato', detail: null, tone: 'ko' };
    case 'SEND_ANALOG_DOMICILE':
      return { title: `Spedita per posta${e.productType ? `: ${PRODUCT_LABELS[e.productType] ?? e.productType}` : ''}${attemptSuffix(e)}`, detail: null, tone: 'neutral' };
    case 'SEND_SIMPLE_REGISTERED_LETTER':
      return { title: 'Spedita raccomandata semplice di avviso', detail: null, tone: 'neutral' };
    case 'SEND_ANALOG_PROGRESS': {
      if (!e.code || isIntermediateOutcome(e.code)) return null;
      const known = DELIVERY_CODES[e.code];
      return known
        ? { title: known.title, detail: `Recapitista · ${e.code}`, tone: known.tone }
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
