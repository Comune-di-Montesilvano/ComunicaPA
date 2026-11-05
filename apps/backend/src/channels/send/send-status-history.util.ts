export interface SendStatusHistoryEntry {
  status: string;
  activeFrom: string;
}

export interface SendDigitalDomicile {
  type: string;
  address: string | null;
  source: string;
}

/**
 * Copia diretta di notificationStatusHistory da PN (già completo e
 * ordinato cronologicamente) — nessun merge incrementale, overwrite
 * intero ad ogni poll.
 */
export function extractSendStatusHistory(data: unknown): SendStatusHistoryEntry[] {
  const history = (data as { notificationStatusHistory?: unknown })?.notificationStatusHistory;
  if (!Array.isArray(history)) return [];
  return history.map((h: any) => ({ status: h?.status, activeFrom: h?.activeFrom }));
}

/**
 * Estrae il domicilio digitale (o il fallback cartaceo) dall'evento più
 * recente della timeline: un SEND_ANALOG_DOMICILE successivo a un
 * SEND_DIGITAL_DOMICILE rappresenta un fallback cartaceo e vince, essendo
 * l'ultimo tentativo di recapito effettivamente scelto da PN.
 */
export function extractSendDigitalDomicile(data: unknown): SendDigitalDomicile | null {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return null;

  let result: SendDigitalDomicile | null = null;
  for (const el of timeline as any[]) {
    if (el?.category === 'SEND_DIGITAL_DOMICILE' && el?.details?.digitalAddress) {
      result = {
        type: el.details.digitalAddress.type ?? null,
        address: el.details.digitalAddress.address ?? null,
        source: el.details.digitalAddressSource ?? null,
      };
    } else if (el?.category === 'SEND_ANALOG_DOMICILE') {
      result = { type: 'CARTACEO', address: null, source: 'ANALOG' };
    }
  }
  return result;
}

export interface SendAnalogCostEvent {
  productType: string | null;
  analogCostCents: number;
  envelopeWeight: number | null;
  numberOfPages: number | null;
}

export interface SendAnalogCostInfo {
  analogCostCents: number;
  events: SendAnalogCostEvent[];
}

const ANALOG_CATEGORIES_WITH_COST = ['SEND_ANALOG_DOMICILE', 'SEND_SIMPLE_REGISTERED_LETTER'];

/**
 * Somma analogCost (già in eurocent, campo reale PN) su TUTTI gli eventi
 * analogici della timeline di un IUN — un IUN può avere più eventi (es.
 * primo tentativo fallito + rispedizione), ognuno con un costo reale
 * proprio. Vedi docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
 */
export function extractSendAnalogCost(data: unknown): SendAnalogCostInfo {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return { analogCostCents: 0, events: [] };

  const events: SendAnalogCostEvent[] = [];
  for (const el of timeline as any[]) {
    if (ANALOG_CATEGORIES_WITH_COST.includes(el?.category) && typeof el?.details?.analogCost === 'number') {
      events.push({
        productType: el.details.productType ?? null,
        analogCostCents: el.details.analogCost,
        envelopeWeight: el.details.envelopeWeight ?? null,
        numberOfPages: el.details.numberOfPages ?? null,
      });
    }
  }

  return { analogCostCents: events.reduce((sum, e) => sum + e.analogCostCents, 0), events };
}

/**
 * Evento della timeline PN conservato per il percorso della notifica:
 * solo i fatti utili all'operatore e solo campi tecnici — mai indirizzi
 * fisici/digitali né dati del destinatario.
 */
export interface SendTimelineEvent {
  category: string;
  at: string;
  /** deliveryDetailCode del recapitista (es. RECRN003C, CON080). */
  code?: string;
  /** OK/KO di SEND_ANALOG_FEEDBACK / SEND_DIGITAL_FEEDBACK. */
  responseStatus?: string;
  productType?: string;
  /** Tipo canale del messaggio/domicilio digitale (PEC, EMAIL, SMS, APPIO): mai l'indirizzo. */
  channel?: string;
  deliveryFailureCause?: string;
  /** Numero del tentativo (0 = primo). */
  attempt?: number;
  raddType?: string;
}

export const SEND_TIMELINE_CATEGORIES = [
  'SEND_DIGITAL_DOMICILE',
  'SEND_DIGITAL_FEEDBACK',
  'DIGITAL_FAILURE_WORKFLOW',
  'SEND_COURTESY_MESSAGE',
  'PREPARE_ANALOG_DOMICILE_FAILURE',
  'SEND_ANALOG_DOMICILE',
  'SEND_SIMPLE_REGISTERED_LETTER',
  'SEND_ANALOG_PROGRESS',
  'SEND_ANALOG_FEEDBACK',
  'ANALOG_FAILURE_WORKFLOW',
  'NOTIFICATION_RADD_RETRIEVED',
] as const;

/**
 * Sottoinsieme della timeline PN per il percorso: gli stati sono già in
 * notificationStatusHistory, qui i fatti che avvengono DENTRO uno stato
 * (spedizione cartacea, avanzamenti recapitista, ritiro presso punto RADD...).
 * Overwrite intero ad ogni poll, come lo storico stati.
 */
export function extractSendTimeline(data: unknown): SendTimelineEvent[] {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return [];
  const kept = new Set<string>(SEND_TIMELINE_CATEGORIES);
  const out: SendTimelineEvent[] = [];
  for (const el of timeline as any[]) {
    if (!kept.has(el?.category) || typeof el?.timestamp !== 'string') continue;
    const d = el.details ?? {};
    const ev: SendTimelineEvent = { category: el.category, at: el.timestamp };
    if (typeof d.deliveryDetailCode === 'string') ev.code = d.deliveryDetailCode;
    if (typeof d.responseStatus === 'string') ev.responseStatus = d.responseStatus;
    if (typeof d.productType === 'string') ev.productType = d.productType;
    if (typeof d.digitalAddress?.type === 'string') ev.channel = d.digitalAddress.type;
    if (typeof d.deliveryFailureCause === 'string') ev.deliveryFailureCause = d.deliveryFailureCause;
    if (typeof d.sentAttemptMade === 'number') ev.attempt = d.sentAttemptMade;
    if (typeof d.raddType === 'string') ev.raddType = d.raddType;
    out.push(ev);
  }
  return out;
}
