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
 * Evento della timeline PN: tutti i fatti PN, chiavi PII rimosse (indirizzi
 * fisici/digitali, dati del destinatario). I campi normalizzati sono estratti
 * prima della rimozione; `details` ha il resto.
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
  /** Codice della raccomandata del recapitista: tracciabile su poste.it quando il vettore è Poste. */
  registeredLetterCode?: string;
  /** Dettagli PN senza chiavi PII (sempre presente, anche vuoto). */
  details?: Record<string, unknown>;
}

/** Chiavi con dati personali, tolte a qualunque profondità dai `details`. */
export const SEND_TIMELINE_PII_KEYS: readonly string[] = [
  'physicalAddress',
  'digitalAddress',
  'newAddress',
  'normalizedAddress',
  'oldAddress',
  'address',
  'at',
  'municipality',
  'municipalityDetails',
  'zip',
  'province',
  'foreignState',
  'taxId',
  'denomination',
  'recipient',
  'recipientId',
  'foundAddress',
  'addressDetails',
  'delegateInfo',
  // Righe indirizzo cartaceo (prepare/send analog request).
  'fullname',
  'nameRow2',
  'addressRow2',
  'cap',
  'city',
  'city2',
  'pr',
  'country',
];

/** Testo libero di PN che può ripetere un codice fiscale: tolto dagli elementi di `refusalReasons`. */
const REFUSAL_REASON_FREE_TEXT_KEYS: readonly string[] = ['detail'];

/** Copia profonda (array e oggetti semplici) senza le chiavi PII. */
export function stripSendPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSendPii);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SEND_TIMELINE_PII_KEYS.includes(k)) continue;
      out[k] = k === 'refusalReasons' && Array.isArray(v) ? v.map(stripRefusalReason) : stripSendPii(v);
    }
    return out;
  }
  return value;
}

function stripRefusalReason(reason: unknown): unknown {
  const stripped = stripSendPii(reason);
  if (!stripped || typeof stripped !== 'object' || Array.isArray(stripped)) return stripped;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stripped)) {
    if (!REFUSAL_REASON_FREE_TEXT_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Timeline PN completa (gli stati sono anche in notificationStatusHistory),
 * con le chiavi PII rimosse dai dettagli. Overwrite intero ad ogni poll.
 */
export function extractSendTimeline(data: unknown): SendTimelineEvent[] {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return [];
  const out: SendTimelineEvent[] = [];
  for (const el of timeline as any[]) {
    if (typeof el?.category !== 'string' || typeof el?.timestamp !== 'string') continue;
    const d = el.details ?? {};
    const ev: SendTimelineEvent = { category: el.category, at: el.timestamp, details: {} };
    if (typeof d.deliveryDetailCode === 'string') ev.code = d.deliveryDetailCode;
    if (typeof d.responseStatus === 'string') ev.responseStatus = d.responseStatus;
    if (typeof d.productType === 'string') ev.productType = d.productType;
    if (typeof d.digitalAddress?.type === 'string') ev.channel = d.digitalAddress.type;
    if (typeof d.deliveryFailureCause === 'string') ev.deliveryFailureCause = d.deliveryFailureCause;
    if (typeof d.sentAttemptMade === 'number') ev.attempt = d.sentAttemptMade;
    if (typeof d.raddType === 'string') ev.raddType = d.raddType;
    if (typeof d.registeredLetterCode === 'string' && d.registeredLetterCode) ev.registeredLetterCode = d.registeredLetterCode;
    const stripped = stripSendPii(d);
    if (stripped && typeof stripped === 'object' && !Array.isArray(stripped)) ev.details = stripped as Record<string, unknown>;
    out.push(ev);
  }
  return out;
}
